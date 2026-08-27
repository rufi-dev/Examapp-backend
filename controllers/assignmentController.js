const asyncHandler = require("express-async-handler");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const Assignment = require("../models/assignmentModel");
const Submission = require("../models/submissionModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const parentNotify = require("../helper/parentNotify");

// Shared by the route-level upload guard and the re-submission merge check so
// new submissions and edits always enforce the same student file limit.
const STUDENT_SUBMISSION_MAX_FILES = 20;

// PRIVATE storage — deliberately NOT under uploads/ (which express.static serves
// publicly). Holds BOTH teacher handout attachments and student submission
// files; nothing here is reachable without passing an access check below.
const ASSIGNMENTS_DIR = path.join(process.cwd(), "assignments");
if (!fs.existsSync(ASSIGNMENTS_DIR)) fs.mkdirSync(ASSIGNMENTS_DIR, { recursive: true });

// Cached image thumbnails live in a subdir of the private store, so previews
// stay behind the same access checks as the originals.
const THUMBS_DIR = path.join(ASSIGNMENTS_DIR, ".thumbs");
const THUMB_MAX_EDGE = 400; // px on the long edge — enough to eyeball the work.

// sharp is a native module; if it fails to load (or is absent on a host), we
// simply serve the full-size original instead. Previews degrade, never break.
let sharp = null;
try {
  // eslint-disable-next-line global-require
  sharp = require("sharp");
} catch {
  sharp = null;
}

const isImageMeta = (meta) =>
  meta && (meta.kind === "image" || String(meta.mimeType || "").startsWith("image/"));

// Return an absolute path to a small cached webp thumbnail for an image file,
// or null to signal "no thumbnail — send the original". Generated once, then
// reused. Any failure (unsupported format like HEIC, corrupt file) → null.
async function thumbnailPathFor(meta) {
  if (!sharp || !isImageMeta(meta)) return null;
  const srcAbs = path.join(ASSIGNMENTS_DIR, meta.fileName);
  if (!srcAbs.startsWith(ASSIGNMENTS_DIR) || !fs.existsSync(srcAbs)) return null;
  const thumbAbs = path.join(THUMBS_DIR, `${meta.fileName}.webp`);
  try {
    if (fs.existsSync(thumbAbs) && fs.statSync(thumbAbs).size > 0) return thumbAbs;
    if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });
    await sharp(srcAbs, { failOn: "none" })
      .rotate() // honour EXIF orientation so phone photos aren't sideways
      .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72 })
      .toFile(thumbAbs);
    return thumbAbs;
  } catch {
    cleanup(thumbAbs); // never leave a half-written thumb behind
    return null;
  }
}

const cleanup = (p) => {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* best effort */
  }
};

// Coarse bucket for the UI icon, from the TRUSTED detected type (never the
// client MIME). Set on each multer file by the route's verify middleware.
function kindFromType(detected) {
  if (detected === "pdf") return "pdf";
  if (["png", "jpg", "gif", "webp", "heic", "isobmff", "heif"].includes(detected)) return "image";
  if (["ooxml", "odf", "ole", "rtf"].includes(detected)) return "office";
  return "other";
}

// multer 1.x (busboy) decodes multipart filenames as latin1, so a UTF-8 name like
// the Azerbaijani "dərs 1 ev tapşırığı.pdf" arrives mojibaked ("dÉrs 1 ev tapÅ…").
// Re-decode the raw bytes as UTF-8 to recover the real name. Guard against bytes that
// aren't valid UTF-8: if re-decoding introduces the replacement char (that wasn't
// already there), keep the original string instead of corrupting it further.
const decodeUploadName = (name) => {
  const raw = String(name || "");
  if (!raw) return "";
  try {
    const utf8 = Buffer.from(raw, "latin1").toString("utf8");
    if (utf8.includes("�") && !raw.includes("�")) return raw;
    return utf8;
  } catch {
    return raw;
  }
};

