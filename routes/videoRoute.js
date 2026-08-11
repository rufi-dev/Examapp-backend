const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const { uploadRateLimit, storageQuota } = require("../middleware/uploadLimit");
const {
  getVideos,
  addVideo,
  updateVideo,
  deleteVideo,
  getStreamToken,
  streamVideo,
  VIDEOS_DIR,
} = require("../controllers/videoController");

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// Uploaded videos land in the PRIVATE videos/ dir under a random name; access is
// checked + token-gated in the controller.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VIDEOS_DIR),
  filename: (req, file, cb) => {
    const ext = /\.webm$/i.test(file.originalname) ? ".webm" : ".mp4";
    cb(null, `vid-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const MAX_VIDEO_BYTES = Number(process.env.VIDEO_MAX_BYTES || 500 * 1024 * 1024); // 500MB
const upload = multer({
  storage,
  limits: { fileSize: MAX_VIDEO_BYTES },
  fileFilter: (req, file, cb) => {
    if (!/\.(mp4|webm)$/i.test(file.originalname || "")) {
      return cb(new Error("Yalnız MP4 və ya WebM video yükləyin"));
    }
    cb(null, true);
  },
});
// A no-file POST (YouTube link) is fine — multer just leaves req.file undefined.
const uploadVideo = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? `Video çox böyükdür (maksimum ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))}MB)`
        : err.message || "Video yüklənmədi";
    res.status(400).json({ message });
  });

// Any signed-in user can watch (list is scoped per-role in the controller);
// only teachers/admins add/edit/delete (delete gated to owner/admin).
router.get("/", protect, getVideos);
// Stream a private uploaded video. `token` (from /:id/token) is the auth — no
// bearer middleware, so a native <video> tag can load it with Range support.
router.get("/:id/stream", streamVideo);
router.get("/:id/token", protect, getStreamToken);
// Rate-limit BEFORE multer so a flood is refused without writing 500MB to disk;
// the quota needs the written size, so it runs after.
router.post("/", protect, teacherOnly, uploadRateLimit, uploadVideo, storageQuota, addVideo);
router.patch("/:id", protect, teacherOnly, updateVideo);
router.delete("/:id", protect, teacherOnly, deleteVideo);

module.exports = router;
