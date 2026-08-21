const asyncHandler = require("express-async-handler");
const Exam = require("../models/examModel");
const PDF = require("../models/pdfModel");
const Tag = require("../models/tagModel");
const Class = require("../models/classModel");
const Question = require("../models/questionModel");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const ExamVersion = require("../models/examVersionModel");
const User = require("../models/userModel");
const Enrollment = require("../models/enrollmentModel");
const { notifyExamStarted, notifyExamFinished } = require("../helper/telegram");
const { notifyStudentsNewExam } = require("../helper/whatsapp");
const { PRESETS } = require("../helper/examPresets");
const { publishExam, resolveActiveVersionForStart, verifyIntegrity, VersionIntegrityError } = require("../helper/examVersion");
const { computePointsPlan } = require("../helper/scoring");
const { assertUnderClassCap, consumeExamCreate } = require("../helper/planLimits");
const mongoose = require("mongoose");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { httpError } = require("../utils/appError");
const { withMongoTransaction } = require("../services/mongoUnitOfWork");
const { pageLimit, withCursor, pageResult, wantsEnvelope } = require("../utils/cursorPagination");
const {
  archiveClass: archiveClassLifecycle,
  archiveTag: archiveTagLifecycle,
} = require("../services/entityLifecycle");

// CR-037: a stable hash of an autosave answers payload, so a duplicate (same
// revision + requestId) is only acknowledged when the BODY is identical too.
const stableStringifyAns = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringifyAns).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringifyAns(v[k])).join(",") + "}";
};
function autosavePayloadHash(answers) {
  return crypto.createHash("sha256").update(stableStringifyAns(answers || [])).digest("hex");
}
const fs = require("fs");
const path = require("path");
// Payments (Stripe) removed — every exam is free. Price is enforced to 0 on
// create/edit, and the old purchase-callback params are refused in addExamToUser.

// Delete a LEGACY server-hosted PDF file (referenced by an old /uploads/<name>
// URL) from disk. No-op for remote (Cloudinary) URLs. CR-067: the physical dir
// is the CONFIGURED staging/uploads dir, not a hard-coded "uploads/".
function deleteLocalPdf(pdfUrl) {
  if (!pdfUrl || typeof pdfUrl !== "string") return;
  const marker = "/uploads/";
  const i = pdfUrl.indexOf(marker);
  if (i === -1) return;
  const name = path.basename(pdfUrl.slice(i + marker.length).split(/[?#]/)[0]);
  const abs = name && stagingPathFor(name);
  if (abs) fs.unlink(abs, () => {});
}

// ---- visibility scoping -----------------------------------------------------
// Categories/classes/exams are owned by the teacher who created them. Teachers
// see only their own; students see only what their APPROVED class enrollments
// expose; admins see everything. Every list/read endpoint funnels through these.

// AUD-005: "staff" capability is the admin role OR an APPROVED teacher — NEVER
// the bare teacher role. A teacher awaiting approval (pending / none) is not
// staff, so on shared and student-facing surfaces (start-attempt gating, result
// visibility, review authorization) they receive NO elevated access. Capability
// is derived from the persisted approval state, mirroring the route-level
// teacherOnly gate in authMiddleware (kept local to avoid a circular import).
const APPROVED_TEACHER_STATES = new Set(["approved", "approved_legacy"]);
const isStaffUser = (u) => !!u && (u.role === "admin" || (u.role === "teacher" && APPROVED_TEACHER_STATES.has(u.teacherApproval)));
const isAdminUser = (u) => !!u && u.role === "admin";

// May this user MUTATE (edit/delete) this doc? admin → yes; otherwise only the
// owner. Legacy docs with no owner stay editable by any teacher during the
// ownership transition (there's no recorded creator to check against).
function ownsOrAdmin(user, doc) {
  if (isAdminUser(user)) return true;
  if (!doc) return false;
  if (!doc.owner) return true; // legacy, ownerless
  return String(doc.owner) === String(user._id);
}

// Archived (trashed) exams are READ-ONLY everywhere except Trash restore /
// permanent-delete. Call after loading the exam in any mutating or attempt
// endpoint: returns true (and writes the response) when the exam is archived,
// so the caller should `return`.
function blockIfArchived(res, exam) {
  if (exam && exam.deletedAt) {
    res
      .status(403)
      .json({ reason: "archived", message: "İmtahan arxivdədir (zibil qutusunda)" });
    return true;
  }
  return false;
}

// A short, unambiguous join code (no easily-confused chars).
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genJoinCode(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
async function uniqueJoinCode() {
  for (let i = 0; i < 8; i++) {
    const code = genJoinCode();
    // eslint-disable-next-line no-await-in-loop
    if (!(await Class.exists({ joinCode: code }))) return code;
  }
  return genJoinCode(8); // extremely unlikely fallback
}

// Class ids the student is APPROVED in (the heart of student visibility).
async function approvedClassIds(userId) {
  const rows = await Enrollment.find({ student: userId, status: "approved" }).select("class").lean();
  return rows.map((r) => r.class);
}

async function studentApprovedInClass(userId, classId) {
  if (!userId || !classId) return false;
  return !!(await Enrollment.exists({ student: userId, class: classId, status: "approved" }));
}

// Public/open classes were removed — every class is code-only now. Kept as a
// constant-false helper so all former "public" branches simply never fire.
const classIsPublic = () => false;

// Public class ids (cheap id-only query) — used to widen student visibility.
async function publicClassIds() {
  return Class.find({ requireCode: false }).distinct("_id");
}

// Can this user see/open a given class doc? admin → yes; otherwise the OWNER
// (a teacher's own class) OR anyone APPROVED-enrolled (a student, or a teacher
// who joined another teacher's class as a participant).
async function canAccessClass(user, classDoc) {
  if (!classDoc) return false;
  if (isAdminUser(user)) return true;
  if (classDoc.owner && String(classDoc.owner) === String(user._id)) return true;
  // Public classes are open to every signed-in user — no enrollment needed.
  if (classIsPublic(classDoc)) return true;
  return studentApprovedInClass(user._id, classDoc._id);
}

// Add Tag
const addTag = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(500);
    throw new Error("Name field required");
  }

  // Categories are per-owner now, so only block a duplicate name WITHIN this
  // teacher's own categories (two teachers may each have a "Riyaziyyat").
  const exists = await Tag.findOne({ name, owner: req.user._id });

  if (exists) {
    res.status(500);
    throw new Error("Tag with this name already exists");
  }

  const tag = await Tag.create({ name, owner: req.user._id });
  res.status(200).json({ name, _id: tag._id });
});

// Add Class
const addClass = asyncHandler(async (req, res) => {
  const { name, level, coverImage } = req.body;

  // Plan gate: block a NEW class once the teacher is at their tier's class cap
  // (grandfathered — existing classes keep working). Thrown 402 propagates via
  // asyncHandler; placed BEFORE the try below, whose catch collapses to a 500.
  await assertUnderClassCap(req.user);

  try {
    // A class needs a label: a text name (preferred) or the legacy numeric level.
    const label = typeof name === "string" ? name.trim() : "";
    if (!label && !level) {
      res.status(400).json({ error: "Sinif adını daxil edin" });
      return;
    }

    // Categories were removed — classes are now top-level (no tag).
    // All classes are CODE-ONLY: a student must enter the joinCode to access.
    // (Public/open classes were removed.)
    const newClass = await Class.create({
      name: label || undefined,
      level: level !== undefined && level !== "" ? level : undefined,
      coverImage: typeof coverImage === "string" ? coverImage.trim() : "",
      owner: req.user._id,
      joinCode: await uniqueJoinCode(),
      requireCode: true,
    });

    res.status(201).json({ message: "Class has been saved", newClass });
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

const getClass = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const _class = await Class.findById(id);

  if (!_class) {
    res.status(404);
    throw new Error("No class found");
  }
  if (!(await canAccessClass(req.user, _class))) {
    res.status(403);
    throw new Error("Bu sinifə giriş yoxdur");
  }
  // Only the owning teacher (or admin) sees the join code.
  const obj = _class.toObject();
  const canSeeCode =
    isAdminUser(req.user) || (_class.owner && String(_class.owner) === String(req.user._id));
  if (!canSeeCode) delete obj.joinCode;
  res.status(200).json(obj);
});

// Get Tags (categories) — scoped to who's asking.
const getTags = asyncHandler(async (req, res) => {
  let filter;
  if (isAdminUser(req.user)) {
    filter = {};
  } else {
    // Own categories OR categories that contain a class the user is enrolled in.
    // (Covers students AND teachers who joined another teacher's class.)
    const classIds = await approvedClassIds(req.user._id);
    const classes = await Class.find({ _id: { $in: classIds } }).select("tag").lean();
    const tagIds = [...new Set(classes.map((c) => c.tag).filter(Boolean).map(String))];
    filter = { $or: [{ owner: req.user._id }, { _id: { $in: tagIds } }] };
  }
  // Do NOT populate exams (that would expose raw exam docs). The category list
  // only needs the tag fields themselves.
  const tags = await Tag.find(filter);
  res.status(200).json(tags || []);
});

// Get a single category — access-checked.
const getTag = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const tag = await Tag.findById(id);

  if (!tag) {
    res.status(404);
    throw new Error("No tag found");
  }

  let allowed = isAdminUser(req.user) || (tag.owner && String(tag.owner) === String(req.user._id));
  if (!allowed) {
    // Not the owner: allowed if approved-enrolled in any class under this category.
    const classIdsInTag = await Class.find({ tag: id }).distinct("_id");
    allowed = !!(await Enrollment.exists({
      student: req.user._id,
      status: "approved",
      class: { $in: classIdsInTag },
    }));
  }
  if (!allowed) {
    res.status(403);
    throw new Error("Bu kateqoriyaya giriş yoxdur");
  }

  res.status(200).json(tag);
});

const addExam = asyncHandler(async (req, res) => {
  const {
    name,
    duration,
    price,
    startDate,
    endDate,
    videoLink,
    totalMarks,
    passingMarks,
    maxTry,
    showScore,
    showCorrectAnswers,
    revealAfterEnd,
    password,
    negativeMarking,
    wrongPerPenalty,
    correctPerPenalty,
    negMarkUntil,
    preset,
    antiCheat,
    partialCredit,
    shuffleOptions,
    shuffleQuestions,
    studentSolutionPhotos,
    coverImage,
    pdf,
    mode,
  } = req.body;
  const { classId } = req.params;

  // "structured" exams have native in-app questions (no PDF). Any other value
  // (or absent) means the legacy PDF flow, which still hard-requires a PDF.
  const isStructured = mode === "structured";

  // Check if all required fields are present
  if (!name || !duration || !totalMarks || !passingMarks || (!isStructured && !pdf)) {
    res
      .status(400)
      .json({ success: false, message: "All fields are required" });
    return;
  }
  try {
    // Ownership FIRST. This used to run after the PDF row was written, so a
    // rejected request still left a PDF document behind for a class the caller
    // did not own.
    const existingClass = await Class.findById(classId);
    if (!existingClass) {
      return res.status(404).json({ success: false, error: "Class not found" });
    }
    // Only the class OWNER (or admin) may add exams into it — otherwise any
    // teacher could plant an exam in someone else's class.
    if (!ownsOrAdmin(req.user, existingClass)) {
      return res.status(403).json({ success: false, error: "Bu sinif sizə aid deyil" });
    }
    const suppliedKey =
      req.get?.("x-idempotency-key") ||
      req.body?.clientMutationId;
    const creationKey =
      typeof suppliedKey === "string" && /^[A-Za-z0-9:_-]{16,128}$/.test(suppliedKey)
        ? suppliedKey
        : process.env.NODE_ENV === "test"
          ? `test:${crypto.randomUUID()}`
          : null;
    if (!creationKey) {
      throw httpError(
        400,
        "idempotency_key_required",
        "A valid idempotency key is required"
      );
    }
    const existingExam = await Exam.findOne({
      owner: req.user._id,
      creationKey,
    }).select("+creationKey");
    if (existingExam) {
      return res.status(200).json({
        success: true,
        idempotent: true,
        data: existingExam,
      });
    }

    // Create a PDF entry only in PDF mode. Structured exams have no PDF doc.
    // AUD-013 CR-069/CR-075: `pdf` is an opaque STAGED-UPLOAD id (from /uploadPdf).
    // Preallocate the exam id and CLAIM the upload BOUND to it atomically for THIS
    // teacher — never accept a raw key or a client path. If exam creation then
    // fails, the claimed upload is deleted so it never strands unattached.
    const newExamId = new mongoose.Types.ObjectId();
    let savedPdf = null;
    if (!isStructured) {
      savedPdf = await claimStagedPdf(pdf, req.user._id, newExamId);
      if (!savedPdf) {
        return res.status(400).json({ success: false, error: "PDF yüklənməsi etibarsızdır və ya artıq istifadə olunub" });
      }
      // CR-079: win the commit intent (claimed → attaching) BEFORE writing the
      // Exam reference. If the janitor already took the row (→ deleting), abort
      // without referencing a PDF that is being deleted.
      if (!(await beginAttach(savedPdf._id, req.user._id, newExamId, savedPdf.opToken))) {
        return res.status(409).json({ success: false, error: "PDF yüklənməsi ləğv olundu — yenidən yükləyin" });
      }
    }

    const examData = {
      _id: newExamId,
      creationKey,
      name,
      duration,
      // Payments removed: price is ALWAYS 0, never the client-supplied value — a
      // forged price in the request body cannot create a paid exam.
      price: 0,
      totalMarks,
      passingMarks,
      maxTry,
      mode: isStructured ? "structured" : "pdf",
      showScore: showScore === "true" || showScore === true,
      showCorrectAnswers: showCorrectAnswers === "true" || showCorrectAnswers === true,
      revealAfterEnd: revealAfterEnd === "true" || revealAfterEnd === true,
      password: typeof password === "string" ? password : "",
      negativeMarking: negativeMarking === "true" || negativeMarking === true,
      wrongPerPenalty: Math.max(1, Number(wrongPerPenalty) || 3),
      correctPerPenalty: Math.max(1, Number(correctPerPenalty) || 1),
      negMarkUntil: Math.max(0, Number(negMarkUntil) || 0),
      preset: typeof preset === "string" && PRESETS[preset] ? preset : "",
      antiCheat: antiCheat === "true" || antiCheat === true,
      partialCredit: partialCredit === "true" || partialCredit === true,
      shuffleOptions: shuffleOptions === "true" || shuffleOptions === true,
      shuffleQuestions: shuffleQuestions === "true" || shuffleQuestions === true,
      studentSolutionPhotos: studentSolutionPhotos === "true" || studentSolutionPhotos === true,
      coverImage: typeof coverImage === "string" ? coverImage : "",
      videoLink,
      startDate,
      endDate,
      class: classId,
      owner: req.user._id,
      // Only PDF exams carry a pdf reference.
      ...(savedPdf ? { pdf: savedPdf._id } : {}),
    };
    let newExam;
    try {
      newExam = await withMongoTransaction(async (session) => {
        const opts = session ? { session } : {};
        // Plan gate: decrement the free tier's lifetime exam-creation allowance
        // (unlimited tiers/admins are a no-op). Inside the transaction so a
        // failed create rolls the decrement back; throws 402 when exhausted.
        await consumeExamCreate(req.user, session);
        const created = await Exam.create([examData], opts);
        const linked = await Class.updateOne(
          { _id: classId },
          { $inc: { examCount: 1 } },
          opts
        );
        if (linked.matchedCount !== 1) {
          throw httpError(409, "class_changed", "Class changed during exam creation");
        }
        if (savedPdf) {
          const attached = await PDF.updateOne(
            {
              _id: savedPdf._id,
              owner: req.user._id,
              examId: newExamId,
              state: "attaching",
              opToken: savedPdf.opToken,
            },
            {
              $set: { state: "attached" },
              $unset: { opToken: "", claimedAt: "", expiresAt: "" },
            },
            opts
          );
          if (attached.matchedCount !== 1) {
            throw httpError(409, "pdf_attach_conflict", "PDF attachment changed");
          }
        }
        return created[0];
      });
    } catch (saveErr) {
      // CR-079/CR-081: the exam did NOT commit — delete the `attaching` upload
      // DURABLY (bytes before row; retain + alert on an fs failure), so it never
      // strands referenced-by-nothing.
      if (savedPdf) await deletePdfDurably(savedPdf._id, ["attaching", "claimed"], "add_failed");
      throw saveErr;
    }

    // Return success response
    res.status(201).json({ success: true, data: newExam });
  } catch (error) {
    throw error;
  }
});

// Store an exam PDF on the server's disk and return its public URL. Used
// instead of Cloudinary so large PDFs aren't blocked by the 10MB limit.
// Older PDF paths were saved as http:// (Express saw the internal request as
// http behind the proxy). An HTTPS page — and especially an installed PWA,
// which has no "load anyway" escape hatch — blocks http subresources as mixed
// content, so the viewer shows "PDF yüklənmədi". Upgrade any non-local http URL
// to https on the way out; this fixes existing exams with no DB migration.
const httpsify = (url) =>
  typeof url === "string" &&
  /^http:\/\//i.test(url) &&
  !/localhost|127\.0\.0\.1/i.test(url)
    ? url.replace(/^http:\/\//i, "https://")
    : url;

const uploadPdf = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error("Fayl tapılmadı");
  }
  // AUD-013 CR-056/CR-057: structurally validate the file (real %PDF- header +
  // %%EOF trailer, not the client MIME) and then MOVE it into PRIVATE random-key
  // storage that is never served statically. The response returns an opaque KEY
  // (as `url` for the existing client contract) — no origin-qualified public URL
  // ever leaves the server, so a leaked link can't bypass exam access.
  // CR-067: read the staged file from the CONFIGURED staging dir (never a
  // hard-coded "uploads/"), so a disposable run stages under an OS-temp dir.
  const src = stagingPathFor(req.file.filename);
  if (!src) {
    res.status(400);
    throw new Error("Fayl tapılmadı");
  }
  const result = await validateUploadFile(src, ".pdf");
  if (!result.ok) {
    try { await fs.promises.unlink(src); } catch { /* best effort */ }
    res.status(400);
    throw new Error("Yalnız PDF fayl yükləyin");
  }
  await ensureDir();
  const key = newKey();
  const dest = pathForKey(key);
  // AUD-013 CR-075: write the DB LOCATOR first (state:"staged", no size/hash yet),
  // THEN move the bytes. A crash during/after the move can then never leave an
  // UNTRACKED private file — the reconciler always finds it by the row. The
  // record is OWNER-BOUND and EXPIRING; its opaque id (never the raw key) is
  // returned, and add/edit must atomically CLAIM it as the same teacher.
  const staged = await PDF.create({
    key,
    owner: req.user._id,
    state: "staged",
    expiresAt: new Date(Date.now() + STAGED_UPLOAD_TTL_MS),
  });
  try {
    const bytes = await fs.promises.readFile(src);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    try {
      await fs.promises.rename(src, dest);
    } catch (e) {
      await fs.promises.copyFile(src, dest); // cross-device (EXDEV)
      await fs.promises.unlink(src).catch(() => {});
    }
    await PDF.updateOne({ _id: staged._id }, { $set: { size: bytes.length, hash } });
  } catch (e) {
    // CR-081: the move failed. Delete any partial bytes DURABLY, dropping the
    // locator ONLY once its bytes are confirmed absent — otherwise leave the
    // staged row for the janitor (its expiry reclaims it) rather than orphaning
    // an undeletable file with no DB record.
    await deletePdfDurably(staged._id, ["staged"], "upload_failed");
    res.status(500);
    throw new Error("Fayl saxlanıla bilmədi");
  }
  res.status(200).json({ url: String(staged._id), uploadId: String(staged._id), filename: req.file.filename });
});

// AUD-013 CR-081: lifecycle timings are BOOT-VALIDATED bounded positive safe
// integers (0/negative/NaN/Infinity/fractional/huge would disable or corrupt
// expiry/recovery). The validator is a pure exported function so it is unit
// tested directly and also runs at module load (fail closed at boot).
const PDF_TIMING_MIN_MS = 1000;                        // 1s
const PDF_TIMING_MAX_MS = 400 * 24 * 60 * 60 * 1000;   // ~400 days
function validatePdfTiming(name, raw, def) {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < PDF_TIMING_MIN_MS || n > PDF_TIMING_MAX_MS) {
    throw new Error(`Invalid ${name}="${raw}" — need an integer in [${PDF_TIMING_MIN_MS}, ${PDF_TIMING_MAX_MS}] ms.`);
  }
  return n;
}
const STAGED_UPLOAD_TTL_MS = validatePdfTiming("STAGED_UPLOAD_TTL_MS", process.env.STAGED_UPLOAD_TTL_MS, 24 * 60 * 60 * 1000);
const CLAIM_RECOVERY_MS = validatePdfTiming("PDF_CLAIM_RECOVERY_MS", process.env.PDF_CLAIM_RECOVERY_MS, 60 * 60 * 1000);
const PDF_LEASE_MS = validatePdfTiming("PDF_LEASE_MS", process.env.PDF_LEASE_MS, 5 * 60 * 1000);

const newToken = () => crypto.randomBytes(24).toString("hex");
const pdfHealthAlert = (event, detail) => { try { console.error(`[SECURITY] ${event}`, detail); } catch { /* never throw from a signal */ } };

// AUD-013 CR-069/CR-075/CR-079: atomically claim a STAGED, owner-matched,
// NON-EXPIRED upload — binding it to the target examId with an unpredictable
// operation token in the SAME CAS. Returns the claimed doc (with opToken) or null.
async function claimStagedPdf(uploadId, ownerId, examId) {
  if (!uploadId || !mongoose.Types.ObjectId.isValid(String(uploadId))) return null;
  // CR-095: the EXACT single-row claim predicate — a staged, owner-matched,
  // non-expired row with NO prior examId/opToken. This is the ONLY write the model
  // guard permits to assign examId.
  return PDF.findOneAndUpdate(
    { _id: uploadId, owner: ownerId, state: "staged", examId: { $exists: false }, opToken: { $exists: false }, expiresAt: { $gt: new Date() } },
    { $set: { state: "claimed", examId, opToken: newToken(), claimedAt: new Date() }, $unset: { expiresAt: "" } },
    { new: true }
  );
}

// CR-079: win the COMMIT INTENT (claimed → attaching) for THIS request's exact
// owner/exam/opToken BEFORE the Exam reference is written. Contends with the
// janitor's `claimed → deleting` on the same state:"claimed" — only one wins. A
// loser (janitor took it, or it expired) returns false and MUST NOT reference it.
async function beginAttach(pdfId, ownerId, examId, opToken) {
  const r = await PDF.findOneAndUpdate(
    { _id: pdfId, owner: ownerId, examId, state: "claimed", opToken },
    { $set: { state: "attaching" } },
    { new: true }
  );
  return !!r;
}

// CR-079/CR-083/CR-091: finish the attach once the Exam durably references the PDF.
// Returns a TYPED result (an idempotent completion is NOT a failure):
//   "attached"         — THIS call won the attaching→attached CAS;
//   "already_attached" — a legitimate concurrent reconciler already completed the
//                        EXACT same row (same _id + owner + examId, state:attached);
//                        an IDEMPOTENT success, never to be rolled back;
//   "conflict"         — the row is missing / deleting / rebound / wrong owner-exam.
// The IMMUTABLE owner + examId binding is preserved on the terminal `attached` row
// (only the transient opToken/claimedAt/expiresAt are cleared).
async function attachPdf(pdfId, ownerId, examId, opToken, session = null) {
  const writeOpts = session ? { session } : {};
  const r = await PDF.updateOne(
    { _id: pdfId, owner: ownerId, examId, state: "attaching", opToken },
    { $set: { state: "attached" }, $unset: { opToken: "", claimedAt: "", expiresAt: "" } },
    writeOpts
  );
  if (r.matchedCount === 1) return "attached";
  const row = await PDF.findById(pdfId).session(session || null);
  if (row && row.state === "attached" && String(row.owner) === String(ownerId) && String(row.examId) === String(examId)) {
    return "already_attached";
  }
  return "conflict";
}
const attachSucceeded = (s) => s === "attached" || s === "already_attached";

// Delete a PDF's exact bytes. CR-081: TYPED result — only success/ENOENT are
// "gone"; any other fs error (EACCES/EBUSY/…) is a RETAINABLE failure so the
// caller never drops the locator while bytes remain. Legacy /uploads paths stay
// best-effort (they are migrated away).
async function deletePdfFile(pdfDoc) {
  if (!pdfDoc) return { gone: true };
  if (pdfDoc.key) {
    const p = pathForKey(pdfDoc.key);
    if (!p) return { gone: true };
    try { await fs.promises.unlink(p); return { gone: true }; }
    catch (e) { if (e.code === "ENOENT") return { gone: true }; return { gone: false, code: e.code || "EIO" }; }
  }
  if (pdfDoc.path) { deleteLocalPdf(pdfDoc.path); return { gone: true }; }
  return { gone: true };
}

