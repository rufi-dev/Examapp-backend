const asyncHandler = require("express-async-handler");
const Exam = require("../models/examModel");
const PDF = require("../models/pdfModel");
const Tag = require("../models/tagModel");
const Class = require("../models/classModel");
const Question = require("../models/questionModel");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const User = require("../models/userModel");
const Enrollment = require("../models/enrollmentModel");
const { notifyExamStarted, notifyExamFinished } = require("../helper/telegram");
const { notifyStudentsNewExam } = require("../helper/whatsapp");
const { PRESETS } = require("../helper/examPresets");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");
// Only used to VERIFY a checkout session was actually paid before unlocking a
// paid exam. Null if Stripe isn't configured (paid adds then fail closed).
const stripe = process.env.STRIPE_KEY ? Stripe(process.env.STRIPE_KEY) : null;

// Delete a server-hosted PDF file from disk. No-op for remote (Cloudinary) URLs.
function deleteLocalPdf(pdfUrl) {
  if (!pdfUrl || typeof pdfUrl !== "string") return;
  const marker = "/uploads/";
  const i = pdfUrl.indexOf(marker);
  if (i === -1) return;
  const name = path.basename(pdfUrl.slice(i + marker.length).split(/[?#]/)[0]);
  if (name) fs.unlink(path.join("uploads", name), () => {});
}

// ---- visibility scoping -----------------------------------------------------
// Categories/classes/exams are owned by the teacher who created them. Teachers
// see only their own; students see only what their APPROVED class enrollments
// expose; admins see everything. Every list/read endpoint funnels through these.

const isStaffUser = (u) => !!u && (u.role === "admin" || u.role === "teacher");
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
    // Create a PDF entry only in PDF mode. Structured exams have no PDF doc.
    let savedPdf = null;
    if (!isStructured) {
      const pdfModel = new PDF({
        path: pdf,
      });
      // Save the PDF entry to the database
      savedPdf = await pdfModel.save();
    }

    // Create an exam entry with the PDF ID

    const existingClass = await Class.findById(classId);
    if (!existingClass) {
      return res.status(404).json({ success: false, error: "Class not found" });
    }
    // Only the class OWNER (or admin) may add exams into it — otherwise any
    // teacher could plant an exam in someone else's class.
    if (!ownsOrAdmin(req.user, existingClass)) {
      return res.status(403).json({ success: false, error: "Bu sinif sizə aid deyil" });
    }

    const newExam = new Exam({
      name,
      duration,
      price,
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
      studentSolutionPhotos: studentSolutionPhotos === "true" || studentSolutionPhotos === true,
      coverImage: typeof coverImage === "string" ? coverImage : "",
      videoLink,
      startDate,
      endDate,
      class: classId,
      owner: req.user._id,
      // Only PDF exams carry a pdf reference.
      ...(savedPdf ? { pdf: savedPdf._id } : {}),
    });
    // Save the exam entry
    await newExam.save();

    existingClass.exams.push(newExam._id);
    await existingClass.save();

    // Return success response
    res.status(201).json({ success: true, data: newExam });
  } catch (error) {
    console.error("Error saving PDF:", error);
    res.status(500).json({ success: false, error: "Failed to save PDF" });
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
  const url = httpsify(
    `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`
  );
  res.status(200).json({ url, filename: req.file.filename });
});

const getPdfByExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;

  if (!examId) {
    res.status(404);
    throw new Error("Exam is not defined!");
  }

  try {
    const exam = await Exam.findById(examId);

    if (!exam) {
      res.status(404);
      throw new Error("Exam not found!");
    }

    // Only the exam's OWNER (or admin) may fetch the questions PDF freely.
    // Everyone else — students AND other teachers — must have actually started
    // an attempt (which requires the exam password, if any) or hold a result.
    // Previously ANY staff bypassed this, so a throwaway "teacher" account could
    // pull any exam's PDF.
    const isOwner = ownsOrAdmin(req.user, exam);
    if (!isOwner) {
      const [hasAttempt, hasResult] = await Promise.all([
        Attempt.countDocuments({ userId: req.user._id, examId, unscorable: { $ne: true } }),
        Result.countDocuments({ userId: req.user._id, examId }),
      ]);
      if (!hasAttempt && !hasResult) {
        return res
          .status(403)
          .json({ reason: "no_access", error: "İmtahana giriş yoxdur" });
      }
    }

    // Fetch the PDF associated with the exam
    const pdf = await PDF.findById(exam.pdf);

    if (!pdf) {
      res.status(500);
      throw new Error("PDF not found");
    }

    // Force https so the PWA's mixed-content guard doesn't block the viewer.
    const out = pdf.toObject();
    out.path = httpsify(out.path);
    res.status(200).json(out);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const addExamToUser = asyncHandler(async (req, res) => {
  const { token } = req.query;
  const { examId } = req.params;

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
  if (!exam) {
    res.status(404);
    throw new Error("No Exam found");
  }

  // Paid exams require a real, verified Stripe payment. Free exams (price 0)
  // are added directly, with no payment step.
  const isPaid = exam.price && Number(exam.price) > 0;
  if (token) {
    let decodedToken;
    try {
      decodedToken = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      res.status(401);
      throw new Error("Unauthorized");
    }
    // Bind the token to THIS user, THIS exam, and the purchase token type: a
    // token minted for one user/exam (or a login token) can't be replayed here.
    if (
      decodedToken.typ !== "exam_purchase" ||
      !decodedToken.userId ||
      String(decodedToken.userId) !== String(req.user._id) ||
      String(decodedToken.examId) !== String(examId)
    ) {
      res.status(401);
      throw new Error("Unauthorized");
    }
    // PROOF OF PAYMENT: a self-minted token is NOT proof a payment happened, so
    // for paid exams verify the Stripe Checkout Session was actually paid (and
    // belongs to this user+exam). Fail closed.
    if (isPaid) {
      const sessionId = req.query.session_id;
      if (!stripe) {
        res.status(500);
        throw new Error("Ödəniş yoxlanışı konfiqurasiya olunmayıb");
      }
      let session;
      try {
        session = sessionId
          ? await stripe.checkout.sessions.retrieve(String(sessionId))
          : null;
      } catch {
        session = null;
      }
      if (
        !session ||
        session.payment_status !== "paid" ||
        String(session.metadata?.userId) !== String(req.user._id) ||
        String(session.metadata?.examId) !== String(examId)
      ) {
        res.status(402);
        throw new Error("Ödəniş təsdiqlənmədi");
      }
    }
  } else if (isPaid) {
    res.status(400);
    throw new Error("Bu imtahan ödənişlidir");
  }

  if (user.exams.includes(examId)) {
    res.status(400);
    throw new Error("Bu imtahan artıq əlavə edilib");
  }

  user.exams.push(examId);
  await user.save();

  exam.users.push(user._id);
  await exam.save();

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

  const isExamExist = user.exams.includes(examId);

  if (isExamExist) {
    res.status(500);
    throw new Error("Exam has already been added!");
  } else {
    user.exams.push(examId);
    await user.save();

    exam.users.push(user._id);
    await exam.save();

    res.status(200).json({ message: "Exam successfully added" });
  }
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

function sanitizeQuestionItem(q) {
  const out = { type: q.type };
  // Legacy PDF letters.
  if (q.options !== undefined) out.options = q.options;
  // Structured question content (absent on PDF exams).
  if (q.text !== undefined) out.text = q.text;
  if (q.title !== undefined) out.title = q.title; // reading passage heading
  if (q.kind !== undefined) out.kind = q.kind; // section block kind (reading/listening)
  if (q.audio !== undefined) out.audio = q.audio; // listening-section audio
  if (q.covers !== undefined) out.covers = q.covers; // questions this block governs
  if (q.blanks !== undefined) out.blanks = q.blanks; // open: number of answer boxes
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
    let filter = { tag: tagId };
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
  let filter = {};
  if (!isAdminUser(req.user)) {
    const classIds = await approvedClassIds(req.user._id);
    // Owned, approved-enrolled, OR public (requireCode:false) classes.
    filter = {
      $or: [
        { owner: req.user._id },
        { _id: { $in: classIds } },
        { requireCode: false },
      ],
    };
  }
  const classes = await Class.find(filter).sort({ createdAt: -1 }).lean();
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
    });
  }

  res.status(200).json(classes || []);
});

