/*
 * MSO blueprint readiness, task validation, A/B semantics and the adaptation
 * registries.
 *
 * The load-bearing behaviours:
 *   - the 20-row Bloom mapping is the owner's and is LOCKED; rows 16-20 have no
 *     defaults and generation refuses until the owner decides them;
 *   - totalPoints is explicit and validated — never assumed to be 100;
 *   - CR-MSO-014: an A/B pair is EXEMT from the duplicate rule and REQUIRED to
 *     differ in a validated variable;
 *   - CR-MSO-007/013/017: no model-supplied expression is ever executed, and a
 *     document is interpreted under its ORIGINAL semantics or not at all.
 */
const assert = require("assert");
const v = require("../helper/msoValidators");
const t = require("../helper/adaptationTemplates");
const { buildRows, presetSummary, BLOOM_LEVELS } = require("../config/msoPresets");
const MANIFEST = require("../config/adaptationManifest");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};
const codes = (r) => [...new Set((r.problems || []).map((p) => p.code))];

// ---------------------------------------------------------------- fixtures
const TPL = "volume_rectangular_prism.v1";
const HASH = t.templateHashOf(TPL);
const adaptation = (a, b, c, computed) => ({
  templateId: TPL,
  templateHash: HASH,
  evaluatorVersion: "v1",
  variables: [
    { name: "a", value: a, unit: "sm" },
    { name: "b", value: b, unit: "sm" },
    { name: "c", value: c, unit: "sm" },
  ],
  rounding: "int",
  computed,
});

// The document's own 15-task structure, with an optional 20-task variant whose
// rows 16-20 the document never specifies.
function blueprint({ preset = "az-mso-15" } = {}) {
  const rows = buildRows(preset).map((r) => ({
    ...r,
    subStandard: "2.1.3",
    criterion: "meyar",
    testedSkill: "skill",
    sourceRequirement: "any",
  }));
  const complete = rows.every((r) => Number.isFinite(Number(r.points)));
  return {
    rows,
    rowCount: rows.length,
    totalPoints: complete ? rows.reduce((s2, r) => s2 + Number(r.points), 0) : undefined,
  };
}
const ROWS = 15;

function task(no, variant, over = {}) {
  const bp = blueprint().rows[no - 1];
  const base = {
    no,
    variant,
    pairId: `p${no}`,
    questionType: bp.questionType,
    points: bp.points,
    bloom: bp.bloom,
    subStandard: bp.subStandard,
    criterion: bp.criterion,
    testedSkill: bp.testedSkill,
    difficulty: "",
    statement: `Sual ${no}${variant}`,
    reviewStatus: "accepted",
    sourceMode: "original",
  };
  if (bp.questionType === "closed4") {
    base.choices = ["a", "b", "c", "d"];
    base.correctIndex = no % 4;
  } else if (bp.questionType === "short") base.answer = "cavab";
  else base.rubric = "meyarlar";
  return { ...base, ...over };
}
const fullDoc = (over = () => ({})) => ({
  tasks: [...Array(ROWS)].flatMap((_, i) => ["A", "B"].map((va) => task(i + 1, va, over(i + 1, va)))),
});

console.log("\n1. The paper's shape is DATA, and gaps are never guessed:");
{
  // The document specifies 15 tasks five times over, including an explicit
  // "15 sualdan ibarət strukturu dəyişmək olmaz". That preset is complete.
  const p15 = presetSummary("az-mso-15");
  ok("the default preset is the document's 15-task structure", p15.rowCount === 15 && p15.complete, JSON.stringify(p15));
  ok("its ladder sums to exactly 100", p15.pointsSum === 100 && p15.totalPoints === 100, p15.pointsSum);
  ok("a 15-task blueprint is ready to generate", v.readyToGenerate(blueprint()).ok);

  // The 20-task listing in the same document never states types or points for
  // 16-20, so those rows stay empty and generation refuses, naming them.
  const r20 = v.readyToGenerate(blueprint({ preset: "az-mso-20" }));
  ok("the 20-task preset is NOT ready", r20.ok === false);
  ok("it names exactly rows 16-20", JSON.stringify(r20.undecidedRows) === JSON.stringify([16, 17, 18, 19, 20]), JSON.stringify(r20.undecidedRows));
  ok(
    "the reasons are type/points/grading, not a guess",
    ["question_type_undecided", "points_undecided", "grading_mode_undecided"].every((c) => codes(r20).includes(c)),
    JSON.stringify(codes(r20))
  );
  ok("nothing is copied from row 15", r20.problems.some((p) => p.no === 16 && p.code === "question_type_undecided"));
  ok("its total is undecided too, since the ladder cannot be known", codes(r20).includes("total_points_undecided"));

  // Any other length works with no code change.
  const rows12 = buildRows("az-mso-15").slice(0, 12);
  const bp12 = { rows: rows12, rowCount: 12, totalPoints: rows12.reduce((s2, r) => s2 + r.points, 0) };
  ok("an arbitrary 12-task paper validates", v.readyToGenerate(bp12).ok, JSON.stringify(v.readyToGenerate(bp12).problems.slice(0, 2)));
  ok("its analytics table has 12 rows", v.buildAnalyticsTable({ tasks: [] }, bp12).length === 12);
}