// Turn a validated multer file into the stored-file subdocument.
const fileDocFor = (file) => ({
  fileName: path.basename(file.path),
  originalName: decodeUploadName(file.originalname),
  mimeType: file.canonicalMime || file.mimetype || "",
  sizeBytes: Number(file.size || 0),
  kind: kindFromType(file.detectedType),
});

// ---- access helpers ---------------------------------------------------------
// The teacher who owns the class (or an admin) manages its assignments.
async function isClassManager(user, classId) {
  if (!user) return false;
  if (user.role === "admin") return true;
  const cls = await Class.findById(classId).select("owner deletedAt").lean();
  if (!cls || cls.deletedAt) return false;
  return String(cls.owner) === String(user._id);
}

// A student may see/submit only in a class they are APPROVED-enrolled in.
async function isEnrolledStudent(user, classId) {
  if (!user) return false;
  const e = await Enrollment.findOne({
    student: user._id,
    class: classId,
    status: "approved",
  }).select("_id").lean();
  return !!e;
}

// Anyone who may open the class page: its manager (teacher/admin) or an
// approved student.
async function canSeeClass(user, classId) {
  return (await isClassManager(user, classId)) || (await isEnrolledStudent(user, classId));
}

const isManagerRole = (user) => user && (user.role === "admin" || user.role === "teacher");

// ---- endpoints --------------------------------------------------------------

// GET /api/assignments?classId=...  — the class's tasks, scoped to the caller.
// Managers get submission progress counts; a student gets their OWN submission
// attached to each task.
const listAssignments = asyncHandler(async (req, res) => {
  const classId = String(req.query.classId || "").trim();
  if (!classId) return res.status(400).json({ message: "Sinif seçilməyib" });
  if (!(await canSeeClass(req.user, classId))) {
    return res.status(403).json({ message: "Bu sinfə girişiniz yoxdur" });
  }

  const assignments = await Assignment.find({ class: classId, deletedAt: null })
    .sort({ createdAt: -1 })
    .lean();
  const ids = assignments.map((a) => a._id);

  const manager = await isClassManager(req.user, classId);
  if (manager) {
    // How many approved students are in the class, and how many have submitted
    // per task — the "3/12 təhvil verildi" progress the teacher wants at a glance.
    const studentTotal = await Enrollment.countDocuments({ class: classId, status: "approved" });
    const counts = await Submission.aggregate([
      { $match: { assignment: { $in: ids } } },
      {
        $group: {
          _id: "$assignment",
          submitted: { $sum: 1 },
          graded: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } },
          // Unseen by the owner, or re-uploaded since it was last seen.
          newSub: { $sum: { $cond: [{ $lt: [{ $ifNull: ["$seenByOwnerAt", new Date(0)] }, "$submittedAt"] }, 1, 0] } },
        },
      },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c]));
    const out = assignments.map((a) => {
      const c = byId.get(String(a._id));
      return { ...a, studentTotal, submittedCount: c?.submitted || 0, gradedCount: c?.graded || 0, newCount: c?.newSub || 0 };
    });
    return res.json(out);
  }

  // Student view: attach only their own submission (they never see classmates').
  const mine = await Submission.find({ assignment: { $in: ids }, student: req.user._id }).lean();
  const byAssignment = new Map(mine.map((s) => [String(s.assignment), s]));
  const out = assignments.map((a) => ({
    // Never leak how many others submitted or the roster to a student.
    _id: a._id,
    class: a.class,
    ownerName: a.ownerName,
    title: a.title,
    description: a.description,
    attachments: a.attachments,
    dueAt: a.dueAt,
    allowLate: a.allowLate,
    lockAfterSubmit: a.lockAfterSubmit,
    boardEnabled: a.boardEnabled,
    maxPoints: a.maxPoints,
    createdAt: a.createdAt,
    mySubmission: byAssignment.get(String(a._id)) || null,
  }));
  return res.json(out);
});

