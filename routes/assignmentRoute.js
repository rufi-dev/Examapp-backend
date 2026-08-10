const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const fsp = require("fs").promises;
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const { uploadRateLimit } = require("../middleware/uploadLimit");
const { validateUploadFile } = require("../utils/fileValidation");
const {
  ASSIGNMENTS_DIR,
  listAssignments,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  getSubmissions,
  gradeSubmission,
  submitAssignment,
  getAttachmentFile,
  getSubmissionFile,
} = require("../controllers/assignmentController");

if (!fs.existsSync(ASSIGNMENTS_DIR)) fs.mkdirSync(ASSIGNMENTS_DIR, { recursive: true });

// Files land in the PRIVATE assignments/ dir under a random name — the original
// name can never be guessed from a URL, and access is checked in the controller.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ASSIGNMENTS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const rand = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `asg-${rand}${ext}`);
  },
});

// The same safe set materials accept: PDF, images, Word/PowerPoint/Excel. This
// covers every real homework file (including phone photos of handwritten work)
// while staying fail-closed — executables/archives are refused.
const ALLOWED_EXT = new Set([
  ".pdf",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif",
  ".doc", ".docx", ".odt", ".rtf",
  ".ppt", ".pptx", ".odp",
  ".xls", ".xlsx", ".ods",
]);

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 10 }, // 50MB/file, up to 10 files
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error("Yalnız PDF, şəkil, Word, PowerPoint və ya Excel faylı yükləyin"));
    }
    cb(null, true);
  },
});

// AUD-013: validate the ACTUAL bytes of EVERY uploaded file against its
// extension (magic bytes). On any mismatch, delete ALL uploaded files and fail
// closed — a rejected file must never linger in the private dir. The trusted
// detected type / canonical MIME is attached to each file for the controller.
async function verifyUploads(req, res, next) {
  const files = req.files || [];
  if (!files.length) return next();
  try {
    for (const file of files) {
      const ext = path.extname(file.originalname || file.filename || "").toLowerCase();
      const result = await validateUploadFile(file.path, ext);
      if (!result.ok) {
        await Promise.all(files.map((f) => fsp.unlink(f.path).catch(() => {})));
        return res.status(400).json({ message: "Faylın məzmunu uzantısı ilə uyğun gəlmir" });
      }
      file.detectedType = result.type;
      file.canonicalMime = result.canonicalMime;
    }
    next();
  } catch (err) {
    await Promise.all(files.map((f) => fsp.unlink(f.path).catch(() => {})));
    next(err);
  }
}

// multer errors (size/type/count) → a clean 400 + Azerbaijani message.
const runUpload = (field, max) => (req, res, next) =>
  upload.array(field, max)(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Fayl çox böyükdür (maksimum 50MB)"
        : err.code === "LIMIT_FILE_COUNT"
        ? "Çox fayl seçildi (maksimum 10)"
        : err.message || "Fayl yüklənmədi";
    res.status(400).json({ message });
  });

// ---- reads ------------------------------------------------------------------
router.get("/", protect, listAssignments); // ?classId=...
router.get("/:id/attachment/:fileName", protect, getAttachmentFile);
router.get("/:id/submissions/:submissionId/files/:fileName", protect, getSubmissionFile);
router.get("/:id/submissions", protect, teacherOnly, getSubmissions);

// ---- teacher writes ---------------------------------------------------------
router.post("/", protect, teacherOnly, uploadRateLimit, runUpload("attachments", 5), verifyUploads, createAssignment);
router.patch("/:id", protect, teacherOnly, updateAssignment);
router.patch("/:id/submissions/:submissionId", protect, teacherOnly, gradeSubmission);
router.delete("/:id", protect, teacherOnly, deleteAssignment);

// ---- student write ----------------------------------------------------------
// Any signed-in user (enrollment is checked in the controller) can submit.
router.post("/:id/submit", protect, uploadRateLimit, runUpload("files", 10), verifyUploads, submitAssignment);

module.exports = router;