console.log("\n2. Bloom lives on the row, seeded from the document's bands:");
{
  const rows = buildRows("az-mso-15");
  const at = (n) => rows[n - 1].bloom;
  // The document's first three bands, verbatim.
  ok("1-3 are Yadda saxlama", [1, 2, 3].every((n) => at(n) === "Yadda saxlama"));
  ok("4-6 are Anlama", [4, 5, 6].every((n) => at(n) === "Anlama"));
  ok("7-11 are Tətbiq", [7, 8, 9, 10, 11].every((n) => at(n) === "Tətbiq"));
  // The remaining three levels, in the document's order, over the four open tasks.
  ok("12-13 are Təhlil", [12, 13].every((n) => at(n) === "Təhlil"));
  ok("14 is Qiymətləndirmə", at(14) === "Qiymətləndirmə");
  ok("15 is Yaratma — the hardest task stays last", at(15) === "Yaratma");
  ok("the 20-task preset keeps the document's longer listing", buildRows("az-mso-20")[19].bloom === "Yaratma");

  const bp = blueprint();
  bp.rows[11].bloom = "";
  ok("a blank Bloom level blocks generation", codes(v.readyToGenerate(bp)).includes("bloom_undecided"));
  const bp2 = blueprint();
  bp2.rows[11].bloom = "Uydurma səviyyə";
  ok("an invented Bloom level blocks generation", codes(v.readyToGenerate(bp2)).includes("bloom_undecided"));
  ok("all six levels are recognised", BLOOM_LEVELS.length === 6);

  const short = blueprint();
  short.rows = short.rows.slice(0, 12);
  ok("a row count that disagrees with rowCount is refused", codes(v.readyToGenerate(short)).includes("row_count"));
}

console.log("\n3. totalPoints is explicit, never assumed to be 100:");
{
  const bp = blueprint();
  bp.totalPoints = 137;
  ok("a sum that disagrees with totalPoints is refused", codes(v.readyToGenerate(bp)).includes("points_sum_mismatch"));
  const bp2 = blueprint();
  delete bp2.totalPoints;
  ok("a missing totalPoints is refused, not defaulted", codes(v.readyToGenerate(bp2)).includes("total_points_undecided"));
  const bp3 = blueprint();
  bp3.rows = bp3.rows.map((r) => ({ ...r, points: 6 }));
  bp3.totalPoints = 6 * ROWS;
  ok("a NON-100 total is accepted when it matches the sum", v.readyToGenerate(bp3).ok);
  ok("the document's own ladder does sum to 100", blueprint().totalPoints === 100, blueprint().totalPoints);
}

console.log("\n4. CR-MSO-014 — three duplicate scopes, not one:");
{
  const bp = blueprint();
  // A legitimate pair: same structure, different numbers.
  const doc = fullDoc((no, va) => ({
    // Each QUESTION differs (or the within-variant rule fires, correctly); the two
    // VARIANTS of one question differ only in their numbers.
    statement: `Sual ${no}: həcmi tapın: ${va === "A" ? `${no}, 3, 4` : `${no + 3}, 6, 7`} sm`,
    adaptation: va === "A" ? adaptation(no, 3, 4, no * 12) : adaptation(no + 3, 6, 7, (no + 3) * 42),
  }));
  const r = v.validateMsoDocument(doc, bp);
  ok("a properly differentiated A/B pair is NOT a duplicate", !codes(r).includes("duplicate_across_pairs"), JSON.stringify(codes(r)));
  ok("a properly differentiated A/B pair validates clean", r.ok, JSON.stringify(r.problems.slice(0, 4)));

  // Identical A and B — the failure the exemption must still catch.
  const same = fullDoc((no, va) => ({ statement: "Eyni sual", adaptation: adaptation(2, 3, 4, 24) }));
  ok("an IDENTICAL pair is rejected as not differentiated", codes(v.validateMsoDocument(same, bp)).includes("variant_not_differentiated"));

  // Two different questions inside one variant that read the same.
  const dupInVariant = fullDoc((no, va) => ({ statement: va === "A" && (no === 3 || no === 4) ? "Təkrar sual" : `Sual ${no}${va}` }));
  ok("a duplicate WITHIN a variant is rejected", codes(v.validateMsoDocument(dupInVariant, bp)).includes("duplicate_within_variant"));

  // A's question 3 equals B's question 7 — unrelated pairs.
  const crossPair = fullDoc((no, va) => {
    if (va === "A" && no === 3) return { statement: "Eyni mətn" };
    if (va === "B" && no === 7) return { statement: "Eyni mətn" };
    return {};
  });
  ok("a duplicate across UNRELATED pairs is rejected", codes(v.validateMsoDocument(crossPair, bp)).includes("duplicate_across_pairs"));

  // Parity: a pair must not differ in points/bloom/type.
  const skew = fullDoc((no, va) => (va === "B" && no === 2 ? { points: 9, statement: "fərqli" } : {}));
  ok("a pair differing in an invariant field is rejected", codes(v.validateMsoDocument(skew, bp)).includes("pair_parity"));
}

