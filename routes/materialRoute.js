const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const {
  getMaterials,
  addMaterial,
  viewMaterial,
  downloadMaterial,
  updateMaterial,
  deleteMaterial,
  MATERIALS_DIR,
} = require("../controllers/materialController");

if (!fs.existsSync(MATERIALS_DIR)) fs.mkdirSync(MATERIALS_DIR, { recursive: true });

// Files land in the PRIVATE materials/ dir (not served by express.static) under
// a random name, so the original filename can never be guessed from a URL.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MATERIALS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const rand = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `mat-${rand}${ext}`);
  },
});

const ALLOWED_EXT = new Set([
  ".pdf",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif",
  ".doc", ".docx", ".odt", ".rtf",
  ".ppt", ".pptx", ".odp",
  ".xls", ".xlsx", ".ods",
]);

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB — plenty for lecture notes
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(
        new Error("Yalnız PDF, şəkil, Word və ya PowerPoint faylı yükləyin")
      );
    }
    cb(null, true);
  },
});

// Turn multer's own errors (size/type) into a clean 400 + Azerbaijani message
// instead of the generic 500 the error middleware would produce.
const uploadSingle = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Fayl çox böyükdür (maksimum 30MB)"
        : err.message || "Fayl yüklənmədi";
    res.status(400).json({ message });
  });

// Any signed-in user can list/read (scoped per role in the controller);
// only teachers/admins upload, edit or delete (further gated to the owner).
router.get("/", protect, getMaterials);
router.get("/:id/file", protect, viewMaterial);
router.get("/:id/download", protect, downloadMaterial);
router.post("/", protect, teacherOnly, uploadSingle, addMaterial);
router.patch("/:id", protect, teacherOnly, updateMaterial);
router.delete("/:id", protect, teacherOnly, deleteMaterial);

module.exports = router;
