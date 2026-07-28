/*
 * Teacher Success Journey — the ONE server-authoritative entitlement registry
 * (ADR §5). The frontend may DISPLAY entitlements, but backend enforcement is
 * required for any genuinely level-restricted ADDITIVE feature.
 *
 * Invariants (asserted in config validation + tests):
 *  - Every level keeps ALL core creation/management tools (D5).
 *  - AI quality/models/privacy are identical at every level (D6); only the
 *    allowance QUANTITY differs (see allowances.js).
 *  - Entitlements are ADDITIVE: momentum ⊇ spark, impact ⊇ momentum. A higher
 *    level never REMOVES something a lower level had (no artificial
 *    differentiation by taking features away from Spark).
 *  - An entitlement is only surfaced/enforced once `implemented:true`. Nothing
 *    is advertised before it exists (D6/§5).
 */
const { LEVELS } = require("./levels");

// Core capabilities present at EVERY level. Never gated by level.
const CORE = [
  "manual_pdf_exam",
  "structured_exam",
  "questions_and_sections",
  "publishing",
  "grading",
  "own_classes",
  "own_students_results",
  "exam_management",
  "manual_when_ai_exhausted",
  "ai_tools", // available at every level; quality identical (D6)
];

// Additive, level-restricted entitlements. `implemented` gates advertising +
// backend enforcement. minLevel is the lowest level that has it.
const ADDITIVE = [
  { key: "reusable_ai_template_presets", minLevel: "momentum", implemented: false },
  { key: "priority_temp_credit_review", minLevel: "momentum", implemented: false },
  { key: "community_template_feedback", minLevel: "momentum", implemented: false },
  { key: "advanced_insights", minLevel: "momentum", implemented: false },
  { key: "batch_productivity_workflows", minLevel: "impact", implemented: false },
  { key: "featured_teacher_eligibility", minLevel: "impact", implemented: false },
  { key: "early_access_flagged", minLevel: "impact", implemented: false },
  { key: "priority_support", minLevel: "impact", implemented: false },
];

const { levelIndex } = require("./levels");

// Does this level HAVE this additive entitlement (regardless of implemented)?
function levelHasAdditive(level, key) {
  const e = ADDITIVE.find((a) => a.key === key);
  if (!e) return false;
  return levelIndex(level) >= levelIndex(e.minLevel);
}

// The set of entitlements to ENFORCE for a level: core (always) plus additive
// entries that are BOTH available at this level AND actually implemented.
function enforcedEntitlements(level) {
  const additive = ADDITIVE.filter((a) => a.implemented && levelHasAdditive(level, a.key)).map((a) => a.key);
  return [...CORE, ...additive];
}

// What the UI may DISPLAY for a level: core + additive-available (implemented
// flag included so the UI can show "coming soon" without advertising as live).
function displayEntitlements(level) {
  return {
    core: [...CORE],
    additive: ADDITIVE.filter((a) => levelHasAdditive(level, a.key)).map((a) => ({ key: a.key, implemented: a.implemented })),
  };
}

module.exports = { CORE, ADDITIVE, LEVELS, levelHasAdditive, enforcedEntitlements, displayEntitlements };
