const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const { requireCurriculum } = require("../middleware/curriculumFlag");
const { requireActiveOperation } = require("../middleware/aiOperation");
const { aiRateLimit, aiBudgetGuard } = require("../middleware/aiLimit");
const c = require("../controllers/lessonPlanController");

router.get("/", requireCurriculum, protect, teacherOnly, c.listPlans);
router.post("/", requireCurriculum, protect, teacherOnly, c.createPlan);
router.get("/:id", requireCurriculum, protect, teacherOnly, c.getPlan);
router.patch("/:id", requireCurriculum, protect, teacherOnly, c.updatePlan);
router.put("/:id/sources", requireCurriculum, protect, teacherOnly, c.setSources);
router.post("/:id/publish", requireCurriculum, protect, teacherOnly, c.publishPlan);
router.post("/:id/archive", requireCurriculum, protect, teacherOnly, c.archivePlan);
router.delete("/:id", requireCurriculum, protect, teacherOnly, c.deletePlan);
router.post("/:id/proposal/accept", requireCurriculum, protect, teacherOnly, c.acceptProposal);
router.get("/:id/projector", requireCurriculum, protect, teacherOnly, c.projectorView);
// Two-variant worksheet, DERIVED from the plan's tasks — no AI call, no credit.
router.post("/:id/worksheet", requireCurriculum, protect, teacherOnly, c.worksheet);

// Student-facing: the server withholds solutions by role AND document state.
router.get("/:id/student", requireCurriculum, protect, c.studentPlanView);

/*
 * AI generation. requireActiveOperation stays in front even now that the operation
 * is priced: it is what makes a future unpriced operation fail closed instead of
 * generating for free.
 *
 * There is deliberately NO chargeAi here: credits for document work are reserved
 * and committed through services/aiCreditService (claim-before-charge), and using
 * both mechanisms on one route would double-charge.
 */
router.post(
  "/:id/generate",
  requireCurriculum,
  protect,
  teacherOnly,
  requireActiveOperation("ai.generate.lessonplan"),
  aiRateLimit,
  aiBudgetGuard,
  c.generatePlan
);

module.exports = router;
