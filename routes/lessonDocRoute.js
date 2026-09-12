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
 * The AI route, and what gates it.
 *
 * A non-streaming twin (POST /:id/message) used to be mounted beside it and ran
 * the older whole-document path — no patch edits, no page reads, no render
 * check. The app had stopped calling it; it is gone rather than left for an old
 * client to find, so every AI edit enters the same turn.
 *
 * `requireStudioAi` is the kill switch; `requireActiveOperation` refuses if
 * either operation is ever set back to `active: false` in config/aiOperations.js,
 * so an unpriced operation can never quietly run for free by accident.
 *
 * METERED, by owner decision on 2026-09-13 — it charged nothing and limited
 * nothing until then. `aiRateLimit` and `aiBudgetGuard` are the same guards every
 * other paid AI route carries. The credit charge itself is NOT a route middleware
 * here, because a creation and an edit share this route and cost different
 * amounts, and which one this is depends on the document: the controller calls
 * the same meter (middleware/aiCredit.js `meterFor`) once the document is
 * loaded, still before the first byte of the stream goes out, so a refusal is a
 * proper 402. The per-turn usage row the controller writes stays, so the spend
 * is visible as well as bounded.
 */
const { aiRateLimit, aiBudgetGuard } = require("../middleware/aiLimit");
const aiChain = [
  requireStudioAi,
  requireActiveOperation("ai.generate.material"),
  requireActiveOperation("ai.edit.material"),
  aiRateLimit,
  aiBudgetGuard,
];
router.post("/:id/message/stream", ...aiChain, c.streamMessage);
router.post("/:id/files", runUpload, c.addFile);
router.get("/:id/files/:key", c.getFile);
router.delete("/:id/files/:key", c.removeFile);
router.get("/:id/export", c.exportDoc);

module.exports = router;
