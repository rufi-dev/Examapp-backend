/*
 * Teacher Success Journey — monthly AI credit allowances per level (ADR §2 D7).
 *
 * Spark 100 / Momentum 300 / Impact 750. These are VALIDATED configuration
 * values, not scattered constants: an env override must be a bounded positive
 * safe integer or boot fails (see index.assertTeacherSuccessConfig). AI parity
 * (D6) means this QUANTITY is the ONLY universal difference between levels.
 */
const { LEVELS } = require("./levels");

const DEFAULTS = { spark: 100, momentum: 300, impact: 750 };
const ENV_KEY = (level) => `TSJ_AI_ALLOWANCE_${level.toUpperCase()}`;
const BOUND = { min: 1, max: 1_000_000 };

// Raw (possibly env-overridden) value for a level, unparsed. index validates it.
function rawAllowance(level, env = process.env) {
  const v = env[ENV_KEY(level)];
  return v === undefined || v === "" ? String(DEFAULTS[level]) : v;
}

// Resolved integer allowance for a level. Falls back to the default if an
// override is somehow invalid AND validation was skipped; startup validation
// (assertTeacherSuccessConfig) guarantees overrides are valid before serving.
function allowanceFor(level, env = process.env) {
  const n = Number(rawAllowance(level, env));
  return Number.isSafeInteger(n) && n >= BOUND.min && n <= BOUND.max ? n : DEFAULTS[level];
}

// The full validated map (used by services/UI). Advancing a level must not lower
// the allowance — this ordering invariant is asserted in config validation.
function allowanceMap(env = process.env) {
  const out = {};
  for (const l of LEVELS) out[l] = allowanceFor(l, env);
  return out;
}

module.exports = { DEFAULTS, ENV_KEY, BOUND, rawAllowance, allowanceFor, allowanceMap };
