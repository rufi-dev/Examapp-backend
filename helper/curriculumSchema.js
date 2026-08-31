/*
 * Curriculum metadata as a COMPOSED schema, used only in curriculum/MSO mode.
 *
 * `EXTRACTION_SCHEMA` and `GEMINI_SCHEMA` in controllers/aiController.js are NOT
 * modified. They are shared by every ordinary exam extraction and generation, and
 * adding five required keys there would make the model emit them for every teacher
 * on every question — extra tokens and a quality risk on the product's core flow,
 * for a feature most teachers never touch. `withCurriculum()` returns a NEW object
 * instead, so ordinary exam generation is byte-identical by construction.
 *
 * Strict-mode facts that shape the fields (each one is a real 400 if ignored):
 *   - every object needs additionalProperties:false AND every property listed in
 *     `required` — there are no optionals, so "not applicable" is "" / [] / 0;
 *   - `bloom`'s enum MUST include "", or the model is forced to assign a Bloom
 *     level to a reading passage;
 *   - printedPageLabel and sourceTaskNo are STRINGS ("iv", "A-12", "124a", "12a");
 *   - minItems/maximum/pattern do not exist in the strict subset, so counts and
 *     ranges are enforced by prompt AND normalised server-side, never by schema.
 */
const BLOOM_LEVELS = ["", "Yadda saxlama", "Anlama", "Tətbiq", "Təhlil", "Qiymətləndirmə", "Yaratma"];
const SOURCE_MODES = ["verbatim", "adapted", "original"];

// Flat by design: OpenAI strict mode caps nesting depth and total property count,
// and a nested evidence object here would push the question item past it.
const CURRICULUM_FIELDS = {
  subStandard: { type: "string" },
  bloom: { type: "string", enum: BLOOM_LEVELS },
  criterion: { type: "string" },
  sourceMode: { type: "string", enum: SOURCE_MODES },
  // The PRINTED page label, as a string. "" when there is no source or the page
  // carries no number. There is deliberately no integer page field to disagree
  // with it.
  printedPageLabel: { type: "string" },
  sourceTaskNo: { type: "string" },
  // Verbatim text the model claims to have read, so the server can match it
  // against the pinned bytes. "" when nothing is claimed.
  sourceExcerpt: { type: "string" },
};

const GEMINI_TYPES = { object: "OBJECT", array: "ARRAY", string: "STRING", integer: "INTEGER", number: "NUMBER", boolean: "BOOLEAN" };

/*
 * Mechanical transform to the Gemini OpenAPI subset. `additionalProperties`,
 * `description` and `$schema` are DROPPED deliberately: the subset rejects them and
 * a bad config returns 400 "invalid argument", burning a call.
 */
function toGeminiSchema(node) {
  if (!node || typeof node !== "object") return node;
  const out = {};
  if (node.type) out.type = GEMINI_TYPES[node.type] || String(node.type).toUpperCase();
  if (node.enum) out.enum = node.enum.slice();
  if (node.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties)) out.properties[k] = toGeminiSchema(v);
  }
  if (node.items) out.items = toGeminiSchema(node.items);
  if (Array.isArray(node.required)) out.required = node.required.slice();
  return out;
}

// Deep clone that keeps key order stable, so a composed schema diffs cleanly.
const clone = (v) => JSON.parse(JSON.stringify(v));

/*
 * Compose curriculum fields onto a question-shaped schema WITHOUT touching the
 * original. Returns a new object; the input is never mutated.
 */
function withCurriculum(baseSchema) {
  const out = clone(baseSchema);
  const items = out?.properties?.questions?.items;
  if (!items || !items.properties || !Array.isArray(items.required)) {
    throw new Error("withCurriculum: expected a schema with properties.questions.items");
  }
  for (const [k, v] of Object.entries(CURRICULUM_FIELDS)) {
    items.properties[k] = clone(v);
    if (!items.required.includes(k)) items.required.push(k);
  }
  return out;
}

/*
 * Walk a schema and prove it is OpenAI-strict-valid at EVERY nesting level. This
 * is the single most valuable assertion in the feature: a `required` array that
 * omits one property is a hard 400 on the default model — an instant outage — and
 * it is invisible to review.
 */
function assertStrict(node, path = "$") {
  const problems = [];
  const walk = (n, p) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "object") {
      if (n.additionalProperties !== false) problems.push(`${p}: additionalProperties must be false`);
      const props = Object.keys(n.properties || {});
      const req = Array.isArray(n.required) ? n.required : [];
      for (const k of props) if (!req.includes(k)) problems.push(`${p}: "${k}" missing from required`);
      for (const k of req) if (!props.includes(k)) problems.push(`${p}: required lists unknown "${k}"`);
      for (const [k, v] of Object.entries(n.properties || {})) walk(v, `${p}.${k}`);
    }
    if (n.type === "array") walk(n.items, `${p}[]`);
  };
  walk(node, path);
  return { ok: problems.length === 0, problems };
}

function schemaDepth(node, d = 0) {
  if (!node || typeof node !== "object") return d;
  let max = d;
  if (node.properties) for (const v of Object.values(node.properties)) max = Math.max(max, schemaDepth(v, d + 1));
  if (node.items) max = Math.max(max, schemaDepth(node.items, d + 1));
  return max;
}

function countProperties(node) {
  if (!node || typeof node !== "object") return 0;
  let n = 0;
  if (node.properties) {
    n += Object.keys(node.properties).length;
    for (const v of Object.values(node.properties)) n += countProperties(v);
  }
  if (node.items) n += countProperties(node.items);
  return n;
}

module.exports = {
  BLOOM_LEVELS,
  SOURCE_MODES,
  CURRICULUM_FIELDS,
  withCurriculum,
  toGeminiSchema,
  assertStrict,
  schemaDepth,
  countProperties,
};
