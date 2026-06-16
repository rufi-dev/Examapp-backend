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
  startAttempt,
  attemptStatus,
  reportViolation,
  getExamRank,
  getResultsByUser,
  addPhotoToResult,
  getResultsByUserByExam,
  addExamToUser,
  getExamsByUser,
  reviewByResult,
  deleteMyExam,
  addExamToUserById,
  getExams,
  getClassesByTag,
  addClass,
  getClass,
  getExamTagandClass,
  getResultsByExam
} = require("../controllers/quizController");
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


router.post("/addTag", protect, teacherOnly, addTag);
router.post("/addClass/:tagId", protect, teacherOnly, addClass);
router.get("/server-time", serverTime);
router.get("/getTags", getTags);
router.post("/addExam/:classId", upload.single("pdf"), protect, teacherOnly, addExam);
router.post("/addPhotoToResult/:resultId", protect, teacherOnly, addPhotoToResult);
router.get("/getPdfByExam/:examId", protect, getPdfByExam);
router.post("/uploadPdf", protect, teacherOnly, pdfUpload.single("file"), uploadPdf);
router.get("/getExamTagandClass/:examId", protect, getExamTagandClass);
router.get("/getResultsByExam/:examId", protect, teacherOnly, getResultsByExam);
router.get("/getExamsByClass/:classId", protect, getExamsByClass);
router.get("/getClassesByTag/:tagId", getClassesByTag);
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
router.get("/getTag/:id", getTag);
router.get("/getClass/:id", getClass);
router.patch("/editExam/:examId", protect, teacherOnly, editExam);
router.delete("/deleteExam/:examId", protect, teacherOnly, deleteExam);
router.delete("/deleteClass/:classId", protect, teacherOnly, deleteClass);
router.delete("/deleteTag/:tagId", protect, teacherOnly, deleteTag);
router.patch("/editTag/:tagId", protect, teacherOnly, editTag);
router.patch("/editClass/:classId", protect, teacherOnly, editClass);
router.patch("/setExamHidden/:examId", protect, teacherOnly, setExamHidden);
router.post("/exam/:examId/start", protect, startAttempt);
router.get("/exam/:examId/attemptStatus", protect, attemptStatus);
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
router.get("/getExams", protect, teacherOnly, getExams);
router.get("/reviewByResult/:resultId", protect, verifiedOnly, reviewByResult);
router.delete("/deleteMyExam/:examId", protect, verifiedOnly, deleteMyExam);
// router.post('/uploadpdf', upload.single('./pdf'), uploadFile);
module.exports = router;
