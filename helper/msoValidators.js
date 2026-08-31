/*
 * Deterministic MSO validators. Pure; run per generated batch AND again before
 * publish, so nothing reaches a printed paper unchecked.
 *
 * The blueprint is DATA, not prompt text, and so is the paper's SHAPE: a blueprint
 * states its own rowCount, its own per-row Bloom level and its own points ladder,
 * seeded from a preset in config/msoPresets.js. Nothing here hard-codes 15 or 20,
 * so a paper of any length validates.
 *
 * Anything the teacher has not decided is reported as a blocking gap — never
 * guessed, never copied from a neighbouring row.
 */
const MsoBlueprint = require("../models/msoBlueprintModel");
const { verifyAdaptation } = require("./adaptationTemplates");
const { VERIFY_STATUS } = require("./curriculumEvidence");
const { BLOOM_LEVELS } = require("../config/msoPresets");

const { QUESTION_TYPES, GRADING_MODES } = MsoBlueprint;

// The paper's length is DATA, never a constant: a blueprint states its own
// rowCount and every rule below reads it. `rows.length` is the fallback so a
// blueprint written before the field existed still validates.
const rowCountOf = (bp) =>
  Number(bp && bp.rowCount) || (Array.isArray(bp && bp.rows) ? bp.rows.length : 0);

const issue = (code, detail = {}) => ({ code, ...detail });

/*
 * Is the blueprint complete enough to generate from?
 *
 * Every row needs a Bloom level, a question type, a points value and a grading
 * mode, and the ladder must sum to the stated total. A row a preset did not cover
 * stays empty on purpose: generation refuses and NAMES it, rather than reusing a
 * neighbouring row's rules or fabricating a distribution.
 */
function readyToGenerate(blueprint) {
  const problems = [];
  const rows = Array.isArray(blueprint && blueprint.rows) ? blueprint.rows : [];

  const total = rowCountOf(blueprint);
  if (!total) problems.push(issue("row_count_undecided"));
  else if (rows.length !== total) problems.push(issue("row_count", { expected: total, got: rows.length }));

  const seen = new Set();
  for (const r of rows) {
    const no = Number(r.no);
    if (!Number.isSafeInteger(no) || no < 1 || (total && no > total)) { problems.push(issue("row_number_invalid", { no: r.no })); continue; }
    if (seen.has(no)) problems.push(issue("row_duplicated", { no }));
    seen.add(no);

    // Bloom lives on the ROW (seeded by a preset), so any structure is expressible;
    // it must still be one of the six recognised levels and must not be blank.
    if (!BLOOM_LEVELS.includes(r.bloom)) problems.push(issue("bloom_undecided", { no, got: r.bloom || null }));
    if (!QUESTION_TYPES.includes(r.questionType)) problems.push(issue("question_type_undecided", { no }));
    if (!Number.isFinite(Number(r.points))) problems.push(issue("points_undecided", { no }));
    if (!GRADING_MODES.includes(r.gradingMode)) problems.push(issue("grading_mode_undecided", { no }));
  }
  for (let n = 1; n <= total; n++) if (!seen.has(n)) problems.push(issue("row_missing", { no: n }));

  // totalPoints is explicit and validated against the ladder — never assumed. The
  // teacher's 15-task ladder already sums to exactly 100, so any change to the
  // paper's length forces a deliberate decision about the total.
  const wantTotal = Number(blueprint && blueprint.totalPoints);
  if (!Number.isFinite(wantTotal) || wantTotal <= 0) problems.push(issue("total_points_undecided"));
  else {
    const sum = rows.reduce((s, r) => s + (Number.isFinite(Number(r.points)) ? Number(r.points) : 0), 0);
    const complete = rows.every((r) => Number.isFinite(Number(r.points)));
    if (complete && Math.abs(sum - wantTotal) > 1e-9) problems.push(issue("points_sum_mismatch", { sum, total: wantTotal }));
  }

  const undecided = [...new Set(problems.filter((p) => p.code.endsWith("_undecided") && p.no).map((p) => p.no))].sort((a, b) => a - b);
  return { ok: problems.length === 0, problems, undecidedRows: undecided };
}

// ------------------------------------------------------------ task validation
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("az");

const PAIR_INVARIANTS = [
  "questionType", "points", "bloom", "subStandard", "criterion", "testedSkill", "difficulty",
];

/*
 * CR-MSO-014 — duplicates have THREE scopes, not one:
 *   within one variant            -> reject
 *   across variants, different pair -> reject
 *   across variants, SAME pair      -> EXEMPT (structural equivalence is the point)
 * A pair must additionally be DIFFERENTIATED: same template, but at least one
 * approved variable holding a different validated value.
 */
