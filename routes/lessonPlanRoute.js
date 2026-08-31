const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const { requireCurriculum } = require("../middleware/curriculumFlag");
const { requireActiveOperation } = require("../middleware/aiOperation");
const { aiRateLimit, aiBudgetGuard } = require("../middleware/aiLimit");
const { chargeAi } = require("../middleware/aiCredit");
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
router.post("/:id/proposal/discard", requireCurriculum, protect, teacherOnly, c.discardProposal);
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
 * chargeAi is the RIGHT tool here, and is what every other AI route in this app
 * uses: one request, one document, one charge, committed only at the genuine
 * success point so a failed generation is free. The reserve/commit protocol in
 * services/aiCreditService exists for the BATCHED MSO job, where a single request
 * spans many provider calls and a crash between them must not forgive the charge.
 * Using both on one route would double-charge, so this route uses exactly one.
 */
router.post(
  "/:id/generate",
  requireCurriculum,
  protect,
  teacherOnly,
  requireActiveOperation("ai.generate.lessonplan"),
  aiRateLimit,
  aiBudgetGuard,
  chargeAi("ai.generate.lessonplan"),
  c.generatePlan
);

module.exports = router;
