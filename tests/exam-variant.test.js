/*
 * The B variant of a summative paper.
 *
 * The dangerous failure here is quiet and total: if B keeps A's answer key while
 * its numbers change, every closed question on the paper is marked against the
 * wrong answer and nothing in the UI looks broken. So the key must come from the
 * variant or the question must not change at all — never one without the other.
 *
 * Pure functions, no DB: this is about what is done with a provider's answer.
 */
const assert = require("assert");
const v = require("../helper/examVariantSchema");
const { assertStrict, toGeminiSchema } = require("../helper/curriculumSchema");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

const A = () => [
  {
    type: "Cm",
    text: "Kubun tərəfi 4 sm. Səth sahəsini tapın.",
    choices: [{ text: "96 sm²", latex: "" }, { text: "64 sm²", latex: "" }, { text: "24 sm²", latex: "" }, { text: "16 sm²", latex: "" }],
    correct: [0],
  },
  { type: "reading", text: "Oxu mətni", title: "Mətn 1" },
  { type: "Co", text: "Tərəfi 5 sm olan kubun həcmi?", answer: "125 sm³" },
  { type: "Cm", text: "Rəqəmi olmayan nəzəri sual.", choices: [{ text: "A", latex: "" }, { text: "B", latex: "" }], correct: [1] },
];

console.log("\n1. The schema is valid for both providers:");
{
  assertStrict(v.VARIANT_SCHEMA);
  ok("OpenAI strict mode accepts it", true);
  ok("the Gemini mirror drops additionalProperties", !JSON.stringify(toGeminiSchema(v.VARIANT_SCHEMA)).includes("additionalProperties"));
  ok("no empty enum value anywhere", !JSON.stringify(toGeminiSchema(v.VARIANT_SCHEMA)).includes('""'));
}

console.log("\n2. The answer key comes from the VARIANT, never from A:");
{
  const items = A();
  const { B, varied } = v.applyVariant(items, [
    { index: 0, text: "Kubun tərəfi 6 sm. Səth sahəsini tapın.", choices: ["216 sm²", "144 sm²", "36 sm²", "24 sm²"], correct: [0], openAnswer: "" },
    { index: 2, text: "Tərəfi 7 sm olan kubun həcmi?", choices: [], correct: [], openAnswer: "343 sm³" },
  ]);

  ok("the changed question carries the variant's key", JSON.stringify(B[0].correct) === "[0]");
  ok("and the variant's choices", B[0].choices[0].text === "216 sm²", JSON.stringify(B[0].choices[0]));
  ok("the open answer is re-solved", B[2].answer === "343 sm³", B[2].answer);
  ok("two questions were varied", varied === 2, varied);

  // The critical negative: a variant that supplies text but NO key must not be
  // allowed to keep A's key against different numbers.
  const risky = v.applyVariant(items, [
    { index: 0, text: "Kubun tərəfi 9 sm. Səth sahəsini tapın.", choices: ["486 sm²", "324 sm²", "81 sm²", "54 sm²"], correct: [], openAnswer: "" },
  ]);
  ok(
    "new options with NO key are refused outright",
    risky.B[0].text === items[0].text && JSON.stringify(risky.B[0].choices) === JSON.stringify(items[0].choices),
    JSON.stringify(risky.B[0])
  );
  ok("and it does not count as varied", risky.varied === 0, risky.varied);
  ok("an OPEN question with no choices is still allowed to change", (() => {
    const r = v.applyVariant(items, [{ index: 2, text: "Tərəfi 9 sm olan kubun həcmi?", choices: [], correct: [], openAnswer: "729 sm³" }]);
    return r.varied === 1 && r.B[2].answer === "729 sm³";
  })());
}

console.log("\n3. A is never mutated:");
{
  const items = A();
  const before = JSON.stringify(items);
  v.applyVariant(items, [{ index: 0, text: "dəyişdi", choices: ["x", "y"], correct: [1], openAnswer: "" }]);
  ok("the source paper is untouched", JSON.stringify(items) === before);
}

