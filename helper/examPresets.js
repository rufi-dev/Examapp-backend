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

// 9th-grade Azerbaijani-language buraxılış scoring (DİM). The subject is scored
// out of 100 (the relative "nisbi bal"). Open (written) questions are weighted
// 2x closed ones — DİM formula: (2·correct_open + correct_closed)/34·100. So we
// give each closed question 100/34 pts and each open question 200/34 pts; the
// open questions sit at Q19-20 and Q29-30 in the canonical 30-question layout.
function azWrittenPlan(count) {
  const n = Number(count) || 0;
  const openIdx = new Set([18, 19, 28, 29]); // 0-based Q19, Q20, Q29, Q30
  const unit = 100 / 34; // raw 34 (26·1 + 4·2) normalized to 100
  return Array.from({ length: n }, (_, i) => (openIdx.has(i) ? 2 * unit : unit));
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
    label: "Blok 1 və 2-ci qrup",
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

  "az-buraxilis-9": {
    id: "az-buraxilis-9",
    label: "Buraxılış — Azərbaycan dili (9)",
    // Scored out of 100 (DİM nisbi bal): closed = 100/34, open (written) = 200/34
    // — open weighted 2x. All correct = 100; the score equals the official bal.
    totalMarks: 100,
    // 30 tapşırıq: 10 dil qaydası (qapalı) + 2 mətn (bədii, publisistik), hər
    // mətndə 8 qapalı + 2 açıq (yazılı) = 26 qapalı + 4 açıq. Açıq suallar
    // Q19-20 və Q29-30 mövqelərindədir (mətnlərin sonunda).
    slots: [
      { type: "Cm", count: 18 }, // Q1-10 qaydalar + Q11-18 mətn-1 (qapalı)
      { type: "Co", count: 2 },  // Q19-20 mətn-1 (açıq, yazılı)
      { type: "Cm", count: 8 },  // Q21-28 mətn-2 (qapalı)
      { type: "Co", count: 2 },  // Q29-30 mətn-2 (açıq, yazılı)
    ],
    // Açıq sual qapalıdan 2x ağırdır; cəmi maksimal bal 100 (DİM nisbi balı).
    pointsPlan: azWrittenPlan,
    negativeMarking: null,
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
