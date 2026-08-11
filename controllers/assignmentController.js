const asyncHandler = require("express-async-handler");
const fs = require("fs");
const path = require("path");
const Assignment = require("../models/assignmentModel");
const Submission = require("../models/submissionModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");

// PRIVATE storage — deliberately NOT under uploads/ (which express.static serves
// publicly). Holds BOTH teacher handout attachments and student submission
// files; nothing here is reachable without passing an access check below.
const ASSIGNMENTS_DIR = path.join(process.cwd(), "assignments");
if (!fs.existsSync(ASSIGNMENTS_DIR)) fs.mkdirSync(ASSIGNMENTS_DIR, { recursive: true });

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

// Turn a validated multer file into the stored-file subdocument.
const fileDocFor = (file) => ({
  fileName: path.basename(file.path),
  originalName: file.originalname || "",
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
      { $group: { _id: "$assignment", submitted: { $sum: 1 }, graded: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } } } },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c]));
    const out = assignments.map((a) => {
      const c = byId.get(String(a._id));
      return { ...a, studentTotal, submittedCount: c?.submitted || 0, gradedCount: c?.graded || 0 };
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
    maxPoints: a.maxPoints,
    createdAt: a.createdAt,
    mySubmission: byAssignment.get(String(a._id)) || null,
  }));
  return res.json(out);
});

// POST /api/assignments — teacher/admin creates a task (multipart; optional
// handout files under the "attachments" field).
const createAssignment = asyncHandler(async (req, res) => {
  const files = req.files || [];
  const fail = (code, message) => {
    files.forEach((f) => cleanup(f.path));
    return res.status(code).json({ message });
  };

  const classId = String(req.body.classId || "").trim();
  if (!classId) return fail(400, "Sinif seçilməyib");
  if (!(await isClassManager(req.user, classId))) return fail(403, "Bu sinif sizə aid deyil");

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

  const assignment = await Assignment.create({
    class: classId,
    owner: req.user._id,
    ownerName: req.user.name || "",
    title,
    description: String(req.body.description || "").trim(),
    attachments: files.map(fileDocFor),
    dueAt,
    // Multipart booleans arrive as the string "true"/"false".
    allowLate: String(req.body.allowLate) !== "false",
    maxPoints,
  });

  res.status(201).json(assignment.toObject());
});

// PATCH /api/assignments/:id — owner/admin edits the text fields, deadline,
// late policy and grading ceiling. Attachments are set at creation.
const updateAssignment = asyncHandler(async (req, res) => {
  const a = await Assignment.findById(req.params.id);
  if (!a || a.deletedAt) return res.status(404).json({ message: "Tapılmadı" });
  if (!(await isClassManager(req.user, a.class))) return res.status(403).json({ message: "İcazə yoxdur" });

  if (req.body.title !== undefined) {
    const title = String(req.body.title).trim();
    if (!title) return res.status(400).json({ message: "Başlıq daxil edin" });
    a.title = title;
  }
  if (req.body.description !== undefined) a.description = String(req.body.description).trim();
  if (req.body.allowLate !== undefined) a.allowLate = String(req.body.allowLate) !== "false";
  if (req.body.dueAt !== undefined) {
    if (!req.body.dueAt) a.dueAt = null;
    else {
      const d = new Date(req.body.dueAt);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "Son tarix yanlışdır" });
      a.dueAt = d;
    }
  }
  if (req.body.maxPoints !== undefined) {
    if (req.body.maxPoints === "" || req.body.maxPoints === null) a.maxPoints = null;
    else {
      const n = Number(req.body.maxPoints);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: "Maksimal bal yanlışdır" });
      a.maxPoints = n;
    }
  }
  await a.save();
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
});

// POST /api/assignments/:id/submit — student uploads work (multipart, field
// "files", 1..10). A re-submission REPLACES the previous files (one row per
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
  if (existing) {
    const oldFiles = existing.files || [];
    const kept = keepList ? oldFiles.filter((f) => keepList.includes(f.fileName)) : [];
    const combined = [...kept, ...fileDocs];
    if (!combined.length) return fail(400, "Ən azı bir fayl olmalıdır");
    if (combined.length > 10) return fail(400, "Maksimum 10 fayl");

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
      .forEach((f) => cleanup(path.join(ASSIGNMENTS_DIR, f.fileName)));
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
        { $group: { _id: "$assignment", submitted: { $sum: 1 }, graded: { $sum: { $cond: [{ $eq: ["$status", "returned"] }, 1, 0] } } } },
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
  return sendStored(res, meta, req.query.download === "1");
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

  const meta = (s.files || []).find((f) => f.fileName === req.params.fileName);
  if (!meta) return res.status(404).json({ message: "Fayl tapılmadı" });
  return sendStored(res, meta, req.query.download === "1");
});

// Stream a stored file after the caller has been authorised. Inline by default
// (so images/PDF render in-app); `download` forces a save with the real name.
function sendStored(res, meta, download) {
  const abs = path.join(ASSIGNMENTS_DIR, meta.fileName);
  // Defensive: never let a crafted fileName escape the assignments dir.
  if (!abs.startsWith(ASSIGNMENTS_DIR) || !fs.existsSync(abs)) {
    return res.status(404).json({ message: "Fayl tapılmadı" });
  }
  if (download) {
    const safeName = String(meta.originalName || meta.fileName).replace(/[\\/:*?"<>|]+/g, "_");
    return res.download(abs, safeName);
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
  listAssignments,
  myAssignments,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  getSubmissions,
  gradeSubmission,
  submitAssignment,
  getAttachmentFile,
  getSubmissionFile,
  isManagerRole,
};
