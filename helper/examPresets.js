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

// 9th-grade Azerbaijani-language buraxılış scoring (DİM), out of 100 (nisbi bal).
// Weighted BY TYPE, not position — so a variant can place its open / matching
// questions in ANY order (or have a different number of them) and still score
// right: each open (Co) question is worth 2 units, every closed one
// (Cm/Cs/Cma/Cmu) 1 unit, and the whole sheet is normalized to 100. For the
// standard 26 closed + 4 open that is 34 units → closed 100/34, open 200/34.
function azWrittenPlan(count, types) {
  const n = Number(count) || 0;
  if (n <= 0) return [];
  const t = Array.isArray(types) ? types : [];
  const weights = Array.from({ length: n }, (_, i) => (t[i] === "Co" ? 2 : 1));
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  return weights.map((w) => (w / total) * 100);
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
      { type: "Cmu", count: 1 },
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
    // Scored out of 100 (DİM nisbi bal): 26 qapalı + 4 açıq, açıq 2x ağır →
    // qapalı ≈ 2.94, açıq ≈ 5.88, cəmi 100.
    totalMarks: 100,
    // 30 tapşırıq: 10 dil qaydası (qapalı) + 2 oxu mətni × (8 qapalı + 2 açıq).
    // Adətən UYĞUNLAŞDIRMA (matching) OLMUR — yalnız tək seçim və açıq.
    // Oxu mətnləri (reading) məzmun blokudur, qiymətləndirilmir.
    slots: [
      { type: "Cm", count: 10 },     // dil qaydaları (qapalı)
      { type: "reading", count: 1 }, // Mətn 1
      { type: "Cm", count: 8 },      // mətn-1 qapalı
      { type: "Co", count: 2 },      // mətn-1 açıq (yazılı)
      { type: "reading", count: 1 }, // Mətn 2
      { type: "Cm", count: 8 },      // mətn-2 qapalı
      { type: "Co", count: 2 },      // mətn-2 açıq (yazılı)
    ],
    // Açıq sual qapalıdan 2x ağırdır; cəmi maksimal bal 100 (DİM nisbi balı).
    pointsPlan: azWrittenPlan,
    negativeMarking: null,
  },

  "az-buraxilis-11": {
    id: "az-buraxilis-11",
    label: "Buraxılış — Azərbaycan dili (11)",
    // Scored out of 100 (DİM nisbi bal): 20 qapalı × 2.5 + 10 açıq × 5 = 100,
    // açıq 2x ağır.
    totalMarks: 100,
    // 30 tapşırıq: 10 dil qaydası (qapalı) + 2 oxu mətni (bədii + publisistik),
    // hər mətndə 5 qapalı + 5 açıq. Adətən uyğunlaşdırma olmur.
    slots: [
      { type: "Cm", count: 10 },     // dil qaydaları (qapalı)
      { type: "reading", count: 1 }, // Mətn 1 (bədii)
      { type: "Cm", count: 5 },      // mətn-1 qapalı
      { type: "Co", count: 5 },      // mətn-1 açıq (yazılı)
      { type: "reading", count: 1 }, // Mətn 2 (publisistik)
      { type: "Cm", count: 5 },      // mətn-2 qapalı
      { type: "Co", count: 5 },      // mətn-2 açıq (yazılı)
    ],
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