console.log("\n4. The two papers always line up:");
{
  const items = A();
  // The model answers for only ONE question and skips the rest.
  const { B, varied } = v.applyVariant(items, [{ index: 0, text: "yeni", choices: ["a", "b", "c", "d"], correct: [2], openAnswer: "" }]);
  ok("B has exactly as many questions as A", B.length === items.length, `${items.length} -> ${B.length}`);
  ok("a skipped question is copied, not dropped", B[2].text === items[2].text);
  ok("its key is copied too", B[2].answer === items[2].answer);
  ok("only the answered one counts as varied", varied === 1, varied);

  // A reading block has no numbers to change and must survive verbatim.
  ok("a reading block is untouched", B[1].type === "reading" && B[1].text === "Oxu mətni" && B[1].title === "Mətn 1");

  // Identical text is not a variant.
  const same = v.applyVariant(items, [{ index: 3, text: items[3].text, choices: ["A", "B"], correct: [0], openAnswer: "" }]);
  ok("text identical to A is not treated as varied", same.varied === 0, same.varied);
  ok("and its key is left alone", JSON.stringify(same.B[3].correct) === "[1]");
}

console.log("\n5. Shapes and junk:");
{
  const items = A();
  const { B } = v.applyVariant(items, [{ index: 0, text: "yeni", choices: ["a", "b"], correct: [0], openAnswer: "" }]);
  ok("object choices stay objects", typeof B[0].choices[0] === "object" && B[0].choices[0].text === "a");

  const stringChoices = [{ type: "Cm", text: "q", choices: ["a", "b"], correct: [0] }];
  const r2 = v.applyVariant(stringChoices, [{ index: 0, text: "q2", choices: ["c", "d"], correct: [1], openAnswer: "" }]);
  ok("string choices stay strings", typeof r2.B[0].choices[0] === "string");

  ok("an out-of-range index is ignored", v.applyVariant(items, [{ index: 99, text: "x", choices: [], correct: [], openAnswer: "" }]).varied === 0);
  ok("a non-integer index is ignored", v.applyVariant(items, [{ index: "0", text: "x", choices: [], correct: [], openAnswer: "" }]).varied === 0);
  ok("no variants at all yields a faithful copy", JSON.stringify(v.applyVariant(items, []).B) === JSON.stringify(items));
  ok("junk input does not throw", v.applyVariant(items, null).B.length === items.length);
  ok("an empty paper is fine", v.applyVariant([], []).B.length === 0);
}

console.log("\n6. The prompt gives the model what it needs to re-solve:");
{
  const p = v.buildVariantPrompt(A());
  ok("it numbers the questions by index", p.includes("#0 ") && p.includes("#2 "));
  ok("it sends the choices", p.includes("96 sm²"));
  ok("it sends A's key, so the model knows what to re-derive", p.includes("düzgün: 0"));
  ok("it sends open answers", p.includes("125 sm³"));
  ok("the rules forbid copying A's answer", /A variantının cavabını köçürmək/.test(v.SYSTEM));
  ok("and require re-solving", /YENİDƏN HƏLL ET/.test(v.SYSTEM));
}

console.log("\n7. Labels never stack up:");
{
  /*
   * A duplicate of a B variant of a duplicate must not become
   * "Riyaziyyat (dublikat) (B variantı) (dublikat 2)". The base name is recovered
   * before any label is applied, so every suffix lands on the original title.
   */
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "../controllers/quizController.js"), "utf8");
  const m = src.match(/const baseNameOf = \(name\) =>[\s\S]*?\|\| "İmtahan";/);
  ok("baseNameOf is defined in the controller", !!m);

  // eslint-disable-next-line no-new-func
  const baseNameOf = new Function(`${m[0]} return baseNameOf;`)();

  ok("a plain name is unchanged", baseNameOf("Riyaziyyat") === "Riyaziyyat");
  ok("(A variantı) is stripped", baseNameOf("Riyaziyyat (A variantı)") === "Riyaziyyat");
  ok("(B variantı) is stripped", baseNameOf("Riyaziyyat (B variantı)") === "Riyaziyyat");
  ok("(dublikat) is stripped", baseNameOf("Riyaziyyat (dublikat)") === "Riyaziyyat");
  ok("a numbered duplicate is stripped", baseNameOf("Riyaziyyat (dublikat 3)") === "Riyaziyyat");
  ok("an empty name falls back", baseNameOf("") === "İmtahan" && baseNameOf(null) === "İmtahan");
  ok("Azerbaijani letters survive", baseNameOf("Fəza fiqurları (B variantı)") === "Fəza fiqurları");
  ok(
    "a title that merely CONTAINS the words is untouched",
    baseNameOf("B variantı haqqında dərs") === "B variantı haqqında dərs"
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} exam-variant assertions failed`);
process.exit(failed ? 1 : 0);