// Used by the teacher "İmtahan nəticələri" list — scoped so a teacher sees only
// their OWN exams (admins see all).
const getExams = asyncHandler(async (req, res) => {
  const filter = { deletedAt: null, ...(isAdminUser(req.user) ? {} : { owner: req.user._id }) };
  const exams = await Exam.find(filter);
  res.status(200).json(exams || []);
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
    // approved enrollment (or the legacy per-user grant), and gets the SANITIZED
    // view (no answer key / password / pdf).
    const ownsLegacy =
      (req.user.exams || []).some((e) => String(e) === String(id)) ||
      (exam.users || []).some((u) => String(u) === String(req.user._id));
    const enrolled = await studentApprovedInClass(req.user._id, exam.class);
    // Public class → any signed-in user may view the (sanitized) exam.
    const classDoc = exam.class
      ? await Class.findById(exam.class).select("requireCode").lean()
      : null;
    if (!ownsLegacy && !enrolled && !classIsPublic(classDoc)) {
      res.status(403);
      throw new Error("Bu imtahana giriş yoxdur");
    }
    return res.status(200).json(sanitizeExamForStudent(exam));
  }

  const obj = exam.toObject();
  if (obj.pdf?.path) obj.pdf.path = httpsify(obj.pdf.path);
  res.status(200).json(obj);
});

