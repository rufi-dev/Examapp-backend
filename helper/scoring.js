// AUD-003 / CR-035 — the per-question POINT PLAN, frozen at publish so a stored
// version reproduces the exact historical score even if the in-code presets or
// the legacy split later change. `EVALUATOR_VERSION` stamps which correctness
// evaluator (answerScore/isCorrectAnswer semantics) graded a version; if that
// algorithm ever changes, grading branches on the stored version instead of
// silently re-scoring old results differently.
const { PRESETS } = require("./examPresets");

const EVALUATOR_VERSION = "1";

// Legacy 18/55-45 split (total 100) for custom/no-preset exams.
function questionPoints(count) {
  const FIRST = 18;
  const SP = 45;
  const n = Number(count) || 0;
  if (n <= 0) return [];
  const a = Math.min(FIRST, n);
  const b = n - a;
  if (b === 0) return new Array(n).fill(100 / a);
  const secondEach = Math.round((SP / b) * 100) / 100;
  const firstEach = (100 - secondEach * b) / a;
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = i < a ? firstEach : secondEach;
  return pts;
}

// A plain passage (reading, not gap-fill) is not scored.
const isRead = (c) => c && c.type === "reading" && !c.gapfill;

// The resolved per-question points array. Passage slots are 0; a manual typePoints
// override wins per type; otherwise the preset (or the legacy split) drives it.
function computePointsPlan(correct, { preset, typePoints } = {}) {
  const list = Array.isArray(correct) ? correct : [];
  const presetCfg = preset ? PRESETS[preset] : null;
  const qTypes = list.filter((c) => !isRead(c)).map((c) => c && c.type);
  const planQ =
    presetCfg && typeof presetCfg.pointsPlan === "function"
      ? presetCfg.pointsPlan(qTypes.length, qTypes)
      : questionPoints(qTypes.length);
  let qi = 0;
  const autoPoints = list.map((c) => (isRead(c) ? 0 : planQ[qi++] || 0));
  const tp = typePoints && typeof typePoints === "object" ? typePoints : null;
  if (!tp) return autoPoints;
  return list.map((c, i) => {
    const v = c && c.type != null ? tp[c.type] : undefined;
    return v === undefined || v === null || Number.isNaN(Number(v)) ? autoPoints[i] || 0 : Number(v);
  });
}

module.exports = { EVALUATOR_VERSION, questionPoints, computePointsPlan, isRead };
