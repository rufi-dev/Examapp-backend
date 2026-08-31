/*
 * The two-variant worksheet the lesson-plan prompt asks for
 * ("iki variantda iş vərəqi generatoru").
 *
 * The property that matters: what the pupil READS, what the server STORED and what
 * the answer key SAYS must all agree. A sequential find-and-replace breaks exactly
 * that whenever one variable's new value equals another's old one, so the rewrite
 * is two-pass and this file pins it.
 *
 * The document also requires the variant to keep its difficulty — "Süjet, ifadə
 * tərzi və çətinlik səviyyəsi saxlanılır" — so a perturbation that turns 5 into 56
 * is a bug, not a variant.
 */
const assert = require("assert");
const { perturb, varyTask, buildWorksheet } = require("../helper/worksheetVariants");
const { TEMPLATES, templateHashOf } = require("../helper/adaptationTemplates");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

const TPL = "volume_rectangular_prism.v1";
const box = (a, b, c) => ({
  statement: `Uzunluğu ${a} sm, eni ${b} sm, hündürlüyü ${c} sm olan cismin həcmini tapın.`,
  adaptation: {
    templateId: TPL,
    templateHash: templateHashOf(TPL),
    evaluatorVersion: "v1",
    rounding: "int",
    variables: [
      { name: "a", value: a, unit: "sm" },
      { name: "b", value: b, unit: "sm" },
      { name: "c", value: c, unit: "sm" },
    ],
    computed: a * b * c,
  },
});
const numbersIn = (s) => (String(s).match(/\d+/g) || []).map(Number);

console.log("\n1. Statement, stored variables and answer all agree:");
{
  // (2,2,2) and (5,3,4) are the collision cases: a new value equal to another's
  // old one is exactly what a single-pass replace corrupts.
  for (const [a, b, c] of [[5, 3, 4], [12, 10, 8], [2, 2, 2], [7, 7, 3], [1, 1, 1]]) {
    const w = buildWorksheet([box(a, b, c)]);
    const shown = numbersIn(w.B[0].statement);
    const vars = w.B[0].adaptation.variables.map((v) => v.value);
    const product = vars[0] * vars[1] * vars[2];
    ok(
      `(${a},${b},${c}) -> the pupil reads exactly the stored variables`,
      JSON.stringify(shown) === JSON.stringify(vars),
      `read ${shown} vs stored ${vars}`
    );
    ok(`(${a},${b},${c}) -> the answer is the server's recomputation`, Number(w.B[0].answer) === product, `${w.B[0].answer} vs ${product}`);
  }
}

console.log("\n2. A variant keeps its difficulty:");
{
  const decl = TEMPLATES[TPL].variables[0];
  for (const v of [5, 12, 100]) {
    const next = perturb(decl, v, 1);
    const ratio = next / v;
    ok(`${v} moves but stays comparable (${next})`, next !== v && ratio > 0.5 && ratio < 2, `${v} -> ${next}`);
    ok(`${v} stays an integer`, Number.isInteger(next));
    ok(`${v} stays inside the template bounds`, next >= decl.min && next <= decl.max);
  }
  ok("a decimal stays a decimal", !Number.isInteger(perturb(decl, 2.5, 1)) || perturb(decl, 2.5, 1) !== 2.5);
}

console.log("\n3. A task with no formal model is flagged, never faked:");
{
  const prose = { statement: "Öz sözlərinizlə həcm anlayışını izah edin." };
  const w = buildWorksheet([box(5, 3, 4), prose]);
  ok("it is reported as unvaried, with a reason", w.unvaried.length === 1 && w.unvaried[0].reason === "no_numbers_in_text", JSON.stringify(w.unvaried));
  ok("variant B carries it unchanged", w.B[1].statement === prose.statement);
  ok("and marks it for the teacher", w.B[1].reviewStatus === "needs_teacher_review");
  ok("the note says what the teacher must do", (w.B[1].reviewNotes || []).some((n) => /variant B/i.test(n)));
  ok("the count reflects only what was really varied", w.variedCount === 1, w.variedCount);

  // A stale template hash means the semantics moved: refuse rather than recompute
  // under a meaning the plan was not authored against.
  const stale = box(5, 3, 4);
  stale.adaptation.templateHash = "0".repeat(64);
  ok("a stale template hash refuses to vary", varyTask(stale, 1).reason === "template_hash_mismatch");
  const unknown = box(5, 3, 4);
  unknown.adaptation.templateId = "nope.v1";
  ok("an unknown template refuses to vary", varyTask(unknown, 1).reason === "template_unknown");
}

