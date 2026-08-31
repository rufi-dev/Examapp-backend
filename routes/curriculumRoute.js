const express = require("express");
const router = express.Router();
const multer = require("multer");
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const { requireCurriculum } = require("../middleware/curriculumFlag");
const { uploadRateLimit } = require("../middleware/uploadLimit");
const c = require("../controllers/curriculumController");

// requireCurriculum runs BEFORE protect on every route, so a flag-off deployment
// answers 404 (not 401) and the surface looks as if it does not exist.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: c.MAX_SOURCE_MB * 1024 * 1024, files: 1 },
});
const runUpload = (req, res, next) =>
  upload.single("source")(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? `Fayl çox böyükdür (maksimum ${c.MAX_SOURCE_MB}MB)`
        : err.code === "LIMIT_FILE_COUNT"
          ? "Bir dəfəyə yalnız bir fayl yükləyin"
          : "Fayl yüklənmədi";
    res.status(400).json({ code: "upload_rejected", message });
  });

router.get("/sources", requireCurriculum, protect, teacherOnly, c.listSources);
router.post("/sources", requireCurriculum, protect, teacherOnly, uploadRateLimit, runUpload, c.createSource);

router.patch("/sources/:id/versions/:vid/page-map", requireCurriculum, protect, teacherOnly, c.setPageMap);
router.get("/sources/:id/versions/:vid/pages/:page/text", requireCurriculum, protect, teacherOnly, c.pageText);
router.post("/sources/:id/versions/:vid/crop", requireCurriculum, protect, teacherOnly, c.renderCrop);
router.post("/sources/:id/versions/:vid/verify", requireCurriculum, protect, teacherOnly, c.verifyCitation);
router.get("/sources/:id/versions/:vid/holders", requireCurriculum, protect, teacherOnly, c.versionHolders);
router.delete("/sources/:id/versions/:vid", requireCurriculum, protect, teacherOnly, c.deleteVersion);

// Private bytes: owner-checked, no-store, never enumerable.
router.get("/assets/:key", requireCurriculum, protect, c.getAsset);

module.exports = router;