// CR-079/CR-081: DURABLE deletion. Win an exact-state `→ deleting` CAS (fencing
// token), delete the bytes, then remove the row ONLY once the exact bytes are
// confirmed absent — and only if the deleteToken still matches. A non-ENOENT fs
// error RETAINS the row (state:"deleting") + emits a health signal for retry, so
// a failed unlink never erases the only locator. Returns a status string.
async function deletePdfDurably(pdfId, fromStates, reason) {
  const deleteToken = newToken();
  const acq = await PDF.findOneAndUpdate(
    { _id: pdfId, state: { $in: fromStates } },
    { $set: { state: "deleting", deleteToken, deletingAt: new Date() }, $unset: { opToken: "" } },
    { new: true }
  );
  if (!acq || acq.deleteToken !== deleteToken) return "not_acquired";
  const r = await deletePdfFile(acq);
  if (!r.gone) { pdfHealthAlert("pdf_delete_retained", { pdfId: String(pdfId), code: r.code, reason }); return "retained"; }
  const del = await PDF.deleteOne({ _id: pdfId, state: "deleting", deleteToken });
  return del.deletedCount === 1 ? "deleted" : "cas_lost";
}

// AUD-013 CR-083: replace an exam's PDF SAFELY under concurrency. Claim + win the
// commit intent, then swap the Exam reference with an EXACT expected-old-reference
// CAS — only ONE of two concurrent replacements can win. The loser durably
// reclaims its OWN new upload so it never strands as an `attached` orphan; the
// winner finishes the attach (immutable owner+examId preserved) and durably
// deletes the now-unreferenced old PDF. Returns { ok, status, pdfId }.
async function replaceExamPdf(examId, uploadId, ownerId, opts = {}) {
  const claimed = await claimStagedPdf(uploadId, ownerId, examId);
  if (!claimed) return { ok: false, status: "invalid_upload" };
  if (!(await beginAttach(claimed._id, ownerId, examId, claimed.opToken))) return { ok: false, status: "claim_cancelled", pdfId: claimed._id };

  // AUD-009: editExam supplies its scalar draft update here. The PDF reference,
  // PDF lifecycle completion, and those fields commit in one Mongo transaction;
  // an aborted transaction leaves the old Exam/PDF pair intact and the claimed
  // upload is reclaimed below. Filesystem removal of the now-unreferenced old
  // bytes is deliberately post-commit and retry-safe.
  if (opts.examUpdate) {
    let oldPdfId = null;
    try {
      oldPdfId = await withMongoTransaction(async (session) => {
        const writeOpts = session ? { session } : {};
        const current = await Exam.findById(examId)
          .select("pdf")
          .session(session || null);
        if (!current) {
          const err = new Error("exam_missing");
          err.operationStatus = "cas_lost";
          throw err;
        }
        const previous = current.pdf || null;
        const expectedRef = previous
          ? { pdf: previous }
          : { $or: [{ pdf: null }, { pdf: { $exists: false } }] };
        const won = await Exam.findOneAndUpdate(
          { _id: examId, purging: { $ne: true }, ...expectedRef },
          { $set: { ...opts.examUpdate, pdf: claimed._id } },
          { new: true, ...writeOpts }
        );
        if (!won) {
          const err = new Error("exam_changed");
          err.operationStatus = "cas_lost";
          throw err;
        }
        const status = await attachPdf(
          claimed._id,
          ownerId,
          examId,
          claimed.opToken,
          session
        );
        if (!attachSucceeded(status)) {
          const err = new Error("pdf_attach_conflict");
          err.operationStatus = "attach_failed";
          throw err;
        }
        return previous;
      });
    } catch (error) {
      await deletePdfDurably(
        claimed._id,
        ["attaching", "claimed", "deleting"],
        "edit_transaction_aborted"
      );
      return {
        ok: false,
        status: error.operationStatus || "transaction_failed",
        pdfId: claimed._id,
      };
    }
    if (oldPdfId && String(oldPdfId) !== String(claimed._id)) {
      await deletePdfDurably(
        oldPdfId,
        ["attached", "attaching", "claimed", "deleting"],
        "replaced"
      );
    }
    return { ok: true, status: "replaced", pdfId: claimed._id };
  }

  const exam = await Exam.findById(examId).select("pdf");
  const oldPdfId = exam && exam.pdf;
  const expectedRef = oldPdfId ? { pdf: oldPdfId } : { $or: [{ pdf: null }, { pdf: { $exists: false } }] };
  // CR-087: the reference CAS ALSO requires the exam not be under a permanent-purge
  // claim (`purging:{$ne:true}`). So ONLY ONE of {this replacement, a competing
  // replacement, a purge} can move the pdf reference: a purge that has fenced the
  // exam makes this fail, and the loser durably reclaims its OWN upload — never
  // stranding a freshly-attached orphan.
  const won = await Exam.findOneAndUpdate(
    { _id: examId, purging: { $ne: true }, ...expectedRef },
    { $set: { pdf: claimed._id } },
    { new: true }
  );
  if (!won) {
    await deletePdfDurably(claimed._id, ["attaching", "claimed"], "replace_cas_lost");
    return { ok: false, status: "cas_lost", pdfId: claimed._id };
  }
  // TEST seam (CR-087): interleave a competing mutation (e.g. a concurrent
  // reconciler completing the attach, or a steal) between the Exam CAS and attachPdf.
  if (opts.__afterExamCas) await opts.__afterExamCas(claimed._id);
  // CR-091: attach completion is TYPED and idempotent. A `conflict` (missing /
  // deleting / rebound) is a genuine failure → roll the Exam reference back under
  // the fence and reclaim our upload, so the exam never references a non-live PDF.
  // An `attached`/`already_attached` (a legitimate concurrent reconciler finished
  // the SAME row) is NOT a failure and is NEVER rolled back.
  const attachStatus = await attachPdf(claimed._id, ownerId, examId, claimed.opToken);
  if (attachStatus === "conflict") {
    await Exam.updateOne(
      { _id: examId, pdf: claimed._id, purging: { $ne: true } },
      oldPdfId ? { $set: { pdf: oldPdfId } } : { $unset: { pdf: "" } }
    );
    await deletePdfDurably(claimed._id, ["attaching", "claimed", "deleting"], "attach_cas_lost");
    return { ok: false, status: "attach_failed", pdfId: claimed._id };
  }
  // CR-091: before reporting replacement success, require the UNFENCED exam to
  // still reference exactly this PDF. If a purge has since claimed the exam (or the
  // reference otherwise moved), do NOT report success and do NOT roll back an
  // idempotently-attached row — let purge finish containment of the exact winner.
  const stillReferenced = await Exam.findOne({ _id: examId, pdf: claimed._id, purging: { $ne: true } }).select("_id");
  if (!stillReferenced) {
    // Purge (or another mutation) owns the exam. Our Exam CAS already swapped the
    // reference OFF the old PDF, so the old PDF is unreferenced regardless — reclaim
    // it as the success path would, and leave the NEW attached PDF for purge to
    // contain. Never roll back an idempotently-attached row.
    if (oldPdfId && String(oldPdfId) !== String(claimed._id)) {
      await deletePdfDurably(oldPdfId, ["attached", "attaching", "claimed", "deleting"], "replaced_superseded");
    }
    return { ok: false, status: "superseded", pdfId: claimed._id };
  }
  if (oldPdfId && String(oldPdfId) !== String(claimed._id)) {
    await deletePdfDurably(oldPdfId, ["attached", "attaching", "claimed", "deleting"], "replaced");
  }
  return { ok: true, status: "replaced", pdfId: claimed._id };
}

// AUD-013 CR-075/CR-079/CR-081: reclaim abandoned uploads DURABLY, never racing a
// live attach. (1) Old `attaching` intents are RECONCILED (exam committed →
// attached) or RETAINED + alerted (never auto-deleted under a cross-collection
// TOCTOU). (2) Expired `staged`, genuinely crashed old `claimed`, and stuck
// `deleting` rows are removed via `deletePdfDurably`, whose exact-state CAS loses
// to a concurrent `beginAttach` — so a row that becomes `attaching`/`attached`
// after classification can never be deleted. (3) Orphan private files with no row
// are swept (counted only after confirmed deletion). `opts.__afterClassify` is a
// TEST seam to inject the exact attach-vs-janitor interleaving.
async function purgeStagedUploads(now = Date.now(), opts = {}) {
  const nowD = new Date(now);
  const claimCutoff = new Date(now - CLAIM_RECOVERY_MS);
  let removed = 0, reconciled = 0, retained = 0, orphanFiles = 0, attachingRetained = 0;

  // 1) Reconcile old `attaching` intents — NEVER auto-delete under uncertainty.
  for (const c of await PDF.find({ state: "attaching", claimedAt: { $lt: claimCutoff } }).select("_id owner examId opToken")) {
    const exam = c.examId ? await Exam.findById(c.examId).select("pdf") : null;
    if (exam && String(exam.pdf) === String(c._id)) { if (attachSucceeded(await attachPdf(c._id, c.owner, c.examId, c.opToken))) reconciled += 1; }
    else { attachingRetained += 1; pdfHealthAlert("pdf_attaching_orphan", { pdfId: String(c._id) }); }
  }

  // Classify deletable candidates (READ), then let a test interleave an attach.
  const staged = await PDF.find({ state: "staged", expiresAt: { $lt: nowD } }).select("_id key state");
  const claimed = await PDF.find({ state: "claimed", claimedAt: { $lt: claimCutoff } }).select("_id key state owner examId opToken");
  const stuck = await PDF.find({ state: "deleting" }).select("_id key state");
  if (opts.__afterClassify) await opts.__afterClassify();

  // 2) A crashed old `claimed` whose exam DID commit the reference (race) is
  //    reconciled, not deleted. Otherwise reclaim it.
  for (const c of claimed) {
    const exam = c.examId ? await Exam.findById(c.examId).select("pdf") : null;
    if (exam && String(exam.pdf) === String(c._id)) {
      if (await beginAttach(c._id, c.owner, c.examId, c.opToken) && attachSucceeded(await attachPdf(c._id, c.owner, c.examId, c.opToken))) reconciled += 1;
    }
  }
  for (const c of [...staged, ...claimed, ...stuck]) {
    const status = await deletePdfDurably(c._id, [c.state], "janitor");
    if (status === "deleted") removed += 1;
    else if (status === "retained") retained += 1;
  }

  // 3) Orphan private FILES with no PDF row — counted only after confirmed absent.
  try {
    for (const n of (await fs.promises.readdir(EXAM_PDF_DIR)).filter((x) => /^[a-f0-9]{64}\.pdf$/.test(x))) {
      const key = n.slice(0, 64);
      if (await PDF.findOne({ key }).select("_id")) continue;
      try { await fs.promises.unlink(pathForKey(key)); orphanFiles += 1; }
      catch (e) { if (e.code === "ENOENT") { /* already gone */ } else { retained += 1; pdfHealthAlert("pdf_orphan_unlink_failed", { key, code: e.code }); } }
    }
  } catch { /* dir absent */ }

  return { removed, reconciled, retained, orphanFiles, attachingRetained };
}

const getPdfByExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;

  if (!examId || !mongoose.isValidObjectId(examId)) {
    throw httpError(404, "exam_not_found", "Exam not found");
  }

  const exam = await Exam.findById(examId);
  if (!exam) throw httpError(404, "exam_not_found", "Exam not found");

  // Only the exam's OWNER (or admin) may fetch the questions PDF freely.
  // Everyone else must have actually started an attempt or hold a result.
  const isOwner = ownsOrAdmin(req.user, exam);
  if (!isOwner) {
    const [hasAttempt, hasResult] = await Promise.all([
      Attempt.countDocuments({ userId: req.user._id, examId, unscorable: { $ne: true } }),
      Result.countDocuments({ userId: req.user._id, examId }),
    ]);
    if (!hasAttempt && !hasResult) {
      throw httpError(403, "pdf_access_denied", "İmtahana giriş yoxdur");
    }
  }

  const pdf = exam.pdf ? await PDF.findById(exam.pdf) : null;
  if (!pdf) throw httpError(404, "pdf_not_found", "PDF not found");

  // Never emit a storage path. A legacy path-only row remains unavailable until
  // the private-storage migration is complete.
  const out = { _id: pdf._id };
  if (pdf.key) out.streamUrl = `/api/quiz/exam/${String(exam._id)}/pdf/stream`;
  res.status(200).json(out);
});

// AUD-013 CR-057 — the AUTHORIZED range-streaming endpoint for a private exam PDF.
// Same authorization as getPdfByExam (owner/admin OR a user who started an attempt
// / holds a result). NO existence leak: a missing exam, missing PDF/file, or a
// denied caller ALL return an identical opaque 404. Serves bytes with correct
// Range/Content-Type/private-cache/nosniff contracts. Credentials never appear in
// the URL — the caller sends the in-memory access token as a header.
const { pathForKey, newKey, ensureDir, isValidKey, stagingPathFor, PDF_STAGING_DIR, EXAM_PDF_DIR } = require("../helper/examPdfStorage");
const { validateUploadFile } = require("../utils/fileValidation");
const streamExamPdf = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const deny = () => {
    throw httpError(404, "pdf_not_found", "PDF not found");
  };
  if (!mongoose.isValidObjectId(examId)) {
    throw httpError(400, "invalid_exam_id", "Invalid exam id");
  }

  const exam = await Exam.findById(examId);
  if (!exam || exam.deletedAt) return deny();

  if (!ownsOrAdmin(req.user, exam)) {
    const [hasAttempt, hasResult] = await Promise.all([
      Attempt.countDocuments({ userId: req.user._id, examId, unscorable: { $ne: true } }),
      Result.countDocuments({ userId: req.user._id, examId }),
    ]);
    if (!hasAttempt && !hasResult) return deny();
  }

  const pdf = exam.pdf ? await PDF.findById(exam.pdf) : null;
  const abs = pdf && pdf.key ? pathForKey(pdf.key) : null;
  if (!abs) return deny();
  let stat;
  try {
    stat = await fs.promises.stat(abs);
  } catch (error) {
    if (error && error.code === "ENOENT") return deny();
    throw httpError(500, "pdf_storage_unavailable", "PDF storage unavailable");
  }

  // AUD-013 CR-090 (TEST-ONLY): an optional per-chunk delay so the E2E can let the
  // mounted pdf.js viewer's MULTI-CHUNK range download stay in flight long enough
  // to inject a stale token mid-load and prove the viewer's OWN range request
  // recovers. Gated on an env var that production never sets.
  const streamDelay = Number(process.env.EXAM_PDF_STREAM_DELAY_MS) || 0;
  if (streamDelay > 0) await new Promise((r) => setTimeout(r, streamDelay));

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Accept-Ranges", "bytes");

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m || (m[1] === "" && m[2] === "")) {
      res.setHeader("Content-Range", `bytes */${stat.size}`);
      throw httpError(416, "invalid_range", "Invalid byte range");
    }
    let start = m[1] === "" ? stat.size - Number(m[2]) : Number(m[1]);
    let end = m[2] === "" || m[1] === "" ? stat.size - 1 : Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || end >= stat.size) {
      res.setHeader("Content-Range", `bytes */${stat.size}`);
      throw httpError(416, "invalid_range", "Invalid byte range");
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", end - start + 1);
    return fs.createReadStream(abs, { start, end }).pipe(res);
  }
  res.status(200);
  res.setHeader("Content-Length", stat.size);
  return fs.createReadStream(abs).pipe(res);
});

// CR-097 / CR-101: `User.exams` is the SOLE CANONICAL acquisition side, read by
// EVERY authorization/listing/start/review/detail path. `Exam.users` is a DERIVED
// reverse index used only for teacher rosters/reporting — never for authorization.
// The sync/pull helpers update it BEST-EFFORT (a failure never blocks or reverses
// the canonical outcome and never affects access); `rebuildExamUsersIndex`
// reconstructs it from the canonical side, so the projection is always repairable.
//
// CR-101: bounded, low-cardinality metrics so a persistently failing projection is
// observable (scraped by the repair CLI / health) without unbounded per-id logging.
const examUsersProjectionMetrics = { addFailures: 0, pullFailures: 0, lastError: null };
function noteProjectionFailure(kind, err) {
  if (kind === "add") examUsersProjectionMetrics.addFailures += 1;
  else examUsersProjectionMetrics.pullFailures += 1;
  examUsersProjectionMetrics.lastError = err && err.message ? err.message : String(err);
  // One bounded warning per failure — no exam/user ids, no payloads.
  console.warn(`[exam-users-projection] ${kind} failed (add=${examUsersProjectionMetrics.addFailures} pull=${examUsersProjectionMetrics.pullFailures}); run scripts/repairExamUsersProjection.js`);
}
async function syncExamUsersReverse(examId, userId) {
  try { await Exam.updateOne({ _id: examId }, { $addToSet: { users: userId } }); return true; }
  catch (err) { noteProjectionFailure("add", err); return false; }
}
async function pullExamUsersReverse(examId, userId) {
  try { await Exam.updateOne({ _id: examId }, { $pull: { users: userId } }); return true; }
  catch (err) { noteProjectionFailure("pull", err); return false; }
}
async function rebuildExamUsersIndex(examId) {
  const holders = await User.find({ exams: examId }).distinct("_id");
  await Exam.updateOne({ _id: examId }, { $set: { users: holders } });
  return holders.length;
}

const addExamToUser = asyncHandler(async (req, res) => {
  const { examId } = req.params;

  // Payments removed: every exam is free and is added directly. A request that
  // still carries the OLD Stripe purchase-callback params (token / session_id /
  // success) is a stale payment redirect — refuse to associate an exam from it,
  // so an old bookmarked/emailed checkout URL can never enrol a student.
  if (req.query.token || req.query.session_id || req.query.success) {
    res.status(410);
    throw new Error("Ödənişli imtahanlar artıq mövcud deyil");
  }

  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }
  if (!examId) {
    res.status(404);
    throw new Error("No Exam found");
  }

  const exam = await Exam.findById(examId);
  // STRIPE-002 / CR-098: "free" is NOT "public". A DELETED (trashed) exam is
  // unavailable to EVERYONE; a HIDDEN (draft) exam may be self-acquired ONLY by its
  // EXACT owner or an admin — an unrelated (even approved) teacher, a pending
  // teacher and a student all get the SAME opaque 404 as a missing exam, so a draft
  // can never be attached by guessing its id and denied/missing are indistinguishable.
  if (!exam || exam.deletedAt || (exam.hidden && !ownsOrAdmin(req.user, exam))) {
    res.status(404);
    throw new Error("No Exam found");
  }

  // CR-097: `User.exams` is the CANONICAL acquisition side — a SINGLE-document
  // atomic `$addToSet`, read by EVERY access/listing path (startAttempt, details,
  // My Exams). `Exam.users` is a DERIVED reverse index, updated best-effort and
  // rebuildable from the canonical side (`rebuildExamUsersIndex`); it is NEVER the
  // source of truth, so a crash/failure after the canonical write can lose only a
  // recoverable projection — never the student's access. `modifiedCount === 0`
  // means this user already owned the exam (duplicate/concurrent → plain 400).
  const added = await User.updateOne(
    { _id: user._id, exams: { $ne: exam._id } },
    { $addToSet: { exams: exam._id } }
  );
  if (added.modifiedCount === 0) {
    await syncExamUsersReverse(exam._id, user._id); // idempotent derived-index repair
    res.status(400);
    throw new Error("Bu imtahan artıq əlavə edilib");
  }
  await syncExamUsersReverse(exam._id, user._id); // derived reverse index (recoverable)

  // Never echo the access password / pdf location back to the student.
  res.status(200).json(sanitizeExamForStudent(exam));
});

const addExamToUserById = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { examId } = req.body;
  const user = await User.findById(userId);
  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }
  if (!examId) {
    res.status(404);
    throw new Error("Exam is not defined");
  }

  const exam = await Exam.findById(examId);

  if (!exam) {
    res.status(404);
    throw new Error("No Exam found");
  }

  // A teacher may only assign an exam THEY OWN, and only to THEIR OWN student
  // (someone approved-enrolled in a class they own). Admin can assign anything.
  // Without this, any teacher account could mutate arbitrary accounts.
  if (req.user.role !== "admin") {
    if (!ownsOrAdmin(req.user, exam)) {
      res.status(403);
      throw new Error("Bu imtahan sizə aid deyil");
    }
    const myClassIds = await Class.find({ owner: req.user._id }).distinct("_id");
    const isMyStudent = await Enrollment.exists({
      class: { $in: myClassIds },
      student: userId,
      status: "approved",
    });
    if (!isMyStudent) {
      res.status(403);
      throw new Error("Bu şagird sizə aid deyil");
    }
  }

  // CR-097: canonical-first, duplicate-safe assignment — the CANONICAL `User.exams`
  // is a single atomic `$addToSet`; `Exam.users` is the derived, repairable reverse
  // index (best-effort). `modifiedCount === 0` means already assigned.
  const added = await User.updateOne(
    { _id: user._id, exams: { $ne: exam._id } },
    { $addToSet: { exams: exam._id } }
  );
  if (added.modifiedCount === 0) {
    await syncExamUsersReverse(exam._id, user._id);
    res.status(500);
    throw new Error("Exam has already been added!");
  }
  await syncExamUsersReverse(exam._id, user._id);
  res.status(200).json({ message: "Exam successfully added" });
});

// Strip ONE correctAnswers[] item down to what a student may see. PDF items
// keep just {type, options} (the letters a/b/c/d). Structured items keep their
// DISPLAY content (text, image(s), latex, choices' text/image/latex) but NEVER
// the answer key: `correct` (the right indices), matching `pairs`, and the
// canonical `answer` string are all dropped. Single source of truth shared by
// every student-facing payload (listing, details, review-when-hidden, the
// /start runner payload) so a leak can't slip in through one path.
// Fisher-Yates shuffle (returns a NEW array, leaves input untouched). Used to
// de-correlate the matching right column so its display order can't reveal the
// correct pairing.
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Build a per-question choice permutation for a shuffled-options attempt:
// { qIndex: perm } where perm[displayPos] = originalChoiceIndex. Only Cm/Cs
// questions with 2+ choices get an entry; returns undefined when nothing to shuffle.
function buildOptionOrder(correctAnswers) {
  const order = {};
  (correctAnswers || []).forEach((q, idx) => {
    if (
      (q.type === "Cm" || q.type === "Cs") &&
      Array.isArray(q.choices) &&
      q.choices.length > 1
    ) {
      order[idx] = shuffled(q.choices.map((_, k) => k));
    }
  });
  return Object.keys(order).length ? order : undefined;
}

// Per-student QUESTION order, BLOCK-SAFE. Returns questionOrder[displayPos] =
// canonicalIndex, or undefined if there's nothing to shuffle. Reading/listening
// passages keep their governed questions grouped and their block boundaries fixed
// (so the runner still pages sections correctly); we only shuffle WITHIN each
// segment — a standalone run of questions, or a passage's governed questions
// (passage itself stays first). For a plain (block-less) exam this is a full shuffle.
function buildQuestionOrder(correctAnswers) {
  const list = Array.isArray(correctAnswers) ? correctAnswers : [];
  const n = list.length;
  if (n < 2) return undefined;
  const isBlock = (it) => !!it && it.type === "reading";
  const isPassage = (it) => isBlock(it) && !it.gapfill;
  const order = [];
  let moved = false;
  const pushShuffled = (indices, keepFirst) => {
    if (keepFirst != null) order.push(keepFirst);
    const sh = shuffled(indices);
    if (sh.some((v, k) => v !== indices[k])) moved = true;
    for (const v of sh) order.push(v);
  };
  let i = 0;
  while (i < n) {
    if (isBlock(list[i])) {
      if (list[i].gapfill) {
        order.push(i);
        i += 1;
        continue;
      }
      const cov = Number(list[i].covers) || 0;
      let q = i + 1;
      let c = 0;
      while (q < n && !isPassage(list[q]) && (cov === 0 || c < cov)) {
        q += 1;
        c += 1;
      }
      const gov = [];
      for (let k = i + 1; k < q; k += 1) gov.push(k);
      pushShuffled(gov, i); // passage first, its questions shuffled
      i = q;
      continue;
    }
    const start = i;
    while (i < n && !isBlock(list[i])) i += 1;
    const run = [];
    for (let k = start; k < i; k += 1) run.push(k);
    pushShuffled(run, null);
  }
  return moved && order.length === n ? order : undefined;
}

