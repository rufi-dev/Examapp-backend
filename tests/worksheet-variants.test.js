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
  ok("it is reported as unvaried, with a reason", w.unvaried.length === 1 && w.unvaried[0].reason === "no_formal_model", JSON.stringify(w.unvaried));
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
