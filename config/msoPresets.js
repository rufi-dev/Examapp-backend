/*
 * MSO structures as DATA, so the paper is never hard-coded to one shape.
 *
 * The teacher's own prompt document specifies, five times over, a FIFTEEN-task
 * assessment:
 *   - "15 tapşırıq"
 *   - "1–11-ci tapşırıqlar — qapalı tip, 4 cavab variantı … yalnız 1 düzgün cavab"
 *   - "12–15-ci tapşırıqlar — açıq tip (qısa cavab)"
 *   - a points ladder ending at 15 that sums to EXACTLY 100
 *     (4x5 + 5x6 + 2x7 + 2x8 + 2x10 = 20+30+14+16+20 = 100)
 *   - "Cədvəldə BÜTÜN 15 tapşırıq olmalıdır"
 *   - and an explicit prohibition: "15 sualdan ibarət strukturu dəyişmək olmaz"
 *
 * The one line pointing elsewhere is a Bloom listing that runs to 20 — a leftover
 * from a 20-task template. Its first three bands (1–3, 4–6, 7–11) land exactly on
 * the closed-question range, so `az-mso-15` keeps them verbatim and folds the
 * remaining three levels onto the four open tasks in the document's own order.
 * Nothing is invented: the levels, their order and their names are the document's.
 *
 * `az-mso-20` ships the literal 20-row listing for a teacher who wants it. Neither
 * is privileged in code — a preset only SEEDS a blueprint, and every row stays
 * editable afterwards, so a structure nobody has thought of yet is still reachable.
 */
const BLOOM_LEVELS = Object.freeze([
  "Yadda saxlama",
  "Anlama",
  "Tətbiq",
  "Təhlil",
  "Qiymətləndirmə",
  "Yaratma",
]);

// A band is inclusive on both ends and 1-based, matching how the document writes
// them ("1–3", "12–15").
const band = (from, to, value) => ({ from, to, value });

const PRESETS = {
  "az-mso-15": {
    id: "az-mso-15",
    label: "MSO — 15 tapşırıq (müəllimin promtu)",
    rowCount: 15,
    totalPoints: 100,
    // "1–11 qapalı tip", "12–15 açıq tip (qısa cavab)".
    types: [band(1, 11, "closed4"), band(12, 15, "short")],
    // The open tasks need BOTH a full answer and criteria — the document asks for
    // "12–15-ci tapşırıqlar üçün tam düzgün cavablar" AND a criteria column
    // "xüsusilə açıq suallar üçün" — so they are rubric-graded, not auto.
    grading: [band(1, 11, "auto"), band(12, 15, "rubric")],
    points: [band(1, 4, 5), band(5, 9, 6), band(10, 11, 7), band(12, 13, 8), band(14, 15, 10)],
    // The document's first three bands verbatim; the last three levels, in its
    // order, over the four open tasks.
    bloom: [
      band(1, 3, "Yadda saxlama"),
      band(4, 6, "Anlama"),
      band(7, 11, "Tətbiq"),
      band(12, 13, "Təhlil"),
      band(14, 14, "Qiymətləndirmə"),
      band(15, 15, "Yaratma"),
    ],
    sourceRequirement: "textbook_only", // "BÜTÜN tapşırıqlar YALNIZ dərslikdən"
  },

  "az-mso-20": {
    id: "az-mso-20",
    label: "MSO — 20 tapşırıq (genişləndirilmiş Blum)",
    rowCount: 20,
    // Deliberately absent: extending the ladder past 15 changes a total that is
    // already exactly 100, and that is the teacher's call, not a default.
    totalPoints: undefined,
    // The document specifies types, grading and points only up to task 15. Rows
    // 16-20 are therefore left COMPLETELY undecided — extending "short/rubric" to
    // them would be an inference, and the teacher must state it.
    types: [band(1, 11, "closed4"), band(12, 15, "short")],
    grading: [band(1, 11, "auto"), band(12, 15, "rubric")],
    points: [band(1, 4, 5), band(5, 9, 6), band(10, 11, 7), band(12, 13, 8), band(14, 15, 10)],
    // The document's listing, exactly as written.
    bloom: [
      band(1, 3, "Yadda saxlama"),
      band(4, 6, "Anlama"),
      band(7, 11, "Tətbiq"),
      band(12, 17, "Təhlil"),
      band(18, 19, "Qiymətləndirmə"),
      band(20, 20, "Yaratma"),
    ],
    sourceRequirement: "textbook_only",
  },
};

const DEFAULT_PRESET = "az-mso-15";
const presetIds = () => Object.keys(PRESETS);
const isPreset = (id) => Object.prototype.hasOwnProperty.call(PRESETS, id);

const valueAt = (bands, no) => {
  const hit = (bands || []).find((b) => b && no >= b.from && no <= b.to);
  return hit ? hit.value : undefined;
};

/*
 * Seed a blueprint's rows from a preset. A row the preset does not cover is left
 * DELIBERATELY INCOMPLETE (no type, no points, no grading mode) so
 * readyToGenerate refuses and names it, rather than the platform guessing.
 */
function buildRows(presetId = DEFAULT_PRESET) {
  const p = PRESETS[presetId];
  if (!p) throw new Error(`Unknown MSO preset "${presetId}"`);
  const rows = [];
  for (let no = 1; no <= p.rowCount; no++) {
    rows.push({
      no,
      bloom: valueAt(p.bloom, no) || "",
      questionType: valueAt(p.types, no),
      points: valueAt(p.points, no),
      gradingMode: valueAt(p.grading, no),
      subStandard: "",
      criterion: "",
      testedSkill: "",
      difficulty: "",
      sourceRequirement: p.sourceRequirement || "textbook_preferred",
    });
  }
  return rows;
}

const presetSummary = (id) => {
  const p = PRESETS[id];
  if (!p) return null;
  const rows = buildRows(id);
  const sum = rows.reduce((s, r) => s + (Number.isFinite(Number(r.points)) ? Number(r.points) : 0), 0);
  const complete = rows.every((r) => r.questionType && Number.isFinite(Number(r.points)) && r.gradingMode && r.bloom);
  return { id, label: p.label, rowCount: p.rowCount, totalPoints: p.totalPoints, pointsSum: sum, complete };
};

module.exports = { BLOOM_LEVELS, PRESETS, DEFAULT_PRESET, presetIds, isPreset, buildRows, valueAt, presetSummary };
