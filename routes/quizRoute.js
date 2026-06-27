const express = require("express");
const {
  protect,
  adminOnly,
  teacherOnly,
  verifiedOnly,
} = require("../middleware/authMiddleware");
const {
  serverTime,
  addExam,
  getExamsByClass,
  getPdfByExam,
  uploadPdf,
  addTag,
  getTags,
  addQuestion,
  deleteExam,
  editQuestion,
  deleteQuestion,
  getQuestionsByExam,
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
  getResultsByExam
} = require("../controllers/quizController");
const { extractQuestions, extractQuestionsStream, getAiUsage } = require("../controllers/aiController");
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

const multer = require("multer");
const fs = require("fs");
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads", { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage })

// Dedicated PDF storage: unique .pdf filenames, served from /uploads.
const pdfStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
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


router.post("/addTag", protect, teacherOnly, addTag);
// AI: extract structured questions from an uploaded PDF (teacher reviews + saves).
router.post(
  "/extractQuestions/:examId",
  protect,
  teacherOnly,
  memUpload.single("pdf"),
  extractQuestions
);
// Same extraction, streamed over SSE so the teacher watches questions appear.
router.post(
  "/extractQuestionsStream/:examId",
  protect,
  teacherOnly,
  memUpload.single("pdf"),
  extractQuestionsStream
);
// Admin-only AI spend dashboard data.
router.get("/aiUsage", protect, adminOnly, getAiUsage);
router.post("/addClass", protect, teacherOnly, addClass);
router.get("/server-time", serverTime);
// Scoped to the caller (teacher → own, student → enrolled, admin → all), so it
// now requires auth.
router.get("/getTags", protect, getTags);
router.post("/addExam/:classId", upload.single("pdf"), protect, teacherOnly, addExam);

// ---- enrollment (class membership) ----
router.post("/enroll", protect, verifiedOnly, joinClass);
router.get("/myEnrollments", protect, myEnrollments);
router.delete("/leaveClass/:classId", protect, leaveClass);
router.get("/teacher/requests", protect, teacherOnly, teacherRequests);
router.get("/teacher/classes", protect, teacherOnly, teacherClasses);
router.get("/class/:classId/students", protect, teacherOnly, classStudents);
router.get("/class/:classId/assignable", protect, teacherOnly, assignableStudents);
router.post("/class/:classId/addStudent", protect, teacherOnly, addStudentToClass);
router.patch("/enrollment/:id", protect, teacherOnly, decideEnrollment);
router.patch("/class/:classId/joinSettings", protect, teacherOnly, setJoinSettings);
router.post("/addPhotoToResult/:resultId", protect, teacherOnly, addPhotoToResult);
router.get("/getPdfByExam/:examId", protect, getPdfByExam);
router.post("/uploadPdf", protect, teacherOnly, pdfUpload.single("file"), uploadPdf);
router.get("/getExamTagandClass/:examId", protect, getExamTagandClass);
router.get("/getResultsByExam/:examId", protect, teacherOnly, getResultsByExam);
router.get("/getExamsByClass/:classId", protect, getExamsByClass);
router.get("/getClassesByTag/:tagId", protect, getClassesByTag);
router.get("/getClasses", protect, getAllClasses);
router.post("/addQuestion/:examId", protect, teacherOnly, addQuestion);
router.patch("/editQuestion/:questionId", protect, teacherOnly, editQuestion);
router.delete(
  "/deleteQuestion/:questionId",
  protect,
  teacherOnly,
  deleteQuestion
);
router.get("/getQuestionsByExam/:examId", protect, teacherOnly, getQuestionsByExam);
router.get("/getExam/:id", protect, getExam);
router.get("/getTag/:id", protect, getTag);
router.get("/getClass/:id", protect, getClass);
router.patch("/editExam/:examId", protect, teacherOnly, editExam);
router.delete("/deleteExam/:examId", protect, teacherOnly, deleteExam);
router.delete("/deleteClass/:classId", protect, teacherOnly, deleteClass);
router.delete("/deleteTag/:tagId", protect, teacherOnly, deleteTag);
router.patch("/editTag/:tagId", protect, teacherOnly, editTag);
router.patch("/editClass/:classId", protect, teacherOnly, editClass);
router.patch("/setExamHidden/:examId", protect, teacherOnly, setExamHidden);
router.post("/exam/:examId/start", protect, startAttempt);
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
// Public landing feed — newest exams from open classes (no auth).
router.get("/publicExams", getPublicExams);
router.get("/getExams", protect, teacherOnly, getExams);
router.get("/reviewByResult/:resultId", protect, verifiedOnly, reviewByResult);
router.delete("/deleteMyExam/:examId", protect, verifiedOnly, deleteMyExam);
// router.post('/uploadpdf', upload.single('./pdf'), uploadFile);
module.exports = router;