const addQuestion = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { correctAnswers, questionsPerPage, forwardOnly, typePoints, listeningAudio } = req.body;

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
  if (listeningAudio !== undefined) {
    exam.listeningAudio = typeof listeningAudio === "string" ? listeningAudio.trim() : "";
    await exam.save();
  }

  // Persist the structured per-page layout (0 = show all) alongside the answer
  // key, so saving questions also saves this setting in one round-trip.
  if (questionsPerPage !== undefined || forwardOnly !== undefined || typePoints !== undefined) {
    if (questionsPerPage !== undefined) {
      exam.questionsPerPage = Math.max(0, Math.min(50, Number(questionsPerPage) || 0));
    }
    if (forwardOnly !== undefined) {
      exam.forwardOnly = forwardOnly === true || forwardOnly === "true";
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
      exam.typePoints = tp && Object.keys(tp).length ? tp : undefined;
      exam.markModified("typePoints");
    }
    await exam.save();
  }

  // If this exam already has a question set, replace its answers instead of
  // refusing — this lets admins re-save / edit the answer key.
  if (exam.questions) {
    const updated = await Question.findByIdAndUpdate(
      exam.questions,
      { correctAnswers },
      { new: true }
    );
    if (updated) {
      // The exam now has its answer key — announce it to students (no-op until
      // WhatsApp is configured; idempotent + skips drafts). Fire-and-forget.
      notifyStudentsNewExam(examId).catch(() => {});
      return res
        .status(200)
        .json({ message: "Answers updated successfully", newQuestion: updated });
    }
    // Linked question doc is missing (dangling ref): fall through and recreate.
  }

  const convertedExamId = new mongoose.Types.ObjectId(examId);
  const newQuestion = await Question.create({
    correctAnswers,
    exam: convertedExamId,
  });

  exam.questions = newQuestion._id;
  await exam.save();

  // Exam is now ready (has questions) — announce to students. Fire-and-forget.
  notifyStudentsNewExam(examId).catch(() => {});

  res.status(200).json({ message: "Answers added successfully", newQuestion });
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
  if (user && (user.role === "admin" || user.role === "teacher"))
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
  if (!vis.canSeeScore) {
    obj.earnPoints = null;
    obj.correctAnswersByType = null;
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

  const payload = (attempt) => {
    const order = attempt.optionOrder || null;
    return {
      attemptId: attempt._id,
      // Effective deadline (capped at the exam's CURRENT endDate) so a shortened
      // window takes effect on the client timer immediately on resume.
      expiresAt: new Date(effectiveExpiry(attempt, exam)),
      name: exam.name,
      duration: exam.duration,
      antiCheat: !!exam.antiCheat,
      // Server-truth anti-cheat state so a reload/resume restores the real count
      // (it can't be wiped by refreshing or clearing localStorage).
      violations: attempt.violations || 0,
      terminated: !!attempt.terminated,
      // "pdf" or "structured" so the runner knows whether to show the PDF panel
      // or render native questions.
      mode: exam.mode === "structured" ? "structured" : "pdf",
      // Structured pagination: questions per page (0 = all on one page). The
      // runner paginates native questions; ignored for PDF exams.
      questionsPerPage: exam.questionsPerPage || 0,
      // Linear mode: the runner hides "back" navigation — student only goes next.
      forwardOnly: !!exam.forwardOnly,
      // When on, the runner shows a per-question "upload solution photo" control.
      studentSolutionPhotos: !!exam.studentSolutionPhotos,
      // Listening-section audio (mp3 URL) — runner shows a player at the top.
      listeningAudio: exam.listeningAudio || "",
      // Same sanitizer as every other student payload: display content only, the
      // answer key (`correct`/`pairs`/`answer`) is never sent to the runner. When
      // options are shuffled, reorder each Cm/Cs question's choices by THIS
      // attempt's stored permutation (stable across resumes).
      questions: correctAnswers.map((q, idx) => {
        const item = sanitizeQuestionItem(q);
        const perm = order && order[idx];
        // Only apply the stored permutation when it still aligns with the current
        // choices. If the question was edited mid-attempt (choice count changed),
        // fall back to canonical order so picks can't map to stale indices.
        if (
          Array.isArray(perm) &&
          Array.isArray(item.choices) &&
          perm.length === item.choices.length
        ) {
          item.choices = perm.map((o) => item.choices[o]);
        }
        return item;
      }),
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
      return res.status(200).json(payload(attempt)); // live resume
    }
    // Expired without submitting -> finalize from the autosaved answers (never a
    // bare `submitted:true` with no Result), then fall through to a possible NEW start.
    await finalizeAttempt(attempt, { reason: "expired_resume" });
    attempt = null;
  }

  // ── NEW START gates (only reached when there is NO in-flight attempt) ─────────
  // A legally-started attempt already resumed/finalized above regardless of these,
  // so archival / hidden / ownership changes never strand an in-flight student.
  const isStaff = user.role === "admin" || user.role === "teacher";
  // Archived (trashed) exams can't be freshly started.
  if (exam.deletedAt) return res.status(403).json({ reason: "finished" });
  // Hidden (draft) exams are not accessible to students.
  if (exam.hidden && !isStaff) return res.status(403).json({ reason: "not_started" });
  // Ownership gate: a student must have ACQUIRED the exam (free add, paid purchase,
  // or teacher assignment). A FREE exam is accessible to an approved-enrolled
  // student OR one whose class is PUBLIC; paid exams still go through purchase.
  const isFree = !exam.price || Number(exam.price) === 0;
  let classFreeAccess = false;
  if (isFree && exam.class) {
    if (await studentApprovedInClass(user._id, exam.class)) {
      classFreeAccess = true;
    } else {
      const classDoc = await Class.findById(exam.class).select("requireCode").lean();
      classFreeAccess = classIsPublic(classDoc);
    }
  }
  const owns =
    user.exams.some((e) => e.toString() === String(examId)) ||
    exam.users.some((u) => u.toString() === user._id.toString()) ||
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

  // An exam whose author never added questions must not be startable — a student
  // would land in a blank paper and burn an attempt.
  if (!correctAnswers.length)
    return res.status(403).json({
      reason: "no_questions",
      message: "Bu imtahana hələ sual əlavə edilməyib. Müəlliminizlə əlaqə saxlayın.",
    });

  // Enforce maxTry (number of started tries; also counts legacy results).
  // Unscorable attempts (deleted exam/user, retired duplicates) never consumed a
  // real try, so they're excluded from the count.
  const maxTry = exam.maxTry || 0;
  if (maxTry > 0) {
    const [attemptCount, resultCount] = await Promise.all([
      Attempt.countDocuments({ userId: user._id, examId, unscorable: { $ne: true } }),
      Result.countDocuments({ userId: user._id, examId }),
    ]);
    if (Math.max(attemptCount, resultCount) >= maxTry)
      return res.status(403).json({ reason: "max_tries" });
  }

  const startedAt = new Date(now);
  // The personal duration timer, but never past the exam's closing time: a
  // student who starts near endDate is cut off at endDate, not given the full
  // duration. expiresAt is server-stored, so the timer survives reloads.
  let expMs = now + (exam.duration || 0) * 1000;
  if (exam.endDate) expMs = Math.min(expMs, new Date(exam.endDate).getTime());
  const expiresAt = new Date(expMs);
  // Per-student choice shuffle: generate the permutation ONCE at creation and
  // store it on the attempt, so resume shows the same order and submit can map
  // the picks back to original indices.
  const optionOrder =
    exam.shuffleOptions && exam.mode === "structured"
      ? buildOptionOrder(correctAnswers)
      : undefined;
  try {
    attempt = await Attempt.create({
      userId: user._id,
      examId,
      startedAt,
      expiresAt,
      ...(optionOrder ? { optionOrder } : {}),
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
      if (existing) return res.status(200).json(payload(existing));
    }
    throw e;
  }

  // A brand-new attempt was just created (resume/duplicate paths returned
  // above). Ping the exam owner over Telegram — fire-and-forget so a slow or
  // failed notification never delays/blocks the student's start. Gating (event
  // flag + class/exam scope) lives in the helper / the owner's prefs.
  notifyExamStarted(exam, user);

  return res.status(200).json(payload(attempt));
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
  const isStaff = user && (user.role === "admin" || user.role === "teacher");
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
const isMultiBlank = (ca) => (Number(ca.blanks) || 0) > 1 && Array.isArray(ca.blankAnswers);
function blankScore(ca, sel) {
  const n = Number(ca.blanks) || 0;
  const a = sel && sel.answer;
  const m = a && typeof a === "object" && !Array.isArray(a) ? a : {};
  const keys = Array.isArray(ca.blankAnswers) ? ca.blankAnswers : [];
  let graded = 0;
  let correct = 0;
  for (let k = 0; k < n; k++) {
    const acc = (Array.isArray(keys[k]) ? keys[k] : []).map(openNorm).filter(Boolean);
    if (!acc.length) continue;
    graded += 1;
    const got = openNorm(m[k]);
    if (got && acc.includes(got)) correct += 1;
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
      const got = openNorm(a);
      return got !== "" && accepted.some((ans) => openNorm(ans) === got);
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

// Idempotently link a Result into the exam's + user's result arrays. $addToSet so
// a retry / crash-recovery never double-adds (unlike push+save).
async function linkResult(examId, userId, resultId) {
  await Promise.all([
    Exam.updateOne({ _id: examId }, { $addToSet: { results: resultId } }),
    User.updateOne({ _id: userId }, { $addToSet: { results: resultId } }),
  ]);
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

  // Score on the server, against answers the client never received.
  const correct = exam.questions?.correctAnswers || [];
  // Per-question points come from the exam's preset (server-authoritative) and
  // adapt to the actual question count; legacy/custom exams fall back to the
  // original 18/55-45 split (total 100).
  const presetCfg = exam.preset ? PRESETS[exam.preset] : null;
  // Reading passages aren't scored: build the points plan over QUESTIONS ONLY,
  // then scatter the values back into a full-length array (0 at passage slots),
  // so the totals stay exactly 100 even when passages sit between questions.
  const isRead = (c) => c && c.type === "reading";
  const qTypes = correct.filter((c) => !isRead(c)).map((c) => c && c.type);
  const planQ =
    presetCfg && typeof presetCfg.pointsPlan === "function"
      ? presetCfg.pointsPlan(qTypes.length, qTypes)
      : questionPoints(qTypes.length);
  let _qp = 0;
  const autoPoints = correct.map((c) => (isRead(c) ? 0 : planQ[_qp++] || 0));
  // Manual per-type override (builder scoring panel) wins for the types it sets;
  // other types keep the preset's auto points.
  const tp = exam.typePoints && typeof exam.typePoints === "object" ? exam.typePoints : null;
  const points = tp
    ? correct.map((c, i) => {
        const v = c && c.type != null ? tp[c.type] : undefined;
        return v === undefined || v === null || Number.isNaN(Number(v)) ? autoPoints[i] || 0 : Number(v);
      })
    : autoPoints;
  // Negative marking only penalizes wrong answers in questions 1..until
  // (0 / unset = every question, the legacy behavior).
  const until = exam.negMarkUntil > 0 ? Math.min(exam.negMarkUntil, correct.length) : correct.length;
  let sel = Array.isArray(selectedAnswers) ? selectedAnswers : [];

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
  correct.forEach((ca, i) => {
    const s = sel[i];
    if (!isAnswered(s)) return;
    const frac = answerScore(ca, s, exam.partialCredit);
    earnedPoints += (points[i] || 0) * frac;
    if (frac >= 1) {
      if (counts[ca.type] !== undefined) counts[ca.type]++;
    } else if (frac <= 0 && i < until) {
      // Wrong only penalizes inside the negative-marking range; blanks never do.
      wrongCount += 1;
    }
  });

  if (exam.negativeMarking && (exam.wrongPerPenalty || 0) > 0) {
    // "One correct's worth" = the average points of a question in the penalized
    // range (the closed section for Blok; all questions for legacy 100-pt exams).
    let rangeSum = 0;
    for (let i = 0; i < until; i++) rangeSum += points[i] || 0;
    const avgPerQuestion = until > 0 ? rangeSum / until : 0;
    const units = Math.floor(wrongCount / exam.wrongPerPenalty);
    const cancelledCorrects = units * (exam.correctPerPenalty || 1);
    earnedPoints = Math.max(0, earnedPoints - cancelledCorrects * avgPerQuestion);
  }
  earnedPoints = Math.round(earnedPoints * 100) / 100;

  const isTerminated =
    !!attempt.terminated || terminated === true || terminated === "true";
  if (isTerminated) earnedPoints = 0;

  const fields = {
    userId: user._id,
    examId,
    attemptId: attempt._id,
    autoSubmitted: !!auto,
    attempts: sel.filter(isAnswered).length,
    earnPoints: earnedPoints,
    violations: Math.max(attempt.violations || 0, Number(violations) || 0),
    terminated: isTerminated,
    selectedAnswers: sel.map((a) => ({
      type: a?.type,
      answer: storableAnswer(a?.answer),
      ...(exam.studentSolutionPhotos && typeof a?.photo === "string" && a.photo
        ? { photo: a.photo }
        : {}),
    })),
    correctAnswers: correct.map((a) => ({ type: a.type, answer: renderableCorrect(a) })),
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
  const { selectedAnswers, violations, terminated, attemptId } = req.body;
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
  const answers =
    !late && Array.isArray(selectedAnswers) ? selectedAnswers : attempt.answers || [];
  const earnPoints = await scoreAndCreateResult(exam, user, attempt, answers, {
    violations,
    terminated,
  });

  res.status(200).json({ message: "Result has been saved", earnPoints, late });
});

// Periodic autosave of the in-progress selections onto the active attempt, so
// the server can finalize the exam even if the student never submits. Cheap:
// stores the draft only (no scoring). Touches only the owner's OWN live attempt.
const autosaveAttempt = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { selectedAnswers, attemptId, currentQuestion, answeredCount } = req.body;
  if (!Array.isArray(selectedAnswers)) {
    return res.status(200).json({ ok: false });
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
      return res.status(409).json({ ok: false, reason: "invalid_attempt" });
    }
  } else {
    attempt = await Attempt.findOne({
      userId: req.user._id,
      examId,
      submitted: false,
    }).sort({ createdAt: -1 });
    if (!attempt) return res.status(200).json({ ok: false });
  }
  if (attempt.unscorable) return res.status(409).json({ ok: false, reason: "unscorable" });
  // STRICT deadline cutoff (NO grace): drop autosaves past the effective deadline
  // so attempt.answers can never contain post-deadline edits (which the late-submit
  // path scores). effectiveExpiry honors a shortened exam.endDate.
  const examDl = await Exam.findById(examId).select("endDate").lean();
  if (Date.now() > effectiveExpiry(attempt, examDl)) {
    return res.status(200).json({ ok: false, reason: "expired" });
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
  await Attempt.updateOne(filter, { $set: set });
  res.status(200).json({ ok: true });
});

// Live exam watch (owner/admin only): who is currently writing this exam, which
// question they're on, progress, time, and live violations. The runner pushes a
// heartbeat via autosave; this reads the active attempts.
const LIVE_ACTIVE_MS = 30 * 1000; // heartbeat within 30s → "active"
const getLiveAttempts = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const exam = await Exam.findById(examId).populate("questions");
  if (!exam) {
    res.status(404);
    throw new Error("Exam not found");
  }
  if (!ownsOrAdmin(req.user, exam)) {
    return res.status(403).json({ message: "Bu imtahan sizə aid deyil" });
  }
  const total = (exam.questions?.correctAnswers || []).length;
  const now = Date.now();
  // Live attempts only: unsubmitted and not long-expired (the finalizer clears
  // dead ones within a minute, but exclude clearly-past ones from the view).
  const attempts = await Attempt.find({
    examId,
    submitted: false,
    expiresAt: { $gt: new Date(now - 2 * 60 * 1000) },
  })
    .populate("userId", "name email grade")
    .sort({ lastSeenAt: -1, startedAt: -1 })
    .lean();
  const students = attempts.map((a) => {
    const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    return {
      attemptId: a._id,
      name: a.userId?.name || "—",
      email: a.userId?.email || "",
      grade: a.userId?.grade || "",
      currentQuestion: a.currentQuestion || 0,
      answeredCount: a.answeredCount || 0,
      total,
      violations: a.violations || 0,
      terminated: !!a.terminated,
      startedAt: a.startedAt,
      expiresAt: a.expiresAt,
      lastSeenAt: a.lastSeenAt || null,
      active: !!seen && now - seen < LIVE_ACTIVE_MS,
    };
  });
  res.status(200).json({
    examName: exam.name,
    total,
    activeCount: students.filter((s) => s.active).length,
    serverNow: new Date(now),
    students,
  });
});

