const express = require("express");
const {
  protect,
  adminOnly,
  teacherOnly,
  verifiedOnly,
  requireCompleteProfile,
} = require("../middleware/authMiddleware");
const {
  serverTime,
  addExam,
  getExamsByClass,
  getPdfByExam,
  streamExamPdf,
  uploadPdf,
  addTag,
  getTags,
  addQuestion,
  deleteExam,
  restoreExam,
  deleteExamForever,
  getArchivedExams,
  getExam,
  getTag,
  editExam,
  deleteClass,
  deleteTag,
  editTag,
  editClass,
  setExamHidden,
  addResult,
  autosaveAttempt,
  getLiveAttempts,
  startAttempt,
  attemptStatus,
  reportViolation,
  getExamRank,
  getResultsByUser,
  addPhotoToResult,
  getResultsByUserByExam,
  addExamToUser,
  getExamsByUser,
  getLatestExams,
  getPublicExams,
  reviewByResult,
  deleteMyExam,
  addExamToUserById,
  getExams,
  getClassesByTag,
  getAllClasses,
  addClass,
  getClass,
  getExamTagandClass,
  getResultsByExam,
  getPendingReviews,
  gradeManualAnswer
} = require("../controllers/quizController");
const { extractQuestions, extractQuestionsStream, getAiUsage, chatAssistant, generateQuestions, generateQuestionsStream, transcribeAudio, realtimeToken, listAiModels, regenerateQuestion } = require("../controllers/aiController");
const { aiRateLimit, aiBudgetGuard } = require("../middleware/aiLimit");
// Teacher Success Journey — per-teacher AI credit metering (flag-gated; passthrough when off).
const { chargeAi } = require("../middleware/aiCredit");
// CR-124: decomposed server-derived capabilities on the SHIPPING routes.
const { requireCapability } = require("../helper/teacherCapabilities");
const {
  joinClass,
  myEnrollments,
  leaveClass,
  teacherRequests,
  teacherClasses,
  classStudents,
  assignableStudents,
  addStudentToClass,
  decideEnrollment,
  setJoinSettings,
} = require("../controllers/enrollmentController");
const router = express.Router();
const { deprecatedRoute } = require("../middleware/deprecatedRoute");
const retiredQuestionPath = deprecatedRoute("legacy_question_crud", {
  removalAfter: "2026-10-31",
});

const multer = require("multer");
const fs = require("fs");
// CR-067: the transient upload STAGING dir is configuration-driven (a disposable
// E2E run points it at an OS-temp dir); never hard-code "uploads/".
const { PDF_STAGING_DIR } = require("../helper/examPdfStorage");
if (!fs.existsSync(PDF_STAGING_DIR)) fs.mkdirSync(PDF_STAGING_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, PDF_STAGING_DIR);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage })

// Dedicated PDF storage: unique .pdf filenames staged before the controller
// validates the bytes and moves them into PRIVATE key storage.
const pdfStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PDF_STAGING_DIR),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}.pdf`),
});
const pdfUpload = multer({ storage: pdfStorage, limits: { fileSize: 100 * 1024 * 1024 } });

// In-memory PDF (kept only long enough to base64-encode for the AI extractor;
// 32MB is Anthropic's per-request PDF cap).
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
});

// addExam receives the pdf as a URL *string* field (uploaded earlier via
// /uploadPdf) — never an actual file. Parse the multipart fields in memory with
// a tight cap so this route can NEVER write to disk (and can't be used
// unauthenticated to fill the disk). Text fields still land in req.body.
const formFieldsOnly = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024, files: 0 },
});


router.post("/addTag", protect, requireCapability("exam:manage:own"), addTag);
// AI: extract structured questions from an uploaded PDF (teacher reviews + saves).
router.post(
  "/extractQuestions/:examId",
  protect,
  teacherOnly,
  aiRateLimit,
  aiBudgetGuard,
  memUpload.single("pdf"),
  chargeAi("ai.extract.questions"),
  extractQuestions
);
// Same extraction, streamed over SSE so the teacher watches questions appear.
router.post(
  "/extractQuestionsStream/:examId",
  protect,
  teacherOnly,
  aiRateLimit,
  aiBudgetGuard,
  memUpload.single("pdf"),
  chargeAi("ai.extract.questions"),
  extractQuestionsStream
);
// Admin-only AI spend dashboard data.
router.get("/aiUsage", protect, adminOnly, getAiUsage);
// AI chat assistant for teachers (in-dashboard floating helper).
router.post("/chat", protect, requireCapability("ai:use:own"), aiRateLimit, aiBudgetGuard, chargeAi("ai.chat.message"), chatAssistant);
// AI: generate questions from a text description (for the in-chat exam wizard).
router.post("/generateQuestions/:examId", protect, requireCapability("ai:use:own"), aiRateLimit, aiBudgetGuard, chargeAi("ai.generate.questions"), generateQuestions);
router.post("/generateQuestionsStream/:examId", protect, requireCapability("ai:use:own"), aiRateLimit, aiBudgetGuard, chargeAi("ai.generate.questions"), generateQuestionsStream);

// Which engines the builder may offer for question generation.
router.get("/ai/models", protect, requireCapability("ai:use:own"), listAiModels);
// Rewrite a single question in the builder.
router.post("/regenerateQuestion/:examId", protect, requireCapability("ai:use:own"), aiRateLimit, aiBudgetGuard, chargeAi("ai.regenerate.question"), regenerateQuestion);
// Voice → text (Azerbaijani) for the chat assistant.
router.post("/transcribe", protect, requireCapability("ai:use:own"), aiRateLimit, aiBudgetGuard, memUpload.single("audio"), chargeAi("ai.transcribe.audio"), transcribeAudio);
// Ephemeral token for OpenAI Realtime live transcription (browser → OpenAI direct).
// Mints a client secret the browser uses to talk to OpenAI directly — spend we
// never see in AiUsage, so the daily budget has to gate handing one out.
router.post("/realtime-token", protect, requireCapability("ai:use:own"), aiRateLimit, aiBudgetGuard, chargeAi("ai.realtime.session"), realtimeToken);

// DISPOSABLE-ONLY deterministic AI seam for the Journey E2E (never registered in
// production). It exercises the REAL chargeAi settlement contract without a
// provider: mode=success commits (usable), fail releases (no usable), sse-done
// commits after the authoritative done, sse-fail releases (disconnect-before-done).
if (process.env.EXQ_E2E_DISPOSABLE === "1") {
  router.post("/ai/e2e", protect, requireCapability("ai:use:own"), chargeAi("ai.generate.questions"), (req, res) => {
    const mode = req.query.mode || "success";
    if (mode === "fail") return res.status(502).json({ ok: false });
    if (mode === "sse-fail") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: {\"q\":1}\n\n"); return res.end(); }
    if (mode === "sse-done") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: {\"q\":1}\n\n"); if (req.aiCredit) req.aiCredit.usable(); res.write("data: {\"done\":true}\n\n"); return res.end(); }
    if (req.aiCredit) req.aiCredit.usable();
    return res.json({ ok: true });
  });
}
router.post("/addClass", protect, requireCapability("class:manage:own"), addClass);
router.get("/server-time", serverTime);
// Scoped to the caller (teacher → own, student → enrolled, admin → all), so it
// now requires auth.
router.get("/getTags", protect, getTags);
router.post("/addExam/:classId", protect, requireCapability("exam:create:own"), formFieldsOnly.single("pdf"), addExam);

// ---- enrollment (class membership) ----
router.post("/enroll", protect, verifiedOnly, requireCompleteProfile, joinClass);
router.get("/myEnrollments", protect, myEnrollments);
router.delete("/leaveClass/:classId", protect, leaveClass);
router.get("/teacher/requests", protect, teacherOnly, teacherRequests);
router.get("/teacher/classes", protect, teacherOnly, teacherClasses);
router.get("/class/:classId/students", protect, teacherOnly, classStudents);
router.get("/class/:classId/assignable", protect, teacherOnly, assignableStudents);
router.post("/class/:classId/addStudent", protect, teacherOnly, addStudentToClass);
router.patch("/enrollment/:id", protect, teacherOnly, decideEnrollment);
router.patch("/class/:classId/joinSettings", protect, requireCapability("class:manage:own"), setJoinSettings);
router.post("/addPhotoToResult/:resultId", protect, teacherOnly, addPhotoToResult);
router.get("/getPdfByExam/:examId", protect, getPdfByExam);
// AUD-013 CR-057: authorized private-PDF byte stream (owner/admin/attempt/result).
router.get("/exam/:examId/pdf/stream", protect, streamExamPdf);
router.post("/uploadPdf", protect, requireCapability("exam:create:own"), pdfUpload.single("file"), uploadPdf);
router.get("/getExamTagandClass/:examId", protect, getExamTagandClass);
router.get("/getResultsByExam/:examId", protect, requireCapability("results:view:own"), getResultsByExam);
// Manual grading (MANUAL_GRADING_ENABLED): the teacher's grading queue for an exam,
// and the per-answer verdict submit. Both no-op / 403 when the flag is off.
router.get("/exam/:examId/pending-reviews", protect, requireCapability("results:view:own"), getPendingReviews);
router.patch("/result/:resultId/grade", protect, teacherOnly, gradeManualAnswer);
router.get("/getExamsByClass/:classId", protect, getExamsByClass);
router.get("/getClassesByTag/:tagId", protect, getClassesByTag);
router.get("/getClasses", protect, getAllClasses);
router.post("/addQuestion/:examId", protect, requireCapability("exam:create:own"), addQuestion);
router.patch("/editQuestion/:questionId", protect, teacherOnly, retiredQuestionPath);
router.delete(
  "/deleteQuestion/:questionId",
  protect,
  teacherOnly,
  retiredQuestionPath
);
router.get("/getQuestionsByExam/:examId", protect, teacherOnly, retiredQuestionPath);
router.get("/getExam/:id", protect, getExam);
router.get("/getTag/:id", protect, getTag);
router.get("/getClass/:id", protect, getClass);
router.patch("/editExam/:examId", protect, requireCapability("exam:manage:own"), editExam);
router.delete("/deleteExam/:examId", protect, requireCapability("exam:manage:own"), deleteExam);
// Trash / soft-delete: list archived, restore, or purge forever (owner/admin).
router.get("/archivedExams", protect, requireCapability("exam:manage:own"), getArchivedExams);
router.patch("/exam/:examId/restore", protect, requireCapability("exam:manage:own"), restoreExam);
router.delete("/exam/:examId/forever", protect, requireCapability("exam:manage:own"), deleteExamForever);
router.delete("/deleteClass/:classId", protect, requireCapability("class:manage:own"), deleteClass);
router.delete("/deleteTag/:tagId", protect, requireCapability("exam:manage:own"), deleteTag);
router.patch("/editTag/:tagId", protect, requireCapability("exam:manage:own"), editTag);
router.patch("/editClass/:classId", protect, requireCapability("class:manage:own"), editClass);
router.patch("/setExamHidden/:examId", protect, requireCapability("exam:manage:own"), setExamHidden);
router.post("/exam/:examId/start", protect, requireCompleteProfile, startAttempt);
router.post("/exam/:examId/autosave", protect, autosaveAttempt);
router.get("/exam/:examId/attemptStatus", protect, attemptStatus);
// Live exam watch — owner/admin sees who is currently writing + their progress.
router.get("/exam/:examId/live", protect, getLiveAttempts);
router.post("/exam/:examId/violation", protect, reportViolation);
router.get("/exam/:examId/rank", protect, getExamRank);
router.post("/addResult/:examId", protect, verifiedOnly, addResult);
router.get("/getResultsByUser", protect, verifiedOnly, getResultsByUser);
router.get(
  "/getResultsByUserByExam/:examId",
  protect,
  verifiedOnly,
  getResultsByUserByExam
);
router.post("/addExamToUser/:examId", protect, verifiedOnly, addExamToUser);
router.post(
  "/addExamToUserById/:userId",
  protect,
  teacherOnly,
  addExamToUserById
);
router.get("/getExamsByUser", protect, verifiedOnly, getExamsByUser);
router.get("/getLatestExams", protect, verifiedOnly, getLatestExams);
// Public landing feed removed — all classes are code-only now.
router.get("/getExams", protect, requireCapability("results:view:own"), getExams);
router.get("/reviewByResult/:resultId", protect, verifiedOnly, reviewByResult);
router.delete("/deleteMyExam/:examId", protect, verifiedOnly, deleteMyExam);
// router.post('/uploadpdf', upload.single('./pdf'), uploadFile);
module.exports = router;
