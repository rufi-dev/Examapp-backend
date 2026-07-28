/*
 * Teacher Success Journey — the backend-owned feature flag (ADR §12 D16).
 *
 * TEACHER_SUCCESS_JOURNEY_ENABLED (default OFF). Flag-off must remain fully
 * compatible and create NO Journey collections/indexes from normal model import
 * (migrations own creation). The frontend receives this enabled state from a
 * trusted backend config/identity response, NOT a Vite flag.
 *
 * Low-balance warning threshold is configurable (ADR §13, default 20%).
 */
const TRUE_SET = new Set(["1", "true", "yes", "on"]);

function isJourneyEnabled(env = process.env) {
  return TRUE_SET.has(String(env.TEACHER_SUCCESS_JOURNEY_ENABLED || "").trim().toLowerCase());
}

// Fraction (0..1) of the monthly allowance at/below which the header warns.
function lowBalanceThreshold(env = process.env) {
  const raw = env.TSJ_LOW_BALANCE_THRESHOLD;
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n) || n <= 0 || n >= 1) return 0.2;
  return n;
}

module.exports = { isJourneyEnabled, lowBalanceThreshold };
