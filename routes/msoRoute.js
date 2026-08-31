const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const { requireCurriculum } = require("../middleware/curriculumFlag");
const { requireActiveOperation } = require("../middleware/aiOperation");
const { aiRateLimit, aiBudgetGuard } = require("../middleware/aiLimit");
const c = require("../controllers/msoController");

// The structures the UI can offer, as data — a new shape needs no code change.
router.get("/presets", requireCurriculum, protect, teacherOnly, c.listPresets);
router.get("/blueprints", requireCurriculum, protect, teacherOnly, c.listBlueprints);
router.post("/blueprints", requireCurriculum, protect, teacherOnly, c.createBlueprint);
router.get("/blueprints/:id", requireCurriculum, protect, teacherOnly, c.getBlueprint);
router.patch("/blueprints/:id", requireCurriculum, protect, teacherOnly, c.updateBlueprint);

/*
 * requireActiveOperation stays in front even now that the operation is priced: it
 * is what makes a future unpriced operation fail closed rather than generate for
 * free. The handler then answers 422 while any blueprint row is still undecided.
 *
 * There is deliberately NO chargeAi here: document credits are reserved and
 * committed through services/aiCreditService (claim-before-charge), and using both
 * mechanisms on one route would double-charge.
 */
router.post(
  "/blueprints/:id/generate",
  requireCurriculum,
  protect,
  teacherOnly,
  requireActiveOperation("ai.generate.mso"),
  aiRateLimit,
  aiBudgetGuard,
  c.generateMso
);

router.get("/documents/:id", requireCurriculum, protect, teacherOnly, c.getDocument);
router.post("/documents/:id/review", requireCurriculum, protect, teacherOnly, c.reviewTask);
router.post("/documents/:id/publish", requireCurriculum, protect, teacherOnly, c.publishMso);
// One frozen version, four renderings: student paper, teacher paper, key, analytics.
router.get("/documents/:id/render", requireCurriculum, protect, teacherOnly, c.renderMso);

module.exports = router;
