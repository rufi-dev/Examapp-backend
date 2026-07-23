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

// Riyaziyyat Buraxılış 9-cu sinif (DİM), out of 100: solution-required questions
// (type Cd) are weighted 2×; normalized to 100. No negative marking. BY TYPE.
function bur9Plan(count, types) {
  const n = Number(count) || 0;
  if (n <= 0) return [];
  const t = Array.isArray(types) ? types : [];
  const weights = Array.from({ length: n }, (_, i) => (t[i] === "Cd" ? 2 : 1));
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  return weights.map((w) => (w / total) * 100);
}

// Every question worth an EQUAL share of totalMarks (10 pts each for a 10-question
// test). Adapts to the count so the total stays at totalMarks.
function equalPlan(count, totalMarks) {
  const n = Number(count) || 0;
  return n > 0 ? Array.from({ length: n }, () => totalMarks / n) : [];
}

const PRESETS = {
  // Custom — no fixed blueprint. The teacher builds from scratch; for PDF+AI the
  // model auto-detects the actual question count and open/closed types. Scoring
  // falls back to legacy per-question points (pointsPlan null).
  custom: {
    id: "custom",
    label: "Fərdi (sıfırdan)",
    totalMarks: 100,
    slots: [],
    pointsPlan: null,
    negativeMarking: null,
  },

  buraxilis: {
    id: "buraxilis",
    label: "Buraxılış (11-ci sinif)",
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
    label: "Buraxılış (9-cu sinif)",
    totalMarks: 100,
    // 25 tapşırıq: 15 qapalı (#1-15) + 6 açıq (#16-21) + 4 həlli tələb olunan açıq
    // (#22-25, type Cd). Cd suallar 2× ağırdır; cəmi 100. Səhv düzü aparmır.
    slots: [
      { type: "Cm", count: 15 },
      { type: "Co", count: 6 },
      { type: "Cd", count: 4 },
    ],
    pointsPlan: bur9Plan,
    negativeMarking: null,
  },

  dqt: {
    id: "dqt",
    label: "DQT (Dərsi Qiymətləndirmə Testi)",
    totalMarks: 100,
    // 10 sual, hər biri 10 bal (cəmi 100). Standart 7 qapalı + 3 açıq — açıq/qapalı
    // sayı PDF-ə görə dəyişir, müəllim tipləri özü təyin edə bilər.
    slots: [
      { type: "Cm", count: 7 },
      { type: "Co", count: 3 },
    ],
    pointsPlan: (count) => equalPlan(count, 100),
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

  // English (İngilis dili) buraxılış — DİM blueprint, out of 100. 30 questions:
  // 23 closed + 7 open, open weighted 2× closed (closed ≈ 2.70, open ≈ 5.41) via
  // azWrittenPlan. Sections: Listening 6 (4 closed + 2 open) + Grammar/Vocab 16
  // (closed) + Reading 8 (1 passage + 3 closed + 5 open). Listening audio (mp3)
  // is attached to the exam itself. 9th & 11th share the same structure.
  "en-buraxilis-9": {
    id: "en-buraxilis-9",
    label: "Buraxılış — İngilis dili (9)",
    totalMarks: 100,
    slots: [
      { type: "Cm", count: 4 },      // Listening (Dinləmə) — qapalı
      { type: "Co", count: 2 },      // Listening — açıq
      { type: "Cm", count: 16 },     // Grammar & Vocabulary — qapalı
      { type: "reading", count: 1 }, // Reading passage (Oxu mətni)
      { type: "Cm", count: 3 },      // Reading — qapalı
      { type: "Co", count: 5 },      // Reading — açıq
    ],
    pointsPlan: azWrittenPlan,
    negativeMarking: null,
  },

  "en-buraxilis-11": {
    id: "en-buraxilis-11",
    label: "Buraxılış — İngilis dili (11)",
    totalMarks: 100,
    slots: [
      { type: "Cm", count: 4 },      // Listening (Dinləmə) — qapalı
      { type: "Co", count: 2 },      // Listening — açıq
      { type: "Cm", count: 16 },     // Grammar & Vocabulary — qapalı
      { type: "reading", count: 1 }, // Reading passage (Oxu mətni)
      { type: "Cm", count: 3 },      // Reading — qapalı
      { type: "Co", count: 5 },      // Reading — açıq
    ],
    pointsPlan: azWrittenPlan,
    negativeMarking: null,
  },

  // IELTS Academic Reading — 3 long passages, ~13 questions each (~40 total),
  // scored 1 mark per question (band conversion is external). The AI writes the
  // real structure; these slots are only a light fallback for manual building.
  // Reading blocks are content, not scored.
  "ielts-reading": {
    id: "ielts-reading",
    label: "IELTS Academic Reading",
    totalMarks: 40,
    slots: [
      { type: "reading", count: 1 },
      { type: "Cm", count: 13 },
      { type: "reading", count: 1 },
      { type: "Cm", count: 13 },
      { type: "reading", count: 1 },
      { type: "Cm", count: 14 },
    ],
    pointsPlan: (count) => equalPlan(count, 40),
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