// Which classes a create targets: the hub picker sends `classIds` (a JSON array
// — one or many, "all my classes" is just the full list resolved client-side);
// a class page still sends a single `classId`. De-duplicated, trimmed.
function parseTargetClassIds(body) {
  let ids = [];
  if (body.classIds !== undefined) {
    try {
      const parsed = JSON.parse(body.classIds);
      if (Array.isArray(parsed)) ids = parsed;
    } catch {
      ids = [];
    }
  }
  if (!ids.length && body.classId) ids = [body.classId];
  return [...new Set(ids.map((x) => String(x || "").trim()).filter(Boolean))];
}

// POST /api/assignments — teacher/admin creates a task (multipart; optional
// handout files under the "attachments" field). Targets one class (class page)
// or several at once (the hub's "all / specific classes" picker) — in which case
// one independent assignment is created per class, each with its OWN copy of the
// uploaded handout bytes so editing/deleting one never affects the others.
const createAssignment = asyncHandler(async (req, res) => {
  const files = req.files || [];
  const fail = (code, message) => {
    files.forEach((f) => cleanup(f.path));
    return res.status(code).json({ message });
  };

  const classIds = parseTargetClassIds(req.body);
  if (!classIds.length) return fail(400, "Sinif seçilməyib");
  for (const cid of classIds) {
    if (!(await isClassManager(req.user, cid))) return fail(403, "Sinif sizə aid deyil");
  }

  const title = String(req.body.title || "").trim();
  if (!title) return fail(400, "Başlıq daxil edin");

  let dueAt = null;
  if (req.body.dueAt) {
    const d = new Date(req.body.dueAt);
    if (Number.isNaN(d.getTime())) return fail(400, "Son tarix yanlışdır");
    dueAt = d;
  }
  let maxPoints = null;
  if (req.body.maxPoints !== undefined && req.body.maxPoints !== "" && req.body.maxPoints !== null) {
    const n = Number(req.body.maxPoints);
    if (!Number.isFinite(n) || n < 0) return fail(400, "Maksimal bal yanlışdır");
    maxPoints = n;
  }

  const base = {
    owner: req.user._id,
    ownerName: req.user.name || "",
    title,
    description: String(req.body.description || "").trim(),
    dueAt,
    // Multipart booleans arrive as the string "true"/"false".
    allowLate: String(req.body.allowLate) !== "false",
    lockAfterSubmit: String(req.body.lockAfterSubmit) === "true",
    boardEnabled: String(req.body.boardEnabled) === "true",
    maxPoints,
  };
  const baseFiles = files.map(fileDocFor);

  const created = [];
  for (let i = 0; i < classIds.length; i += 1) {
    const iterCopies = [];
    try {
      // The first class keeps the originally uploaded files; the rest get a
      // private copy each so their lifecycles are fully independent.
      let attachments = baseFiles;
      if (i > 0) {
        attachments = [];
        for (const f of files) {
          const ext = path.extname(f.path);
          const newName = `asg-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
          const newPath = path.join(ASSIGNMENTS_DIR, newName);
          await fsp.copyFile(f.path, newPath);
          iterCopies.push(newPath);
          attachments.push(fileDocFor({ ...f, path: newPath }));
        }
      }
      const a = await Assignment.create({ ...base, class: classIds[i], attachments });
      created.push(a.toObject());
    } catch (err) {
      iterCopies.forEach(cleanup); // never leave this iteration's copies orphaned
      if (!created.length) return fail(500, "Tapşırıq yaradılmadı");
      break; // some already committed — keep them, stop here
    }
  }

  // Single target → the assignment object (unchanged contract for the class page).
  // Multiple → a small summary; the hub refetches its list either way.
  if (classIds.length === 1) return res.status(201).json(created[0]);
  res.status(201).json({ created: created.length, assignments: created });
});

function parseRemovedAttachments(value) {
  if (value === undefined || value === null || value === "") return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length > 5) return null;
  const names = [];
  for (const raw of parsed) {
    const name = String(raw || "");
    if (!name || name !== path.basename(name) || name.includes("\\")) return null;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

// PATCH /api/assignments/:id — owner/admin edits content, policy and optional
// handouts. New files are validated before this handler; removed private bytes
// are deleted only after the assignment document has committed successfully.
const updateAssignment = asyncHandler(async (req, res) => {
  const files = req.files || [];
  const fail = (code, message) => {
    files.forEach((file) => cleanup(file.path));
    return res.status(code).json({ message });
  };

  const a = await Assignment.findById(req.params.id);
  if (!a || a.deletedAt) return fail(404, "Tapılmadı");
  if (!(await isClassManager(req.user, a.class))) return fail(403, "İcazə yoxdur");

  const removeNames = parseRemovedAttachments(req.body.removeAttachments);
  if (removeNames === null) return fail(400, "Silinəcək fayllar yanlışdır");
  const currentFiles = Array.from(a.attachments || []);
  const currentNames = new Set(currentFiles.map((file) => String(file.fileName)));
  if (removeNames.some((name) => !currentNames.has(name))) {
    return fail(400, "Silinəcək fayl tapılmadı");
  }
  const removeSet = new Set(removeNames);
  const retainedFiles = currentFiles.filter((file) => !removeSet.has(String(file.fileName)));
  if (retainedFiles.length + files.length > 5) {
    return fail(400, "Maksimum 5 fayl əlavə etmək olar");
  }

  if (req.body.title !== undefined) {
    const title = String(req.body.title).trim();
    if (!title) return fail(400, "Başlıq daxil edin");
    a.title = title;
  }
  if (req.body.description !== undefined) a.description = String(req.body.description).trim();
  if (req.body.allowLate !== undefined) a.allowLate = String(req.body.allowLate) !== "false";
  if (req.body.lockAfterSubmit !== undefined) a.lockAfterSubmit = String(req.body.lockAfterSubmit) === "true";
  if (req.body.boardEnabled !== undefined) a.boardEnabled = String(req.body.boardEnabled) === "true";
  if (req.body.dueAt !== undefined) {
    if (!req.body.dueAt) a.dueAt = null;
    else {
      const d = new Date(req.body.dueAt);
      if (Number.isNaN(d.getTime())) return fail(400, "Son tarix yanlışdır");
      a.dueAt = d;
    }
  }
  if (req.body.maxPoints !== undefined) {
    if (req.body.maxPoints === "" || req.body.maxPoints === null) a.maxPoints = null;
    else {
      const n = Number(req.body.maxPoints);
      if (!Number.isFinite(n) || n < 0) return fail(400, "Maksimal bal yanlışdır");
      a.maxPoints = n;
    }
  }

  a.attachments = [...retainedFiles, ...files.map(fileDocFor)];
  try {
    await a.save();
  } catch (error) {
    files.forEach((file) => cleanup(file.path));
    throw error;
  }

  removeNames.forEach((name) => {
    cleanup(path.join(ASSIGNMENTS_DIR, name));
    cleanup(path.join(THUMBS_DIR, `${name}.webp`));
  });
  res.json(a.toObject());
});

// DELETE /api/assignments/:id — soft delete (owner/admin). Submissions and
// their files are left on disk so a mistaken delete is recoverable by an admin.
const deleteAssignment = asyncHandler(async (req, res) => {
  const a = await Assignment.findById(req.params.id);
  if (!a || a.deletedAt) return res.status(404).json({ message: "Tapılmadı" });
  if (!(await isClassManager(req.user, a.class))) return res.status(403).json({ message: "İcazə yoxdur" });
  a.deletedAt = new Date();
  a.deletedBy = req.user._id;
  await a.save();
  res.json({ ok: true });
});

// GET /api/assignments/:id/submissions — teacher/admin review view: every
// submission plus the roster of approved students who have NOT submitted yet.
const getSubmissions = asyncHandler(async (req, res) => {
  const a = await Assignment.findById(req.params.id).lean();
  if (!a || a.deletedAt) return res.status(404).json({ message: "Tapılmadı" });
  if (!(await isClassManager(req.user, a.class))) return res.status(403).json({ message: "İcazə yoxdur" });

  const submissions = await Submission.find({ assignment: a._id })
    .sort({ submittedAt: -1 })
    .populate("student", "name email photo")
    .lean();

  // Who is enrolled but hasn't handed anything in.
  const enrolled = await Enrollment.find({ class: a.class, status: "approved" })
    .populate("student", "name email photo")
    .lean();
  const submittedIds = new Set(submissions.map((s) => String(s.student?._id || s.student)));
  const missing = enrolled
    .filter((e) => e.student && !submittedIds.has(String(e.student._id)))
    .map((e) => ({ _id: e.student._id, name: e.student.name, email: e.student.email, photo: e.student.photo }));

  res.json({ assignment: a, submissions, missing });
});

// PATCH /api/assignments/:id/submissions/:submissionId — grade / return work.
const gradeSubmission = asyncHandler(async (req, res) => {
  const a = await Assignment.findById(req.params.id).lean();
  if (!a || a.deletedAt) return res.status(404).json({ message: "Tapılmadı" });
  if (!(await isClassManager(req.user, a.class))) return res.status(403).json({ message: "İcazə yoxdur" });

  const s = await Submission.findOne({ _id: req.params.submissionId, assignment: a._id });
  if (!s) return res.status(404).json({ message: "Təhvil tapılmadı" });

  if (req.body.grade !== undefined) {
    if (req.body.grade === "" || req.body.grade === null) s.grade = null;
    else {
      const n = Number(req.body.grade);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: "Bal yanlışdır" });
      if (a.maxPoints != null && n > a.maxPoints) {
        return res.status(400).json({ message: `Bal ${a.maxPoints}-dan çox ola bilməz` });
      }
      s.grade = n;
    }
  }
  if (req.body.feedback !== undefined) s.feedback = String(req.body.feedback).trim();
  // Grading a submission returns it to the student.
  s.status = "returned";
  s.gradedAt = new Date();
  s.gradedBy = req.user._id;
  await s.save();

  const populated = await Submission.findById(s._id).populate("student", "name email photo").lean();
  res.json(populated);
  parentNotify
    .homeworkGraded(s.student, a.class, {
      childName: populated?.student?.name || s.studentName,
      title: a.title,
      grade: s.grade,
      maxPoints: a.maxPoints,
    })
    .catch(() => {});
});

// POST /api/assignments/:id/submissions/:submissionId/seen — the class owner
// opened this submission in the review dialog; clear its "new" badge. Idempotent.
const markSubmissionSeen = asyncHandler(async (req, res) => {
  const a = await Assignment.findById(req.params.id).lean();
  if (!a || a.deletedAt) return res.status(404).json({ message: "Tapılmadı" });
  if (!(await isClassManager(req.user, a.class))) return res.status(403).json({ message: "İcazə yoxdur" });

  const now = new Date();
  const s = await Submission.findOneAndUpdate(
    { _id: req.params.submissionId, assignment: a._id },
    { $set: { seenByOwnerAt: now } },
    { new: true }
  ).lean();
  if (!s) return res.status(404).json({ message: "Təhvil tapılmadı" });
  res.json({ _id: s._id, seenByOwnerAt: s.seenByOwnerAt });
});

// POST /api/assignments/:id/submit — student uploads work (multipart, field
// "files", 1..20). A re-submission REPLACES the previous files (one row per
// student per task). Blocked after the deadline unless the teacher allows late.
const submitAssignment = asyncHandler(async (req, res) => {
  const files = req.files || [];
  const fail = (code, message) => {
    files.forEach((f) => cleanup(f.path));
    return res.status(code).json({ message });
  };

  const a = await Assignment.findById(req.params.id).lean();
  if (!a || a.deletedAt) return fail(404, "Tapşırıq tapılmadı");
  if (!(await isEnrolledStudent(req.user, a.class))) return fail(403, "Bu sinfin şagirdi deyilsiniz");
  const now = new Date();
  const isLate = a.dueAt ? now > new Date(a.dueAt) : false;
  if (isLate && !a.allowLate) return fail(403, "Son tarix keçib — təhvil bağlıdır");

  const fileDocs = files.map(fileDocFor);

  // Re-upload = EDIT, not wipe: the client sends `keep` (a JSON array of the
  // student's previously-stored file names) so they can keep some, drop some, and
  // add new ones. Absent `keep` (older client) → previous "replace all" behavior.
  let keepList = null;
  if (typeof req.body.keep === "string") {
    try {
      const parsed = JSON.parse(req.body.keep);
      keepList = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      keepList = [];
    }
  }

  const existing = await Submission.findOne({ assignment: a._id, student: req.user._id });
  // "Upload once" tasks: the first submission is final — no edit, add, or remove.
  if (existing && a.lockAfterSubmit) {
    return fail(403, "Bu tapşırıq birdəfəlikdir — təhvil verildikdən sonra dəyişmək olmaz");
  }
  if (existing) {
    const oldFiles = existing.files || [];
    const kept = keepList ? oldFiles.filter((f) => keepList.includes(f.fileName)) : [];
    const combined = [...kept, ...fileDocs];
    if (!combined.length) return fail(400, "Ən azı bir fayl olmalıdır");
    if (combined.length > STUDENT_SUBMISSION_MAX_FILES) {
      return fail(400, `Maksimum ${STUDENT_SUBMISSION_MAX_FILES} fayl`);
    }

    existing.files = combined;
    existing.note = String(req.body.note || "").trim();
    existing.submittedAt = now;
    existing.late = isLate;
    // A re-submission is fresh work: clear any prior grade/return state.
    existing.status = "submitted";
    existing.grade = null;
    existing.feedback = "";
    existing.gradedAt = null;
    existing.gradedBy = null;
    await existing.save();
    // Delete ONLY the files that were actually removed (in old, not in the new set).
    const keptNames = new Set(combined.map((f) => f.fileName));
    oldFiles
      .filter((f) => !keptNames.has(f.fileName))
      .forEach((f) => {
        cleanup(path.join(ASSIGNMENTS_DIR, f.fileName));
        cleanup(path.join(THUMBS_DIR, `${f.fileName}.webp`));
      });
    return res.status(200).json(existing.toObject());
  }

  // First submission: at least one uploaded file required.
  if (!fileDocs.length) return fail(400, "Ən azı bir fayl yükləyin");
  const submission = await Submission.create({
    assignment: a._id,
    class: a.class,
    student: req.user._id,
    studentName: req.user.name || "",
    files: fileDocs,
    note: String(req.body.note || "").trim(),
    submittedAt: now,
    late: isLate,
  });
  res.status(201).json(submission.toObject());
});

// GET /api/assignments/mine — the caller's tasks across ALL their classes, for
// the top-level "Tapşırıqlar" hub (a deadline/status view, not a class picker).
// Teacher/admin: everything they own + per-task submission progress. Student:
// every task from their approved-enrolled classes + THEIR own submission.
const myAssignments = asyncHandler(async (req, res) => {
  if (isManagerRole(req.user)) {
    // ADMIN oversees the whole platform → every teacher's tasks. A TEACHER sees
    // only the ones they created (across all THEIR classes). Each doc carries
    // `ownerName`, so the admin view can label who created each task.
    const filter =
      req.user.role === "admin" ? { deletedAt: null } : { owner: req.user._id, deletedAt: null };
    const assignments = await Assignment.find(filter)
      .populate("class", "name")
      .sort({ createdAt: -1 })
      .lean();
    if (!assignments.length) return res.json([]);
    const ids = assignments.map((a) => a._id);
    // Unique class ObjectIds (from the populated class) for the roster counts.
    const classObjIds = [
      ...new Map(assignments.filter((a) => a.class?._id).map((a) => [String(a.class._id), a.class._id])).values(),
    ];
    const [counts, enroll] = await Promise.all([
      Submission.aggregate([
        { $match: { assignment: { $in: ids } } },
        {
          $group: {
            _id: "$assignment",
            submitted: { $sum: 1 },
            graded: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } },
            newSub: { $sum: { $cond: [{ $lt: [{ $ifNull: ["$seenByOwnerAt", new Date(0)] }, "$submittedAt"] }, 1, 0] } },
          },
        },
      ]),
      classObjIds.length
        ? Enrollment.aggregate([
            { $match: { class: { $in: classObjIds }, status: "approved" } },
            { $group: { _id: "$class", n: { $sum: 1 } } },
          ])
        : Promise.resolve([]),
    ]);
    const cById = new Map(counts.map((c) => [String(c._id), c]));
    const eByClass = new Map(enroll.map((e) => [String(e._id), e.n]));
    const out = assignments.map((a) => {
      const c = cById.get(String(a._id));
      return {
        ...a,
        studentTotal: eByClass.get(String(a.class?._id || a.class)) || 0,
        submittedCount: c?.submitted || 0,
        gradedCount: c?.graded || 0,
        newCount: c?.newSub || 0,
      };
    });
    return res.json(out);
  }

  // Student view.
  const classIds = await Enrollment.find({ student: req.user._id, status: "approved" }).distinct("class");
  if (!classIds.length) return res.json([]);
  const assignments = await Assignment.find({ class: { $in: classIds }, deletedAt: null })
    .populate("class", "name")
    .sort({ createdAt: -1 })
    .lean();
  const ids = assignments.map((a) => a._id);
  const mine = await Submission.find({ assignment: { $in: ids }, student: req.user._id }).lean();
  const byA = new Map(mine.map((s) => [String(s.assignment), s]));
  const out = assignments.map((a) => ({
    _id: a._id,
    class: a.class, // { _id, name }
    ownerName: a.ownerName,
    title: a.title,
    description: a.description,
    attachments: a.attachments,
    dueAt: a.dueAt,
    allowLate: a.allowLate,
    lockAfterSubmit: a.lockAfterSubmit,
    boardEnabled: a.boardEnabled,
    maxPoints: a.maxPoints,
    createdAt: a.createdAt,
    mySubmission: byA.get(String(a._id)) || null,
  }));
  return res.json(out);
});

// GET /api/assignments/:id/attachment/:fileName — a teacher's handout file.
// Readable by anyone who can see the class (manager or enrolled student).
const getAttachmentFile = asyncHandler(async (req, res) => {
  const a = await Assignment.findById(req.params.id).lean();
  if (!a || a.deletedAt) return res.status(404).json({ message: "Tapılmadı" });
  if (!(await canSeeClass(req.user, a.class))) return res.status(403).json({ message: "İcazə yoxdur" });
  const meta = (a.attachments || []).find((f) => f.fileName === req.params.fileName);
  if (!meta) return res.status(404).json({ message: "Fayl tapılmadı" });
  return sendStored(res, meta, { download: req.query.download === "1", thumb: req.query.thumb === "1" });
});

// GET /api/assignments/:id/submissions/:submissionId/files/:fileName — a
// student's uploaded file. Readable by the owning student OR the class manager.
const getSubmissionFile = asyncHandler(async (req, res) => {
  const a = await Assignment.findById(req.params.id).lean();
  if (!a || a.deletedAt) return res.status(404).json({ message: "Tapılmadı" });
  const s = await Submission.findOne({ _id: req.params.submissionId, assignment: a._id }).lean();
  if (!s) return res.status(404).json({ message: "Təhvil tapılmadı" });

  const owns = String(s.student) === String(req.user._id);
  const manages = await isClassManager(req.user, a.class);
  if (!owns && !manages) return res.status(403).json({ message: "İcazə yoxdur" });

  const meta =
    (s.files || []).find((f) => f.fileName === req.params.fileName) ||
    (s.annotations || []).find((f) => f.fileName === req.params.fileName);
  if (!meta) return res.status(404).json({ message: "Fayl tapılmadı" });
  return sendStored(res, meta, { download: req.query.download === "1", thumb: req.query.thumb === "1" });
});

// POST /api/assignments/:id/submissions/:submissionId/annotation — the teacher's
// marked-up image (✓/✗, notes drawn over the student's work). One flattened PNG,
// field "annotation". Replaces any prior annotation of the same source file, marks
// the submission "returned" so the student sees it.
const annotateSubmission = asyncHandler(async (req, res) => {
  const files = req.files || [];
  const fail = (code, message) => {
    files.forEach((f) => cleanup(f.path));
    return res.status(code).json({ message });
  };
  const a = await Assignment.findById(req.params.id).lean();
  if (!a || a.deletedAt) return fail(404, "Tapılmadı");
  if (!(await isClassManager(req.user, a.class))) return fail(403, "İcazə yoxdur");
  const s = await Submission.findOne({ _id: req.params.submissionId, assignment: a._id });
  if (!s) return fail(404, "Təhvil tapılmadı");
  const file = files[0];
  if (!file) return fail(400, "Şəkil tapılmadı");
  if (kindFromType(file.detectedType) !== "image") return fail(400, "Yalnız şəkil");

  const sourceFileName = String(req.body.sourceFileName || "");
  const doc = {
    fileName: path.basename(file.path),
    originalName: decodeUploadName(file.originalname) || "isarelenmis.png",
    mimeType: file.canonicalMime || file.mimetype || "image/png",
    sizeBytes: Number(file.size || 0),
    sourceFileName,
    createdAt: new Date(),
  };
  // Replace an earlier annotation of the same source image (don't pile up).
  if (sourceFileName) {
    const idx = s.annotations.findIndex((x) => x.sourceFileName === sourceFileName);
    if (idx >= 0) {
      cleanup(path.join(ASSIGNMENTS_DIR, s.annotations[idx].fileName));
      s.annotations.splice(idx, 1);
    }
  }
  s.annotations.push(doc);
  s.status = "returned";
  s.gradedAt = new Date();
  s.gradedBy = req.user._id;
  await s.save();

  const populated = await Submission.findById(s._id).populate("student", "name email photo").lean();
  res.json(populated);
});

// Stream a stored file after the caller has been authorised. Inline by default
// (so images/PDF render in-app); `download` forces a save with the real name;
// `thumb` serves a small cached preview for images (falls back to the original).
async function sendStored(res, meta, { download = false, thumb = false } = {}) {
  const abs = path.join(ASSIGNMENTS_DIR, meta.fileName);
  // Defensive: never let a crafted fileName escape the assignments dir.
  if (!abs.startsWith(ASSIGNMENTS_DIR) || !fs.existsSync(abs)) {
    return res.status(404).json({ message: "Fayl tapılmadı" });
  }
  if (download) {
    const safeName = String(meta.originalName || meta.fileName).replace(/[\\/:*?"<>|]+/g, "_");
    return res.download(abs, safeName);
  }
  if (thumb) {
    const thumbAbs = await thumbnailPathFor(meta);
    if (thumbAbs) {
      return res.sendFile(thumbAbs, {
        headers: {
          "Content-Type": "image/webp",
          "Content-Disposition": "inline",
          "Cache-Control": "private, max-age=86400",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
    // No thumbnail available (not an image, or sharp unavailable) → original.
  }
  res.sendFile(abs, {
    acceptRanges: true,
    headers: {
      "Content-Type": meta.mimeType || "application/octet-stream",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

module.exports = {
  ASSIGNMENTS_DIR,
  STUDENT_SUBMISSION_MAX_FILES,
  listAssignments,
  myAssignments,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  getSubmissions,
  gradeSubmission,
  markSubmissionSeen,
  submitAssignment,
  getAttachmentFile,
  getSubmissionFile,
  annotateSubmission,
  isManagerRole,
};
