// AUD-003 / CR-035 — the per-question POINT PLAN, frozen at publish so a stored
// version reproduces the exact historical score even if the in-code presets or
// the legacy split later change. `EVALUATOR_VERSION` stamps which correctness
// evaluator (answerScore/isCorrectAnswer semantics) graded a version; if that
// algorithm ever changes, grading branches on the stored version instead of
// silently re-scoring old results differently.
const { PRESETS } = require("./examPresets");

const EVALUATOR_VERSION = "1";

/*
 * The 18/55-45 ladder: the first 18 questions share 55 points, the rest share 45.
 *
 * This is the DİM Buraxılış shape, where the paper really is two parts and the
 * closing tasks really are worth more. It belongs to the presets that say so —
 * see `buraxilis` in examPresets, which now names it explicitly.
 *
 * It used to be the fallback for EVERY exam with no preset, which is a different
 * claim entirely, and a wrong one. A teacher building their own paper has not
 * asked for a ladder, and at ordinary sizes the result is indefensible: at 20
 * questions the last two are worth 22.5 each against 3.06 for the other
 * eighteen, so two questions carry 45% of the grade. At 21 it is 3.06 against
 * 15. On production, 101 of 365 custom exams are over 18 questions and 62 of
 * those mix written with multiple-choice — the case a teacher wrote in about,
 * asking how to make "yazılı" and "test" worth the same.
 */
function ladderPoints(count) {
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

/*
 * The default when no preset is chosen: every scored question is worth the same.
 *
 * Nothing about "I am building my own exam" implies that question 19 should be
 * worth five times question 3, or that a written answer should be worth less
 * than a multiple-choice one because of where it happens to sit. Equal is the
 * only split that needs no explanation, and a teacher who wants something else
 * has the per-type editor and the presets.
 */
function questionPoints(count) {
  const n = Number(count) || 0;
  if (n <= 0) return [];
  return new Array(n).fill(100 / n);
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

module.exports = { EVALUATOR_VERSION, questionPoints, ladderPoints, computePointsPlan, isRead };
