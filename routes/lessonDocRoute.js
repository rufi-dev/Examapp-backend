const express = require("express");
const multer = require("multer");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const c = require("../controllers/lessonDocController");
const F = require("../helper/lessonDocFiles");

// Memory storage: the file is hashed and written under a content-addressed key by
// the helper, so multer's own temp name would only be something to clean up.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: F.MAX_FILE_MB * 1024 * 1024, files: 1 },
});
const runUpload = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? `Fayl çox böyükdür (maksimum ${F.MAX_FILE_MB}MB)`
        : "Fayl yüklənmədi";
    res.status(400).json({ code: "upload_rejected", message });
  });

// Teacher surface: a student has nothing to do here, and the AI turn costs money.
router.use(protect, teacherOnly);

router.get("/", c.listDocs);
router.post("/", c.createDoc);
router.get("/:id", c.getDoc);
router.patch("/:id", c.updateDoc);
router.delete("/:id", c.removeDoc);
router.post("/:id/message", c.sendMessage);
router.post("/:id/message/stream", c.streamMessage);
router.post("/:id/files", runUpload, c.addFile);
router.get("/:id/files/:key", c.getFile);
router.delete("/:id/files/:key", c.removeFile);
router.get("/:id/export", c.exportDoc);

module.exports = router;
