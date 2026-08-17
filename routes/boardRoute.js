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
} = require("../controllers/boardController");

// Pages (all canvases) are sent as one multipart file — dodges the JSON body cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const runSaveUpload = (req, res, next) =>
  upload.single("pages")(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === "LIMIT_FILE_SIZE" ? "Lövhə çox böyükdür (maksimum 25MB)" : "Lövhə yadda saxlanmadı";
    res.status(400).json({ message });
  });

// Teacher manages their own boards.
router.get("/", protect, teacherOnly, listBoards);
router.post("/", protect, teacherOnly, createBoard);
// Boards shared to a class (class page) — students + the class owner. Declared
// before "/:id" so "class" is never parsed as a board id.
router.get("/class/:classId", protect, listClassBoards);
// Cheap live-session poll (declared before "/:id"'s siblings is fine — 2 segments).
router.get("/:id/live", protect, boardLiveStatus);
// One board — the controller decides edit (owner) vs view-only (audience student).
router.get("/:id", protect, getBoard);
router.patch("/:id", protect, teacherOnly, runSaveUpload, saveBoard);
router.delete("/:id", protect, teacherOnly, deleteBoard);

module.exports = router;