console.log("\n5. Per-task rules:");
{
  const bp = blueprint();
  const bad = (over, code) => {
    const doc = fullDoc((no, va) => (no === 1 && va === "A" ? over : {}));
    ok(`${code}`, codes(v.validateMsoDocument(doc, bp)).includes(code), JSON.stringify(codes(v.validateMsoDocument(doc, bp))));
  };
  bad({ choices: ["a", "b", "c"] }, "closed_needs_four_choices");
  bad({ choices: ["a", "a", "b", "c"] }, "closed_choices_not_distinct");
  bad({ correctIndex: 9 }, "closed_needs_one_correct");
  bad({ correctIndex: undefined }, "closed_needs_one_correct");

  const shortDoc = fullDoc((no, va) => (no === 12 && va === "A" ? { answer: "" } : {}));
  ok("short_needs_answer", codes(v.validateMsoDocument(shortDoc, bp)).includes("short_needs_answer"));
  // The 15-task structure has no `extended` row, so build one: the rule must hold
  // for any shape a teacher configures, not just the default.
  const extBp = blueprint();
  extBp.rows[ROWS - 1] = { ...extBp.rows[ROWS - 1], questionType: "extended", gradingMode: "manual" };
  const extDoc = fullDoc((no, va) =>
    no === ROWS ? { questionType: "extended", rubric: va === "A" ? "" : "meyarlar", answer: "" } : {}
  );
  ok("extended_needs_rubric", codes(v.validateMsoDocument(extDoc, extBp)).includes("extended_needs_rubric"));

  const missing = { tasks: fullDoc().tasks.filter((x) => !(x.no === 5 && x.variant === "B")) };
  const mr = codes(v.validateMsoDocument(missing, bp));
  ok("a missing task is caught", mr.includes("variant_task_missing") && mr.includes("variant_task_count"));

  const unreviewed = fullDoc((no, va) => (no === 2 && va === "A" ? { reviewStatus: "pending" } : {}));
  ok("publish (strict) requires every task accepted", codes(v.validateMsoDocument(unreviewed, bp, { strict: true })).includes("task_not_accepted"));
  ok("generation (non-strict) does not", !codes(v.validateMsoDocument(unreviewed, bp)).includes("task_not_accepted"));
}

console.log("\n6. textbook_only demands RESOLVED evidence:");
{
  const bp = blueprint();
  bp.rows = bp.rows.map((r) => ({ ...r, sourceRequirement: "textbook_only" }));
  const noEv = fullDoc(() => ({ sourceMode: "verbatim" }));
  ok("a task with no evidence is refused", codes(v.validateMsoDocument(noEv, bp)).includes("evidence_unresolved"));
  const unver = fullDoc(() => ({ sourceMode: "verbatim", sourceEvidence: { verifyStatus: "unverified" } }));
  ok("an UNVERIFIED citation is refused", codes(v.validateMsoDocument(unver, bp)).includes("evidence_unresolved"));
  const original = fullDoc(() => ({ sourceMode: "original", sourceEvidence: { verifyStatus: "teacher_verified" } }));
  ok("sourceMode 'original' is forbidden in textbook_only", codes(v.validateMsoDocument(original, bp)).includes("original_forbidden_in_textbook_only"));
  const good = fullDoc((no, va) => ({
    sourceMode: "verbatim",
    sourceEvidence: { verifyStatus: va === "A" ? "machine_matched" : "teacher_verified" },
    statement: `Sual ${no}${va}`,
  }));
  ok("machine_matched and teacher_verified both satisfy it", !codes(v.validateMsoDocument(good, bp)).includes("evidence_unresolved"));
}