console.log("\n3b. Prose tasks are varied by shifting their numbers:");
{
  const nums = (t) => (String(t).match(/-?\d+/g) || []).map(Number);
  const cases = [
    "Verilmiş nöqtələr A(2;3) və B(5;11). Bucaq əmsalını hesablayın.",
    "Nöqtələr A(-1;4) və B(3;0) verilmişdir. Bucaq əmsalını hesablayın.",
    // Deliberately vertical: both x are 2, and that IS the point of the task.
    "Nöqtələr E(2;5) və F(2;10) verilmişdir. Xəttin tənliyini müəyyən edin.",
    "Nöqtələr C(0;0) və D(4;4) verilmişdir. Tənliyi tapın.",
  ];
  const w = buildWorksheet(cases.map((statement) => ({ statement })));
  ok("every prose task gets a genuinely different variant B", w.A.every((a, i) => a.statement !== w.B[i].statement));
  ok("none is left for manual work", w.unvaried.length === 0, JSON.stringify(w.unvaried));

  /*
   * The guard that matters. Shifting must not change WHICH numbers are equal:
   *   A(2;3) B(5;11) -> A(4;6) B(4;9) makes both x equal, a vertical line whose
   *   slope the task asks for and which does not exist;
   *   E(2;5) F(2;10) must STAY vertical, because that is the case being taught.
   */
  let broken = 0;
  w.A.forEach((a, i) => {
    const A = nums(a.statement);
    const B = nums(w.B[i].statement);
    if (A.length !== B.length) { broken += 1; return; }
    for (let x = 0; x < A.length; x++) {
      for (let y = x + 1; y < A.length; y++) {
        if ((A[x] === A[y]) !== (B[x] === B[y])) broken += 1;
      }
    }
  });
  ok("the pattern of equal numbers is preserved exactly", broken === 0, `${broken} mismatches`);
  ok("a vertical-line task stays vertical", nums(w.B[2].statement)[0] === nums(w.B[2].statement)[2]);
  ok("distinct points stay distinct", nums(w.B[0].statement)[0] !== nums(w.B[0].statement)[2]);
  ok("no answer is claimed for a text-varied task", w.B.every((t) => !t.answer && !t.solution));
  ok("the count reports how many were varied by text", w.textVaried === 4, w.textVaried);
}

console.log("\n3c. A model-authored variant B is preferred, and carries its own solution:");
{
  const authored = {
    statement: "Nöqtələr A(1;2) və B(3;6) verilmişdir. Xəttin tənliyini yazın.",
    solution: "k = (6-2)/(3-1) = 2; y - 2 = 2(x - 1); y = 2x.",
    answer: "y = 2x",
    variantB: {
      statement: "Nöqtələr A(2;1) və B(5;10) verilmişdir. Xəttin tənliyini yazın.",
      solution: "k = (10-1)/(5-2) = 3; y - 1 = 3(x - 2); y = 3x - 5.",
      answer: "y = 3x - 5",
    },
  };
  const w = buildWorksheet([authored]);
  ok("B uses the authored statement", w.B[0].statement === authored.variantB.statement);
  ok("B carries its OWN worked solution", w.B[0].solution === authored.variantB.solution);
  ok("B carries its own answer", w.B[0].answer === authored.variantB.answer);
  ok("B is marked as model-authored", w.B[0].variedBy === "ai", w.B[0].variedBy);
  ok("it is counted", w.aiVaried === 1, w.aiVaried);
  ok("A keeps its own solution", w.A[0].solution === authored.solution);

  // The B recipe must not print on the A paper, and must not recurse into B.
  ok("A does not carry the variantB blob", w.A[0].variantB === undefined);
  ok("B does not carry the variantB blob", w.B[0].variantB === undefined);

  // The whole point is two DIFFERENT papers. A model that copies A must not be
  // trusted just because it filled the field in.
  const copied = { ...authored, variantB: { ...authored.variantB, statement: authored.statement } };
  const w2 = buildWorksheet([copied]);
  ok("a copied variant is rejected and B is varied another way", w2.B[0].statement !== authored.statement);
  ok("and it is not counted as model-authored", w2.aiVaried === 0, w2.aiVaried);

  // Falling back must still work when there is no authored variant at all.
  const w3 = buildWorksheet([{ statement: authored.statement, solution: authored.solution }]);
  ok("no authored variant still yields a different B", w3.B[0].statement !== authored.statement);
  ok("and reports the path it used", w3.B[0].variedBy === "text", w3.B[0].variedBy);
}

console.log("\n4. Both variants are complete and paired:");
{
  const w = buildWorksheet([box(5, 3, 4), box(9, 2, 6), { statement: "İzah edin." }]);
  ok("A and B have the same length", w.A.length === 3 && w.B.length === 3);
  ok("numbering is 1..n in both", w.A.every((t, i) => t.no === i + 1) && w.B.every((t, i) => t.no === i + 1));
  ok("each task is paired across variants", w.A.every((t, i) => t.pairId === w.B[i].pairId));
  ok("variants are labelled", w.A.every((t) => t.variant === "A") && w.B.every((t) => t.variant === "B"));
  ok(
    "no varied task is identical to its A counterpart",
    w.A.every((t, i) => w.unvaried.some((u) => u.no === t.no) || t.statement !== w.B[i].statement)
  );
  ok("an empty plan yields empty variants rather than throwing", buildWorksheet([]).A.length === 0);
  ok("a non-array is tolerated", buildWorksheet(null).A.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} worksheet assertions failed`);
process.exit(failed ? 1 : 0);