// Finalize ONE attempt: load its exam + user, score from the given (or autosaved)
// answers, and ensure the attempt ends terminal. If the exam or user was deleted,
// the attempt can never be scored -> mark it terminal `unscorable` (never left
// dangling `submitted:false` counting toward tries). Meta (violations/terminated)
// is merged MONOTONICALLY. Idempotent via scoreAndCreateResult's attemptId key.
async function finalizeAttempt(attempt, opts = {}) {
  const { answersOverride, meta, reason, suppressNotifications } = opts;
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
  const m = meta || {};
  const mergedTerminated =
    !!attempt.terminated || m.terminated === true || m.terminated === "true";
  const mergedViolations = Math.max(attempt.violations || 0, Number(m.violations) || 0);
  const answers = answersOverride != null ? answersOverride : attempt.answers || [];
  // scoreAndCreateResult stamps attemptId, creates-or-reconciles the Result, and
  // flips submitted:true (result-first). A crash before that flip leaves
  // submitted:false + Result, healed by the migration / attemptStatus / start.
  // auto:true marks this as a SERVER autosave finalize (observability only) — a
  // later real client submit still only RECONCILES it, never overwrites (anti-cheat).
  return scoreAndCreateResult(exam, user, attempt, answers, {
    violations: mergedViolations,
    terminated: mergedTerminated,
    suppressNotifications,
    auto: true,
  });
}

