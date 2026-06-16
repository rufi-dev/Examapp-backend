const asyncHandler = require("express-async-handler");
const Exam = require("../models/examModel");
const PDF = require("../models/pdfModel");
const Tag = require("../models/tagModel");
const Class = require("../models/classModel");
const Question = require("../models/questionModel");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const User = require("../models/userModel");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

// Delete a server-hosted PDF file from disk. No-op for remote (Cloudinary) URLs.
function deleteLocalPdf(pdfUrl) {
  if (!pdfUrl || typeof pdfUrl !== "string") return;
  const marker = "/uploads/";
  const i = pdfUrl.indexOf(marker);
  if (i === -1) return;
  const name = path.basename(pdfUrl.slice(i + marker.length).split(/[?#]/)[0]);
  if (name) fs.unlink(path.join("uploads", name), () => {});
}

// Add Tag
const addTag = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(500);
    throw new Error("Name field required");
  }

  const exists = await Tag.findOne({ name });

  if (exists) {
    res.status(500);
    throw new Error("Tag with this name already exists");
  }

  await Tag.create({ name });
  res.status(200).json({ name });
});

// Add Class
const addClass = asyncHandler(async (req, res) => {
  const { level } = req.body;
  const { tagId } = req.params;

  try {
    if (!level) {
      res.status(400).json({ error: "Level field required" });
      return;
    }

    const tag = await Tag.findById(tagId);

    if (!tag) {
      res.status(404).json({ error: "No Tag found" });
      return;
    }

    const newClass = await Class.create({ level, tag: tagId });
    tag.classes.push(newClass._id);
    await tag.save();

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

  res.status(200).json(_class);
});

// Get Tags
const getTags = asyncHandler(async (req, res) => {
  const tags = await Tag.find().populate("exams");

  if (!tags) {
    res.status(404);
    throw new Error("No tags found");
  }

  res.status(200).json(tags);
});

// Get Tags
const getTag = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const tag = await Tag.findById(id);

  if (!tag) {
    res.status(404);
    throw new Error("No tag found");
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
    pdf,
  } = req.body;
  const { classId } = req.params;

  // Check if all required fields are present
  if (!name || !duration || !totalMarks || !passingMarks || !pdf) {
    res
      .status(400)
      .json({ success: false, message: "All fields are required" });
    return;
  }
  try {
    // Create a PDF entry
    const pdfModel = new PDF({
      path: pdf,
    });
    // Save the PDF entry to the database
    const savedPdf = await pdfModel.save();

    // Create an exam entry with the PDF ID

    const existingClass = await Class.findById(classId);
    if (!existingClass) {
      return res.status(404).json({ success: false, error: "Class not found" });
    }

    const newExam = new Exam({
      name,
      duration,
      price,
      totalMarks,
      passingMarks,
      maxTry,
      showScore: showScore === "true" || showScore === true,
      showCorrectAnswers: showCorrectAnswers === "true" || showCorrectAnswers === true,
      revealAfterEnd: revealAfterEnd === "true" || revealAfterEnd === true,
      password: typeof password === "string" ? password : "",
      videoLink,
      startDate,
      endDate,
      class: classId,
      pdf: savedPdf._id, // Assign the PDF ID to the exam's pdf field
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
const uploadPdf = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error("Fayl tapılmadı");
  }
  const url = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
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

    // Students may only fetch the PDF once they've actually started an attempt
    // (which requires the exam password, if any) or already have a result.
    // This keeps the questions PDF behind the same gate as the answer sheet.
    const isStaff =
      req.user && (req.user.role === "admin" || req.user.role === "teacher");
    if (!isStaff) {
      const [hasAttempt, hasResult] = await Promise.all([
        Attempt.countDocuments({ userId: req.user._id, examId }),
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

    res.status(200).json(pdf);
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

  // Paid exams require a valid Stripe-issued token. Free exams (price 0)
  // are added directly, with no payment step.
  if (token) {
    const decodedToken = jwt.verify(token, process.env.JWT_SECRET);
    if (!decodedToken.userId) {
      res.status(401);
      throw new Error("Unauthorized");
    }
  } else if (exam.price && Number(exam.price) > 0) {
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

  res.status(200).json(exam);
});

const addExamToUserById = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { examId } = req.body;
  const user = await User.findById(userId);
  console.log(req.body);
  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }
  if (!examId) {
    res.status(404);
    throw new Error("Exam is not defined");
  }

  const isExamExist = user.exams.includes(examId);

  const exam = await Exam.findById(examId);

  if (!exam) {
    res.status(404);
    throw new Error("No Exam found");
  }

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

  const objectId = new mongoose.Types.ObjectId(classId);

  const exams = await Exam.find({ class: objectId }).populate("questions");

  if (!exams) {
    res.status(500);
    throw new Error("No Exams Added yet");
  }

  res.status(200).json(exams);
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
    const classes = await Class.find({ tag: tagId });

    if (classes.length === 0) {
      res.status(404).json({ message: "No classes found for this tag" });
      return;
    }

    res.status(200).json(classes);
  } catch (error) {
    console.error("Error fetching classes by tag:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const getExams = asyncHandler(async (req, res) => {
  const exams = await Exam.find({});

  if (!exams) {
    res.status(500);
    throw new Error("No Exams Found yet");
  }

  res.status(200).json(exams);
});

const getExam = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const exam = await Exam.findById(id).populate("pdf").populate("questions");

  if (!exam) {
    res.status(404);
    throw new Error("No exams found");
  }

  // Never expose the correct answers to students through the exam payload.
  const isStaff = req.user && (req.user.role === "admin" || req.user.role === "teacher");
  const obj = exam.toObject();
  if (!isStaff) {
    if (obj.questions && Array.isArray(obj.questions.correctAnswers)) {
      obj.questions.correctAnswers = obj.questions.correctAnswers.map((q) => ({
        type: q.type,
        options: q.options,
      }));
    }
    // Never leak the access password or the PDF location to students here;
    // the PDF is fetched only through the gated getPdfByExam.
    delete obj.password;
    delete obj.pdf;
  }

  res.status(200).json(obj);
});

const addQuestion = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { correctAnswers } = req.body;

  if (!correctAnswers || !examId) {
    res.status(400).json({ message: "All fields are required" });
    return;
  }

  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404).json({ message: "Exam not found" });
    return;
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

  const tag = await Tag.findById(_class.tag);
  if (!tag) {
    res.status(404).json({ message: "Qrup tapilmadi" });
    return;
  }
  res.status(200).json({ tag, _class });
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
  }
  return obj;
}