console.log("\n7. CR-MSO-007/013/017 — adaptation is server-computed and version-pinned:");
{
  ok("a correct adaptation verifies", t.verifyAdaptation(adaptation(2, 3, 4, 24)).ok);
  ok("a WRONG claimed answer is rejected", t.verifyAdaptation(adaptation(2, 3, 4, 25)).code === "computed_mismatch");
  ok("an unknown template is rejected", t.verifyAdaptation({ templateId: "nope.v1" }).code === "template_unknown");
  ok("an out-of-bounds variable is rejected", t.verifyAdaptation(adaptation(999999, 3, 4, 1)).code === "variable_out_of_bounds");
  ok("a non-finite variable is rejected", t.verifyAdaptation({ ...adaptation(2, 3, 4, 24), variables: [{ name: "a", value: Infinity, unit: "sm" }, { name: "b", value: 3, unit: "sm" }, { name: "c", value: 4, unit: "sm" }] }).code === "variable_non_finite");
  ok("a unit mismatch is rejected", t.verifyAdaptation({ ...adaptation(2, 3, 4, 24), variables: [{ name: "a", value: 2, unit: "km" }, { name: "b", value: 3, unit: "sm" }, { name: "c", value: 4, unit: "sm" }] }).code === "unit_mismatch");
  ok("division by zero is rejected", t.computeAdaptation({ templateId: "linear_equation_root.v1", variables: [{ name: "a", value: 0 }, { name: "b", value: 1 }, { name: "c", value: 5 }] }).code === "adaptation_division_by_zero");

  // A CHANGED template hash means the semantics moved. The document must fail,
  // never be re-interpreted under the new meaning.
  ok("a stale templateHash fails closed", t.verifyAdaptation({ ...adaptation(2, 3, 4, 24), templateHash: "0".repeat(64) }).code === "template_hash_mismatch");
  ok("a mismatched evaluatorVersion fails closed", t.verifyAdaptation({ ...adaptation(2, 3, 4, 24), evaluatorVersion: "v2" }).code === "evaluator_version_mismatch");

  // Evaluators are an append-only REGISTRY: an unknown version resolves to nothing
  // at all, rather than falling back to the newest.
  let code = null;
  try { t.evaluatorFor("v99"); } catch (e) { code = e.code; }
  ok("an unknown evaluator version throws, with no fallback", code === "evaluator_version_unknown");
  ok("evaluatorFor('v1') resolves the pinned implementation", t.evaluatorFor("v1").version === "v1");

  // No expression is ever executed.
  ok("computeAdaptation ignores a model-supplied expression", t.verifyAdaptation({ ...adaptation(2, 3, 4, 24), expression: "process.exit(1)" }).ok);
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "helper", "adaptationTemplates.js"), "utf8");
  ok("the module contains no eval/Function/vm", !/\beval\s*\(|new Function\s*\(|require\(["']vm["']\)/.test(src));

  // The frozen manifest is what makes an in-place edit fail at BOOT.
  const live = t.buildManifest();
  ok("the frozen manifest matches the live registries", JSON.stringify(live) === JSON.stringify(MANIFEST));
  ok("the manifest carries a digest per EVALUATOR version too", Object.keys(MANIFEST.evaluators).length >= 1 && typeof MANIFEST.evaluators.v1 === "string");
  ok("a tampered template hash would be detected by the manifest", MANIFEST.templates[TPL] === t.templateHashOf(TPL));
}

console.log("\n8. The analytics table is DERIVED from the tasks:");
{
  const bp = blueprint();
  const doc = fullDoc((no) => ({
    sourceEvidence: { printedPageLabel: `${100 + no}`, sourceTaskNo: `${no}`, verifyStatus: "teacher_verified" },
  }));
  const table = v.buildAnalyticsTable(doc, bp);
  // "Cədvəldə BÜTÜN 15 tapşırıq olmalıdır."
  ok("the table has one row per task", table.length === ROWS, table.length);
  ok("its Bloom column comes from the blueprint rows", table.every((r) => r.bloom === bp.rows[r.no - 1].bloom));
  ok("its page labels come from the task evidence", table[7].printedPageLabel === "108" && table[7].sourceTaskNo === "8");
  ok("its points come from the blueprint", table.every((r) => r.points === bp.rows[r.no - 1].points));
  ok("the last row is the hardest task", table[ROWS - 1].no === ROWS && table[ROWS - 1].bloom === "Yaratma");
}

console.log("\n9. The document's answer-key rules:");
{
  const bp = blueprint();
  // "Ardıcıl olaraq təkrarlanan düzgün cavablar olmamalıdır."
  const run = fullDoc((no, va) => (no <= 11 ? { correctIndex: 1, statement: `Sual ${no}${va}` } : {}));
  ok("a run of identical correct answers is rejected", codes(v.validateMsoDocument(run, bp)).includes("answer_key_consecutive_repeat"));
  const spread = fullDoc((no, va) => (no <= 11 ? { correctIndex: no % 4, statement: `Sual ${no}${va}` } : {}));
  ok("a varied key is accepted", !codes(v.validateMsoDocument(spread, bp)).includes("answer_key_consecutive_repeat"));
  ok("a mild repeat is tolerated (no artificial pattern forced)", v.MAX_ANSWER_RUN >= 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} mso-validator assertions failed`);
process.exit(failed ? 1 : 0);