// ── Server-side safety net ──────────────────────────────────────────────────
// Once an exam is started it WILL be scored. When an attempt's timer runs out
// and the student never submitted (closed the tab, lost connection, abandoned
// it), the server auto-submits the LAST autosaved answers and creates the
// result — so the student/teacher can see it later. Runs on an interval from
// server.js. A grace window lets a live client submit first; there is NO
// pre-claim — scoreAndCreateResult is idempotent (unique attemptId) and
// result-first, so the client and the job converge on one Result if they race.
const FINALIZE_GRACE_MS = 60 * 1000;
async function finalizeExpiredAttempts() {
  let finalized = 0;
  try {
    const now = Date.now();
    const nowD = new Date(now);
    // Floor: ignore very old orphan attempts so the FIRST run after deploy
    // doesn't resurrect months of history in one burst. Going forward the job
    // runs every minute, so nothing legitimate ever ages past this window.
    const floor = new Date(now - 7 * 24 * 60 * 60 * 1000);
    // Candidates come from TWO sources so a shortened exam.endDate is honored:
    //   (a) attempts whose RAW expiresAt has already passed, and
    //   (b) attempts whose exam's endDate has passed even though their raw
    //       expiresAt is still in the future (teacher shortened the window).
    const rawExpired = await Attempt.find({
      submitted: false,
      unscorable: { $ne: true },
      expiresAt: { $lt: nowD, $gt: floor },
    })
      .sort({ expiresAt: 1 })
      .limit(200)
      .lean();
    const endedExams = await Exam.find({ endDate: { $lt: nowD, $gt: floor } })
      .select("_id")
      .lean();
    let endedAttempts = [];
    if (endedExams.length) {
      endedAttempts = await Attempt.find({
        examId: { $in: endedExams.map((e) => e._id) },
        submitted: false,
        unscorable: { $ne: true },
        expiresAt: { $gte: nowD, $gt: floor },
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
        // NO pre-claim: scoreAndCreateResult is idempotent (unique attemptId) and
        // RESULT-FIRST (creates the Result, then flips submitted). So a crash can
        // never leave submitted:true with no Result, and a racing client submit
        // converges to the same single Result instead of a double or a lost one.
        await finalizeAttempt(row, { reason: "finalizer" });
        finalized += 1;
      } catch (e) {
        console.error("[FINALIZE] attempt", String(row._id), "failed:", e.message);
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
  if (!resultId) {
    res.status(400);
    throw new Error("Nəticə id si lazım");
  }

  const result = await Result.findById(resultId);

  if (!result) {
    res.status(404);
    throw new Error("Nəticə tapılmadı");
  }

  result.photos.push(photo);

  await result.save();

  res.status(200).json(result);
});

const getResultsByUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const results = await Result.find({ userId: user._id }).populate("examId");

  if (!results) {
    res.status(404);
    throw new Error("No results found");
  }

  res.status(200).json(
    results.map((r) => applyResultVisibility(r, resultVisibility(r.examId, user)))
  );
});

// STAFF ONLY (route is protect+teacherOnly). This returns RAW, unsanitized
// results (full userId + examId, score + answers) with no per-viewer visibility
// gating, so it MUST never be exposed on a student-reachable route.
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

  const results = await Result.find({ examId })
    .populate("examId")
    .populate("userId");

  if (!results) {
    res.status(404);
    throw new Error("No results found!");
  }

  res.status(200).json(results);
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
  const results = await Result.find({ userId: user._id, examId })
    .sort({ createdAt: 1 })
    .populate("examId")
    .populate("userId");

  if (!results) {
    res.status(404);
    throw new Error("No results found!");
  }

  const vis = resultVisibility(exam, user);
  res.status(200).json(results.map((r) => applyResultVisibility(r, vis)));
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

  // The student (owner of the result), an admin, or the TEACHER WHO OWNS THE
  // EXAM may view a review. Legacy exams with no owner stay open to any teacher.
  const isOwner = result.userId?.toString() === user._id.toString();
  const examOwner = result.examId?.owner;
  const teacherOwnsExam =
    user.role === "teacher" && (!examOwner || String(examOwner) === String(user._id));
  if (!isOwner && user.role !== "admin" && !teacherOwnsExam) {
    res.status(403);
    throw new Error("Bu nəticəyə icazəniz yoxdur");
  }

  const vis = resultVisibility(result.examId, user);
  res.status(200).json(applyResultVisibility(result, vis));
});

