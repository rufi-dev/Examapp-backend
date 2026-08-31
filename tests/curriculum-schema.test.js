/*
 * The composed curriculum schema, and the Gemini mirror derivation.
 *
 * The single most valuable assertion here is assertStrict: OpenAI strict mode
 * rejects any schema whose `properties` and `required` differ, at ANY nesting
 * level. Getting that wrong is a hard 400 on the default model — an instant outage
 * — and it is invisible to code review.
 *
 * The second is the equivalence proof. GEMINI_SCHEMA is a hand-maintained
 * transliteration of EXTRACTION_SCHEMA that nothing checks. Proving
 * toGeminiSchema(EXTRACTION_SCHEMA) === GEMINI_SCHEMA both shows the two have not
 * drifted AND makes replacing the literal later a provable no-op. (Proving is this
 * pass; flipping is a separate commit.)
 */
const assert = require("assert");
const { EXTRACTION_SCHEMA, GEMINI_SCHEMA } = require("../controllers/aiController");
const {
  withCurriculum,
  toGeminiSchema,
  assertStrict,
  schemaDepth,
  countProperties,
  CURRICULUM_FIELDS,
  BLOOM_LEVELS,
} = require("../helper/curriculumSchema");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

console.log("\n1. Strict-mode validity at every nesting level:");
{
  const base = assertStrict(EXTRACTION_SCHEMA);
  ok("EXTRACTION_SCHEMA is strict-valid", base.ok, base.problems.join("; "));
  const composed = withCurriculum(EXTRACTION_SCHEMA);
  const c = assertStrict(composed);
  ok("the composed curriculum schema is strict-valid", c.ok, c.problems.join("; "));

  // The exact failure this guards: a property present but absent from `required`.
  const broken = JSON.parse(JSON.stringify(composed));
  broken.properties.questions.items.required = broken.properties.questions.items.required.filter((k) => k !== "bloom");
  ok("a property missing from `required` is caught", assertStrict(broken).ok === false);
  const broken2 = JSON.parse(JSON.stringify(composed));
  delete broken2.properties.questions.items.additionalProperties;
  ok("a missing additionalProperties:false is caught", assertStrict(broken2).ok === false);
}

console.log("\n2. Composition never touches the shared exam schema:");
{
  const before = JSON.stringify(EXTRACTION_SCHEMA);
  const composed = withCurriculum(EXTRACTION_SCHEMA);
  ok("EXTRACTION_SCHEMA is byte-identical after composing", JSON.stringify(EXTRACTION_SCHEMA) === before);
  ok("the composed object is a different object", composed !== EXTRACTION_SCHEMA);
  const items = composed.properties.questions.items;
  ok(
    "every curriculum field is present AND required",
    Object.keys(CURRICULUM_FIELDS).every((k) => items.properties[k] && items.required.includes(k))
  );
  ok(
    "no curriculum field leaked into the base schema",
    Object.keys(CURRICULUM_FIELDS).every((k) => !EXTRACTION_SCHEMA.properties.questions.items.properties[k])
  );
  // Composing twice must not duplicate `required` entries.
  const twice = withCurriculum(withCurriculum(EXTRACTION_SCHEMA));
  const req = twice.properties.questions.items.required;
  ok("composition is idempotent in `required`", new Set(req).size === req.length);
}

console.log("\n3. The strict-mode traps that actually bite:");
{
  const items = withCurriculum(EXTRACTION_SCHEMA).properties.questions.items;
  // Without "" the model is FORCED to Bloom-tag a reading passage.
  ok('bloom.enum includes ""', items.properties.bloom.enum.includes(""));
  ok("BLOOM_LEVELS starts with the empty option", BLOOM_LEVELS[0] === "");
  // Real books use "iv", "A-12", "124a" — an integer page cannot represent them.
  ok("printedPageLabel is a string", items.properties.printedPageLabel.type === "string");
  ok("sourceTaskNo is a string", items.properties.sourceTaskNo.type === "string");
  ok(
    "there is no flat integer page field to disagree with the evidence",
    !items.properties.sourcePage && !items.properties.sourceNo
  );
  ok("depth stays within the strict limit (<= 5)", schemaDepth(withCurriculum(EXTRACTION_SCHEMA)) <= 5, schemaDepth(withCurriculum(EXTRACTION_SCHEMA)));
  ok("property count stays well under the strict limit (<= 100)", countProperties(withCurriculum(EXTRACTION_SCHEMA)) <= 100, countProperties(withCurriculum(EXTRACTION_SCHEMA)));
  // minItems/maximum do not exist in the strict subset — counts must be enforced
  // by prompt and server normalisation, never by schema.
  const json = JSON.stringify(withCurriculum(EXTRACTION_SCHEMA));
  ok("no minItems/maxItems/minimum/maximum/pattern anywhere", !/"(minItems|maxItems|minimum|maximum|pattern)"/.test(json));
}

console.log("\n4. The Gemini mirror is derivable (prove now, flip later):");
{
  const derived = toGeminiSchema(EXTRACTION_SCHEMA);
  let same = true;
  try { assert.deepStrictEqual(derived, GEMINI_SCHEMA); } catch { same = false; }
  ok("toGeminiSchema(EXTRACTION_SCHEMA) deep-equals the hand-written GEMINI_SCHEMA", same);

  const noAP = (n) => {
    if (!n || typeof n !== "object") return true;
    if (Object.prototype.hasOwnProperty.call(n, "additionalProperties")) return false;
    return Object.values(n.properties || {}).every(noAP) && (n.items ? noAP(n.items) : true);
  };
  ok("the derivation drops additionalProperties everywhere", noAP(derived));

  const ALLOWED = new Set(["OBJECT", "ARRAY", "STRING", "INTEGER", "NUMBER", "BOOLEAN"]);
  const typesOk = (n) => {
    if (!n || typeof n !== "object") return true;
    if (n.type && !ALLOWED.has(n.type)) return false;
    return Object.values(n.properties || {}).every(typesOk) && (n.items ? typesOk(n.items) : true);
  };
  ok("every type is an uppercase OpenAPI type", typesOk(derived));
  ok("the composed schema also derives cleanly", assertStrict(withCurriculum(EXTRACTION_SCHEMA)).ok && noAP(toGeminiSchema(withCurriculum(EXTRACTION_SCHEMA))));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} curriculum-schema assertions failed`);
process.exit(failed ? 1 : 0);
