// Exam presets — the single source of truth for how a preset shapes an exam:
// its question structure (types/count), its per-question scoring, and its
// default negative-marking rule. Adding a new preset = one entry below.
//
// Scoring is computed here (server-authoritative) from the preset + the actual
// question count, so it adapts if the teacher adds/removes a question. An exam
// stores only the preset id (+ teacher-editable neg-marking fields); the live
// submit and the server-side auto-submit both score through the same path.

// Per-question points where the LAST `tail` questions are worth `tailEach` and
// the remaining questions split the leftover equally. Sums to `totalMarks`.
function tailEqualPlan(count, totalMarks, tail, tailEach) {
  const n = Number(count) || 0;
  if (n <= 0) return [];
  const t = Math.min(tail, n);
  const restCount = n - t;
  const restEach = restCount > 0 ? (totalMarks - t * tailEach) / restCount : 0;
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = i < restCount ? restEach : tailEach;
  return pts;
}

const PRESETS = {
  buraxilis: {
    id: "buraxilis",
    label: "Buraxılış",
    totalMarks: 100,
    // Seeded structure for the builder (teacher can adjust). Scoring stays the
    // legacy one (pointsPlan null -> quizController falls back to questionPoints:
    // first 18 share 55 pts, the rest share 45 — total 100), unchanged.
    slots: [
      { type: "Cm", count: 13 },
      { type: "Co", count: 5 },
      { type: "Cd", count: 7 },
    ],
    pointsPlan: null,
    negativeMarking: null,
  },

  "blok-1": {
    id: "blok-1",
    label: "Blok — 1-ci qrup",
    totalMarks: 150,
    // 30 questions: 22 closed, 4 open, 1 matching (#27), 3 open (#28-30).
    slots: [
      { type: "Cm", count: 22 },
      { type: "Co", count: 4 },
      { type: "Cma", count: 1 },
      { type: "Cd", count: 3 },
    ],
    // Last 3 questions = 9 pts each (27 total); the remaining questions split
    // 123 equally (~4.5556 each for 27 questions). Total = 150.
    pointsPlan: (count) => tailEqualPlan(count, 150, 3, 9),
    // Negative marking only on the closed section (Q1-22): every 4 wrong cancels
    // 1 correct's worth.
    negativeMarking: {
      enabled: true,
      wrongPerPenalty: 4,
      correctPerPenalty: 1,
      untilQuestion: 22,
    },
  },
};

// Total number of seeded questions in a preset's structure.
const presetCount = (preset) =>
  (preset?.slots || []).reduce((sum, s) => sum + (Number(s.count) || 0), 0);

// The ordered list of question types a preset seeds (length = presetCount).
const presetTypes = (preset) => {
  const types = [];
  (preset?.slots || []).forEach((s) => {
    for (let i = 0; i < (Number(s.count) || 0); i++) types.push(s.type);
  });
  return types;
};

module.exports = { PRESETS, presetCount, presetTypes, tailEqualPlan };