const editQuestion = asyncHandler(async (req, res) => {
  const { questionId } = req.params;
  const { name, correctOption, options } = req.body;

  const questionExists = await Question.findById(questionId);

  if (questionExists) {
    const ownerExam = await Exam.findOne({ questions: questionExists._id });
    if (!ownsOrAdmin(req.user, ownerExam)) {
      res.status(403);
      throw new Error("Bu sual sizə aid deyil");
    }
    if (blockIfArchived(res, ownerExam)) return;
    await Question.findByIdAndUpdate(questionId, {
      name,
      correctOption,
      options,
    });

    res.status(200).json({
      message: "Question updated successfully",
    });
  } else {
    res.status(404).json({
      error: "Question not found!",
    });
  }
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
      price,
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

    await Exam.findByIdAndUpdate(examId, update);

    if (pdfPath) {
      // Replacing the PDF: delete the previous file + record first.
      if (examExists.pdf) {
        const oldPdf = await PDF.findById(examExists.pdf);
        if (oldPdf) {
          deleteLocalPdf(oldPdf.path);
          await oldPdf.deleteOne();
        }
      }
      const pdfModel = new PDF({
        path: pdfPath,
      });
      const savedPdf = await pdfModel.save();

      await Exam.findByIdAndUpdate(examId, {
        pdf: savedPdf._id,
      });
    }

    res.status(200).json({
      message: "İmtahan uğurla yeniləndi!",
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

const deleteQuestion = asyncHandler(async (req, res) => {
  const { questionId } = req.params;

  const question = await Question.findById(questionId);

  if (!question) {
    res.status(404);
    throw new Error("Question not found!");
  }
  const exam = await Exam.findOne({ questions: question._id });

  if (exam) {
    if (!ownsOrAdmin(req.user, exam)) {
      res.status(403);
      throw new Error("Bu sual sizə aid deyil");
    }
    if (blockIfArchived(res, exam)) return;
    exam.questions = undefined;
    await exam.save();
  } else {
    res.status(404);
    throw new Error("Exam not found!");
  }

  await question.deleteOne();
  res.status(200).json({ message: "Question deleted succesfully" });
});

const deleteAllQuestions = asyncHandler(async (req, res) => {
  await Question.deleteMany({});
  res.status(200).json({ message: "All questions deleted successfully" });
});

// Fully remove an exam: questions, PDF (disk + record), results, attempts, and
// every reference to it (users, class, tag).
async function purgeExam(examId) {
  const exam = await Exam.findById(examId);
  if (!exam) return;

  await Question.deleteMany({ exam: exam._id });

  if (exam.pdf) {
    const pdfDoc = await PDF.findById(exam.pdf);
    if (pdfDoc) {
      deleteLocalPdf(pdfDoc.path);
      await pdfDoc.deleteOne();
    }
  }

  const results = await Result.find({ examId: exam._id }).select("_id");
  const resultIds = results.map((r) => r._id);
  await Result.deleteMany({ examId: exam._id });
  await Attempt.deleteMany({ examId: exam._id });

  await User.updateMany(
    {},
    { $pull: { exams: exam._id, results: { $in: resultIds } } }
  );
  if (exam.class) await Class.updateOne({ _id: exam.class }, { $pull: { exams: exam._id } });
  await Tag.updateMany({}, { $pull: { exams: exam._id } });

  await exam.deleteOne();
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
async function purgeClass(classId) {
  const _class = await Class.findById(classId);
  if (!_class) return;
  await archiveExams({ class: classId });
  if (_class.tag) await Tag.updateOne({ _id: _class.tag }, { $pull: { classes: classId } });
  await _class.deleteOne();
}

// Remove a tag and its classes. Exams under them are ARCHIVED (Trash), not wiped.
async function purgeTag(tagId) {
  const tag = await Tag.findById(tagId);
  if (!tag) return;
  const classes = await Class.find({ tag: tagId }).select("_id");
  for (const c of classes) await purgeClass(c._id);
  await archiveExams({ tag: tagId });
  await tag.deleteOne();
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
    await Class.updateOne({ _id: exam.class }, { $addToSet: { exams: exam._id } });
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
    await Class.updateOne({ _id: target._id }, { $addToSet: { exams: exam._id } });
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
  const filter = { deletedAt: { $ne: null } };
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

// Sweep: permanently purge exams archived longer than the retention window.
// Scheduled from server.js; safe to run repeatedly.
async function purgeExpiredArchived() {
  const cutoff = new Date(Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const due = await Exam.find({ deletedAt: { $ne: null, $lte: cutoff } }).select("_id");
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
  await purgeClass(classId);
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
  await purgeTag(tagId);
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

  user.exams.pull(examId);
  await user.save();

  exam.users.pull(user._id);
  await exam.save();

  res.status(200).json({ message: "My Exam deleted succesfully" });
});

const getQuestionsByExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;

  if (!examId) {
    res.status(404);
    throw new Error("Exam is not defined!");
  }
  const exam = await Exam.findById(examId);

  if (!exam) {
    res.status(404);
    throw new Error("Exam not found!");
  }

  // The raw Question docs carry the ANSWER KEY (correct[], pairs, openAnswers).
  // Only the exam's owner (or admin) may read them — otherwise anyone who can
  // self-assign the teacher role could pull any exam's answers. Students never
  // hit this route; they get the sanitized runner payload instead.
  if (!ownsOrAdmin(req.user, exam)) {
    res.status(403);
    throw new Error("Bu imtahan sizə aid deyil");
  }

  const questions = await Question.find({ exam: examId });

  if (!questions) {
    res.status(500);
    throw new Error("No Questions Added yet");
  }

  res.status(200).json(questions);
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
  addExam,
  getExamsByClass,
  addTag,
  getTags,
  addQuestion,
  getQuestionsByExam,
  editQuestion,
  deleteQuestion,
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
  finalizeExpiredAttempts,
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
  deleteAllQuestions,
  getExamTagandClass,
  getResultsByExam,
};