function validatePairs(tasks) {
  const problems = [];
  const byPair = new Map();
  for (const t of tasks) {
    if (!byPair.has(t.pairId)) byPair.set(t.pairId, {});
    byPair.get(t.pairId)[t.variant] = t;
  }

  for (const [pairId, pair] of byPair) {
    const { A, B } = pair;
    if (!A || !B) { problems.push(issue("pair_incomplete", { pairId, have: Object.keys(pair) })); continue; }

    for (const field of PAIR_INVARIANTS) {
      if (String(A[field] ?? "") !== String(B[field] ?? "")) {
        problems.push(issue("pair_parity", { pairId, field, a: A[field], b: B[field] }));
      }
    }
    const at = A.adaptation || {};
    const bt = B.adaptation || {};
    if (String(at.templateId || "") !== String(bt.templateId || "")) {
      problems.push(issue("pair_template_mismatch", { pairId }));
    }
    if (String(at.templateHash || "") !== String(bt.templateHash || "")) {
      problems.push(issue("pair_template_hash_mismatch", { pairId }));
    }

    // Differentiation. A and B must not be the same paper twice.
    const av = Array.isArray(at.variables) ? at.variables : [];
    const bv = Array.isArray(bt.variables) ? bt.variables : [];
    const differsByVariable =
      av.length > 0 &&
      av.length === bv.length &&
      av.some((v) => {
        const other = bv.find((x) => x && x.name === v.name);
        return other && Number(other.value) !== Number(v.value);
      });
    const differsByStatement = norm(A.statement) !== norm(B.statement);
    if (!differsByVariable && !differsByStatement) {
      problems.push(issue("variant_not_differentiated", { pairId }));
    }
    // When the template is answer-affecting, the two answers must differ too.
    if (at.templateId && Number.isFinite(Number(at.computed)) && Number.isFinite(Number(bt.computed))) {
      if (Number(at.computed) === Number(bt.computed) && differsByVariable) {
        problems.push(issue("variant_answers_identical", { pairId }));
      }
    }
  }
  return problems;
}

function validateDuplicates(tasks) {
  const problems = [];
  // within one variant
  for (const variant of ["A", "B"]) {
    const seen = new Map();
    for (const t of tasks.filter((x) => x.variant === variant)) {
      const k = norm(t.statement);
      if (!k) continue;
      if (seen.has(k)) problems.push(issue("duplicate_within_variant", { variant, a: seen.get(k), b: t.no }));
      else seen.set(k, t.no);
    }
  }
  // across variants, UNRELATED pairs only — a same-pair match is required, not a fault
  const a = tasks.filter((t) => t.variant === "A");
  const b = tasks.filter((t) => t.variant === "B");
  for (const x of a) {
    for (const y of b) {
      if (x.pairId === y.pairId) continue;
      if (norm(x.statement) && norm(x.statement) === norm(y.statement)) {
        problems.push(issue("duplicate_across_pairs", { a: x.no, b: y.no }));
      }
    }
  }
  return problems;
}

function validateTask(task, row) {
  const problems = [];
  const where = { no: task.no, variant: task.variant };

  if (row) {
    if (task.questionType !== row.questionType) problems.push(issue("type_off_blueprint", { ...where, expected: row.questionType }));
    if (Number(task.points) !== Number(row.points)) problems.push(issue("points_off_blueprint", { ...where, expected: row.points }));
    if (task.bloom !== row.bloom) problems.push(issue("bloom_off_blueprint", { ...where, expected: row.bloom }));
  }

  if (task.questionType === "closed4") {
    const choices = Array.isArray(task.choices) ? task.choices.map(norm).filter(Boolean) : [];
    if (choices.length !== 4) problems.push(issue("closed_needs_four_choices", { ...where, got: choices.length }));
    if (new Set(choices).size !== choices.length) problems.push(issue("closed_choices_not_distinct", where));
    const ci = Number(task.correctIndex);
    if (!Number.isSafeInteger(ci) || ci < 0 || ci > 3) problems.push(issue("closed_needs_one_correct", where));
  } else if (task.questionType === "short") {
    if (!norm(task.answer)) problems.push(issue("short_needs_answer", where));
  } else if (task.questionType === "extended") {
    if (!norm(task.rubric)) problems.push(issue("extended_needs_rubric", where));
  }

  // Numeric adaptation is auto-verified ONLY through a server-owned template.
  // Anything else is honestly marked for review, never claimed as verified.
  if (task.adaptation && task.adaptation.templateId) {
    const r = verifyAdaptation(task.adaptation);
    if (!r.ok) problems.push(issue("adaptation_unverified", { ...where, reason: r.code }));
  } else if (task.sourceMode === "adapted") {
    problems.push(issue("adaptation_not_formalised", where));
  }

  // Textbook-only tasks need RESOLVED evidence, not merely a page number.
  if (row && row.sourceRequirement === "textbook_only") {
    if (task.sourceMode === "original") problems.push(issue("original_forbidden_in_textbook_only", where));
    const ev = task.sourceEvidence;
    const okStatus = ev && [VERIFY_STATUS.MACHINE_MATCHED, VERIFY_STATUS.TEACHER_VERIFIED].includes(ev.verifyStatus);
    if (!okStatus) problems.push(issue("evidence_unresolved", { ...where, status: ev ? ev.verifyStatus : null }));
  }
  return problems;
}