function sanitizeQuestionItem(q) {
  const out = { type: q.type };
  // Legacy PDF letters.
  if (q.options !== undefined) out.options = q.options;
  // Structured question content (absent on PDF exams).
  if (q.text !== undefined) out.text = q.text;
  if (q.title !== undefined) out.title = q.title; // reading passage heading
  if (q.kind !== undefined) out.kind = q.kind; // section block kind (reading/listening)
  if (q.audio !== undefined) out.audio = q.audio; // listening-section audio
  if (q.maxPlays !== undefined) out.maxPlays = q.maxPlays; // listening: max times playable
  if (q.allowPause !== undefined) out.allowPause = q.allowPause; // listening: pausable?
  if (q.covers !== undefined) out.covers = q.covers; // questions this block governs
  if (q.blanks !== undefined) out.blanks = q.blanks; // open: number of answer boxes
  if (q.inline) out.inline = true; // inline gap-fill (text already anonymised)
  if (q.gapfill) out.gapfill = true; // gap-fill reading / cloze (scored passage)
  if (q.manualGrade) out.manualGrade = true; // open, teacher-graded (no auto-score)
  if (Array.isArray(q.table)) {
    // "Complete the table": send the grid layout + static cell text, but STRIP
    // every cell's answer key (it lives in blankAnswers, which is never sent).
    out.table = q.table.map((row) =>
      (Array.isArray(row) ? row : []).map((c) => ({
        text: c.text || "",
        blank: !!c.blank,
        colspan: c.colspan || 1,
        rowspan: c.rowspan || 1,
      }))
    );
  }
  if (q.image !== undefined) out.image = q.image;
  if (q.images !== undefined) out.images = q.images;
  if (q.latex !== undefined) out.latex = q.latex;
  if (Array.isArray(q.choices)) {
    out.choices = q.choices.map((c) => ({
      text: c.text,
      image: c.image,
      latex: c.latex,
    }));
  }
  if (Array.isArray(q.pairs)) {
    // Matching: send the LEFT column in order and the RIGHT column SHUFFLED,
    // each side carrying only display content. The correct pairing
    // (pairs[k].left <-> pairs[k].right) is NEVER sent; the server re-derives
    // correctness from the submitted {leftIndex: rightText} map on scoring.
    out.lefts = q.pairs.map((p) => ({ text: p.left, latex: p.leftLatex, image: p.leftImage }));
    out.rights = shuffled(
      q.pairs.map((p) => ({ text: p.right, latex: p.rightLatex, image: p.rightImage }))
    );
  }
  if (q.type === "Cmu") {
    // Correspondence: only the grid SIZES are shown (numbers + letters live in
    // the PDF). The correct mapping (q.key) is NEVER sent.
    out.leftCount = q.leftCount;
    out.rightCount = q.rightCount;
  }
  // NOTE: q.correct, q.pairs, q.key and q.answer are intentionally omitted.
  return out;
}

// Strip an exam down to what a STUDENT may receive: no answer key, no access
// password, no direct PDF location. Used by every student-facing exam payload
// (the class listing and the single-exam fetch) so answers can't be read before
// (or instead of) starting. The PDF is reachable only via the gated route.
function sanitizeExamForStudent(exam) {
  const obj = typeof exam.toObject === "function" ? exam.toObject() : { ...exam };
  if (obj.questions && Array.isArray(obj.questions.correctAnswers)) {
    // Build a NEW questions object so we never mutate a shared/populated doc
    // (a plain {...exam} is only a shallow copy of the top level).
    obj.questions = {
      ...obj.questions,
      correctAnswers: obj.questions.correctAnswers.map(sanitizeQuestionItem),
    };
  }
  delete obj.password;
  delete obj.pdf;
  // The generation prompt can name the answers outright ("düzgün cavab B olsun").
  delete obj.aiPrompt;
  // Solution media reveals the answers — never expose it on a pre-exam payload
  // (listing / details / my-exams). It is shown only in the gated review.
  delete obj.videoLink;
  delete obj.solutionPhotos;
  return obj;
}

const getExamsByClass = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  if (!classId) {
    res.status(404);
    throw new Error("Tag is not defined");
  }

  const exists = await Class.findById(classId);

  if (!exists) {
    res.status(404);
    throw new Error("No Class Found");
  }

  // Visibility gate: owner/admin, or a student approved-enrolled in this class.
  if (!(await canAccessClass(req.user, exists))) {
    res.status(403);
    throw new Error("Bu sinifə giriş yoxdur");
  }

  // No questions populate: the exam-card listing doesn't render any question
  // data, so sending populated question/option arrays per card is wasted payload.
  // Class IS populated (name/level) so the card can show the category chip.
  const exams = await Exam.find({ class: exists._id, deletedAt: null }).populate("class", "name level");

  // Question count per exam for the card stats — a cheap $size aggregation that
  // does NOT load the (heavy) answer arrays.
  const qIds = exams.map((e) => e.questions).filter(Boolean);
  const sizeMap = {};
  if (qIds.length) {
    const sizes = await Question.aggregate([
      { $match: { _id: { $in: qIds } } },
      { $project: { n: { $size: { $ifNull: ["$correctAnswers", []] } } } },
    ]);
    sizes.forEach((s) => (sizeMap[String(s._id)] = s.n));
  }
  const withCount = (obj, exam) => ({
    ...obj,
    questionCount: exam.questions ? sizeMap[String(exam.questions)] || 0 : 0,
  });

  // Only the OWNER (or admin) sees drafts + full data. A participant — student
  // OR a teacher who joined this class — gets the sanitized student view.
  const isOwnerOrAdmin =
    isAdminUser(req.user) || (exists.owner && String(exists.owner) === String(req.user._id));
  if (isOwnerOrAdmin) {
    return res.status(200).json(exams.map((e) => withCount(e.toObject(), e)));
  }
  // Hide drafts AND exams whose author never added questions: a student who
  // opens one only finds out at the start screen, and it makes the class look
  // full of broken exams. It reappears by itself once questions are saved.
  const visible = (exams || [])
    .filter((e) => !e.hidden)
    .map((e) => withCount(sanitizeExamForStudent(e), e))
    .filter((e) => e.questionCount > 0);
  res.status(200).json(visible);
});

// Quick publish/hide toggle for an exam (no other fields touched).
const setExamHidden = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { hidden } = req.body;
  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404);
    throw new Error("İmtahan tapılmadı");
  }
  if (!ownsOrAdmin(req.user, exam)) {
    res.status(403);
    throw new Error("Bu imtahan sizə aid deyil");
  }
  if (blockIfArchived(res, exam)) return;
  exam.hidden = hidden === true || hidden === "true";
  await exam.save();
  // Un-hiding = re-publishing → (re)announce to students even if it was already
  // notified before (force). No-op until WhatsApp is ready / exam has questions.
  if (!exam.hidden) notifyStudentsNewExam(examId, { force: true }).catch(() => {});
  res.status(200).json({
    message: exam.hidden ? "İmtahan gizlədildi" : "İmtahan göstərildi",
    hidden: exam.hidden,
  });
});

const getClassesByTag = asyncHandler(async (req, res) => {
  const { tagId } = req.params;

  if (!tagId) {
    res.status(400).json({ error: "Tag ID is required" });
    return;
  }

  // Ensure the provided tagId is a valid ObjectId
  if (!mongoose.Types.ObjectId.isValid(tagId)) {
    res.status(400).json({ error: "Invalid tag ID" });
    return;
  }

  try {
    let filter = { tag: tagId, deletedAt: null };
    if (!isAdminUser(req.user)) {
      // Own classes OR classes in this tag the user is approved-enrolled in.
      const classIds = await approvedClassIds(req.user._id);
      filter.$or = [{ owner: req.user._id }, { _id: { $in: classIds } }];
    }

    const classes = await Class.find(filter).lean();
    const canManage = (c) =>
      isAdminUser(req.user) || (c.owner && String(c.owner) === String(req.user._id));
    // Only the owning teacher (or admin) keeps the join code per class.
    classes.forEach((c) => {
      if (!canManage(c)) delete c.joinCode;
    });

    // Attach the approved-student count to classes the user manages (for the
    // "N joined" badge on each class card).
    const manageIds = classes.filter(canManage).map((c) => c._id);
    if (manageIds.length) {
      const counts = await Enrollment.aggregate([
        { $match: { class: { $in: manageIds }, status: "approved" } },
        { $group: { _id: "$class", n: { $sum: 1 } } },
      ]);
      const map = {};
      counts.forEach((c) => (map[String(c._id)] = c.n));
      classes.forEach((c) => {
        if (canManage(c)) c.students = map[String(c._id)] || 0;
      });
    }

    res.status(200).json(classes || []);
  } catch (error) {
    console.error("Error fetching classes by tag:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Top-level class listing — the category layer is removed, so classes are
// browsed directly. Admin → all; otherwise the user's OWN classes plus any
// class they are approved-enrolled in. Mirrors getClassesByTag minus the tag.
const getAllClasses = asyncHandler(async (req, res) => {
  // Exclude soft-deleted classes (deleteClass sets deletedAt) — otherwise a
  // deleted class keeps showing in the list and re-deleting it 404s.
  let filter = { deletedAt: null };
  let waitlistedSet = new Set();
  if (!isAdminUser(req.user)) {
    const classIds = await approvedClassIds(req.user._id);
    // Waitlisted (pending) classes: the student SEES them (locked) so they know
    // they're queued until the teacher upgrades.
    const pendingRows = await Enrollment.find({ student: req.user._id, status: "pending" })
      .select("class")
      .lean();
    const pendingIds = pendingRows.map((r) => r.class);
    waitlistedSet = new Set(pendingIds.map(String));
    // Owned, approved-enrolled, waitlisted, OR public (requireCode:false) classes.
    filter = {
      deletedAt: null,
      $or: [
        { owner: req.user._id },
        { _id: { $in: classIds } },
        { _id: { $in: pendingIds } },
        { requireCode: false },
      ],
    };
  }
  const classes = await Class.find(filter).sort({ createdAt: -1 }).lean();
  // Flag the student's waitlisted classes so the UI can lock them.
  if (waitlistedSet.size) {
    classes.forEach((c) => {
      if (waitlistedSet.has(String(c._id))) c.waitlisted = true;
    });
  }
  // ADMIN only: attach the creator's name so the class card can show who made it.
  if (isAdminUser(req.user) && classes.length) {
    const ownerIds = [...new Set(classes.map((c) => String(c.owner)).filter(Boolean))];
    const owners = ownerIds.length ? await User.find({ _id: { $in: ownerIds } }).select("name").lean() : [];
    const nameOf = new Map(owners.map((u) => [String(u._id), u.name]));
    classes.forEach((c) => { c.ownerName = nameOf.get(String(c.owner)) || null; });
  }
  const canManage = (c) =>
    isAdminUser(req.user) || (c.owner && String(c.owner) === String(req.user._id));
  // Only the owning teacher (or admin) keeps the join code per class.
  classes.forEach((c) => {
    if (!canManage(c)) delete c.joinCode;
  });
  const manageIds = classes.filter(canManage).map((c) => c._id);
  if (manageIds.length) {
    // Approved AND pending in one pass — the card shows the roster size and,
    // for the owner, how many requests are still waiting to be let in.
    const counts = await Enrollment.aggregate([
      { $match: { class: { $in: manageIds }, status: { $in: ["approved", "pending"] } } },
      { $group: { _id: { c: "$class", s: "$status" }, n: { $sum: 1 } } },
    ]);
    const approved = {};
    const pending = {};
    counts.forEach((r) => {
      const target = r._id.s === "pending" ? pending : approved;
      target[String(r._id.c)] = r.n;
    });
    classes.forEach((c) => {
      if (!canManage(c)) return;
      c.students = approved[String(c._id)] || 0;
      c.pending = pending[String(c._id)] || 0;
    });
  }

  // Exam count per class for the card. A student's count must match what they
  // will actually find inside, so it excludes hidden exams and ones with no
  // questions yet — the same rule getExamsByClass applies.
  const allIds = classes.map((c) => c._id);
  if (allIds.length) {
    const examCounts = await Exam.aggregate([
      { $match: { class: { $in: allIds }, deletedAt: null } },
      {
        $lookup: {
          from: "questions",
          localField: "questions",
          foreignField: "_id",
          as: "q",
        },
      },
      {
        $project: {
          class: 1,
          hidden: 1,
          n: {
            $size: { $ifNull: [{ $arrayElemAt: ["$q.correctAnswers", 0] }, []] },
          },
        },
      },
      {
        $group: {
          _id: "$class",
          total: { $sum: 1 },
          ready: {
            $sum: {
              $cond: [{ $and: [{ $ne: ["$hidden", true] }, { $gt: ["$n", 0] }] }, 1, 0],
            },
          },
        },
      },
    ]);
    const map = {};
    examCounts.forEach((r) => (map[String(r._id)] = r));
    classes.forEach((c) => {
      const row = map[String(c._id)];
      c.exams = canManage(c) ? row?.total || 0 : row?.ready || 0;
      // Exams a student can actually sit (visible, and with questions in them).
      // The owner sees both numbers: "3 exams, 1 ready" is the difference
      // between a class that works and one that only looks set up.
      if (canManage(c)) c.examsReady = row?.ready || 0;
    });
  }

  res.status(200).json(classes || []);
});

// Used by the teacher "İmtahan nəticələri" list — scoped so a teacher sees only
// their OWN exams (admins see all).
const getExams = asyncHandler(async (req, res) => {
  const filter = { deletedAt: null, ...(isAdminUser(req.user) ? {} : { owner: req.user._id }) };
  const query = req.query || {};
  const limit = pageLimit(query.limit);
  const rows = await Exam.find(withCursor(filter, query.cursor))
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const page = pageResult(rows, limit);
  const exams = page.items;

  // Attach a lightweight result summary per exam so the results listing can show
  // the actual OUTCOME of each exam (score spread, average, pass rate), not just
  // a participant count. One grouped aggregation over all these exams' results;
  // percentages are computed here so the client just renders them. Cheating-
  // flagged (terminated) attempts are excluded from the score spread but still
  // counted as participants.
  if (exams.length) {
    const ids = exams.map((e) => e._id);
    const grouped = await Result.aggregate([
      { $match: { examId: { $in: ids } } },
      { $lookup: { from: "exams", localField: "examId", foreignField: "_id", as: "_exam" } },
      { $unwind: "$_exam" },
      {
        $group: {
          _id: "$examId",
          count: { $sum: 1 },
          graded: { $sum: { $cond: [{ $and: [{ $ne: ["$terminated", true] }, { $ne: ["$earnPoints", null] }] }, 1, 0] } },
          sumPoints: { $sum: { $cond: [{ $and: [{ $ne: ["$terminated", true] }, { $ne: ["$earnPoints", null] }] }, "$earnPoints", 0] } },
          topPoints: { $max: { $cond: [{ $and: [{ $ne: ["$terminated", true] }, { $ne: ["$earnPoints", null] }] }, "$earnPoints", null] } },
          passCount: { $sum: { $cond: [{ $and: [{ $ne: ["$terminated", true] }, { $ne: ["$earnPoints", null] }, { $gte: ["$earnPoints", "$_exam.passingMarks"] }] }, 1, 0] } },
        },
      },
    ]);
    const byExam = new Map(grouped.map((g) => [String(g._id), g]));
    for (const e of exams) {
      const summary = byExam.get(String(e._id)) || {};
      const tm = e.totalMarks || 0;
      const graded = summary.graded || 0;
      e.stats = {
        count: summary.count || 0, // participants (incl. terminated)
        passingPct: tm > 0 ? Math.round(((e.passingMarks || 0) / tm) * 100) : null,
        graded,
        averagePct: graded && tm > 0 ? Math.round(((summary.sumPoints || 0) / graded / tm) * 100) : null,
        topPct: graded && tm > 0 ? Math.round(((summary.topPoints || 0) / tm) * 100) : null,
        passRatePct: graded ? Math.round(((summary.passCount || 0) / graded) * 100) : null,
      };
    }
  }

  res.status(200).json(wantsEnvelope(req) ? page : exams);
});

const getExam = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const exam = await Exam.findById(id).populate("pdf").populate("questions");

  if (!exam) {
    res.status(404);
    throw new Error("No exams found");
  }

  // Owner (or admin) gets the full exam (answer key included — for editing).
  // Legacy exams with no owner stay visible to any teacher during the transition.
  const admin = isAdminUser(req.user);
  const owner =
    (exam.owner && String(exam.owner) === String(req.user._id)) ||
    (!exam.owner && isStaffUser(req.user));

  if (!admin && !owner) {
    // Everyone else — a student OR a teacher who joined this class — needs an
    // approved enrollment or a canonical acquisition, and gets the SANITIZED
    // view (no answer key / password / pdf).
    // CR-101: acquisition is read from the CANONICAL `User.exams` ONLY. The derived
    // `Exam.users` reverse index is NEVER an authorization source — a stale
    // reverse-only reference (canonical list empty) must NOT grant access. Any
    // legitimate legacy reverse-only grant is backfilled into `User.exams` by the
    // canonicalize-exam-acquisition migration before this fallback was removed.
    const ownsCanonical = (req.user.exams || []).some((e) => String(e) === String(id));
    const enrolled = await studentApprovedInClass(req.user._id, exam.class);
    // Public class → any signed-in user may view the (sanitized) exam.
    const classDoc = exam.class
      ? await Class.findById(exam.class).select("requireCode").lean()
      : null;
    if (!ownsCanonical && !enrolled && !classIsPublic(classDoc)) {
      res.status(403);
      throw new Error("Bu imtahana giriş yoxdur");
    }
    return res.status(200).json(sanitizeExamForStudent(exam));
  }

  const obj = exam.toObject();
  // AUD-013 CR-069: never emit a public PDF path at runtime. The editor detects
  // "a PDF exists" from pdf.key; the file is reachable only via the authed stream.
  if (obj.pdf?.path) delete obj.pdf.path;
  res.status(200).json(obj);
});

const addQuestion = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { correctAnswers, questionsPerPage, forwardOnly, typePoints, listeningAudio, aiPrompt } =
    req.body;

  if (!correctAnswers || !examId) {
    res.status(400).json({ message: "All fields are required" });
    return;
  }

  // Light validation for STRUCTURED items (legacy PDF items carry just an
  // `answer` string and skip all of this). A choice question must have options
  // and a marked correct answer; a matching question needs at least two pairs.
  for (const ca of Array.isArray(correctAnswers) ? correctAnswers : []) {
    if (!ca) continue;
    if (ca.type === "Cm" || ca.type === "Cs") {
      if (Array.isArray(ca.choices)) {
        if (!ca.choices.length) {
          return res.status(400).json({ message: "Sual üçün ən azı bir variant lazımdır" });
        }
        if (!Array.isArray(ca.correct) || ca.correct.length === 0) {
          return res.status(400).json({ message: "Düzgün cavab seçilməlidir" });
        }
      }
    } else if (ca.type === "Cma" && Array.isArray(ca.pairs)) {
      if (ca.pairs.length < 2) {
        return res.status(400).json({ message: "Uyğunlaşdırma sualı ən azı 2 cüt tələb edir" });
      }
    } else if (ca.type === "Cmu") {
      const N = Number(ca.leftCount) || 0;
      const M = Number(ca.rightCount) || 0;
      if (N < 2 || M < 2) {
        return res.status(400).json({ message: "Uyğunluq sualı ən azı 2 nömrə və 2 hərf tələb edir" });
      }
      if (!Array.isArray(ca.key) || ca.key.length !== N) {
        return res.status(400).json({ message: "Uyğunluq sualının cavab açarı tam deyil" });
      }
    }
  }

  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404).json({ message: "Exam not found" });
    return;
  }
  if (!ownsOrAdmin(req.user, exam)) {
    return res.status(403).json({ message: "Bu imtahan sizə aid deyil" });
  }
  if (blockIfArchived(res, exam)) return;

  // Listening-section audio (Cloudinary URL) — saved with the questions so the
  // builder/PDF page can attach it after the exam is created. "" clears it.
  const draftSet = {};
  const draftUnset = {};
  if (listeningAudio !== undefined) {
    draftSet.listeningAudio =
      typeof listeningAudio === "string" ? listeningAudio.trim() : "";
  }

  // The AI description the teacher may have edited in the builder. Teacher-only
  // (the student sanitisers strip it) — see the field comment on the model.
  if (aiPrompt !== undefined) {
    draftSet.aiPrompt =
      typeof aiPrompt === "string" ? aiPrompt.trim().slice(0, 4000) : "";
  }

  // Persist the structured per-page layout (0 = show all) alongside the answer
  // key, so saving questions also saves this setting in one round-trip.
  if (questionsPerPage !== undefined || forwardOnly !== undefined || typePoints !== undefined) {
    if (questionsPerPage !== undefined) {
      draftSet.questionsPerPage = Math.max(
        0,
        Math.min(50, Number(questionsPerPage) || 0)
      );
    }
    if (forwardOnly !== undefined) {
      draftSet.forwardOnly = forwardOnly === true || forwardOnly === "true";
    }
    // Manual per-type points override ({Cm:1.56,...}); empty/null clears it back
    // to the preset's automatic scoring.
    if (typePoints !== undefined) {
      const tp =
        typePoints && typeof typePoints === "object" && Object.keys(typePoints).length
          ? Object.fromEntries(
              Object.entries(typePoints)
                .filter(([, v]) => v !== "" && v !== null && !Number.isNaN(Number(v)))
                .map(([k, v]) => [k, Number(v)])
            )
          : undefined;
      if (tp && Object.keys(tp).length) draftSet.typePoints = tp;
      else draftUnset.typePoints = "";
    }
  }

  // AUD-009: save the answer key, draft settings, and Exam→Question pointer as a
  // single transaction. A fault can no longer expose a partially saved draft.
  const wasUpdate = Boolean(exam.questions);
  const newQuestion = await withMongoTransaction(async (session) => {
    const writeOpts = session ? { session } : {};
    let question = exam.questions
      ? await Question.findOneAndUpdate(
          { _id: exam.questions, exam: exam._id },
          { $set: { correctAnswers } },
          { new: true, ...writeOpts }
        )
      : null;

    if (!question) {
      const created = await Question.create(
        [{ correctAnswers, exam: exam._id }],
        writeOpts
      );
      question = created[0];
    }

    const update = { $set: { ...draftSet, questions: question._id } };
    if (Object.keys(draftUnset).length) update.$unset = draftUnset;
    const linked = await Exam.updateOne(
      { _id: exam._id, deletedAt: null },
      update,
      writeOpts
    );
    if (linked.matchedCount !== 1) {
      throw httpError(409, "exam_changed", "Exam changed while saving questions");
    }
    return question;
  });

  // CR-034: first complete save — publish v1 as the active version.
  const pub = await republishExam(examId);
  // Only announce when the publish succeeded (CR-034).
  if (pub.ok) notifyStudentsNewExam(examId).catch(() => {});

  res.status(200).json({
    message: wasUpdate
      ? "Answers updated successfully"
      : "Answers added successfully",
    newQuestion,
    publishState: pub.ok ? "published" : "draft_saved_publish_failed",
  });
});

const getExamTagandClass = asyncHandler(async (req, res) => {
  const { examId } = req.params;

  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404).json({ message: "Exam not found" });
    return;
  }

  const _class = await Class.findById(exam.class);
  if (!_class) {
    res.status(404).json({ message: "Sinif tapilmadi" });
    return;
  }

  // Access gate: the owner/admin, or a student approved-enrolled in this class.
  // Otherwise anyone with an exam id could read the class — including its
  // private join code.
  const isOwner = ownsOrAdmin(req.user, exam);
  if (!isOwner) {
    const enrolled = await studentApprovedInClass(req.user._id, exam.class);
    if (!enrolled) {
      res.status(403).json({ message: "Bu imtahana giriş yoxdur" });
      return;
    }
  }

  // Categories removed — a class may have no tag. Return it as null instead of
  // failing, so review/builders that fetch this context still work.
  const tag = _class.tag ? await Tag.findById(_class.tag) : null;
  // Strip the private join code from non-owners (students don't need it here).
  const classObj = _class.toObject();
  if (!isOwner) delete classObj.joinCode;
  res.status(200).json({ tag, _class: classObj });
});

// Position-based point distribution. The last group's per-question value is
// rounded to 2 decimals (45/7 -> 6.43) and the first 18 questions split
// whatever remains, so every question in a group is worth the same and the
// grand total is exactly 100 (e.g. (100 - 6.43*7)/18 = 3.055 each -> the
// sheet is 3.055*18 + 6.43*7 = 100). For <=18 questions the full 100 is split.
function questionPoints(count) {
  const FIRST = 18;
  const SP = 45;
  const n = Number(count) || 0;
  if (n <= 0) return [];
  const a = Math.min(FIRST, n);
  const b = n - a;
  if (b === 0) return new Array(n).fill(100 / a);
  const secondEach = Math.round((SP / b) * 100) / 100; // 6.43
  const firstEach = (100 - secondEach * b) / a; // 3.055
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = i < a ? firstEach : secondEach;
  return pts;
}

// What a viewer is allowed to see of a result. Teachers/admins see everything.
function resultVisibility(exam, user) {
  if (isStaffUser(user))
    return { canSeeScore: true, canSeeAnswers: true };
  if (!exam) return { canSeeScore: false, canSeeAnswers: false };
  const now = Date.now();
  // The "after end" gate applies only to the correct answers (the part that's
  // sensitive to sharing). The score shows immediately when enabled.
  const afterEndOk =
    !exam.revealAfterEnd || !exam.endDate || now > new Date(exam.endDate).getTime();
  return {
    canSeeScore: exam.showScore !== false,
    canSeeAnswers: exam.showCorrectAnswers === true && afterEndOk,
  };
}

// Strip a result down to what the viewer may see.
function applyResultVisibility(result, vis) {
  const obj = typeof result.toObject === "function" ? result.toObject() : { ...result };
  obj.visibility = vis;
  // Manual grading: the student may see which of their questions are still
  // awaiting a teacher (pendingReview) and, once graded, the verdict + points —
  // but never the internal grader identity. When the score is hidden, hide the
  // provisional manual details with it.
  if (Array.isArray(obj.manualItems)) {
    obj.manualItems = obj.manualItems.map(({ gradedBy, ...rest }) => rest);
  }
  if (!vis.canSeeScore) {
    obj.earnPoints = null;
    obj.correctAnswersByType = null;
    obj.autoEarnPoints = null;
    if (Array.isArray(obj.manualItems)) {
      obj.manualItems = obj.manualItems.map((m) => ({
        index: m.index,
        type: m.type,
        verdict: m.verdict,
      }));
    }
  }
  if (!vis.canSeeAnswers) {
    obj.correctAnswers = null;
    // Per-result solution/feedback photos (teacher-added) also reveal answers —
    // hide them until answers are allowed to be shown.
    obj.photos = [];
  }
  // Sanitize the populated exam (examId): a student never gets the password or
  // pdf location through a result, and solution media + the answer key only once
  // answers are allowed to be revealed.
  const ex = obj.examId;
  if (ex && typeof ex === "object") {
    delete ex.password;
    delete ex.pdf;
    delete ex.aiPrompt;
    if (!vis.canSeeAnswers) {
      delete ex.videoLink;
      ex.solutionPhotos = [];
      if (ex.questions && Array.isArray(ex.questions.correctAnswers)) {
        ex.questions = {
          ...ex.questions,
          correctAnswers: ex.questions.correctAnswers.map(sanitizeQuestionItem),
        };
      }
    }
  }
  return obj;
}

