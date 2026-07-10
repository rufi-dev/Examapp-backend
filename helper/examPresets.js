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

// Blok imtahanı (DİM) scoring, out of 150. The "solution-required" questions
// (type Cd — "Həlli tələb olunan açıq sual", normally the last 3: #28-30) are
// worth 9 pts each; every OTHER question shares the remainder of 150 equally
// (e.g. 27 questions → 123/27 ≈ 4.5556 each). Scoring BY TYPE so the per-type
// panel totals exactly 150. If no Cd is marked (legacy exams), fall back to the
// last-3-by-position plan so their scoring is unchanged.
const BLOK_SOLVE_PTS = 9;
function blokPlan(count, types) {
  const n = Number(count) || 0;
  if (n <= 0) return [];
  const t = Array.isArray(types) ? types : [];
  const solveCount = t.filter((x) => x === "Cd").length;
  if (solveCount > 0) {
    const rest = n - solveCount;
    const restEach = rest > 0 ? (150 - BLOK_SOLVE_PTS * solveCount) / rest : 0;
    return Array.from({ length: n }, (_, i) => (t[i] === "Cd" ? BLOK_SOLVE_PTS : restEach));
  }
  return tailEqualPlan(n, 150, 3, BLOK_SOLVE_PTS);
}

// Buraxılış 9-cu sinif (DİM), out of 100 (nisbi bal). Solution-required questions
// (type Cd — "Həlli tələb olunan açıq", the last 4: #22-25) are weighted 2× a
// normal question; the whole sheet is normalized to 100. So 21 normal + 4 Cd →
// 21·1 + 4·2 = 29 units → normal 100/29 ≈ 3.45, Cd 200/29 ≈ 6.90. No negative
// marking (səhv düzü aparmır). Scored BY TYPE so the per-type panel totals 100.
function bur9Plan(count, types) {
  const n = Number(count) || 0;
  if (n <= 0) return [];
  const t = Array.isArray(types) ? types : [];
  const weights = Array.from({ length: n }, (_, i) => (t[i] === "Cd" ? 2 : 1));
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  return weights.map((w) => (w / total) * 100);
}

const PRESETS = {
  buraxilis: {
    id: "buraxilis",
    label: "Buraxılış 11-ci sinif",
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

  "buraxilis-9": {
    id: "buraxilis-9",
    label: "Buraxılış 9-cu sinif",
    totalMarks: 100,
    // 25 tapşırıq: 15 qapalı (#1-15) + 6 açıq (#16-21) + 4 həlli tələb olunan
    // açıq (#22-25). Bu yalnız BAŞLANĞIC şablondur — müəllim dəyişə bilər.
    slots: [
      { type: "Cm", count: 15 },
      { type: "Co", count: 6 },
      { type: "Cd", count: 4 },
    ],
    // Həlli tələb olunan (Cd) suallar 2× ağırdır; cəmi 100 (DİM nisbi balı).
    // Səhv düzü aparmır — mənfi qiymətləndirmə yoxdur.
    pointsPlan: bur9Plan,
    negativeMarking: null,
  },

  "blok-1": {
    id: "blok-1",
    label: "Blok 1 və 2-ci qrup",
    totalMarks: 150,
    // 30 questions: 22 closed (#1-22), 4 open (#23-26), 1 matching (#27), and
    // 3 solution-required open questions (#28-30, type Cd).
    slots: [
      { type: "Cm", count: 22 },
      { type: "Co", count: 4 },
      { type: "Cmu", count: 1 },
      { type: "Cd", count: 3 },
    ],
    // Cd (#28-30) = 9 pts each (27 total); the other 27 share 123 equally
    // (~4.5556 each). Total = 150. See blokPlan.
    pointsPlan: blokPlan,
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