/*
 * The answer key, per the document's own two rules:
 *   "Cavab variantlari inandirici (distraktorlar duzgun secilmis)"
 *   "Ardicil olaraq tekrarlanan duzgun cavablar olmamalidir"
 * A RUN of identical letters is forbidden outright; overall skew is flagged only
 * when it is real, so the key is never forced into an artificial pattern either.
 */
const MAX_ANSWER_RUN = Number(process.env.MSO_MAX_ANSWER_RUN) || 2;

function validateAnswerKeyBalance(tasks) {
  const problems = [];
  for (const variant of ["A", "B"]) {
    const closed = tasks
      .filter((t) => t.variant === variant && t.questionType === "closed4")
      .sort((a, b) => Number(a.no) - Number(b.no));
    if (closed.length < 4) continue;

    const counts = [0, 0, 0, 0];
    for (const t of closed) if (Number.isSafeInteger(Number(t.correctIndex))) counts[Number(t.correctIndex)] += 1;
    const max = Math.max(...counts);
    if (max > Math.ceil(closed.length * 0.6)) problems.push(issue("answer_key_skewed", { variant, counts }));

    let run = 1;
    for (let i = 1; i < closed.length; i++) {
      const same = Number(closed[i].correctIndex) === Number(closed[i - 1].correctIndex);
      run = same ? run + 1 : 1;
      if (run > MAX_ANSWER_RUN) {
        problems.push(issue("answer_key_consecutive_repeat", { variant, from: closed[i - run + 1].no, to: closed[i].no, run }));
        break;
      }
    }
  }
  return problems;
}

/*
 * The whole document. `strict` (publish time) also requires every task accepted.
 */
function validateMsoDocument(doc, blueprint, { strict = false } = {}) {
  const problems = [];
  const ready = readyToGenerate(blueprint);
  if (!ready.ok) problems.push(...ready.problems);

  const tasks = Array.isArray(doc && doc.tasks) ? doc.tasks : [];
  const rowByNo = new Map((blueprint && blueprint.rows ? blueprint.rows : []).map((r) => [Number(r.no), r]));

  const total = rowCountOf(blueprint);
  for (const variant of ["A", "B"]) {
    const list = tasks.filter((t) => t.variant === variant);
    if (list.length !== total) problems.push(issue("variant_task_count", { variant, expected: total, got: list.length }));
    const nos = new Set(list.map((t) => Number(t.no)));
    for (let n = 1; n <= total; n++) if (!nos.has(n)) problems.push(issue("variant_task_missing", { variant, no: n }));
  }
  for (const t of tasks) problems.push(...validateTask(t, rowByNo.get(Number(t.no))));
  problems.push(...validatePairs(tasks));
  problems.push(...validateDuplicates(tasks));
  problems.push(...validateAnswerKeyBalance(tasks));

  const totals = {};
  for (const variant of ["A", "B"]) {
    totals[variant] = tasks.filter((t) => t.variant === variant).reduce((s, t) => s + (Number(t.points) || 0), 0);
    const want = Number(blueprint && blueprint.totalPoints);
    if (Number.isFinite(want) && Math.abs(totals[variant] - want) > 1e-9) {
      problems.push(issue("variant_points_total", { variant, sum: totals[variant], total: want }));
    }
  }

  if (strict) {
    for (const t of tasks) {
      if (t.reviewStatus !== "accepted") problems.push(issue("task_not_accepted", { no: t.no, variant: t.variant, status: t.reviewStatus }));
    }
  }
  return { ok: problems.length === 0, problems, totals };
}

/*
 * The analytics table is DERIVED, never generated separately — so it cannot
 * contradict the paper it describes.
 */
function buildAnalyticsTable(doc, blueprint) {
  const rowByNo = new Map((blueprint && blueprint.rows ? blueprint.rows : []).map((r) => [Number(r.no), r]));
  const out = [];
  // One row per task, whatever the paper's length — the document requires the
  // table to contain EVERY task ("Cedvelde BUTUN ... tapsiriq olmalidir").
  for (let no = 1; no <= rowCountOf(blueprint); no++) {
    const row = rowByNo.get(no) || {};
    const a = (doc.tasks || []).find((t) => Number(t.no) === no && t.variant === "A");
    const ev = (a && a.sourceEvidence) || {};
    out.push({
      no,
      printedPageLabel: ev.printedPageLabel || "",
      sourceTaskNo: ev.sourceTaskNo || "",
      subStandard: row.subStandard || (a && a.subStandard) || "",
      criterion: row.criterion || (a && a.criterion) || "",
      testedSkill: row.testedSkill || (a && a.testedSkill) || "",
      bloom: row.bloom || (a && a.bloom) || "",
      points: row.points ?? (a && a.points) ?? null,
      sourceMode: (a && a.sourceMode) || "",
      verifyStatus: ev.verifyStatus || "",
    });
  }
  return out;
}

module.exports = {
  BLOOM_LEVELS,
  MAX_ANSWER_RUN,
  rowCountOf,
  PAIR_INVARIANTS,
  readyToGenerate,
  validateTask,
  validatePairs,
  validateDuplicates,
  validateAnswerKeyBalance,
  validateMsoDocument,
  buildAnalyticsTable,
};
