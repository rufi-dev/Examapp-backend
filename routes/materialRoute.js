const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { protect, teacherOnly, attachUser } = require("../middleware/authMiddleware");
const { uploadRateLimit, storageQuota } = require("../middleware/uploadLimit");
const {
  getMaterials,
  addMaterial,
  viewMaterial,
  downloadMaterial,
  updateMaterial,
  deleteMaterial,
  setMaterialShare,
  getSharedMaterial,
  getSharedFile,
  getSharedPages,
  getMaterialPages,
  getMaterialPageImage,
  joinFromShare,
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
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB — full scanned textbooks fit
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
        ? "Fayl çox böyükdür (maksimum 200MB)"
        : err.message || "Fayl yüklənmədi";
    res.status(400).json({ message });
  });

// Any signed-in user can list/read (scoped per role in the controller);
// only teachers/admins upload, edit or delete (further gated to the owner).
// Public share links. `attachUser` (not `protect`) so an anonymous reader is
// served when the teacher allowed it, and identified when they did not.
// Declared BEFORE "/:id/..." so the literal "share" segment is not swallowed
// by the id parameter.
router.get("/share/:token", attachUser, getSharedMaterial);
router.get("/share/:token/file", attachUser, getSharedFile);
router.get("/share/:token/pages", attachUser, getSharedPages);
// Signing in is not enough for a gated link — this puts the reader in the
// class it belongs to. Requires a real session, so `protect`, not `attachUser`.
router.post("/share/:token/join", protect, joinFromShare);

// A single rendered page image. The signed token in the query authorises it
// (an <img> can't send headers) and carries the material id, so no session or
// share token is needed here. Declared before "/:id/..." so the literal "page"
// segment is never read as an id.
router.get("/page/:n", getMaterialPageImage);

router.get("/", protect, getMaterials);
router.get("/:id/file", protect, viewMaterial);
router.get("/:id/pages", protect, getMaterialPages);
router.get("/:id/download", protect, downloadMaterial);
// Rate limit BEFORE multer so a flood is refused without writing 200MB to
// disk first; the quota check needs the file size, so it comes after.
router.post("/", protect, teacherOnly, uploadRateLimit, uploadSingle, storageQuota, addMaterial);
router.patch("/:id", protect, teacherOnly, updateMaterial);
router.patch("/:id/share", protect, teacherOnly, setMaterialShare);
router.delete("/:id", protect, teacherOnly, deleteMaterial);

module.exports = router;
