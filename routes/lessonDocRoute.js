const express = require("express");
const multer = require("multer");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const { requireActiveOperation } = require("../middleware/aiOperation");
const { requireStudioAi } = require("../middleware/studioFlag");
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
/*
 * The AI route, and the only two things gating it.
 *
 * A non-streaming twin (POST /:id/message) used to be mounted beside it and ran
 * the older whole-document path — no patch edits, no page reads, no render
 * check. The app had stopped calling it; it is gone rather than left for an old
 * client to find, so every AI edit enters the same turn.
 *
 * `requireStudioAi` is the kill switch; `requireActiveOperation` refuses if the
 * operation is ever set back to `active: false` in config/aiOperations.js, so an
 * unpriced operation can never quietly run for free by accident.
 *
 * Deliberately absent, by owner decision: aiRateLimit, aiBudgetGuard, chargeAi.
 * Studio charges nothing and limits nothing. What replaces them is the per-turn
 * usage row the controller writes — spend is visible even though it is unbounded.
 *
 * One operation name gates both routes because the entitlement is the same; the
 * controller attributes each turn to `ai.generate.material` or `ai.edit.material`
 * in the usage table, which is where the distinction actually matters.
 */
const aiChain = [requireStudioAi, requireActiveOperation("ai.generate.material")];
router.post("/:id/message/stream", ...aiChain, c.streamMessage);
router.post("/:id/files", runUpload, c.addFile);
router.get("/:id/files/:key", c.getFile);
router.delete("/:id/files/:key", c.removeFile);
router.get("/:id/export", c.exportDoc);

module.exports = router;