const ATTEMPT_GRACE_MS = 30 * 1000;

// Deploy boundary set by the one-time migration (backfillAttemptId.js). Orphan
// repair that CREATES a missing Result only runs for attempts started after this,
// so legacy attempts (whose Results may lack attemptId) are never touched. Parsed
// and validated fatally at startup (server.js); null here only in dev/pre-migration.
const MIGRATION_TS = process.env.MIGRATION_TS
  ? new Date(process.env.MIGRATION_TS)
  : null;

// Effective deadline for a live attempt: its stored expiry, but never later than
// the exam's CURRENT endDate. So if a teacher shortens endDate while a student
// is mid-exam, the attempt is cut down to the new endDate on resume/status/
// submit (the stored expiresAt was only capped at endDate when it was created).
function effectiveExpiry(attempt, exam) {
  let t = new Date(attempt.expiresAt).getTime();
  if (exam && exam.endDate) t = Math.min(t, new Date(exam.endDate).getTime());
  return t;
}

// Start (or resume) a server-tracked attempt. The server owns the deadline and
// returns the questions WITHOUT the correct answers, so neither the timer nor
// the answer key can be read or tampered with on the client.
const startAttempt = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }
  if (!user.isVerified) return res.status(403).json({ reason: "unverified" });

  const exam = await Exam.findById(examId).populate("questions");
  if (!exam) {
    res.status(404);
    throw new Error("Exam not found");
  }

  const now = Date.now();
  const correctAnswers = exam.questions?.correctAnswers || [];

  // AUD-003: the questions a student sees come from the attempt's BOUND version
  // (frozen at start), so a mid-attempt teacher edit can't change the paper under
  // an in-progress student. A legacy attempt (no version) falls back to the live
  // draft. A brand-new attempt binds to a version equal to the current draft, so
  // its frozen questions match `correctAnswers` exactly.
  // CR-034: load the attempt's BOUND version so the payload derives its questions
  // AND its runner metadata (duration/mode/paging/forward-only) from ONE coherent
  // frozen version — never frozen questions plus live mutable metadata. A dangling
  // non-null pointer is an integrity failure; a legacy attempt (no version) falls
  // back to the live draft.
  const boundVersionFor = async (attempt) => {
    if (attempt.examVersionId) {
      const v = await ExamVersion.findById(attempt.examVersionId).lean();
      if (!v) {
        throw new VersionIntegrityError(
          `bound version ${attempt.examVersionId} missing for attempt ${attempt._id}`,
          "version_missing"
        );
      }
      return v;
    }
    return null;
  };

  const payload = async (attempt) => {
    const order = attempt.optionOrder || null;
    const v = await boundVersionFor(attempt);
    const boundQuestions = v && Array.isArray(v.questions) ? v.questions : correctAnswers;
    const vDisplay = (v && v.display) || {};
    const vMode = v && v.grading ? v.grading.mode : exam.mode;
    return {
      attemptId: attempt._id,
      attemptOrdinal: attempt.attemptOrdinal ?? null,
      // Effective deadline (capped at the exam's CURRENT endDate) so a shortened
      // window takes effect on the client timer immediately on resume.
      expiresAt: new Date(effectiveExpiry(attempt, exam)),
      name: v ? (vDisplay.name || exam.name) : exam.name,
      duration: v ? (vDisplay.duration || 0) : exam.duration,
      // CR-034: anti-cheat mode is FROZEN with the version (a mid-attempt live
      // toggle must not change the runner an in-progress student sees).
      antiCheat: v ? !!vDisplay.antiCheat : !!exam.antiCheat,
      // Server-truth anti-cheat state so a reload/resume restores the real count
      // (it can't be wiped by refreshing or clearing localStorage).
      violations: attempt.violations || 0,
      terminated: !!attempt.terminated,
      // AUD-004 (CR-039): the server-acknowledged autosave revision + the stored
      // answers, so a reload/second-device resume starts the client revision at
      // this FLOOR (never 0) and hydrates the acknowledged answers instead of
      // sending stale low revisions or overwriting saved work with blanks.
      storedRevision: attempt.autosaveRev || 0,
      savedAnswers: Array.isArray(attempt.answers) ? attempt.answers : [],
      // "pdf" or "structured" so the runner knows whether to show the PDF panel
      // or render native questions — FROZEN with the version.
      mode: vMode === "structured" ? "structured" : "pdf",
      // Structured pagination: questions per page (0 = all on one page) — FROZEN.
      questionsPerPage: v ? (vDisplay.questionsPerPage || 0) : (exam.questionsPerPage || 0),
      // Linear mode: the runner hides "back" navigation — FROZEN.
      forwardOnly: v ? !!vDisplay.forwardOnly : !!exam.forwardOnly,
      // When on, the runner shows a per-question "upload solution photo" control — FROZEN.
      studentSolutionPhotos: v ? !!vDisplay.studentSolutionPhotos : !!exam.studentSolutionPhotos,
      // Listening-section audio (mp3 URL) — runner shows a player at the top — FROZEN.
      listeningAudio: v ? (vDisplay.listeningAudio || "") : (exam.listeningAudio || ""),
      // Same sanitizer as every other student payload: display content only, the
      // answer key (`correct`/`pairs`/`answer`) is never sent to the runner. When
      // options are shuffled, reorder each Cm/Cs question's choices by THIS
      // attempt's stored permutation (stable across resumes).
      // Per-student QUESTION order: send the questions in this attempt's display
      // order (block-safe). optionOrder stays keyed by CANONICAL index, so look it
      // up by the canonical index even after reordering. Falls back to canonical
      // order if the stored permutation no longer matches the question count.
      questions: (() => {
        const qOrder =
          Array.isArray(attempt.questionOrder) && attempt.questionOrder.length === boundQuestions.length
            ? attempt.questionOrder
            : boundQuestions.map((_, i) => i);
        return qOrder.map((canonIdx) => {
          const q = boundQuestions[canonIdx];
          const item = sanitizeQuestionItem(q);
          const perm = order && order[canonIdx];
          // Only apply the stored choice permutation when it still aligns with the
          // current choices (a mid-attempt edit that changed the count falls back).
          if (
            Array.isArray(perm) &&
            Array.isArray(item.choices) &&
            perm.length === item.choices.length
          ) {
            item.choices = perm.map((o) => item.choices[o]);
          }
          return item;
        });
      })(),
    };
  };

  // RESUME: a non-expired, unsubmitted attempt is already in progress, so it is
  // returned WITHOUT re-checking the password, window or tries. An attempt only
  // exists because the server created one (after the password, if any), so a
  // resume can't be forged from the client, and the deadline (expiresAt) is
  // unchanged — resuming can never buy extra time or skip the password for a
  // fresh start.
  let attempt = await Attempt.findOne({
    userId: user._id,
    examId,
    submitted: false,
  }).sort({ createdAt: -1 });

  if (attempt) {
    // Crash-orphan repair: a Result already exists but `submitted` never flipped
    // (e.g. a crash after Result.create). Finalize (mark submitted + repair links)
    // and tell the client the attempt is already finished.
    const existingResult = await Result.findOne({ attemptId: attempt._id })
      .select("_id")
      .lean();
    if (existingResult) {
      await finalizeAttempt(attempt, { reason: "resume_result_exists" });
      return res
        .status(200)
        .json({ finished: true, reason: "already_submitted", attemptId: attempt._id });
    }
    if (effectiveExpiry(attempt, exam) > now) {
      return res.status(200).json(await payload(attempt)); // live resume
    }
    // Expired without submitting -> finalize from the autosaved answers (never a
    // bare `submitted:true` with no Result), then fall through to a possible NEW start.
    await finalizeAttempt(attempt, { reason: "expired_resume" });
    attempt = null;
  }

  // ── NEW START gates (only reached when there is NO in-flight attempt) ─────────
  // A legally-started attempt already resumed/finalized above regardless of these,
  // so archival / hidden / ownership changes never strand an in-flight student.
  const isStaff = isStaffUser(user);
  // Archived (trashed) exams can't be freshly started.
  if (exam.deletedAt) return res.status(403).json({ reason: "finished" });
  // Hidden (draft) exams are not accessible to students.
  if (exam.hidden && !isStaff) return res.status(403).json({ reason: "not_started" });
  // Ownership gate: a student must have ACQUIRED the exam (free add or teacher
  // assignment) OR reach it through their class. STRIPE-002: payments are suspended,
  // so EVERY exam is free and access is NEVER gated on the stored `price` — a legacy
  // positive-price row behaves exactly as free (the reconcile migration zeroes it
  // separately). An approved-enrolled student, or one whose class is PUBLIC, has
  // class-free access regardless of price.
  let classFreeAccess = false;
  if (exam.class) {
    if (await studentApprovedInClass(user._id, exam.class)) {
      classFreeAccess = true;
    } else {
      const classDoc = await Class.findById(exam.class).select("requireCode").lean();
      classFreeAccess = classIsPublic(classDoc);
    }
  }
  // CR-097: read the CANONICAL acquisition side (`User.exams`) only — never the
  // derived `Exam.users` reverse index — so access is correct even if the reverse
  // projection is mid-repair after a crash between the two writes.
  const owns =
    user.exams.some((e) => e.toString() === String(examId)) ||
    classFreeAccess;
  if (!isStaff && !owns) return res.status(403).json({ reason: "not_owned" });

  // NEW START from here on: enforce the window, password, questions, max tries.
  if (exam.startDate && new Date(exam.startDate).getTime() > now)
    return res.status(403).json({ reason: "not_started" });
  if (exam.endDate && new Date(exam.endDate).getTime() < now)
    return res.status(403).json({ reason: "finished" });

  // Password gate (server-authoritative): a missing/wrong password means no new
  // attempt and no questions, even via a tampered URL.
  if (exam.password && String(exam.password).length) {
    const provided = (req.body && req.body.password) || "";
    if (!provided) return res.status(403).json({ reason: "password_required" });
    if (String(provided) !== String(exam.password))
      return res.status(403).json({ reason: "password_wrong" });
  }

  // AUD-003 / CR-034: resolve the ACTIVE published version BEFORE any question-content
  // check, then derive every runner-affecting field from that ONE coherent version —
  // never a mix of frozen questions and live mutable metadata. A start landing
  // mid-edit gets the complete previously published version; an exam never published
  // (legacy) is published once from a consistent read; a non-null dangling pointer is
  // a typed integrity failure (thrown).
  const version = await resolveActiveVersionForStart(exam, exam.questions, ExamVersion, Exam);
  const vDisplay = (version && version.display) || {};
  const vGrading = (version && version.grading) || {};
  const vQuestions = (version && Array.isArray(version.questions)) ? version.questions : correctAnswers;

  // CR-034: an exam with no PUBLISHED question content must not be startable. Check
  // the RESOLVED version's questions (not the live draft), so emptying the live
  // draft without publishing never blocks a start on the already-published paper.
  if (!vQuestions.length)
    return res.status(403).json({
      reason: "no_questions",
      message: "Bu imtahana hələ sual əlavə edilməyib. Müəlliminizlə əlaqə saxlayın.",
    });

  // Enforce maxTry (number of started tries; also counts legacy results).
  // Unscorable attempts (deleted exam/user, retired duplicates) never consumed a
  // real try, so they're excluded from the count.
  const [attemptCount, resultCount] = await Promise.all([
    Attempt.countDocuments({ userId: user._id, examId, unscorable: { $ne: true } }),
    Result.countDocuments({ userId: user._id, examId }),
  ]);
  const usedTryCount = Math.max(attemptCount, resultCount);
  const attemptOrdinal = usedTryCount + 1;
  const maxTry = exam.maxTry || 0;

  // A PLAIN re-visit to an already-FINISHED exam (browser BACK, a re-clicked link,
  // a stale bookmark) must NOT silently start a new attempt — that restarts the
  // exam for the student and yanks them out of the teacher's live "finished" list.
  // Only a DELIBERATE start/retake (start:true, set by the Başla button) begins a
  // fresh attempt; otherwise return the finished result so the client shows it.
  const explicitStart = req.body?.start === true || req.body?.start === "true";
  if (!explicitStart && resultCount > 0) {
    const last = await Result.findOne({ userId: user._id, examId })
      .sort({ createdAt: -1 })
      .select("_id attemptId")
      .lean();
    return res.status(200).json({ finished: true, attemptId: last?.attemptId || null });
  }

  if (maxTry > 0 && usedTryCount >= maxTry)
    return res.status(403).json({ reason: "max_tries" });

  const startedAt = new Date(now);
  // The personal duration timer (FROZEN version duration), but never past the
  // exam's CURRENT closing time — endDate is a live access gate (a shortened window
  // must cut in-flight attempts), not a runner-experience field.
  let expMs = now + (vDisplay.duration || 0) * 1000;
  if (exam.endDate) expMs = Math.min(expMs, new Date(exam.endDate).getTime());
  const expiresAt = new Date(expMs);
  // Per-student choice + question shuffle over the FROZEN version's questions/rules.
  const structured = vGrading.mode === "structured";
  const optionOrder =
    vGrading.shuffleOptions && structured ? buildOptionOrder(vQuestions) : undefined;
  // Question shuffle is a DISPLAY setting (answers are de-shuffled to canonical for
  // scoring), so it's read from the LIVE exam — NOT the frozen version — and is
  // never part of the integrity hash. Enabling it takes effect on the next start.
  const questionOrder =
    exam.shuffleQuestions && structured ? buildQuestionOrder(vQuestions) : undefined;
  try {
    attempt = await Attempt.create({
      userId: user._id,
      examId,
      examVersionId: version ? version._id : null,
      startedAt,
      expiresAt,
      attemptOrdinal,
      ...(optionOrder ? { optionOrder } : {}),
      ...(questionOrder ? { questionOrder } : {}),
    });
  } catch (e) {
    // The partial-unique index allows only ONE active (unsubmitted) attempt per
    // user/exam. A concurrent start that lost the race gets the winner's attempt
    // instead of creating a second one (which would defeat maxTry).
    if (e && e.code === 11000) {
      const existing = await Attempt.findOne({
        userId: user._id,
        examId,
        submitted: false,
      }).sort({ createdAt: -1 });
      if (existing) return res.status(200).json(await payload(existing));
    }
    throw e;
  }

  // A brand-new attempt was just created (resume/duplicate paths returned
  // above). Ping the exam owner over Telegram — fire-and-forget so a slow or
  // failed notification never delays/blocks the student's start. Gating (event
  // flag + class/exam scope) lives in the helper / the owner's prefs.
  notifyExamStarted(exam, user);

  return res.status(200).json(await payload(attempt));
});

// A student's standing on an exam (rank + percentile), computed server-side so
// other students' scores/identities are never exposed. Gated by the exam's
// score visibility (teachers/admins always allowed).
const getExamRank = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404);
    throw new Error("Exam not found");
  }
  const user = await User.findById(req.user._id);
  const isStaff = isStaffUser(user);
  const vis = resultVisibility(exam, user);
  if (!isStaff && !vis.canSeeScore) {
    return res.status(200).json({ visible: false });
  }

  const results = await Result.find({ examId }).select("userId earnPoints terminated");
  // Rank by each user's BEST score; terminated (cheating) results are excluded.
  const bestByUser = new Map();
  for (const r of results) {
    if (r.earnPoints == null || r.terminated) continue;
    const uid = r.userId.toString();
    const cur = bestByUser.get(uid);
    if (cur == null || r.earnPoints > cur) bestByUser.set(uid, r.earnPoints);
  }
  const scores = [...bestByUser.values()].sort((a, b) => b - a);
  const total = scores.length;
  const myBest = bestByUser.get(user._id.toString());
  if (myBest == null) {
    return res.status(200).json({ visible: true, participated: false, total });
  }
  const above = scores.filter((s) => s > myBest).length;
  const rank = above + 1;
  const percentile = total > 1 ? Math.round(((total - rank) / (total - 1)) * 100) : 100;
  const average = total ? Math.round((scores.reduce((a, b) => a + b, 0) / total) * 10) / 10 : 0;

  res.status(200).json({
    visible: true,
    participated: true,
    rank,
    total,
    percentile,
    average,
    top: scores[0],
    your: myBest,
  });
});

// Lightweight check used by the details page: is there an exam in progress for
// this user (so "Start" can become "Resume")? Server-truth only.
const attemptStatus = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const qAttemptId = req.query.attemptId || (req.body && req.body.attemptId);
  // Exam may be null (deleted). We still answer for a deleted-exam attempt so the
  // Result page can show the terminal `unscorable` reason.
  const exam = await Exam.findById(examId);

  // Resolve the attempt in scope. When an attemptId is supplied it is STRICTLY
  // pinned (this user's own attempt for this exam); an invalid/foreign id gets a
  // distinct terminal response — never a fallback to "latest" or a broad lookup.
  let attempt = null;
  if (qAttemptId) {
    if (!mongoose.Types.ObjectId.isValid(qAttemptId)) {
      return res
        .status(404)
        .json({ reason: "invalid_attempt", active: false, finished: false, hasResult: false, unscorable: false });
    }
    attempt = await Attempt.findOne({ _id: qAttemptId, userId: req.user._id, examId });
    if (!attempt) {
      return res
        .status(404)
        .json({ reason: "invalid_attempt", active: false, finished: false, hasResult: false, unscorable: false });
    }
  } else {
    // Latest attempt of ANY state, so submitted / unscorable are visible (not just
    // the unsubmitted one).
    attempt = await Attempt.findOne({ userId: req.user._id, examId }).sort({ createdAt: -1 });
  }

  // Does THIS attempt already have its Result? (One indexed query, reused below.)
  let attemptHasResult = false;
  if (attempt) attemptHasResult = !!(await Result.exists({ attemptId: attempt._id }));

  // Crash-orphan repair: an unsubmitted attempt that already has a Result — flip it
  // submitted + repair links immediately (don't wait for expiry), then treat as finished.
  if (attempt && !attempt.submitted && !attempt.unscorable && attemptHasResult) {
    try {
      await finalizeAttempt(attempt, { reason: "status_result_exists" });
    } catch (e) {
      console.error("[STATUS] repair failed", String(attempt._id), e.message);
    }
    attempt.submitted = true;
  }

  const archived = !!(exam && exam.deletedAt);
  const now = Date.now();
  const exp = attempt
    ? exam
      ? effectiveExpiry(attempt, exam)
      : new Date(attempt.expiresAt).getTime()
    : 0;
  const unscorable = !!(attempt && attempt.unscorable);
  const active =
    !archived && !!attempt && !attempt.submitted && !unscorable && exp > now;

  // hasResult: prefer the attemptId-scoped answer for the current attempt; the
  // broad {userId,examId} fallback is used ONLY when there is no attempt context OR
  // the attempt is legacy (pre-MIGRATION_TS, no attemptId-linked Result) — so a
  // multi-try student with an OLD result + a NEWER pending attempt is not falsely
  // reported finished.
  let hasResult = attemptHasResult;
  if (attempt) {
    if (!hasResult) {
      const legacy =
        MIGRATION_TS && attempt.createdAt && new Date(attempt.createdAt) < MIGRATION_TS;
      if (legacy) hasResult = !!(await Result.exists({ userId: req.user._id, examId }));
    }
  } else {
    hasResult = !!(await Result.exists({ userId: req.user._id, examId }));
  }

  const finished =
    !active && (hasResult || unscorable || !!(attempt && attempt.submitted));
  const reason = unscorable ? attempt.unscorableReason || "unscorable" : undefined;

  // Used-try count (details page only) — exclude unscorable attempts (they never
  // consumed a real try).
  const maxTry = exam?.maxTry || 0;
  let used = 0;
  if (req.query.counts && maxTry > 0) {
    const [attemptCount, resultCount] = await Promise.all([
      Attempt.countDocuments({ userId: req.user._id, examId, unscorable: { $ne: true } }),
      Result.countDocuments({ userId: req.user._id, examId }),
    ]);
    used = Math.max(attemptCount, resultCount);
  }

  // Expose the live anti-cheat state so a second device sharing this attempt
  // can mirror the count and finish/redirect when it's terminated elsewhere.
  res.status(200).json({
    active,
    finished,
    hasResult,
    unscorable,
    reason,
    archived,
    expiresAt: active ? new Date(exp) : null,
    violations: attempt ? attempt.violations || 0 : 0,
    terminated: attempt ? !!attempt.terminated : false,
    used,
    maxTry,
  });
});

// Anti-cheat limit, server-side source of truth (mirrors the client constant).
const ANTICHEAT_LIMIT = 3;

// Records ONE anti-cheat violation against the live attempt and returns the
// authoritative count. The server (not the browser) owns the tally and decides
// when the exam is terminated, so editing JS/localStorage or reloading can't
// reduce it. Reporting is the only thing the client controls; once a violation
// reaches here it is permanent.
const reportViolation = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { attemptId } = req.body || {};
  // STRICT attemptId: when supplied it must be this user's own in-flight attempt —
  // never fall back to the "latest active attempt" on an invalid/foreign id.
  let attempt;
  if (attemptId) {
    // Supplied attemptId is STRICT (even if malformed) — never fall back to latest.
    if (
      !mongoose.Types.ObjectId.isValid(attemptId) ||
      !(attempt = await Attempt.findOne({
        _id: attemptId,
        userId: req.user._id,
        examId,
        submitted: false,
      }))
    ) {
      return res.status(409).json({ reason: "invalid_attempt" });
    }
  } else {
    attempt = await Attempt.findOne({
      userId: req.user._id,
      examId,
      submitted: false,
    }).sort({ createdAt: -1 });
    if (!attempt) return res.status(404).json({ reason: "no_active_attempt" });
  }
  // Anti-cheat keeps counting for an in-flight attempt even if the exam was
  // archived mid-attempt (else a student could finish with under-counted
  // violations) — only the deadline gates reports. exam is loaded just for endDate.
  const exam = await Exam.findById(examId).select("endDate").lean();
  if (attempt.unscorable) {
    return res.status(200).json({
      violations: attempt.violations || 0,
      terminated: !!attempt.terminated,
      limit: ANTICHEAT_LIMIT,
    });
  }
  // Ignore reports after the (effective, endDate-capped) deadline.
  if (effectiveExpiry(attempt, exam) + (ATTEMPT_GRACE_MS || 0) < Date.now()) {
    return res.status(200).json({
      violations: attempt.violations || 0,
      terminated: !!attempt.terminated,
      limit: ANTICHEAT_LIMIT,
    });
  }

  attempt.violations = (attempt.violations || 0) + 1;
  if (attempt.violations >= ANTICHEAT_LIMIT) attempt.terminated = true;
  await attempt.save();

  res.status(200).json({
    violations: attempt.violations,
    terminated: attempt.terminated,
    limit: ANTICHEAT_LIMIT,
  });
});

// Trim surrounding whitespace before comparing (a trailing space/newline on a
// typed answer shouldn't mark it wrong). Letters/indices are unaffected.
const norm = (v) => String(v ?? "").trim();
// Open-answer comparison: trim + lowercase + collapse internal whitespace, so
// casing and extra spaces don't fail an otherwise-correct typed answer.
const openNorm = (v) => norm(v).toLowerCase().replace(/\s+/g, " ");

// A second, looser reading of a typed answer, used only after the strict one
// fails. A student who types "6 x + 2" for "6x+2", or a minus sign their
// keyboard produced as U+2212, has answered correctly and should not lose the
// mark to a character they cannot see.
//
// Deliberately NOT normalised: the decimal separator. "2,3" is the pair {2,3}
// in one question and the number 2.3 in another, and guessing between them
// would hand out marks for wrong answers. Whitespace is stripped entirely,
// which is safe for comma-separated lists because the commas survive.
const openLoose = (v) =>
  openNorm(v)
    .replace(/[−‒–—]/g, "-") // unicode minus / dashes
    .replace(/[×⋅·]/g, "*") // × ⋅ ·
    .replace(/[÷]/g, "/")
    .replace(/[  ]/g, "") // non-breaking spaces
    .replace(/\s+/g, "")
    .replace(/[.;]+$/, ""); // a trailing full stop is punctuation, not maths

// Does a typed answer match any of the accepted ones?
const openAccepts = (accepted, typed) => {
  const strict = openNorm(typed);
  if (strict === "") return false;
  const list = (Array.isArray(accepted) ? accepted : [accepted]).filter((x) => x != null);
  if (list.some((ans) => openNorm(ans) === strict)) return true;
  const loose = openLoose(typed);
  return loose !== "" && list.some((ans) => openLoose(ans) === loose);
};

