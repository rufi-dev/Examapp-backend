const express = require("express");
const {
  protect,
  adminOnly,
  teacherOnly,
  verifiedOnly,
} = require("../middleware/authMiddleware");
const {
  addExam,
  getExamsByClass,
  getPdfByExam,
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
  editTag,
  addResult,
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

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage })


router.post("/addTag", protect, teacherOnly, addTag);
router.post("/addClass/:tagId", protect, teacherOnly, addClass);
router.get("/getTags", getTags);
router.post("/addExam/:classId", upload.single("pdf"), protect, teacherOnly, addExam);
router.post("/addPhotoToResult/:resultId", protect, teacherOnly, addPhotoToResult);
router.get("/getPdfByExam/:examId", protect, getPdfByExam);
router.get("/getExamTagandClass/:examId", protect, getExamTagandClass);
router.get("/getResultsByExam/:examId", protect, teacherOnly, getResultsByExam);
router.get("/getExamsByClass/:classId", getExamsByClass);
router.get("/getClassesByTag/:tagId", getClassesByTag);
router.post("/addQuestion/:examId", protect, teacherOnly, addQuestion);
router.patch("/editQuestion/:questionId", protect, teacherOnly, editQuestion);
router.delete(
  "/deleteQuestion/:questionId",
  protect,
  teacherOnly,
  deleteQuestion
);
router.get("/getQuestionsByExam/:examId", protect, getQuestionsByExam);
router.get("/getExam/:id", getExam);
router.get("/getTag/:id", getTag);
router.get("/getClass/:id", getClass);
router.patch("/editExam/:examId", protect, teacherOnly, editExam);
router.delete("/deleteExam/:examId", protect, teacherOnly, deleteExam);
router.patch("/editTag/:tagId", protect, teacherOnly, editTag);
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
  // teacherOnly,
  addExamToUserById
);
router.get("/getExamsByUser", protect, verifiedOnly, getExamsByUser);
router.get("/getExams", protect, teacherOnly, getExams);
router.get("/reviewByResult/:resultId", protect, verifiedOnly, reviewByResult);
router.delete("/deleteMyExam/:examId", protect, verifiedOnly, deleteMyExam);
// router.post('/uploadpdf', upload.single('./pdf'), uploadFile);
module.exports = router;
