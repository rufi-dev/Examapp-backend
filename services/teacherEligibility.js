/*
 * Teacher Journey — PURE eligibility evaluation. No DB, no side effects.
 *
 * Given server-authoritative metrics + the current level, decide whether the teacher is
 * "Ready for review" for the next level. In the game model, readiness = EVERY non-
 * referral requirement met (lifetime XP + activity counts). A qualified referral is a
 * BONUS indicator, never mandatory. Meeting the target NEVER auto-promotes — it only
 * marks readiness and feeds admin review. Thresholds come from the single validated
 * config (thresholds.js).
 */
const { SPARK_TO_MOMENTUM, MOMENTUM_TO_IMPACT } = require("../config/teacherSuccess/thresholds");
const { nextLevel } = require("../config/teacherSuccess/levels");

// The requirement + bonus spec for the transition OUT of `currentLevel`, or null at top.
function specFor(currentLevel) {
  if (currentLevel === "spark") return SPARK_TO_MOMENTUM;
  if (currentLevel === "momentum") return MOMENTUM_TO_IMPACT;
  return null;
}

/*
 * metrics (all server-authoritative, draft/self/duplicate-proof):
 *   lifetimeXp, publishedExams, publishedQuestions, uniqueStudents,
 *   completedAttempts, distinctActiveDays, distinctActiveWeeks, usefulMaterials,
 *   qualifiedReferrals
 */
function evaluate({ currentLevel, metrics = {} }) {
  const target = nextLevel(currentLevel);
  const spec = specFor(currentLevel);
  if (!target || !spec) {
    return { currentLevel, target: null, recommendedNextLevel: null, readyForReview: false, requirements: [], referralBonus: null };
  }
  // Every requirement must be met (referral excluded — it is a bonus).
  const requirements = Object.entries(spec.requirements).map(([key, need]) => {
    const have = Number(metrics[key] || 0);
    return { key, have, need, met: have >= need };
  });
  const readyForReview = requirements.every((r) => r.met);

  // Referral bonus indicator (never gates readiness).
  const refKey = Object.keys(spec.referralBonus)[0];
  const refNeed = spec.referralBonus[refKey];
  const refHave = Number(metrics[refKey] || 0);
  const referralBonus = { key: refKey, have: refHave, need: refNeed, met: refHave >= refNeed };

  return {
    currentLevel,
    target,
    recommendedNextLevel: readyForReview ? target : null,
    readyForReview,
    requirements,
    referralBonus,
  };
}

module.exports = { evaluate, specFor };