// Does this selection count as a (non-blank) answer? Generalized over the answer
// shapes: a string (letter/typed), a number/index (structured Cm), an array of
// indices (Cs), or a {leftIdx: rightVal} map (Cma). Index 0 must count, so we
// can't use a plain truthiness check.
function isAnswered(sel) {
  if (!sel) return false;
  const a = sel.answer;
  if (a == null) return false;
  if (Array.isArray(a)) return a.length > 0;
  if (typeof a === "object") return Object.keys(a).length > 0;
  return String(a).trim() !== "";
}

// Per-type correctness. The single source of scoring truth, run server-side
// against the answer key the client never received.
// Multi-blank open question: the student's answer is a map { "0": "...", ... }
// and ca.blankAnswers[k] is the list of accepted answers for blank k. Returns
// { graded, correct } over blanks that HAVE a key (blanks with no key are
// ungraded/manual and excluded).
// Blank-scored when there are multiple blanks, OR an inline gap-fill (which may
// have a single blank but is still graded per-blank against blankAnswers).
const isMultiBlank = (ca) =>
  Array.isArray(ca.blankAnswers) && ((Number(ca.blanks) || 0) > 1 || ca.inline || ca.gapfill);
function blankScore(ca, sel) {
  const n = Number(ca.blanks) || 0;
  const a = sel && sel.answer;
  const m = a && typeof a === "object" && !Array.isArray(a) ? a : {};
  const keys = Array.isArray(ca.blankAnswers) ? ca.blankAnswers : [];
  let graded = 0;
  let correct = 0;
  for (let k = 0; k < n; k++) {
    // Same forgiveness as a single-blank open answer — a blank is not stricter
    // just because it sits next to others.
    const acc = (Array.isArray(keys[k]) ? keys[k] : []).filter((x) => norm(x) !== "");
    if (!acc.length) continue;
    graded += 1;
    if (openAccepts(acc, m[k])) correct += 1;
  }
  return { graded, correct };
}

function isCorrectAnswer(ca, sel) {
  if (!isAnswered(sel)) return false;
  const a = sel.answer;
  switch (ca.type) {
    case "Cm": {
      // Structured single-choice (has `choices`): compare the chosen INDEX to
      // the one correct index. Legacy PDF single-choice: compare the LETTER.
      if (Array.isArray(ca.choices) && ca.choices.length) {
        const want = Array.isArray(ca.correct) ? ca.correct[0] : ca.correct;
        return Number(a) === Number(want);
      }
      return norm(a) === norm(ca.answer);
    }
    case "Cs": {
      // Multi-select: set-equality of chosen indices vs the correct set.
      const want = (Array.isArray(ca.correct) ? ca.correct : []).map(Number).sort((x, y) => x - y);
      const got = (Array.isArray(a) ? a : []).map(Number).sort((x, y) => x - y);
      return want.length > 0 && want.length === got.length && want.every((v, k) => v === got[k]);
    }
    case "Cma": {
      // Matching: every left's chosen right must equal the correct right.
      const pairs = Array.isArray(ca.pairs) ? ca.pairs : [];
      if (!pairs.length || typeof a !== "object" || Array.isArray(a)) return false;
      return pairs.every((p, k) => norm(a[k]) === norm(p.right));
    }
    case "Cmu": {
      // Correspondence (numbers -> letters, one-to-many): for EVERY number k the
      // chosen set of letter indices must equal the correct set exactly (no
      // missing/extra, order irrelevant). Letters are reusable, so each number is
      // judged independently. All-or-nothing.
      const key = Array.isArray(ca.key) ? ca.key : [];
      if (!key.length || typeof a !== "object" || Array.isArray(a)) return false;
      const setEq = (x, y) => {
        const xs = (Array.isArray(x) ? x : []).map(Number);
        const ys = (Array.isArray(y) ? y : []).map(Number);
        if (xs.length !== ys.length) return false;
        const s = new Set(xs);
        return ys.every((v) => s.has(v));
      };
      return key.every((correctArr, k) => setEq(a[k], correctArr));
    }
    case "Co":
    case "Cd":
    default: {
      // Multi-blank: ALL graded blanks must be correct (all-or-nothing).
      if (isMultiBlank(ca)) {
        const { graded, correct } = blankScore(ca, { answer: a });
        return graded > 0 && correct === graded;
      }
      // Open/typed: correct if the student's answer matches ANY accepted answer
      // (teachers can list several), compared case-insensitively with collapsed
      // whitespace. Falls back to the single `answer` for legacy questions.
      const accepted =
        Array.isArray(ca.answers) && ca.answers.length ? ca.answers : [ca.answer];
      return openAccepts(accepted, a);
    }
  }
}

// Fractional score (0..1) for one question. 1 = fully correct. When the exam
// enables partial credit, a multi-select (Cs) answer earns
// (correct picks − wrong picks) / (number of correct), floored at 0. Everything
// else is all-or-nothing.
function answerScore(ca, sel, partialCredit) {
  if (!isAnswered(sel)) return 0;
  if (isCorrectAnswer(ca, sel)) return 1;
  if (partialCredit && ca.type === "Cs") {
    const want = new Set((Array.isArray(ca.correct) ? ca.correct : []).map(Number));
    if (!want.size) return 0;
    const got = Array.isArray(sel.answer) ? sel.answer.map(Number) : [];
    const seen = new Set();
    let correctPicked = 0;
    let wrongPicked = 0;
    for (const g of got) {
      if (seen.has(g)) continue; // ignore duplicate picks
      seen.add(g);
      if (want.has(g)) correctPicked += 1;
      else wrongPicked += 1;
    }
    return Math.max(0, (correctPicked - wrongPicked) / want.size);
  }
  return 0;
}

// What to PERSIST for the student's selection. Strings are trimmed (so every
// display surface matches the score); numbers/arrays/maps are stored raw.
function storableAnswer(a) {
  if (a == null) return "";
  if (typeof a === "string") return a.trim();
  return a;
}

// A renderable "correct value" for the review screen. Structured choice
// questions store the correct index/indices; matching stores the right column;
// everything else stores the trimmed answer string.
function renderableCorrect(ca) {
  if (Array.isArray(ca.choices) && ca.choices.length) {
    return Array.isArray(ca.correct) ? ca.correct : [];
  }
  if (ca.type === "Cma" && Array.isArray(ca.pairs)) {
    return ca.pairs.map((p) => p.right);
  }
  if (ca.type === "Cmu" && Array.isArray(ca.key)) {
    return ca.key; // [[idx,…], …] — correct letter indices per number
  }
  // Multi-blank: the accepted answers per blank ([[...], [...]]).
  if (isMultiBlank(ca)) return ca.blankAnswers;
  // Open: show every accepted answer (teacher may list several).
  if (Array.isArray(ca.answers) && ca.answers.length) {
    return ca.answers.map(norm).filter(Boolean).join(" / ");
  }
  return norm(ca.answer);
}

// Result.userId + Result.examId are authoritative. The former mirrored arrays
// made the parent documents grow without bound and are intentionally not
// written anymore (AUD-011).
async function linkResult(examId, userId, resultId) {
  void examId;
  void userId;
  void resultId;
}

// Notify staff of a termination exactly once, gated by the persisted
// terminationNotifiedAt marker. Sets the marker only on a confirmed-successful
// send (notifyExamFinished returns true, incl. the no-recipients no-op). When
// suppressed (migration), still stamp the marker so a later live retry won't alert.
async function markTerminationNotified(result) {
  const at = new Date();
  result.terminationNotifiedAt = at;
  await Result.updateOne({ _id: result._id }, { $set: { terminationNotifiedAt: at } });
}
async function maybeNotifyTermination(exam, user, result, suppress) {
  if (!result.terminated || result.terminationNotifiedAt) return;
  if (suppress) {
    await markTerminationNotified(result);
    return;
  }
  const ok = await notifyExamFinished(exam, user, result);
  if (ok) await markTerminationNotified(result);
}

// Reconcile an already-existing Result for this attempt with a (possibly retried
// or racing) submit: identity assert, MONOTONIC merge (violations never lower,
// termination one-way), ensure the attempt is submitted, repair links, notify.
// Returns the (possibly upgraded) earnPoints. NEVER creates a second Result and
// NEVER changes selectedAnswers/score — an existing Result is authoritative.
async function reconcileExistingResult(existing, exam, user, attempt, opts = {}) {
  const { violations, terminated, suppressNotifications } = opts;
  // Identity ONLY (not current exam access — ownership removal mid-attempt is
  // allowed). Guards against a foreign/guessed attemptId leaking/altering a result.
  if (
    String(existing.userId) !== String(user._id) ||
    String(existing.examId) !== String(exam._id)
  ) {
    throw new Error("attempt_result_identity_mismatch");
  }
  const wantTerminated =
    terminated === true || terminated === "true" || !!attempt.terminated;
  const newViol = Math.max(
    existing.violations || 0,
    Number(violations) || 0,
    attempt.violations || 0
  );
  const set = {};
  if (newViol !== (existing.violations || 0)) {
    set.violations = newViol;
    existing.violations = newViol;
  }
  if (wantTerminated && !existing.terminated) {
    set.terminated = true;
    set.earnPoints = 0;
    existing.terminated = true;
    existing.earnPoints = 0;
  }
  if (Object.keys(set).length)
    await Result.updateOne({ _id: existing._id }, { $set: set });
  await linkResult(exam._id, user._id, existing._id);
  // Ensure the attempt is marked submitted even if a prior run crashed after
  // creating the Result but before flipping submitted (else uniq_active_attempt
  // stays blocked forever though a Result exists).
  await Attempt.updateOne(
    { _id: attempt._id, submitted: false },
    { $set: { submitted: true } }
  );
  await maybeNotifyTermination(exam, user, existing, suppressNotifications);
  return existing.earnPoints;
}

// Score a (already-claimed) attempt's selections and persist the Result. Shared
// by the live client submit (addResult) AND the server-side finalizer, so an
// auto-submitted exam is scored EXACTLY like a hand-submitted one. Idempotent by
// attemptId: a repeat call for an already-scored attempt reconciles the existing
// Result instead of creating a second one.
// AUD-003 — where grading reads its answer key and scoring rules FROM. When the
// attempt is bound to an immutable version, EVERYTHING comes from that frozen
// snapshot, so the official grade is reproducible regardless of later edits. A
// legacy attempt (started before versioning) grades against the live exam and is
// explicitly flagged legacyUnversioned — never silently presented as trustworthy.
async function resolveGradingSource(exam, attempt) {
  // CR-035: a bound version is authoritative and MUST be present + integral. A
  // missing or corrupt bound version is a typed integrity failure — NEVER a silent
  // live-exam fallback (that would let a later edit change the "reproducible" grade).
  if (attempt && attempt.examVersionId) {
    const v = await ExamVersion.findById(attempt.examVersionId).lean();
    if (!v) {
      throw new VersionIntegrityError(
        `bound version ${attempt.examVersionId} is missing for attempt ${attempt._id}`,
        "version_missing"
      );
    }
    const integ = verifyIntegrity(v);
    if (!integ.ok) {
      throw new VersionIntegrityError(
        `bound version ${v._id} failed hash verification (expected ${integ.expected}, got ${integ.actual})`,
        "version_corrupt"
      );
    }
    const g = v.grading || {};
    return {
      legacyUnversioned: false,
      examVersionId: v._id,
      contentHash: v.contentHash || null,
      evaluatorVersion: v.evaluatorVersion || "1",
      // CR-034: the FROZEN solution-photo mode — result photo persistence uses this,
      // never the mutable live exam, so data collected under the bound version isn't
      // silently dropped by a later live toggle.
      studentSolutionPhotos: !!(v.display && v.display.studentSolutionPhotos),
      correct: Array.isArray(v.questions) ? v.questions : [],
      pointsPlan: Array.isArray(v.pointsPlan) ? v.pointsPlan : [],
      negMarkUntil: g.negMarkUntil || 0,
      partialCredit: !!g.partialCredit,
      negativeMarking: !!g.negativeMarking,
      wrongPerPenalty: g.wrongPerPenalty == null ? 3 : g.wrongPerPenalty,
      correctPerPenalty: g.correctPerPenalty == null ? 1 : g.correctPerPenalty,
    };
  }
  // Genuinely legacy attempt (created before versioning, no examVersionId): grade
  // against the live exam, explicitly flagged legacy/untrusted.
  const correct = exam.questions?.correctAnswers || [];
  return {
    legacyUnversioned: true,
    examVersionId: null,
    contentHash: null,
    evaluatorVersion: "1",
    studentSolutionPhotos: !!exam.studentSolutionPhotos, // legacy attempt: live exam
    correct,
    pointsPlan: computePointsPlan(correct, { preset: exam.preset || "", typePoints: exam.typePoints }),
    negMarkUntil: exam.negMarkUntil || 0,
    partialCredit: !!exam.partialCredit,
    negativeMarking: !!exam.negativeMarking,
    wrongPerPenalty: exam.wrongPerPenalty == null ? 3 : exam.wrongPerPenalty,
    correctPerPenalty: exam.correctPerPenalty == null ? 1 : exam.correctPerPenalty,
  };
}

// CR-034: publish the exam's completed draft as the new active immutable version.
// Called at the builder's SAVE commit (addQuestion/editExam) — a single consistent
// re-read of exam+question — so student starts always bind a complete paper, never
// a partially-saved one. Publish failure leaves the previous active version usable.
async function republishExam(examId) {
  const exam = await Exam.findById(examId).populate("questions");
  if (!exam) return { ok: false, reason: "exam_missing" };
  try {
    const version = await publishExam(exam, exam.questions, ExamVersion, Exam);
    // CR-034: publishExam returns null when NOTHING was published (no complete
    // question content). A save that was expected to publish but activated NO
    // version is NOT a success — report it so the caller neither notifies students
    // nor claims "published".
    if (!version) return { ok: false, reason: "not_published" };
    // Teacher Journey (flag-gated, best-effort, after the publish COMMITS): award the
    // publish + published-question XP. Never blocks/rolls back publishing.
    try { Promise.resolve(require("../services/teacherJourneyEvents").onExamPublished(exam.owner, exam._id, version.questions)).catch(() => {}); } catch (_) { /* ignore */ }
    return { ok: true, version };
  } catch (e) {
    // CR-034: do NOT swallow a publish failure. The previous active version stays
    // usable (the pointer only advances on success); the caller reports a typed
    // draft-saved/publish-failed state instead of a bare success.
    console.error("[PUBLISH] failed for exam", String(examId), e && e.message);
    return { ok: false, reason: "publish_failed", error: e && e.message };
  }
}

// CR-035: correctness evaluators keyed by the version's stored evaluatorVersion.
// v1 is the current answerScore semantics; an UNKNOWN version fails closed (a
// version graded by a retired/newer evaluator must not be silently re-scored by
// today's code). Retain past evaluator implementations here as they evolve.
const EVALUATORS = { "1": answerScore };
function resolveEvaluator(evaluatorVersion) {
  const key = evaluatorVersion == null ? "1" : String(evaluatorVersion);
  const fn = EVALUATORS[key];
  if (!fn) {
    throw new VersionIntegrityError(`unknown evaluatorVersion "${key}" — refusing to re-score`, "unknown_evaluator");
  }
  return fn;
}

async function scoreAndCreateResult(exam, user, attempt, selectedAnswers, opts = {}) {
  const { violations, terminated, suppressNotifications, auto } = opts;
  const examId = exam._id;

  // attemptId is the idempotency key — new Results are never created without it.
  if (!attempt || !attempt._id) {
    throw new Error("scoreAndCreateResult: attempt._id is required");
  }
  // An existing Result for this attempt is AUTHORITATIVE and is NEVER overwritten
  // by a later submit — only reconciled (violations/termination merged monotonically).
  // ANTI-CHEAT: a late client submit must NOT be able to replace a server
  // auto-finalized Result. The server cannot distinguish a legitimately-frozen late
  // submit from a deliberate POST-DEADLINE cheat (a direct API call with a known
  // attemptId), and the deadline-cutoff autosave the finalizer already scored is the
  // trustworthy record of the student's answers AT the deadline. So once a Result
  // exists (client or finalizer), its answers/score are frozen.
  const preExisting = await Result.findOne({ attemptId: attempt._id });
  if (preExisting) {
    return reconcileExistingResult(preExisting, exam, user, attempt, opts);
  }

  // AUD-003 / CR-035: score against the BOUND VERSION's frozen key + FROZEN point
  // plan (or the live exam for a genuinely legacy attempt), never whatever the
  // draft currently is. The point plan is frozen at publish so the score is
  // reproducible even if the presets/legacy split later change.
  const src = await resolveGradingSource(exam, attempt);
  const correct = src.correct;
  const points = Array.isArray(src.pointsPlan) ? src.pointsPlan : [];
  // CR-035: dispatch to the evaluator the version was graded with (fail-closed).
  const evaluate = resolveEvaluator(src.evaluatorVersion);
  // Negative marking only penalizes wrong answers in questions 1..until
  // (0 / unset = every question, the legacy behavior).
  const until = src.negMarkUntil > 0 ? Math.min(src.negMarkUntil, correct.length) : correct.length;
  let sel = Array.isArray(selectedAnswers) ? selectedAnswers : [];

  // Per-student QUESTION shuffle: the student answered in DISPLAY order, so map the
  // answers back to CANONICAL order FIRST (questionOrder[displayPos] = canonicalIdx)
  // — everything below (option de-shuffle, scoring, the stored result) is canonical,
  // so scoring and the review are unaffected by the shuffle.
  if (Array.isArray(attempt.questionOrder) && attempt.questionOrder.length) {
    const qperm = attempt.questionOrder;
    const canonical = new Array(correct.length);
    qperm.forEach((canonIdx, dispPos) => {
      if (Number.isInteger(canonIdx) && canonIdx >= 0 && canonIdx < canonical.length) {
        canonical[canonIdx] = sel[dispPos];
      }
    });
    sel = canonical;
  }

  // Per-student option shuffle: map the student's DISPLAY-order picks back to the
  // ORIGINAL choice indices (using this attempt's stored permutation), so scoring
  // and the stored result are always in canonical, unshuffled index space.
  if (attempt.optionOrder) {
    const order = attempt.optionOrder;
    sel = sel.map((a, i) => {
      const perm = order[i];
      if (!a || !Array.isArray(perm)) return a;
      const ca = correct[i];
      if (!ca || (ca.type !== "Cm" && ca.type !== "Cs")) return a;
      if (!Array.isArray(ca.choices) || ca.choices.length !== perm.length) return a;
      const back = (d) => {
        const n = Number(d);
        return Number.isInteger(n) && n >= 0 && n < perm.length ? perm[n] : n;
      };
      if (Array.isArray(a.answer)) return { ...a, answer: a.answer.map(back) };
      if (a.answer === "" || a.answer == null) return a;
      return { ...a, answer: back(a.answer) };
    });
  }

  const counts = { Cm: 0, Cs: 0, Co: 0, Cd: 0, Cma: 0, Cmu: 0 };
  let earnedPoints = 0;
  let wrongCount = 0;
  // Manual grading (MANUAL_GRADING_ENABLED): a question flagged `manualGrade` is
  // NOT auto-scored — it earns 0 now and is recorded as pending so the teacher can
  // grade it by hand later. It never counts as correct and never triggers negative
  // marking. Flag OFF ⇒ manualGrade is ignored and every question auto-grades.
  const manualGradingOn = require("../config/featureFlags").flags.MANUAL_GRADING_ENABLED;
  const manualItems = [];
  correct.forEach((ca, i) => {
    if (manualGradingOn && ca && ca.manualGrade && ca.type !== "reading") {
      const s = sel[i];
      if (isAnswered(s)) {
        manualItems.push({
          index: i,
          type: ca.type,
          verdict: "pending",
          awardedPoints: 0,
          maxPoints: points[i] || 0,
        });
      }
      return;
    }
    const s = sel[i];
    if (!isAnswered(s)) return;
    const frac = evaluate(ca, s, src.partialCredit);
    earnedPoints += (points[i] || 0) * frac;
    if (frac >= 1) {
      if (counts[ca.type] !== undefined) counts[ca.type]++;
    } else if (frac <= 0 && i < until) {
      // Wrong only penalizes inside the negative-marking range; blanks never do.
      wrongCount += 1;
    }
  });
  const hasPendingReview = manualItems.length > 0;

  if (src.negativeMarking && (src.wrongPerPenalty || 0) > 0) {
    // "One correct's worth" = the average points of a question in the penalized
    // range (the closed section for Blok; all questions for legacy 100-pt exams).
    let rangeSum = 0;
    for (let i = 0; i < until; i++) rangeSum += points[i] || 0;
    const avgPerQuestion = until > 0 ? rangeSum / until : 0;
    const units = Math.floor(wrongCount / src.wrongPerPenalty);
    const cancelledCorrects = units * (src.correctPerPenalty || 1);
    earnedPoints = Math.max(0, earnedPoints - cancelledCorrects * avgPerQuestion);
  }
  earnedPoints = Math.round(earnedPoints * 100) / 100;

  const isTerminated =
    !!attempt.terminated || terminated === true || terminated === "true";
  if (isTerminated) earnedPoints = 0;

  const fields = {
    userId: user._id,
    examId,
    // AUD-003: bind the result to the exact grading evidence used (or flag legacy).
    examVersionId: src.examVersionId,
    gradingSnapshotHash: src.contentHash,
    legacyUnversioned: src.legacyUnversioned,
    // AUD-004: the exact autosave revision that was graded (null for legacy /
    // client-submit paths that don't carry a revision).
    gradedRevision: opts.gradedRevision == null ? null : opts.gradedRevision,
    attemptId: attempt._id,
    autoSubmitted: !!auto,
    answeredCount: sel.filter(isAnswered).length,
    attemptOrdinal: attempt.attemptOrdinal ?? null,
    // Compatibility only for consumers not yet migrated. New rows no longer
    // store answered-question count in the misleading legacy field.
    attempts: attempt.attemptOrdinal ?? 1,
    earnPoints: earnedPoints,
    // Manual grading: the score is provisional while any manual question is
    // pending. autoEarnPoints is the immutable auto-graded base the teacher's
    // awarded points are added onto (see the grade endpoint).
    ...(hasPendingReview
      ? { pendingReview: true, autoEarnPoints: earnedPoints, manualItems }
      : {}),
    violations: Math.max(attempt.violations || 0, Number(violations) || 0),
    terminated: isTerminated,
    selectedAnswers: sel.map((a) => ({
      type: a?.type,
      answer: storableAnswer(a?.answer),
      // CR-034: use the FROZEN solution-photo mode (src), never the live exam.
      ...(src.studentSolutionPhotos && typeof a?.photo === "string" && a.photo
        ? { photo: a.photo }
        : {}),
    })),
    correctAnswers: correct.map((a) => ({
      type: a.type,
      ...(a.gapfill ? { gapfill: true } : {}),
      answer: renderableCorrect(a),
    })),
    correctAnswersByType: [
      { type: "Cm", count: counts.Cm },
      { type: "Cs", count: counts.Cs },
      { type: "Co", count: counts.Co },
      { type: "Cd", count: counts.Cd },
      { type: "Cma", count: counts.Cma },
      { type: "Cmu", count: counts.Cmu },
    ],
  };

  // ── CREATE (result-first; a pre-existing Result was already reconciled above) ──
  let newResult;
  try {
    newResult = await Result.create(fields);
  } catch (e) {
    // A concurrent submit / finalizer won the unique attemptId race — reconcile its
    // Result instead of creating a duplicate (never overwrite it).
    if (e && e.code === 11000) {
      const existing = await Result.findOne({ attemptId: attempt._id });
      if (existing) return reconcileExistingResult(existing, exam, user, attempt, opts);
    }
    throw e;
  }

  // Idempotent link + ensure the attempt is flagged submitted (result-first: if a
  // crash lands between here and the caller's submitted flip, the finalizer/repair
  // heals it via the attemptId Result).
  await linkResult(examId, user._id, newResult._id);
  await Attempt.updateOne(
    { _id: attempt._id, submitted: false },
    { $set: { submitted: true } }
  );

  // Teacher Journey (flag-gated, best-effort): a genuine completed attempt by a REAL
  // verified student (never the teacher's own account) awards the exam owner XP.
  try {
    if (user && user.role === "student" && exam.owner && String(user._id) !== String(exam.owner)) {
      Promise.resolve(require("../services/teacherJourneyEvents").onAttemptCompleted(exam.owner, { studentId: user._id, attemptId: attempt._id })).catch(() => {});
    }
  } catch (_) { /* ignore */ }

  // Telegram: normal "finished" alert fires on first creation (unless suppressed
  // by a migration run). If the result was created already terminated, treat the
  // finish alert as the termination alert and stamp terminationNotifiedAt on a
  // confirmed send so a later retry can't re-alert.
  if (!suppressNotifications) {
    const ok = await notifyExamFinished(exam, user, newResult);
    if (isTerminated && ok) await markTerminationNotified(newResult);
  } else if (isTerminated) {
    await markTerminationNotified(newResult);
  }

  return earnedPoints;
}

