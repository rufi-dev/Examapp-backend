const express = require("express");
const router = express.Router();
const multer = require("multer");
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const {
  listBoards,
  createBoard,
  getBoard,
  boardLiveStatus,
  saveBoard,
  deleteBoard,
  listClassBoards,
  uploadBoardFile,
  getBoardFile,
  getOrCreateHomeworkBoard,
  listHomeworkBoards,
  submitHomeworkBoard,
  getOrCreateAnnotationBoard,
} = require("../controllers/boardController");

// Pages (all canvases) are sent as one multipart file — dodges the JSON body cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});
// Board images: private storage, magic-byte validated in the controller.
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 9 * 1024 * 1024, files: 1 },
});
const runImageUpload = (req, res, next) =>
  uploadImage.single("file")(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "Şəkil çox böyükdür (maksimum 8MB)" : "Şəkil yüklənmədi";
    res.status(400).json({ message });
  });

const runSaveUpload = (req, res, next) =>
  upload.single("pages")(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === "LIMIT_FILE_SIZE" ? "Lövhə çox böyükdür (maksimum 25MB)" : "Lövhə yadda saxlanmadı";
    res.status(400).json({ message });
  });

// Student submits a solve-board: the exported PNG (field "file"), up to 25MB.
const runImageSubmit = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "Şəkil çox böyükdür (maksimum 25MB)" : "Göndərilmədi";
    res.status(400).json({ message });
  });

// List boards: teacher/admin get their own/all; a STUDENT gets boards shared to their
// enrolled classes (read-only — the controller branches by role). Creating a board
// stays teacher-only.
router.get("/", protect, listBoards);
router.post("/", protect, teacherOnly, createBoard);
// Boards shared to a class (class page) — students + the class owner. Declared
// before "/:id" so "class" is never parsed as a board id.
router.get("/class/:classId", protect, listClassBoards);
// Homework solve-boards. Declared before "/:id" so "homework" isn't a board id.
router.get("/homework/:assignmentId/list", protect, teacherOnly, listHomeworkBoards);
router.post("/homework/:boardId/submit", protect, runImageSubmit, submitHomeworkBoard);
router.post("/homework/:assignmentId", protect, getOrCreateHomeworkBoard);
// Teacher marks a submitted image on a full board (all custom tools).
router.post("/annotate", protect, teacherOnly, getOrCreateAnnotationBoard);
// Cheap live-session poll (declared before "/:id"'s siblings is fine — 2 segments).
router.get("/:id/live", protect, boardLiveStatus);
// Private board images: owner uploads, the audience reads (declared before "/:id").
router.post("/:id/files", protect, teacherOnly, runImageUpload, uploadBoardFile);
router.get("/:id/files/:fileId", protect, getBoardFile);
// One board — the controller decides edit (owner) vs view-only (audience student).
router.get("/:id", protect, getBoard);
router.patch("/:id", protect, teacherOnly, runSaveUpload, saveBoard);
router.delete("/:id", protect, teacherOnly, deleteBoard);

module.exports = router;