const ATTEMPT_GRACE_MS = 30 * 1000;

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

  const payload = (attempt) => ({
    attemptId: attempt._id,
    expiresAt: attempt.expiresAt,
    name: exam.name,
    duration: exam.duration,
    questions: correctAnswers.map((q) => ({ type: q.type, options: q.options })),
  });

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
    if (new Date(attempt.expiresAt).getTime() > now) {
      return res.status(200).json(payload(attempt));
    }
    attempt.submitted = true; // expired without submitting -> a used try
    await attempt.save();
  }

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

  if (!correctAnswers.length) return res.status(403).json({ reason: "no_questions" });

  // Enforce maxTry (number of started tries; also counts legacy results).
  const maxTry = exam.maxTry || 0;
  if (maxTry > 0) {
    const [attemptCount, resultCount] = await Promise.all([
      Attempt.countDocuments({ userId: user._id, examId }),
      Result.countDocuments({ userId: user._id, examId }),
    ]);
    if (Math.max(attemptCount, resultCount) >= maxTry)
      return res.status(403).json({ reason: "max_tries" });
  }

  const startedAt = new Date(now);
  const expiresAt = new Date(now + (exam.duration || 0) * 1000);
  attempt = await Attempt.create({ userId: user._id, examId, startedAt, expiresAt });

  return res.status(200).json(payload(attempt));
});

// Lightweight check used by the details page: is there an exam in progress for
// this user (so "Start" can become "Resume")? Server-truth only.
const attemptStatus = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const attempt = await Attempt.findOne({
    userId: req.user._id,
    examId,
    submitted: false,
  }).sort({ createdAt: -1 });
  const active =
    !!attempt && new Date(attempt.expiresAt).getTime() > Date.now();
  res.status(200).json({ active, expiresAt: active ? attempt.expiresAt : null });
});

const addResult = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { selectedAnswers } = req.body;
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

  const now = Date.now();
  if (exam.startDate && new Date(exam.startDate).getTime() > now) {
    res.status(400);
    throw new Error("İmtahan hələ başlamayıb");
  }
  if (exam.endDate && new Date(exam.endDate).getTime() < now) {
    res.status(400);
    throw new Error("İmtahan artıq bitib");
  }

  // The in-progress attempt is the source of truth for the deadline.
  const attempt = await Attempt.findOne({
    userId: user._id,
    examId,
    submitted: false,
  }).sort({ createdAt: -1 });
  if (!attempt) {
    res.status(400);
    throw new Error("Aktiv imtahan cəhdi tapılmadı");
  }
  if (new Date(attempt.expiresAt).getTime() + ATTEMPT_GRACE_MS < now) {
    attempt.submitted = true;
    await attempt.save();
    res.status(400);
    throw new Error("İmtahan vaxtı bitib");
  }

  // Score on the server, against answers the client never received.
  const correct = exam.questions?.correctAnswers || [];
  const points = questionPoints(correct.length);
  const sel = Array.isArray(selectedAnswers) ? selectedAnswers : [];
  const counts = { Cm: 0, Co: 0, Cd: 0, Cma: 0 };
  let earnedPoints = 0;
  correct.forEach((ca, i) => {
    const s = sel[i];
    if (s && s.answer != null && s.answer !== "" && s.answer === ca.answer) {
      earnedPoints += points[i] || 0;
      if (counts[ca.type] !== undefined) counts[ca.type]++;
    }
  });
  earnedPoints = Math.round(earnedPoints * 100) / 100;

  const newResult = await Result.create({
    userId: user._id,
    examId,
    attempts: sel.filter((a) => a && a.answer).length,
    earnPoints: earnedPoints,
    selectedAnswers: sel.map((a) => ({ type: a?.type, answer: a?.answer })),
    correctAnswers: correct.map((a) => ({ type: a.type, answer: a.answer })),
    correctAnswersByType: [
      { type: "Cm", count: counts.Cm },
      { type: "Co", count: counts.Co },
      { type: "Cd", count: counts.Cd },
      { type: "Cma", count: counts.Cma },
    ],
  });

  attempt.submitted = true;
  await attempt.save();

  exam.results.push(newResult._id);
  await exam.save();
  user.results.push(newResult._id);
  await user.save();

  res.status(200).json({ message: "Result has been saved", earnPoints: earnedPoints });
});

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

const getResultsByExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const exam = await Exam.findById(examId);

  if (!exam) {
    res.status(404);
    throw new Error("No Exam Found!");
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

  const results = await Result.find({ userId: user._id, examId })
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

  const result = await Result.findById(resultId).populate({
    path: "examId",
    populate: {
      path: "questions",
    },
  });
  if (!result) {
    res.status(404);
    throw new Error("No Result Found!");
  }

  const isStaff = user.role === "admin" || user.role === "teacher";
  const isOwner = result.userId?.toString() === user._id.toString();
  if (!isOwner && !isStaff) {
    res.status(403);
    throw new Error("Bu nəticəyə icazəniz yoxdur");
  }

  const vis = resultVisibility(result.examId, user);
  const obj = result.toObject();
  obj.visibility = vis;
  if (!vis.canSeeScore) {
    obj.earnPoints = null;
    obj.correctAnswersByType = null;
  }
  if (!vis.canSeeAnswers) {
    obj.correctAnswers = null;
    if (obj.examId && obj.examId.questions && Array.isArray(obj.examId.questions.correctAnswers)) {
      obj.examId.questions.correctAnswers = obj.examId.questions.correctAnswers.map((q) => ({
        type: q.type,
        options: q.options,
      }));
    }
  }
  res.status(200).json(obj);
});

const editQuestion = asyncHandler(async (req, res) => {
  const { questionId } = req.params;
  const { name, correctOption, options } = req.body;

  const questionExists = await Question.findById(questionId);

  if (questionExists) {
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
    pdfPath,
  } = req.body;
  const examExists = await Exam.findById(examId);
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
    };
    // Only touch the solution images when the client sends them, so partial
    // edits don't wipe the existing list.
    if (Array.isArray(solutionPhotos)) update.solutionPhotos = solutionPhotos;
    // Empty string disables the password; undefined leaves it unchanged.
    if (typeof password === "string") update.password = password;
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
  const { level } = req.body;
  if (!level) {
    res.status(400);
    throw new Error("Sinif xanasını doldurun");
  }
  const classExists = await Class.findById(classId);
  if (!classExists) {
    res.status(404);
    throw new Error("Sinif tapılmadı!");
  }
  await Class.findByIdAndUpdate(classId, { level });
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

// Remove a class and every exam under it.
async function purgeClass(classId) {
  const _class = await Class.findById(classId);
  if (!_class) return;
  const exams = await Exam.find({ class: classId }).select("_id");
  for (const e of exams) await purgeExam(e._id);
  if (_class.tag) await Tag.updateOne({ _id: _class.tag }, { $pull: { classes: classId } });
  await _class.deleteOne();
}

// Remove a tag and every class + exam under it.
async function purgeTag(tagId) {
  const tag = await Tag.findById(tagId);
  if (!tag) return;
  const classes = await Class.find({ tag: tagId }).select("_id");
  for (const c of classes) await purgeClass(c._id);
  const orphanExams = await Exam.find({ tag: tagId }).select("_id");
  for (const e of orphanExams) await purgeExam(e._id);
  await tag.deleteOne();
}

const deleteExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404);
    throw new Error("Exam not found!");
  }
  await purgeExam(examId);
  res.status(200).json({ message: "Exam deleted succesfully" });
});

const deleteClass = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const _class = await Class.findById(classId);
  if (!_class) {
    res.status(404);
    throw new Error("Class not found!");
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

  if (user.exams.length > 0) {
    res.status(200).json(user.exams);
  } else {
    res.status(200).json([]);
  }
});

module.exports = {
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
  deleteClass,
  deleteTag,
  editTag,
  editClass,
  addPhotoToResult,
  addResult,
  startAttempt,
  attemptStatus,
  uploadPdf,
  getResultsByUser,
  getResultsByUserByExam,
  getClass,
  getClassesByTag,
  addExamToUser,
  getExamsByUser,
  getExams,
  reviewByResult,
  deleteMyExam,
  addExamToUserById,
  getPdfByExam,
  deleteAllQuestions,
  getExamTagandClass,
  getResultsByExam,
};