const addResult = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  // AUD-004: clientRevision is the monotonic revision of the answers the client is
  // submitting — recorded as the graded revision so the review states which one.
  const { selectedAnswers, violations, terminated, attemptId, clientRevision } = req.body;
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }
  if (!examId) {
    res.status(404);
    throw new Error("No Exam found");
  }

  const exam = await Exam.findById(examId).populate("questions");
  if (!exam) {
    res.status(404);
    throw new Error("No Exam found");
  }
  // NOTE: no archived / ownership gate here. A legally-started attempt (looked up
  // below by its own id + owner) must be able to FINALIZE even if the exam was
  // archived / un-assigned mid-attempt — the student's work is never lost. Only
  // NEW starts are gated (startAttempt). We also don't hard-reject on start/endDate:
  // effectiveExpiry + grace is the single deadline source, so a valid submit landing
  // a few seconds late (auto-submit / lag) is still accepted, not silently lost.
  const now = Date.now();

  // Find THIS attempt in ANY submitted state (so a retry after a succeeded-but-lost
  // submit still reconciles idempotently), bound to the owner + exam.
  let attempt = null;
  if (attemptId) {
    // A supplied attemptId (even a malformed one) is STRICT — never fall back to
    // the "latest attempt". Reject distinctly so the client treats it as fatal,
    // not "already submitted → success".
    if (
      !mongoose.Types.ObjectId.isValid(attemptId) ||
      !(attempt = await Attempt.findOne({ _id: attemptId, userId: user._id, examId }))
    ) {
      return res
        .status(409)
        .json({ reason: "invalid_attempt", message: "Cəhd tapılmadı" });
    }
  } else {
    // Legacy client without an attemptId: fall back to the newest in-flight attempt.
    console.warn(
      "[addResult] legacy submit without attemptId",
      String(user._id),
      String(examId)
    );
    attempt = await Attempt.findOne({
      userId: user._id,
      examId,
      submitted: false,
    }).sort({ createdAt: -1 });
    if (!attempt) {
      return res
        .status(409)
        .json({ reason: "already_submitted", message: "İmtahan artıq bağlanıb" });
    }
  }

  // Terminal `unscorable` attempt (deleted exam/user, retired duplicate): never
  // score it — return its terminal status so the client routes to the result page.
  if (attempt.unscorable) {
    return res.status(409).json({
      reason: "unscorable",
      unscorableReason: attempt.unscorableReason || null,
      attemptId: attempt._id,
    });
  }

  // WITHIN grace: score the client's submitted answers — a syntactically valid
  // payload is AUTHORITATIVE even if every answer is blank (the student may submit
  // blank); fall back to autosave only for a non-array (corrupt) payload.
  // PAST grace (late): score the SERVER's deadline-cut autosave (attempt.answers),
  // NEVER the late client payload — the finalizer only runs ~60s after the deadline,
  // so without this a forged/manual API submit in the deadline+30s..+60s window could
  // inject post-deadline answers. (And once a Result exists, scoreAndCreateResult
  // reconciles and never overwrites either way.)
  const late = now > effectiveExpiry(attempt, exam) + ATTEMPT_GRACE_MS;
  // CR-038: classify from the attempt's PERSISTED protocol state, NOT the request
  // shape. Once the attempt has accepted a versioned autosave (autosaveProtocol>=1),
  // a missing/malformed revision may NEVER enter the legacy client-wins branch.
  const isVersionedAttempt = (attempt.autosaveProtocol || 0) >= 1;
  const revOmitted = clientRevision === undefined || clientRevision === null;
  // STRICT: only a genuine number is a valid revision — NOT "", false, [], etc.
  // (which Number() would silently coerce to 0). Bounded, non-negative, safe int.
  const revIsValidNumber =
    typeof clientRevision === "number" &&
    Number.isSafeInteger(clientRevision) &&
    clientRevision >= 0 &&
    clientRevision <= 1e9;
  const submittedRevision = revIsValidNumber ? clientRevision : null;

  const clientAnswers = Array.isArray(selectedAnswers)
    ? selectedAnswers.map((a) => ({ type: a?.type, answer: a?.answer, ...(a?.photo ? { photo: a.photo } : {}) }))
    : [];

  // CR-038: BOTH client submit and the finalizer converge on the SAME atomic freeze.
  //  - Late (past deadline+grace): freeze the SERVER autosave (client can't inject).
  //  - Valid numeric revision: the client snapshot wins ONLY when the acknowledged
  //    autosaveRev is NOT newer (comparison IN the atomic filter, absent-safe). A
  //    stale client loses the CAS → the authoritative SERVER snapshot is frozen.
  //  - Legacy last-write-wins client snapshot: permitted ONLY for an attempt that
  //    has NEVER entered the revisioned protocol AND genuinely omitted the revision.
  //  - Any OTHER case (versioned attempt with an omitted/malformed revision, or any
  //    malformed revision): the submit can't be trusted as newer → freeze the
  //    authoritative SERVER snapshot; NEVER grade stale client answers as rev N.
  let fr;
  let refusedStale = false; // true when a versioned/malformed submit was refused
  if (late) {
    fr = await freezeAttempt(attempt._id, { server: true });
  } else if (revIsValidNumber) {
    const won = await Attempt.findOneAndUpdate(
      {
        _id: attempt._id,
        finalizeState: { $ne: "frozen" },
        $or: [{ autosaveRev: { $lte: submittedRevision } }, { autosaveRev: { $exists: false } }],
      },
      { $set: { finalizeState: "frozen", frozenAnswers: clientAnswers, frozenRev: submittedRevision } },
      { new: true }
    );
    fr = won ? { doc: won, wonFreeze: true } : await freezeAttempt(attempt._id, { server: true });
  } else if (!isVersionedAttempt && revOmitted) {
    // ONLY a never-versioned attempt with a genuinely omitted revision. The legacy
    // freeze CAS ITSELF carries the absent-safe `autosaveProtocol < 1` predicate, so
    // a protocol-cutover RACE (an autosave commits protocol 1 / rev N between this
    // controller's stale read and this write) makes the CAS match 0 documents. On a
    // lost CAS we freeze the AUTHORITATIVE server snapshot instead — never the stale
    // client answers with a mislabelled revision.
    const won = await Attempt.findOneAndUpdate(
      {
        _id: attempt._id,
        finalizeState: { $ne: "frozen" },
        $or: [{ autosaveProtocol: { $lt: 1 } }, { autosaveProtocol: { $exists: false } }],
      },
      { $set: { finalizeState: "frozen", frozenAnswers: clientAnswers, frozenRev: null } },
      { new: true }
    );
    if (won) {
      fr = { doc: won, wonFreeze: true };
    } else {
      // Lost the CAS: the attempt became versioned (or was frozen) after our read →
      // grade the authoritative server snapshot and report the loss.
      refusedStale = true;
      fr = await freezeAttempt(attempt._id, { server: true });
    }
  } else {
    // Versioned attempt with an omitted/malformed revision, or any malformed
    // revision on any attempt → refuse the client snapshot; grade the server's.
    refusedStale = true;
    fr = await freezeAttempt(attempt._id, { server: true });
  }
  const frozenDoc = fr.doc || attempt;
  const answers = frozenDoc.frozenAnswers != null ? frozenDoc.frozenAnswers : (frozenDoc.answers || []);
  const gradedRevision = frozenDoc.frozenRev != null ? frozenDoc.frozenRev : (frozenDoc.autosaveRev || 0);

  let earnPoints;
  try {
    earnPoints = await scoreAndCreateResult(exam, user, frozenDoc, answers, {
      violations,
      terminated,
      gradedRevision,
    });
  } catch (e) {
    // CR-035: a bound-version integrity failure must fail CLOSED (never silently
    // grade against the live draft). Surface a typed error; do NOT create a result.
    if (e instanceof VersionIntegrityError) {
      console.error("[SECURITY] version_integrity_grade_blocked", { attemptId: String(attempt._id), code: e.code });
      return res.status(409).json({ reason: "version_integrity", message: "İmtahan versiyası doğrulana bilmədi. Müəlliminizlə əlaqə saxlayın." });
    }
    throw e;
  }

  // Report the ACTUAL graded revision (from the result) so the client can warn when
  // its submitted revision was NOT the one graded — i.e. some answers didn't reach
  // the server before the freeze — instead of a generic success. `lostAnswers` is
  // true when the client submitted a newer revision than what was officially graded.
  const finalResult = await Result.findOne({ attemptId: attempt._id }).select("gradedRevision").lean();
  const officialGraded = finalResult ? finalResult.gradedRevision : gradedRevision;
  // Loss = the client's submitted answers were NOT the ones officially graded:
  // either it submitted a newer revision than what was graded, or a versioned/
  // malformed submit was refused in favour of the authoritative server snapshot.
  const lostAnswers =
    refusedStale ||
    (submittedRevision != null && officialGraded != null && officialGraded < submittedRevision);
  res.status(200).json({
    message: "Result has been saved",
    earnPoints,
    late: late || lostAnswers,
    gradedRevision: officialGraded,
    submittedRevision,
    storedRevision: frozenDoc.autosaveRev || 0,
  });
});

// Periodic autosave of the in-progress selections onto the active attempt, so
// the server can finalize the exam even if the student never submits. Cheap:
// stores the draft only (no scoring). Touches only the owner's OWN live attempt.
const autosaveAttempt = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  // AUD-004: clientRevision is a per-attempt monotonic counter the client bumps on
  // every answer change; requestId identifies a single autosave POST (for retries).
  const { selectedAnswers, attemptId, currentQuestion, answeredCount, clientRevision, requestId } = req.body;
  const serverTime = new Date();
  if (!Array.isArray(selectedAnswers)) {
    return res.status(200).json({ ok: false, outcome: "invalid_payload", serverTime });
  }
  // Find the target attempt. STRICT when attemptId is supplied — never fall back
  // to the "latest active attempt" (which could hide a failed autosave or mutate
  // the wrong attempt). A matching in-flight attempt is allowed to autosave even
  // if the exam was archived / removed mid-attempt (its work must not be lost);
  // ONLY the deadline gates it.
  let attempt;
  if (attemptId) {
    // Supplied attemptId is STRICT (even if malformed) — never fall back to latest.
    if (
      !mongoose.Types.ObjectId.isValid(attemptId) ||
      !(attempt = await Attempt.findOne({
        _id: attemptId,
        userId: req.user._id,
        examId,
        submitted: false,
      }))
    ) {
      return res.status(409).json({ ok: false, outcome: "invalid_attempt", reason: "invalid_attempt", serverTime });
    }
  } else {
    attempt = await Attempt.findOne({
      userId: req.user._id,
      examId,
      submitted: false,
    }).sort({ createdAt: -1 });
    if (!attempt) return res.status(200).json({ ok: false, outcome: "no_attempt", serverTime });
  }
  if (attempt.unscorable) return res.status(409).json({ ok: false, outcome: "unscorable", reason: "unscorable", serverTime });
  // CR-038: once the finalizer has FROZEN the attempt, autosave is closed — the
  // graded snapshot is fixed and must not move.
  if (attempt.finalizeState === "frozen") {
    return res.status(409).json({ ok: false, outcome: "finalized", storedRevision: attempt.autosaveRev || 0, serverTime });
  }
  // STRICT deadline cutoff (NO grace): drop autosaves past the effective deadline
  // so attempt.answers can never contain post-deadline edits (which the late-submit
  // path scores). effectiveExpiry honors a shortened exam.endDate.
  const examDl = await Exam.findById(examId).select("endDate").lean();
  if (Date.now() > effectiveExpiry(attempt, examDl)) {
    return res.status(200).json({ ok: false, outcome: "expired", reason: "expired", storedRevision: attempt.autosaveRev || 0, serverTime });
  }
  const filter = { _id: attempt._id };
  const answers = selectedAnswers.slice(0, 500).map((a) => ({
    type: a?.type,
    answer: a?.answer,
    ...(typeof a?.photo === "string" && a.photo ? { photo: a.photo } : {}),
  }));
  // Live-watch heartbeat: store where the student is + last-seen time so the
  // teacher's live view can show who's writing which question right now.
  // answeredCount is computed SERVER-SIDE from the answers, so progress shows
  // even for older clients that don't send a count; currentQuestion needs the
  // newer client (the answers don't reveal which page is on screen).
  const hasAns = (a) => {
    const v = a?.answer;
    if (v == null) return false;
    if (typeof v === "string") return v.trim() !== "";
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  };
  const set = {
    answers,
    lastSeenAt: new Date(),
    answeredCount: answers.filter(hasAns).length,
  };
  if (Number.isFinite(currentQuestion) && currentQuestion > 0) {
    // Newer client reports the exact page being viewed.
    set.currentQuestion = Math.floor(currentQuestion);
  } else {
    // Older client (no position): approximate with the furthest answered
    // question, so the live view still shows roughly where they are.
    let furthest = 0;
    for (let i = 0; i < answers.length; i++) if (hasAns(answers[i])) furthest = i + 1;
    set.currentQuestion = furthest;
  }

  // ── AUD-004 (CR-037): monotonic-revision acceptance with a protocol cutover ──
  // Legacy client (no revision): last-write-wins ONLY while the attempt is still
  // on the unversioned protocol. Once a versioned save has been accepted
  // (autosaveProtocol >= 1), a stray unversioned write must NEVER replace the
  // tracked answers (mixed old/new client / lost-order delivery).
  if (clientRevision == null) {
    if ((attempt.autosaveProtocol || 0) >= 1) {
      return res.status(200).json({ ok: false, outcome: "protocol_conflict", storedRevision: attempt.autosaveRev || 0, serverTime });
    }
    // Guard on protocol so a versioned save that landed between our read and write
    // is not clobbered (atomic). ABSENT-SAFE: a raw legacy Attempt with no
    // `autosaveProtocol` field must still accept an unversioned save.
    const uu = await Attempt.updateOne(
      {
        _id: attempt._id,
        submitted: false,
        finalizeState: { $ne: "frozen" },
        $or: [{ autosaveProtocol: { $lt: 1 } }, { autosaveProtocol: { $exists: false } }],
      },
      { $set: set }
    );
    if (uu.modifiedCount === 1) {
      return res.status(200).json({ ok: true, outcome: "stored_unversioned", storedRevision: attempt.autosaveRev || 0, serverTime });
    }
    const cur = await Attempt.findById(attempt._id).select("autosaveRev").lean();
    return res.status(200).json({ ok: false, outcome: "protocol_conflict", storedRevision: cur ? cur.autosaveRev || 0 : 0, serverTime });
  }

  // Versioned path: validate the revision as a BOUNDED positive safe integer.
  const rev = Number(clientRevision);
  if (!Number.isSafeInteger(rev) || rev < 1 || rev > 1e9) {
    return res.status(200).json({ ok: false, outcome: "invalid_revision", storedRevision: attempt.autosaveRev || 0, serverTime });
  }
  // CR-037: a versioned save MUST carry a stable, bounded requestId. A missing,
  // blank, or overlong id is REJECTED (never silently truncated into a collision).
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 200) {
    return res.status(200).json({ ok: false, outcome: "invalid_request", storedRevision: attempt.autosaveRev || 0, serverTime });
  }
  const reqId = requestId;
  const payloadHash = autosavePayloadHash(answers);

  // Atomic accept: a strictly-newer revision, OR the FIRST versioned save on a raw
  // legacy Attempt whose `autosaveRev` field is absent ($exists:false). Stamps the
  // protocol cutover + the payload hash so later duplicate checks are body-aware.
  const upd = await Attempt.updateOne(
    {
      _id: attempt._id,
      submitted: false,
      finalizeState: { $ne: "frozen" },
      $or: [{ autosaveRev: { $lt: rev } }, { autosaveRev: { $exists: false } }],
    },
    { $set: { ...set, autosaveRev: rev, lastAutosaveReqId: reqId, lastAutosavePayloadHash: payloadHash, autosaveProtocol: 1 } }
  );
  if (upd.modifiedCount === 1) {
    return res.status(200).json({ ok: true, outcome: "stored", storedRevision: rev, serverTime });
  }

  // Not stored — classify from the fresh state.
  const fresh = await Attempt.findById(attempt._id).select("autosaveRev lastAutosaveReqId lastAutosavePayloadHash submitted").lean();
  const storedRevision = fresh ? fresh.autosaveRev || 0 : attempt.autosaveRev || 0;
  if (rev === storedRevision) {
    // A duplicate is a SUCCESS only when the revision, requestId AND payload hash
    // ALL match (a retried save of the identical body). The same revision/request
    // with a DIFFERENT body is a typed conflict — never a false "duplicate".
    if (fresh && fresh.lastAutosaveReqId === reqId && fresh.lastAutosavePayloadHash === payloadHash) {
      return res.status(200).json({ ok: true, outcome: "duplicate", storedRevision, serverTime });
    }
    return res.status(200).json({ ok: false, outcome: "revision_conflict", storedRevision, serverTime });
  }
  if (rev < storedRevision) {
    return res.status(200).json({ ok: false, outcome: "stale", storedRevision, serverTime });
  }
  // rev > stored but the write didn't apply: the attempt was submitted/closed.
  return res.status(409).json({ ok: false, outcome: "closed", storedRevision, serverTime });
});

// Lightweight live-watch position heartbeat: the runner posts which question is
// on screen (scroll position) every few seconds so the teacher's live view tracks
// where each student is in ~real time. Deliberately does NOT touch answers or the
// autosave revision machinery — it only stamps currentQuestion + lastSeenAt on the
// caller's OWN in-flight attempt. Cheap enough to call frequently.
const heartbeatAttempt = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { attemptId, currentQuestion } = req.body;
  if (!attemptId || !mongoose.Types.ObjectId.isValid(attemptId)) {
    return res.status(200).json({ ok: false });
  }
  const set = { lastSeenAt: new Date() };
  const cq = Number(currentQuestion);
  if (Number.isFinite(cq) && cq > 0) set.currentQuestion = Math.floor(cq);
  await Attempt.updateOne(
    { _id: attemptId, userId: req.user._id, examId, submitted: false },
    { $set: set }
  );
  return res.status(200).json({ ok: true });
});

// Live exam watch (owner/admin only): who is currently writing this exam, which
// question they're on, progress, time, and live violations. The runner pushes a
// heartbeat via autosave; this reads the active attempts.
const LIVE_ACTIVE_MS = 30 * 1000; // heartbeat within 30s → "active"
// GET /api/quiz/live-exams — exams that CURRENTLY have students taking them (an
// unsubmitted, unexpired attempt). Teacher-scoped by ownership; an admin sees all.
// Powers the "Canlı imtahan" overview: one card per live exam → open its monitor.
const getLiveExams = asyncHandler(async (req, res) => {
  const now = Date.now();
  const activeCutoff = new Date(now - 2 * 60 * 1000); // in-progress (not long-expired)
  const writingCutoff = new Date(now - 20 * 1000); // "writing now" = seen in last ~20s
  const grouped = await Attempt.aggregate([
    { $match: { submitted: false, expiresAt: { $gt: activeCutoff } } },
    {
      $group: {
        _id: "$examId",
        activeCount: { $sum: 1 },
        writingCount: { $sum: { $cond: [{ $gt: ["$lastSeenAt", writingCutoff] }, 1, 0] } },
        lastSeenAt: { $max: "$lastSeenAt" },
      },
    },
  ]);
  if (!grouped.length) return res.json({ exams: [] });
  const byExam = new Map(grouped.map((g) => [String(g._id), g]));
  const isAdmin = req.user.role === "admin";
  const filter = { _id: { $in: grouped.map((g) => g._id) }, deletedAt: null };
  if (!isAdmin) filter.owner = req.user._id; // a teacher only monitors their own exams
  const exams = await Exam.find(filter).select("name class owner totalMarks").populate("class", "name").lean();
  const list = exams.map((e) => {
    const g = byExam.get(String(e._id)) || {};
    return {
      examId: e._id,
      name: e.name,
      className: e.class?.name || "",
      totalMarks: e.totalMarks || 0,
      activeCount: g.activeCount || 0,
      writingCount: g.writingCount || 0,
      lastSeenAt: g.lastSeenAt || null,
    };
  });
  // Most actively-written first, then most-recent activity.
  list.sort(
    (a, b) => b.writingCount - a.writingCount || new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0)
  );
  res.json({ exams: list });
});

const getLiveAttempts = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  // Polled every ~2s while a teacher watches, so keep it light: only the fields the
  // live view needs (ownership + name + how many questions), not the full paper.
  const exam = await Exam.findById(examId)
    .select("name owner questions totalMarks antiCheat")
    .populate({ path: "questions", select: "correctAnswers" });
  if (!exam) {
    res.status(404);
    throw new Error("Exam not found");
  }
  if (!ownsOrAdmin(req.user, exam)) {
    return res.status(403).json({ message: "Bu imtahan sizə aid deyil" });
  }
  const correct = exam.questions?.correctAnswers || [];
  const total = correct.length;
  const now = Date.now();
  const FINISHED_WATCH_MS = 12 * 60 * 60 * 1000; // keep finishers on the board a school day

  const buildAnswered = (a) => {
    const ans = a && Array.isArray(a.answers) ? a.answers : [];
    const arr = [];
    for (let i = 0; i < total; i++) arr.push(isAnswered(ans[i]));
    return arr;
  };

  // LIVE per-question correctness ("correct" | "wrong" | "unanswered" | "manual" |
  // "section"), in DISPLAY order so it lines up 1:1 with `answered`. Reuses the exported
  // pure grader `isCorrectAnswer`; best-effort against the LIVE key. Manual-graded
  // questions and reading/listening section blocks are non-auto (never shown red/green).
  const manualGradingOn = require("../config/featureFlags").flags.MANUAL_GRADING_ENABLED;
  const gradeOne = (ca, sel) => {
    if (!ca || ca.type === "reading") return "section";
    if (manualGradingOn && ca.manualGrade) return "manual";
    if (!isAnswered(sel)) return "unanswered";
    return isCorrectAnswer(ca, sel) ? "correct" : "wrong";
  };
  // Must DE-SHUFFLE first: `answers` is display-order, the key is canonical, and each
  // attempt stores its own question/option permutations (same mapping scoreAndCreateResult
  // applies before grading). Without this, every shuffled attempt would grade garbage.
  const buildCorrectness = (a) => {
    const out = new Array(total).fill("unanswered");
    if (!a || !Array.isArray(a.answers) || !total) return out;
    let sel = a.answers;
    const qperm = Array.isArray(a.questionOrder) && a.questionOrder.length ? a.questionOrder : null;
    if (qperm) {
      const canon = new Array(total);
      qperm.forEach((canonIdx, dispPos) => {
        if (Number.isInteger(canonIdx) && canonIdx >= 0 && canonIdx < total) canon[canonIdx] = sel[dispPos];
      });
      sel = canon;
    }
    if (a.optionOrder) {
      const order = a.optionOrder;
      sel = sel.map((ans, i) => {
        const perm = order[i];
        if (!ans || !Array.isArray(perm)) return ans;
        const ca = correct[i];
        if (!ca || (ca.type !== "Cm" && ca.type !== "Cs")) return ans;
        if (!Array.isArray(ca.choices) || ca.choices.length !== perm.length) return ans;
        const back = (d) => {
          const n = Number(d);
          return Number.isInteger(n) && n >= 0 && n < perm.length ? perm[n] : n;
        };
        if (Array.isArray(ans.answer)) return { ...ans, answer: ans.answer.map(back) };
        if (ans.answer === "" || ans.answer == null) return ans;
        return { ...ans, answer: back(ans.answer) };
      });
    }
    const canonGrade = correct.map((ca, i) => gradeOne(ca, sel[i]));
    if (!qperm) return canonGrade;
    qperm.forEach((canonIdx, dispPos) => {
      out[dispPos] =
        Number.isInteger(canonIdx) && canonIdx >= 0 && canonIdx < total ? canonGrade[canonIdx] : "unanswered";
    });
    return out;
  };
  const uid = (u) => String((u && u._id) || u || ""); // works for a populated user OR a raw id

  // ── Active writers: the CURRENT unsubmitted attempts (one per student). ──
  const activeAttempts = await Attempt.find({
    examId,
    submitted: false,
    expiresAt: { $gt: new Date(now - 2 * 60 * 1000) },
  })
    .populate("userId", "name email grade")
    .sort({ lastSeenAt: -1, startedAt: -1 })
    .lean();
  const activeStudents = activeAttempts.map((a) => {
    const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    return {
      attemptId: a._id,
      name: a.userId?.name || "—",
      email: a.userId?.email || "",
      grade: a.userId?.grade || "",
      currentQuestion: a.currentQuestion || 0,
      answered: buildAnswered(a),
      correctness: buildCorrectness(a), // live per-question right/wrong for the teacher
      answeredCount: a.answeredCount || 0,
      total,
      violations: a.violations || 0,
      terminated: !!a.terminated,
      startedAt: a.startedAt,
      expiresAt: a.expiresAt,
      lastSeenAt: a.lastSeenAt || null,
      active: !!seen && now - seen < LIVE_ACTIVE_MS,
      finished: false,
      finishedAt: null,
      score: null,
      resultId: null,
      pendingReview: false,
    };
  });

  // ── Finished: driven by RESULTS, not raw submitted attempts. A student is only
  // "finished" once they have a graded Result — abandoned/superseded attempts (the
  // previous run that gets frozen when a student restarts) have NO Result and must
  // NOT show up as fake finishers. One card per student (their latest result), and
  // anyone currently writing is shown only in the active section. ──
  const resultRows = await Result.find({
    examId,
    createdAt: { $gt: new Date(now - FINISHED_WATCH_MS) },
  })
    .select("attemptId userId earnPoints pendingReview terminated violations createdAt")
    .populate("userId", "name email grade")
    .sort({ createdAt: -1 })
    .lean();
  const latestByUser = new Map();
  for (const r of resultRows) {
    const u = uid(r.userId);
    // Keep a student's finished result even while they're RETAKING: they then show
    // in BOTH sections — the new attempt under "Yazır" and their previous result
    // under "Bitirənlər" — instead of the result card being replaced.
    if (!latestByUser.has(u)) latestByUser.set(u, r); // first seen = latest (sorted desc)
  }
  const finList = [...latestByUser.values()];
  // Pull each finisher's attempt for the answered count / start time.
  const finAttemptIds = finList.map((r) => r.attemptId).filter(Boolean);
  const attById = new Map(
    (finAttemptIds.length
      ? await Attempt.find({ _id: { $in: finAttemptIds } })
          .select("answers answeredCount violations startedAt")
          .lean()
      : []
    ).map((a) => [String(a._id), a])
  );
  const finishedStudents = finList.map((r) => {
    const a = r.attemptId ? attById.get(String(r.attemptId)) : null;
    return {
      attemptId: r.attemptId || r._id,
      name: r.userId?.name || "—",
      email: r.userId?.email || "",
      grade: r.userId?.grade || "",
      currentQuestion: 0,
      answered: buildAnswered(a),
      answeredCount: a ? a.answeredCount || 0 : 0,
      total,
      violations: (r.violations != null ? r.violations : a?.violations) || 0,
      terminated: !!r.terminated,
      startedAt: a?.startedAt || null,
      expiresAt: null,
      lastSeenAt: null,
      active: false,
      finished: true,
      finishedAt: r.createdAt,
      score: typeof r.earnPoints === "number" ? r.earnPoints : null,
      resultId: r._id,
      pendingReview: !!r.pendingReview,
    };
  });
  // Finished section doubles as a live mini-leaderboard: highest score first.
  finishedStudents.sort((x, y) => (y.score ?? -1) - (x.score ?? -1));

  const students = [...activeStudents, ...finishedStudents];
  res.status(200).json({
    examName: exam.name,
    total,
    totalMarks: exam.totalMarks || 0,
    // Anti-cheat: whether it's ON for this exam + the exit/violation limit, so the
    // monitor can show each student's live "X/limit" violation count.
    antiCheat: !!exam.antiCheat,
    violationLimit: ANTICHEAT_LIMIT,
    activeCount: activeStudents.filter((s) => s.active).length,
    finishedCount: finishedStudents.length,
    serverNow: new Date(now),
    students,
  });
});

// Finalize ONE attempt: load its exam + user, score from the given (or autosaved)
// answers, and ensure the attempt ends terminal. If the exam or user was deleted,
// the attempt can never be scored -> mark it terminal `unscorable` (never left
// dangling `submitted:false` counting toward tries). Meta (violations/terminated)
// is merged MONOTONICALLY. Idempotent via scoreAndCreateResult's attemptId key.
// CR-038: THE single atomic freeze. Whoever wins the CAS sets a definitive
// answers+revision snapshot and flips finalizeState to "frozen"; a later caller
// (client submit OR another finalizer) reconciles THAT snapshot. No scoring path
// may use answers other than the frozen snapshot.
//   spec.server === true  → freeze the CURRENT server autosave atomically ($answers)
//   otherwise             → freeze the provided validated client { answers, revision }
// Returns { doc, wonFreeze }.
async function freezeAttempt(attemptId, spec) {
  const update = spec.server
    ? [{ $set: { finalizeState: "frozen", frozenAnswers: { $ifNull: ["$answers", []] }, frozenRev: { $ifNull: ["$autosaveRev", 0] } } }]
    : { $set: { finalizeState: "frozen", frozenAnswers: spec.answers || [], frozenRev: spec.revision == null ? null : spec.revision } };
  const won = await Attempt.findOneAndUpdate(
    { _id: attemptId, finalizeState: { $ne: "frozen" } },
    update,
    { new: true }
  );
  if (won) return { doc: won, wonFreeze: true };
  return { doc: await Attempt.findById(attemptId), wonFreeze: false };
}

async function finalizeAttempt(attempt, opts = {}) {
  const { answersOverride, maintenance, meta, reason, suppressNotifications } = opts;
  const exam = await Exam.findById(attempt.examId).populate("questions");
  if (!exam) {
    await Attempt.updateOne(
      { _id: attempt._id },
      { $set: { submitted: true, unscorable: true, unscorableReason: "deleted_exam" } }
    );
    console.warn("[FINALIZE] unscorable deleted_exam", String(attempt._id), reason || "");
    return null;
  }
  const user = await User.findById(attempt.userId);
  if (!user) {
    await Attempt.updateOne(
      { _id: attempt._id },
      { $set: { submitted: true, unscorable: true, unscorableReason: "deleted_user" } }
    );
    console.warn("[FINALIZE] unscorable deleted_user", String(attempt._id), reason || "");
    return null;
  }
  // CR-038: freeze the CURRENT server autosave atomically (the finalizer's job),
  // then score the FROZEN doc — never the possibly-stale `attempt` passed in. An
  // answersOverride is a MAINTENANCE-only escape (repair), never an ordinary path.
  let answers;
  let gradedRevision;
  if (answersOverride != null && maintenance === true) {
    answers = answersOverride;
    gradedRevision = null;
  } else {
    const fr = await freezeAttempt(attempt._id, { server: true });
    if (!fr.doc) return null;
    attempt = fr.doc; // score the fresh, frozen document (answers/violations/version)
    answers = fr.doc.frozenAnswers != null ? fr.doc.frozenAnswers : (fr.doc.answers || []);
    gradedRevision = fr.doc.frozenRev != null ? fr.doc.frozenRev : (fr.doc.autosaveRev || 0);
  }
  const m = meta || {};
  const mergedTerminated =
    !!attempt.terminated || m.terminated === true || m.terminated === "true";
  const mergedViolations = Math.max(attempt.violations || 0, Number(m.violations) || 0);
  // scoreAndCreateResult stamps attemptId, creates-or-reconciles the Result, and
  // flips submitted:true (result-first). A crash before that flip leaves
  // submitted:false + Result, healed by the migration / attemptStatus / start. A
  // crash after the freeze but before the result is healed by a later finalizer
  // pass re-scoring the SAME frozen snapshot (deterministic).
  try {
    return await scoreAndCreateResult(exam, user, attempt, answers, {
      violations: mergedViolations,
      terminated: mergedTerminated,
      suppressNotifications,
      auto: true,
      gradedRevision,
    });
  } catch (e) {
    // CR-035: fail closed on an integrity failure — do NOT mark unscorable (that
    // would permanently deny the student a score); leave the attempt for a later
    // pass once the version store is repaired, and raise a critical event.
    if (e instanceof VersionIntegrityError) {
      console.error("[SECURITY] version_integrity_finalize_blocked", { attemptId: String(attempt._id), code: e.code });
      return null;
    }
    throw e;
  }
}

// ── Server-side safety net ──────────────────────────────────────────────────
// Once an exam is started it WILL be scored. When an attempt's timer runs out
// and the student never submitted (closed the tab, lost connection, abandoned
// it), the server auto-submits the LAST autosaved answers and creates the
// result — so the student/teacher can see it later. Runs on an interval from
// server.js. A grace window lets a live client submit first; there is NO
// pre-claim — scoreAndCreateResult is idempotent (unique attemptId) and
// result-first, so the client and the job converge on one Result if they race.
// Grace after the deadline before the finalizer scores (lets a live client submit
// first). Overridable for deterministic E2E (CR-040) via FINALIZE_GRACE_MS; a bad
// value falls back to the 60s default.
const FINALIZE_GRACE_MS = (() => {
  const n = Number(process.env.FINALIZE_GRACE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 60 * 1000;
})();
async function finalizeExpiredAttempts() {
  let finalized = 0;
  try {
    const now = Date.now();
    const nowD = new Date(now);
    const workerId = `finalizer-${crypto.randomUUID()}`;
    const leaseUntil = new Date(now + 5 * 60 * 1000);
    // Candidates come from TWO sources so a shortened exam.endDate is honored:
    //   (a) attempts whose RAW expiresAt has already passed, and
    //   (b) attempts whose exam's endDate has passed even though their raw
    //       expiresAt is still in the future (teacher shortened the window).
    const rawExpired = await Attempt.find({
      submitted: false,
      unscorable: { $ne: true },
      finalizeDeadLetterAt: null,
      $or: [
        { finalizeNextAttemptAt: null },
        { finalizeNextAttemptAt: { $exists: false } },
        { finalizeNextAttemptAt: { $lte: nowD } },
      ],
      expiresAt: { $lt: nowD },
    })
      .sort({ expiresAt: 1 })
      .limit(200)
      .lean();
    const endedExams = await Exam.find({ endDate: { $lt: nowD } })
      .select("_id")
      .lean();
    let endedAttempts = [];
    if (endedExams.length) {
      endedAttempts = await Attempt.find({
        examId: { $in: endedExams.map((e) => e._id) },
        submitted: false,
        unscorable: { $ne: true },
        finalizeDeadLetterAt: null,
        expiresAt: { $gte: nowD },
      })
        .limit(200)
        .lean();
    }
    const seen = new Set();
    const due = [...rawExpired, ...endedAttempts].filter((a) => {
      const k = String(a._id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    for (const row of due) {
      try {
        const exam = await Exam.findById(row.examId).populate("questions");
        const expiry = exam
          ? effectiveExpiry(row, exam)
          : new Date(row.expiresAt).getTime();
        if (expiry + FINALIZE_GRACE_MS >= now) continue; // not yet due
        const claim = await Attempt.findOneAndUpdate(
          {
            _id: row._id,
            submitted: false,
            unscorable: { $ne: true },
            finalizeDeadLetterAt: null,
            $or: [
              { finalizeLeaseUntil: null },
              { finalizeLeaseUntil: { $exists: false } },
              { finalizeLeaseUntil: { $lte: nowD } },
            ],
          },
          {
            $set: { finalizeLeaseOwner: workerId, finalizeLeaseUntil: leaseUntil },
            $inc: { finalizeAttempts: 1 },
          },
          { new: true }
        ).select("+finalizeLeaseOwner +finalizeAttempts");
        if (!claim) continue;
        await finalizeAttempt(claim, { reason: "finalizer" });
        await Attempt.updateOne(
          { _id: claim._id, finalizeLeaseOwner: workerId },
          {
            $set: {
              finalizeLeaseOwner: null,
              finalizeLeaseUntil: null,
              finalizeNextAttemptAt: null,
            },
          }
        );
        finalized += 1;
      } catch (e) {
        console.error("[FINALIZE] attempt", String(row._id), "failed:", e.message);
        const current = await Attempt.findById(row._id).select("+finalizeAttempts +finalizeLeaseOwner");
        if (current && current.finalizeLeaseOwner === workerId) {
          const attempts = Number(current.finalizeAttempts) || 1;
          const dead = attempts >= 8;
          await Attempt.updateOne(
            { _id: row._id, finalizeLeaseOwner: workerId, submitted: false },
            {
              $set: {
                finalizeLeaseOwner: null,
                finalizeLeaseUntil: null,
                ...(dead
                  ? { finalizeDeadLetterAt: new Date() }
                  : {
                      finalizeNextAttemptAt: new Date(
                        Date.now() + Math.min(6 * 60 * 60 * 1000, 60 * 1000 * 2 ** (attempts - 1))
                      ),
                    }),
              },
            }
          );
        }
      }
    }
    if (finalized) console.log(`[FINALIZE] auto-submitted ${finalized} expired attempt(s)`);
  } catch (e) {
    console.error("[FINALIZE] sweep failed:", e.message);
  }
  return finalized;
}

const addPhotoToResult = asyncHandler(async (req, res) => {
  const { resultId } = req.params;
  const { photo } = req.body;

  // AUD-006: reject a malformed id up front. A syntactically-invalid id cannot
  // identify any resource, so a distinct 400 here leaks no existence signal
  // (and avoids the CastError-as-500 the old code produced).
  if (!resultId || !mongoose.Types.ObjectId.isValid(resultId)) {
    res.status(400);
    throw new Error("Yanlış nəticə id-si");
  }

  // AUD-006: validate the media before storing it. Only http(s) URLs (Cloudinary)
  // or base64 image data-URIs, with a size cap — never arbitrary strings.
  const media = typeof photo === "string" ? photo.trim() : "";
  const validMedia =
    /^https?:\/\/\S+$/i.test(media) ||
    /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(media);
  if (!validMedia || media.length > 2_000_000) {
    res.status(400);
    throw new Error("Şəkil linki düzgün deyil");
  }

  // AUD-006: object-level authorization. Load the result WITH its exam owner and
  // authorize by the exam owner (or admin) derived server-side from req.user —
  // never from client-supplied identity. A result that does not exist AND a
  // result the caller may not touch return the SAME 404, so an attacker cannot
  // enumerate result ids by probing this endpoint.
  const result = await Result.findById(resultId).populate("examId", "owner");
  const isAdmin = req.user.role === "admin";
  const examOwner = result?.examId?.owner;
  const ownsExam = examOwner && String(examOwner) === String(req.user._id);
  if (!result || (!isAdmin && !ownsExam)) {
    res.status(404);
    throw new Error("Nəticə tapılmadı");
  }

  result.photos.push(media);
  await result.save();

  // AUD-006: minimal DTO — do not echo answers, score, or other result fields.
  res.status(200).json({ _id: result._id, photos: result.photos });
});

const getResultsByUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const query = req.query || {};
  const limit = pageLimit(query.limit);
  const resultRows = await Result.find(withCursor({ userId: user._id }, query.cursor))
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate("examId");
  const page = pageResult(resultRows, limit);
  const results = page.items;

  if (!results) {
    res.status(404);
    throw new Error("No results found");
  }

  const items = results.map((r) => applyResultVisibility(r, resultVisibility(r.examId, user)));
  res.status(200).json(wantsEnvelope(req) ? { ...page, items } : items);
});

// STAFF ONLY (route is protect+teacherOnly). This returns RAW, unsanitized
// results (full userId + examId, score + answers) with no per-viewer visibility
// gating, so it MUST never be exposed on a student-reachable route.
// Delete ONE result (owner of the exam, or admin). Mirrors getResultsByExam's
// ownership rule. Removes only the graded Result row; the underlying attempt is
// left intact (so try counts / audit history are unchanged).
const deleteResult = asyncHandler(async (req, res) => {
  const { resultId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(resultId)) {
    res.status(400);
    throw new Error("Yanlış nəticə");
  }
  const result = await Result.findById(resultId);
  if (!result) {
    res.status(404);
    throw new Error("Nəticə tapılmadı");
  }
  const exam = await Exam.findById(result.examId).select("owner");
  // A teacher may only delete results for an exam they OWN (admins any). Legacy
  // ownerless exams stay open during the transition, same as the read path.
  if (!isAdminUser(req.user) && exam && exam.owner && String(exam.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("Bu nəticə sizə aid deyil");
  }
  await Result.deleteOne({ _id: resultId });
  res.status(200).json({ message: "Nəticə silindi", _id: resultId });
});

const getResultsByExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const exam = await Exam.findById(examId);

  if (!exam) {
    res.status(404);
    throw new Error("No Exam Found!");
  }

  // A teacher may only see results for an exam they OWN (admins any). Legacy
  // exams with no owner stay visible to any teacher during the transition.
  if (!isAdminUser(req.user) && exam.owner && String(exam.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("Bu imtahanın nəticələri sizə aid deyil");
  }

  const query = req.query || {};
  const limit = pageLimit(query.limit);
  const resultRows = await Result.find(withCursor({ examId }, query.cursor))
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate("examId")
    // AUD-001: project only the safe student fields the UI needs; never the
    // whole user document (which would carry the password hash).
    .populate("userId", "name email phone grade");
  const page = pageResult(resultRows, limit);
  const results = page.items;

  if (!results) {
    res.status(404);
    throw new Error("No results found!");
  }

  // AUD-001 (defense in depth): the populated exam carries the exam access
  // password, AI prompt, and PDF path. This staff endpoint stays visible for
  // legacy ownerless exams, so strip those sensitive exam fields before sending.
  const safe = results.map((r) => {
    const o = r.toObject();
    if (o.examId && typeof o.examId === "object") {
      delete o.examId.password;
      delete o.examId.aiPrompt;
      delete o.examId.pdf;
    }
    return o;
  });

  res.status(200).json(wantsEnvelope(req) ? { ...page, items: safe } : safe);
});

const getResultsByUserByExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const exam = await Exam.findById(examId);

  if (!exam) {
    res.status(404);
    throw new Error("No Exam Found!");
  }
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }

  // Ascending by creation so the frontend's "last array item == latest result"
  // assumption holds (Mongo does not guarantee natural order).
  const query = req.query || {};
  const limit = pageLimit(query.limit);
  const resultRows = await Result.find(withCursor({ userId: user._id, examId }, query.cursor, -1))
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate("examId")
    // AUD-001: safe projection — never serialize the password hash.
    .populate("userId", "name email phone grade");
  const page = pageResult(resultRows, limit);
  const results = page.items;

  if (!results) {
    res.status(404);
    throw new Error("No results found!");
  }

  const vis = resultVisibility(exam, user);
  const items = results.map((r) => applyResultVisibility(r, vis));
  res.status(200).json(wantsEnvelope(req) ? { ...page, items } : items.reverse());
});

const reviewByResult = asyncHandler(async (req, res) => {
  const { resultId } = req.params;

  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }

  const result = await Result.findById(resultId)
    .populate({
      path: "examId",
      populate: {
        path: "questions",
      },
    })
    // Populate the student so the review header can show whose result it is
    // (used by the teacher's eye-button view).
    .populate("userId", "name email");
  if (!result) {
    res.status(404);
    throw new Error("No Result Found!");
  }

  // CR-035/036: the FROZEN version is authoritative for a versioned result.
  const frozen = result.examVersionId
    ? await ExamVersion.findById(result.examVersionId).lean()
    : null;
  if (result.examVersionId && !frozen) {
    // Bound version id present but the row is gone — integrity failure, fail closed.
    res.status(409);
    throw new Error("İmtahan versiyası tapılmadı");
  }
  if (frozen && !verifyIntegrity(frozen).ok) {
    console.error("[SECURITY] version_integrity_review_blocked", { resultId: String(result._id), versionId: String(frozen._id) });
    res.status(409);
    throw new Error("İmtahan versiyası doğrulana bilmədi");
  }

  // ── Authorization (CR-036), fail CLOSED ──
  // Owner: compare the result's user id (NOT a populated doc's toString()).
  const ownerId = result.userId && (result.userId._id || result.userId);
  const isOwner = ownerId != null && String(ownerId) === String(user._id);
  const isAdmin = user.role === "admin";
  // Teacher: for a versioned result authorize against the FROZEN version author;
  // for a legacy result, the live exam owner. A hard-deleted live exam yields no
  // owner evidence for a legacy result → deny (never open to ANY teacher).
  let teacherAuthed = false;
  if (user.role === "teacher" && isStaffUser(user)) {
    const authority = frozen ? frozen.author : (result.examId && result.examId.owner);
    teacherAuthed = authority != null && String(authority) === String(user._id);
  }
  if (!isOwner && !isAdmin && !teacherAuthed) {
    res.status(403);
    throw new Error("Bu nəticəyə icazəniz yoxdur");
  }

  // ── Visibility (CR-036): a versioned result uses the FROZEN reveal policy +
  // FROZEN end timestamp, so a later edit/toggle can't reveal answers earlier than
  // the student was originally promised. A legacy result uses the live exam.
  const vis = frozen
    ? resultVisibility(
        {
          showScore: frozen.reveal && frozen.reveal.showScore,
          showCorrectAnswers: frozen.reveal && frozen.reveal.showCorrectAnswers,
          revealAfterEnd: frozen.reveal && frozen.reveal.revealAfterEnd,
          endDate: (frozen.reveal && frozen.reveal.endDate) || null,
        },
        user
      )
    : resultVisibility(result.examId, user);

  const view = applyResultVisibility(result, vis);
  if (frozen) {
    view.examId = view.examId || {};
    view.examId.name = view.examId.name || frozen.display?.name || "";
    // Frozen question content (immutable). Strip the answer key when answers aren't
    // yet revealable, mirroring applyResultVisibility's handling of live questions.
    view.examId.questions = {
      correctAnswers: vis.canSeeAnswers ? frozen.questions : frozen.questions.map(sanitizeQuestionItem),
    };
    view.gradedVersion = { number: frozen.versionNumber, hash: frozen.contentHash };
  }
  // Observability: which revision was graded and whether this is a legacy result.
  view.gradedRevision = result.gradedRevision == null ? null : result.gradedRevision;
  view.legacyUnversioned = !!result.legacyUnversioned;
  res.status(200).json(view);
});

// ── Manual grading (MANUAL_GRADING_ENABLED) ────────────────────────────────
// A teacher owns the review of every result for an exam they published. Reuses
// the reviewByResult authorization: for a versioned result authorize against the
// FROZEN version author, for a legacy result the live exam owner.
async function loadResultForTeacher(req, res, resultId, user) {
  const result = await Result.findById(resultId)
    .populate({ path: "examId", populate: { path: "questions" } })
    .populate("userId", "name email phone");
  if (!result) {
    res.status(404);
    throw new Error("No Result Found!");
  }
  const frozen = result.examVersionId
    ? await ExamVersion.findById(result.examVersionId).lean()
    : null;
  if (result.examVersionId && !frozen) {
    res.status(409);
    throw new Error("İmtahan versiyası tapılmadı");
  }
  const isAdmin = user.role === "admin";
  let teacherAuthed = false;
  if (user.role === "teacher" && isStaffUser(user)) {
    const authority = frozen ? frozen.author : (result.examId && result.examId.owner);
    teacherAuthed = authority != null && String(authority) === String(user._id);
  }
  if (!isAdmin && !teacherAuthed) {
    res.status(403);
    throw new Error("Bu nəticəyə icazəniz yoxdur");
  }
  return { result, frozen };
}

// GET /exam/:examId/pending-reviews — the teacher's grading queue.
const getPendingReviews = asyncHandler(async (req, res) => {
  const { flags } = require("../config/featureFlags");
  if (!flags.MANUAL_GRADING_ENABLED) return res.status(200).json([]);
  const { examId } = req.params;
  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404);
    throw new Error("No Exam Found!");
  }
  if (!isAdminUser(req.user) && exam.owner && String(exam.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("Bu imtahanın nəticələri sizə aid deyil");
  }
  const rows = await Result.find({ examId, pendingReview: true })
    .sort({ createdAt: 1, _id: 1 })
    .select("userId examId manualItems earnPoints autoEarnPoints createdAt pendingReview")
    .populate("userId", "name email");
  res.status(200).json(rows);
});

// PATCH /result/:resultId/grade — record ONE verdict for a manual question.
// Recomputes earnPoints = autoEarnPoints + Σ awarded, flips pendingReview off when
// the last one is graded. Never re-runs scoreAndCreateResult (which refuses to
// overwrite an authoritative Result).
const gradeManualAnswer = asyncHandler(async (req, res) => {
  const { flags } = require("../config/featureFlags");
  if (!flags.MANUAL_GRADING_ENABLED) {
    res.status(403);
    throw new Error("Manual grading is not enabled");
  }
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }
  const { resultId } = req.params;
  const { result } = await loadResultForTeacher(req, res, resultId, user);

  const index = Number(req.body?.index);
  const verdict = String(req.body?.verdict || "");
  if (!["correct", "wrong", "partial"].includes(verdict)) {
    res.status(400);
    throw new Error("verdict must be correct, wrong or partial");
  }
  const item = (result.manualItems || []).find((m) => Number(m.index) === index);
  if (!item) {
    res.status(400);
    throw new Error("Bu sual əl ilə yoxlanılmır");
  }
  const maxPoints = Number(item.maxPoints) || 0;
  let awarded;
  if (verdict === "correct") awarded = maxPoints;
  else if (verdict === "wrong") awarded = 0;
  else awarded = Math.min(maxPoints, Math.max(0, Number(req.body?.awardedPoints) || 0));

  item.verdict = verdict;
  item.awardedPoints = Math.round(awarded * 100) / 100;
  item.gradedBy = user._id;
  item.gradedAt = new Date();

  const base = Number(result.autoEarnPoints) || 0;
  const manualSum = (result.manualItems || [])
    .filter((m) => m.verdict && m.verdict !== "pending")
    .reduce((s, m) => s + (Number(m.awardedPoints) || 0), 0);
  result.earnPoints = result.terminated ? 0 : Math.round((base + manualSum) * 100) / 100;

  const stillPending = (result.manualItems || []).some((m) => !m.verdict || m.verdict === "pending");
  const justCompleted = result.pendingReview && !stillPending;
  result.pendingReview = stillPending;
  if (justCompleted) result.reviewCompletedAt = new Date();
  await result.save();

  res.status(200).json({
    _id: result._id,
    earnPoints: result.earnPoints,
    pendingReview: result.pendingReview,
    manualItems: (result.manualItems || []).map(({ gradedBy, ...rest }) => rest),
  });
});

const editExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const {
    name,
    price,
    endDate,
    videoLink,
    startDate,
    duration,
    totalMarks,
    passingMarks,
    maxTry,
    showScore,
    showCorrectAnswers,
    revealAfterEnd,
    solutionPhotos,
    password,
    negativeMarking,
    wrongPerPenalty,
    correctPerPenalty,
    negMarkUntil,
    antiCheat,
    partialCredit,
    shuffleOptions,
    shuffleQuestions,
    studentSolutionPhotos,
    coverImage,
    pdfPath,
  } = req.body;
  const examExists = await Exam.findById(examId);
  if (examExists && !ownsOrAdmin(req.user, examExists)) {
    res.status(403);
    throw new Error("Bu imtahan sizə aid deyil");
  }
  if (blockIfArchived(res, examExists)) return;
  if (examExists) {
    // Update the exam fields
    const update = {
      name,
      startDate,
      endDate,
      videoLink,
      // Payments removed: an edit can never set a positive price (forged or not).
      price: 0,
      duration,
      totalMarks,
      passingMarks,
      maxTry,
      showScore: showScore === true || showScore === "true",
      showCorrectAnswers: showCorrectAnswers === true || showCorrectAnswers === "true",
      revealAfterEnd: revealAfterEnd === true || revealAfterEnd === "true",
      negativeMarking: negativeMarking === true || negativeMarking === "true",
      wrongPerPenalty: Math.max(1, Number(wrongPerPenalty) || 3),
      correctPerPenalty: Math.max(1, Number(correctPerPenalty) || 1),
      negMarkUntil: Math.max(0, Number(negMarkUntil) || 0),
      antiCheat: antiCheat === true || antiCheat === "true",
      partialCredit: partialCredit === true || partialCredit === "true",
      shuffleOptions: shuffleOptions === true || shuffleOptions === "true",
      shuffleQuestions: shuffleQuestions === true || shuffleQuestions === "true",
      studentSolutionPhotos:
        studentSolutionPhotos === true || studentSolutionPhotos === "true",
    };
    // Only touch the solution images when the client sends them, so partial
    // edits don't wipe the existing list.
    if (Array.isArray(solutionPhotos)) update.solutionPhotos = solutionPhotos;
    // Cover image: a string (incl. "") sets it; undefined leaves it unchanged.
    if (typeof coverImage === "string") update.coverImage = coverImage;
    // Empty string disables the password; undefined leaves it unchanged.
    if (typeof password === "string") update.password = password;

    // Keep the exam internally consistent.
    const _tM = Number(update.totalMarks);
    const _pM = Number(update.passingMarks);
    if (!Number.isNaN(_tM) && !Number.isNaN(_pM) && _pM > _tM) {
      res.status(400);
      throw new Error("Keçid balı ümumi baldan çox ola bilməz");
    }
    if (update.startDate && update.endDate) {
      const s = new Date(update.startDate).getTime();
      const e = new Date(update.endDate).getTime();
      if (!Number.isNaN(s) && !Number.isNaN(e) && s >= e) {
        res.status(400);
        throw new Error("Başlama tarixi bitmə tarixindən əvvəl olmalıdır");
      }
    }

    const safeUpdate = Object.fromEntries(
      Object.entries(update).filter(([, value]) => value !== undefined)
    );

    if (pdfPath) {
      // AUD-013 CR-069/CR-075: replacing the PDF. CLAIM the new staged upload for
      // THIS teacher, BOUND to this exam id; if the claim fails, leave the old
      // exam PDF untouched and readable (fail without data loss).
      // CR-079/CR-083: claim + concurrency-safe replacement (expected-old-ref CAS).
      const rep = await replaceExamPdf(examId, pdfPath, req.user._id, {
        examUpdate: safeUpdate,
      });
      if (!rep.ok) {
        if (rep.status === "invalid_upload") { res.status(400); throw new Error("PDF yüklənməsi etibarsızdır və ya artıq istifadə olunub"); }
        if (rep.status === "cas_lost") { res.status(409); throw new Error("İmtahan başqa dəyişikliklə yeniləndi — yenidən cəhd edin"); }
        res.status(409); throw new Error("PDF yüklənməsi ləğv olundu — yenidən yükləyin");
      }
    } else {
      const saved = await Exam.updateOne(
        { _id: examId, deletedAt: null, purging: { $ne: true } },
        { $set: safeUpdate }
      );
      if (saved.matchedCount !== 1) {
        throw httpError(409, "exam_changed", "Exam changed while saving");
      }
    }

    // CR-034: scoring/reveal/date fields changed — publish a new active version so
    // subsequent starts grade under the updated (complete) rules.
    const pub = await republishExam(examId);

    res.status(200).json({
      message: "İmtahan uğurla yeniləndi!",
      publishState: pub.ok ? "published" : "draft_saved_publish_failed",
    });
  } else {
    res.status(404);
    throw new Error("İmtahan tapılamdı!");
  }
});

const editTag = asyncHandler(async (req, res) => {
  const { tagId } = req.params;
  const { name } = req.body;
  const tagExists = await Tag.findById(tagId);
  if (tagExists && !ownsOrAdmin(req.user, tagExists)) {
    res.status(403);
    throw new Error("Bu kateqoriya sizə aid deyil");
  }
  if (tagExists) {
    await Tag.findByIdAndUpdate(tagId, { name });

    res.status(200).json({
      message: "Tag updated successfully",
    });
  } else {
    res.status(404);
    throw new Error("Tag not found!");
  }
});

const editClass = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const { name, level, regenerateCode, coverImage } = req.body;
  const label = typeof name === "string" ? name.trim() : "";
  if (!label && !level) {
    res.status(400);
    throw new Error("Sinif adını daxil edin");
  }
  const classExists = await Class.findById(classId);
  if (!classExists) {
    res.status(404);
    throw new Error("Sinif tapılmadı!");
  }
  if (!ownsOrAdmin(req.user, classExists)) {
    res.status(403);
    throw new Error("Bu sinif sizə aid deyil");
  }
  const update = {};
  if (typeof name === "string") update.name = label;
  if (typeof coverImage === "string") update.coverImage = coverImage.trim();
  if (level !== undefined && level !== "") update.level = level;
  // Classes are always code-only (public was removed); keep it enforced.
  update.requireCode = true;
  // Let the teacher rotate the join code (invalidates the previously shared one).
  if (regenerateCode === true || regenerateCode === "true") {
    update.joinCode = await uniqueJoinCode();
  }
  await Class.findByIdAndUpdate(classId, update);
  res.status(200).json({ message: "Sinif uğurla yeniləndi" });
});

// Purge live exam content while retaining the Exam tombstone and historical
// Result/Attempt/ExamVersion evidence required for audit and score review.
async function purgeExam(examId, opts = {}) {
  // AUD-013 CR-087: atomically CLAIM the purge FIRST. While `purging` is set,
  // `replaceExamPdf` can no longer commit a new PDF reference (its CAS requires
  // `purging:{$ne:true}`), so no replacement can strand a freshly-attached orphan
  // past this point. The claim's returned document gives the AUTHORITATIVE,
  // post-claim `pdf` — never a pre-claim stale read — so we always delete the exact
  // winner. A crashed purge left `purging:true`; re-load and finish idempotently
  // (nothing new can attach in the meantime, and every step below is idempotent).
  const claimed = await Exam.findOneAndUpdate(
    { _id: examId, purging: { $ne: true } },
    { $set: { purging: true } },
    { new: true }
  );
  const exam = claimed || await Exam.findById(examId);
  if (!exam) return;

  // TEST seam (CR-087): interleave a real replacement AFTER the purge claim to
  // prove the fence refuses it and no orphan survives.
  if (opts.__afterClaim) await opts.__afterClaim();

  const pdfId = exam.pdf;
  await withMongoTransaction(async (session) => {
    const opts = session ? { session } : {};
    await Question.deleteMany({ exam: exam._id }, opts);
    // Historical Results/Attempts/ExamVersions are retained. Remove only live
    // acquisition/navigation references and convert the Exam to a tombstone.
    await User.updateMany(
      {},
      { $pull: { exams: exam._id, _acqMig: { exam: exam._id } } },
      opts
    );
    if (exam.class) {
      await Class.updateOne(
        { _id: exam.class, examCount: { $gt: 0 } },
        { $inc: { examCount: -1 } },
        opts
      );
    }
    await Exam.updateOne(
      { _id: exam._id, purging: true },
      {
        $set: {
          purgedAt: new Date(),
          deletedAt: exam.deletedAt || new Date(),
          hidden: true,
        },
        $unset: { pdf: "", questions: "", purging: "" },
      },
      opts
    );
  });

  // Filesystem cleanup is intentionally AFTER the authoritative reference
  // commit. The durable PDF state machine retains the locator on unlink errors.
  if (pdfId) {
    await deletePdfDurably(
      pdfId,
      ["attached", "attaching", "claimed", "staged", "deleting"],
      "exam_purged"
    );
  }
}

// Soft-delete (archive) every ACTIVE exam matching the filter, so they land in
// the Trash instead of being wiped. Used when a class/tag is removed — the
// exams/results/PDFs stay recoverable for 30 days rather than being lost.
async function archiveExams(filter) {
  await Exam.updateMany(
    { ...filter, deletedAt: null },
    { $set: { deletedAt: new Date() } }
  );
}

// Remove a class. Its exams are ARCHIVED (Trash), not permanently deleted — so a
// mis-clicked class delete can no longer wipe active exams/results.
async function purgeClass(classId, actorId = null) {
  const _class = await Class.findById(classId);
  if (!_class) return;
  await archiveClassLifecycle(classId, actorId);
}

// Remove a tag and its classes. Exams under them are ARCHIVED (Trash), not wiped.
async function purgeTag(tagId, actorId = null) {
  const tag = await Tag.findById(tagId);
  if (!tag) return;
  await archiveTagLifecycle(tagId, actorId);
}

// How long a trashed exam is kept before the sweep purges it for good.
const ARCHIVE_RETENTION_DAYS = 30;

const deleteExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404);
    throw new Error("Exam not found!");
  }
  if (!ownsOrAdmin(req.user, exam)) {
    res.status(403);
    throw new Error("Bu imtahan sizə aid deyil");
  }
  // Soft-delete: move to the Trash instead of purging. Data (questions, PDF,
  // attempts, results) is kept so it can be restored; the sweep purges it after
  // ARCHIVE_RETENTION_DAYS. Previously this was a hard cascade — two live exams
  // were lost permanently, so delete is now recoverable.
  exam.deletedAt = new Date();
  exam.deletedBy = req.user._id;
  await exam.save();
  res.status(200).json({ message: "Exam archived", archived: true });
});

// Restore an archived exam back to active. If the exam's original class was
// deleted while it sat in Trash, the caller must pick a TARGET class to restore
// it into (a class-less exam would be invisible in the UI) — otherwise we reply
// 409 { needsClass:true } so the client can prompt for one.
const restoreExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { classId } = req.body || {};
  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404);
    throw new Error("Exam not found!");
  }
  if (!ownsOrAdmin(req.user, exam)) {
    res.status(403);
    throw new Error("Bu imtahan sizə aid deyil");
  }
  if (!exam.deletedAt) {
    return res.status(400).json({ message: "İmtahan arxivdə deyil" });
  }

  // Does the exam still have a valid parent class?
  const parentOk = exam.class
    ? !!(await Class.findById(exam.class).select("_id"))
    : false;

  if (parentOk) {
    // Parent still exists — make sure it references the exam again.
    await Class.updateOne({ _id: exam.class }, { $inc: { examCount: 1 } });
  } else {
    // Orphaned (class deleted): need a destination class from the caller.
    if (!classId) {
      return res.status(409).json({
        needsClass: true,
        message:
          "Bu imtahanın sinfi silinib. İmtahanı hansı sinfə qaytarmaq istədiyinizi seçin.",
      });
    }
    const target = await Class.findById(classId);
    if (!target) return res.status(404).json({ message: "Sinif tapılmadı" });
    if (!ownsOrAdmin(req.user, target)) {
      return res.status(403).json({ message: "Bu sinif sizə aid deyil" });
    }
    exam.class = target._id;
    await Class.updateOne({ _id: target._id }, { $inc: { examCount: 1 } });
  }

  exam.deletedAt = null;
  exam.deletedBy = null;
  await exam.save();
  res.status(200).json({ message: "Exam restored", classId: String(exam.class) });
});

// Permanently purge an archived exam (the "delete forever" action in the Trash).
const deleteExamForever = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404);
    throw new Error("Exam not found!");
  }
  if (!ownsOrAdmin(req.user, exam)) {
    res.status(403);
    throw new Error("Bu imtahan sizə aid deyil");
  }
  // Permanent deletion is only allowed from the Trash — the exam MUST already be
  // archived. This stops a direct /forever call from skipping the 30-day safety
  // net and wiping an active exam.
  if (!exam.deletedAt) {
    return res.status(400).json({ message: "Əvvəlcə imtahanı arxivə (zibil qutusuna) köçürün" });
  }
  // Refuse while any in-flight (non-terminal) attempt exists — purge deletes
  // Results AND Attempts, so destroying an unfinished attempt would leave the
  // student with `invalid_attempt` and no terminal status. Safe once every attempt
  // is submitted or `unscorable`. (Finalize-then-delete is NOT safe — it would
  // delete the just-created Result too.)
  const inflight = await Attempt.exists({
    examId,
    submitted: false,
    unscorable: { $ne: true },
  });
  if (inflight) {
    return res.status(409).json({
      reason: "attempt_in_progress",
      message: "Bir imtahan hələ davam edir; bitdikdən sonra silin",
    });
  }
  await purgeExam(examId);
  res.status(200).json({ message: "Exam permanently deleted" });
});

// The Trash listing: archived exams the caller owns (admins see all), newest
// first, with the auto-purge date so the UI can show a countdown.
const getArchivedExams = asyncHandler(async (req, res) => {
  // Only exams that are archived but NOT yet permanently purged. `purgeExam`
  // keeps `deletedAt` set on the tombstone it leaves behind (Results/Attempts
  // integrity), so without the `purgedAt: null` guard a "delete forever" exam
  // would keep reappearing in the Trash after every refresh.
  const filter = { deletedAt: { $ne: null }, purgedAt: null };
  if (!isAdminUser(req.user)) filter.owner = req.user._id;
  const exams = await Exam.find(filter)
    .sort({ deletedAt: -1 })
    .populate("class", "name level")
    .populate("deletedBy", "name")
    .lean();
  const ms = ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  res.status(200).json(
    (exams || []).map((e) => ({
      _id: e._id,
      name: e.name,
      class: e.class ? { name: e.class.name, level: e.class.level } : null,
      deletedAt: e.deletedAt,
      deletedByName: e.deletedBy ? e.deletedBy.name : null,
      purgeAt: e.deletedAt ? new Date(new Date(e.deletedAt).getTime() + ms) : null,
      coverImage: e.coverImage || "",
    }))
  );
});

// Sweep: delete uploaded PDFs that never became an exam.
//
// The builder uploads the file BEFORE creating the exam, so an abandoned form,
// a failed validation or a closed tab leaves the PDF on disk forever. Only
// files older than the grace window are considered, so an upload still being
// filled in on the form is never taken out from under the teacher.
//
// Safety rails: only the dated filenames this route produces, only when no PDF
// document references them, and never anything younger than the window.
const ORPHAN_GRACE_MS = Number(process.env.ORPHAN_PDF_GRACE_MS || 6 * 60 * 60 * 1000);
const UPLOADED_PDF = /^\d{13}-\d+\.pdf$/; // `${Date.now()}-${rand}.pdf`

async function purgeOrphanPdfs() {
  const dir = PDF_STAGING_DIR; // CR-067: configured staging dir, not hard-coded "uploads"
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => UPLOADED_PDF.test(n));
  } catch {
    return { scanned: 0, removed: 0 };
  }
  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  const candidates = names.filter((n) => {
    try {
      return fs.statSync(path.join(dir, n)).mtimeMs < cutoff;
    } catch {
      return false;
    }
  });
  if (!candidates.length) return { scanned: names.length, removed: 0 };

  // One query rather than one per file: match on the filename appearing in the
  // stored URL, since that is what addExam persists.
  const referenced = new Set();
  const rows = await PDF.find({
    path: { $regex: candidates.map((n) => n.replace(/\./g, "\.")).join("|") },
  })
    .select("path")
    .lean();
  rows.forEach((r) => {
    const base = String(r.path || "").split("/").pop();
    if (base) referenced.add(base);
  });

  let removed = 0;
  for (const n of candidates) {
    if (referenced.has(n)) continue;
    try {
      fs.unlinkSync(path.join(dir, n));
      removed += 1;
    } catch {
      /* best effort */
    }
  }
  if (removed) console.log(`[orphan-pdf] removed ${removed} unattached upload(s)`);
  return { scanned: names.length, removed };
}

// Sweep: permanently purge exams archived longer than the retention window.
// Scheduled from server.js; safe to run repeatedly.
async function purgeExpiredArchived() {
  const cutoff = new Date(Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const due = await Exam.find({
    deletedAt: { $ne: null, $lte: cutoff },
    purgedAt: null,
  }).select("_id");
  for (const e of due) {
    try {
      await purgeExam(e._id);
    } catch (err) {
      console.error("[TRASH] purge failed for", String(e._id), err.message);
    }
  }
  if (due.length) console.log(`[TRASH] purged ${due.length} expired archived exam(s)`);
}

const deleteClass = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const _class = await Class.findById(classId);
  if (!_class) {
    res.status(404);
    throw new Error("Class not found!");
  }
  if (!ownsOrAdmin(req.user, _class)) {
    res.status(403);
    throw new Error("Bu sinif sizə aid deyil");
  }
  await purgeClass(classId, req.user._id);
  res.status(200).json({ message: "Class deleted successfully" });
});

const deleteTag = asyncHandler(async (req, res) => {
  const { tagId } = req.params;
  const tag = await Tag.findById(tagId);
  if (!tag) {
    res.status(404);
    throw new Error("Tag not found!");
  }
  if (!ownsOrAdmin(req.user, tag)) {
    res.status(403);
    throw new Error("Bu kateqoriya sizə aid deyil");
  }
  await purgeTag(tagId, req.user._id);
  res.status(200).json({ message: "Tag deleted successfully" });
});

const deleteMyExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }

  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404);
    throw new Error("Exam not found!");
  }

  // CR-101: removal is a SINGLE atomic canonical `$pull` on `User.exams` — the sole
  // source of access. The derived `Exam.users` reverse projection is pulled
  // best-effort; a reverse failure can NEVER leave the canonical removal undone or
  // preserve access (access reads only the canonical side, which is already empty).
  // CR-103: pull any acquisition-migration ownership marker for this exam in the SAME
  // atomic update, so a later re-acquire is a fresh, UNMARKED grant that a migration
  // rollback preserves.
  await User.updateOne({ _id: user._id }, { $pull: { exams: examId, _acqMig: { exam: examId } } });
  await pullExamUsersReverse(examId, user._id);

  res.status(200).json({ message: "My Exam deleted succesfully" });
});

const getExamsByUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).populate("exams");

  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }

  const exams = (user.exams || []).filter((e) => !e.deletedAt); // hide archived

  // Question count per exam for the card stats — the SAME cheap $size aggregation
  // the other listings use. Without it every card here showed "Sual: —" even
  // though questions exist.
  const qIds = exams.map((e) => e.questions).filter(Boolean);
  const sizeMap = {};
  if (qIds.length) {
    const sizes = await Question.aggregate([
      { $match: { _id: { $in: qIds } } },
      { $project: { n: { $size: { $ifNull: ["$correctAnswers", []] } } } },
    ]);
    sizes.forEach((s) => (sizeMap[String(s._id)] = s.n));
  }
  const withCount = (obj, exam) => ({
    ...obj,
    questionCount: exam.questions ? sizeMap[String(exam.questions)] || 0 : 0,
  });

  // The "my exams" list must not carry the access password or pdf location.
  res.status(200).json(exams.map((e) => withCount(sanitizeExamForStudent(e), e)));
});

// The most recently CREATED exams the user can access — a dashboard shortcut so
// a student can jump to a just-published exam without digging through every
// category and class. Student: exams in approved-enrolled classes (no drafts).
// Teacher: their own classes' exams + any class they joined. Admin: everything.
// PUBLIC landing feed (no auth): the newest exams that live in OPEN (public)
// classes, so visitors see real content on the home page. Sanitized — only
// display fields (no answer key / password / pdf path).
const getPublicExams = asyncHandler(async (req, res) => {
  const publicIds = await Class.find({ requireCode: false }).distinct("_id");
  if (!publicIds.length) return res.status(200).json([]);
  const exams = await Exam.find({ class: { $in: publicIds }, hidden: { $ne: true }, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(8)
    .populate("class", "name level")
    .lean();
  const qIds = exams.map((e) => e.questions).filter(Boolean);
  const sizeMap = {};
  if (qIds.length) {
    const sizes = await Question.aggregate([
      { $match: { _id: { $in: qIds } } },
      { $project: { n: { $size: { $ifNull: ["$correctAnswers", []] } } } },
    ]);
    sizes.forEach((s) => (sizeMap[String(s._id)] = s.n));
  }
  const out = exams.map((e) => ({
    _id: e._id,
    name: e.name,
    class: e.class ? { name: e.class.name, level: e.class.level } : null,
    duration: e.duration || 0,
    totalMarks: e.totalMarks || 0,
    questionCount: e.questions ? sizeMap[String(e.questions)] || 0 : 0,
    startDate: e.startDate || null,
    endDate: e.endDate || null,
    price: e.price || 0,
    coverImage: e.coverImage || "",
    createdAt: e.createdAt,
  }));
  res.status(200).json(out);
});

const getLatestExams = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }

  let filter = {};
  if (!isAdminUser(user)) {
    const owned = isStaffUser(user) ? await Class.find({ owner: user._id }).distinct("_id") : [];
    const enrolled = await approvedClassIds(user._id);
    const publicIds = await publicClassIds();
    // Dedupe (a public class the teacher owns would otherwise appear twice).
    const classIds = [...new Set([...owned, ...enrolled, ...publicIds].map(String))];
    filter = { class: { $in: classIds } };
  }
  // Students never see drafts (hidden exams).
  if (!isStaffUser(user)) filter.hidden = { $ne: true };
  filter.deletedAt = null; // never surface archived (trashed) exams

  const exams = await Exam.find(filter)
    .sort({ createdAt: -1 })
    .limit(8)
    .populate("class", "name level");

  // Cheap question-count aggregation for the cards (no heavy answer arrays).
  const qIds = exams.map((e) => e.questions).filter(Boolean);
  const sizeMap = {};
  if (qIds.length) {
    const sizes = await Question.aggregate([
      { $match: { _id: { $in: qIds } } },
      { $project: { n: { $size: { $ifNull: ["$correctAnswers", []] } } } },
    ]);
    sizes.forEach((s) => (sizeMap[String(s._id)] = s.n));
  }
  const ownerOrAdmin = (e) =>
    isAdminUser(user) || (e.owner && String(e.owner) === String(user._id));
  const withCount = (obj, e) => ({
    ...obj,
    questionCount: e.questions ? sizeMap[String(e.questions)] || 0 : 0,
  });

  res.status(200).json(
    exams.map((e) =>
      ownerOrAdmin(e) ? withCount(e.toObject(), e) : withCount(sanitizeExamForStudent(e), e)
    )
  );
});

// Authoritative server clock so client countdowns (exam opening, deadline)
// stay correct even if the device clock is wrong. Returns only the time.
const serverTime = asyncHandler(async (req, res) => {
  res.status(200).json({ now: Date.now() });
});

module.exports = {
  serverTime,
  buildQuestionOrder, // exported for tests
  addExam,
  getExamsByClass,
  addTag,
  getTags,
  addQuestion,
  getExam,
  getTag,
  editExam,
  addClass,
  getClassesByTag,
  deleteExam,
  restoreExam,
  deleteExamForever,
  getArchivedExams,
  purgeExpiredArchived,
  purgeOrphanPdfs,
  purgeStagedUploads,
  claimStagedPdf,
  beginAttach,
  attachPdf,
  deletePdfDurably,
  deletePdfFile,
  replaceExamPdf,
  purgeExam,
  rebuildExamUsersIndex,
  syncExamUsersReverse,
  pullExamUsersReverse,
  examUsersProjectionMetrics,
  validatePdfTiming,
  deleteClass,
  getAllClasses,
  deleteTag,
  editTag,
  editClass,
  setExamHidden,
  addPhotoToResult,
  addResult,
  autosaveAttempt,
  getLiveAttempts,
  getLiveExams,
  heartbeatAttempt,
  finalizeExpiredAttempts,
  finalizeAttempt, // exported for CR-038 deterministic freeze tests
  republishExam, // exported for CR-034 publish tests
  finalizeAttempt,
  scoreAndCreateResult,
  effectiveExpiry,
  startAttempt,
  attemptStatus,
  reportViolation,
  getExamRank,
  uploadPdf,
  getResultsByUser,
  getResultsByUserByExam,
  getClass,
  getClassesByTag,
  addExamToUser,
  getExamsByUser,
  getLatestExams,
  getPublicExams,
  getExams,
  reviewByResult,
  deleteMyExam,
  addExamToUserById,
  getPdfByExam,
  streamExamPdf,
  getExamTagandClass,
  getResultsByExam,
  deleteResult,
  getPendingReviews,
  gradeManualAnswer,
  // Exported for unit tests (pure scoring / sanitisation helpers):
  isCorrectAnswer,
  sanitizeQuestionItem,
};
