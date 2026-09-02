/*
 * The JSON schema for ONE BATCH of MSO tasks, OpenAI-strict-valid at every level.
 *
 * A batch asks for a few blueprint rows at a time, each in BOTH variants, because
 * A and B must be the same task with different numbers — generating them in
 * separate calls would make that impossible to guarantee. The model is handed the
 * row's locked fields (no, bloom, type, points) in the prompt and returns the
 * content for them; it never chooses them, so it cannot drift from the blueprint.
 *
 * Strict mode: additionalProperties:false everywhere AND every property listed in
 * `required`. There are no optionals — a field that does not apply is "" or [] —
 * and minItems/maximum/pattern do not exist in the subset, so counts are enforced
 * by the prompt and, decisively, by helper/msoValidators.js on the way in.
 */
const { toGeminiSchema } = require("./curriculumSchema");

const str = { type: "string" };

const TASK = {
  type: "object",
  additionalProperties: false,
  properties: {
    no: { type: "integer" },
    variant: { type: "string", enum: ["A", "B"] },
    statement: str,
    // Exactly four for a closed task, [] for an open one. The count is checked
    // server-side; the schema cannot express it.
    choices: { type: "array", items: str },
    // 0-based. -1 for an open task, which has no choices to point at.
    correctIndex: { type: "integer" },
    answer: str,
    solution: str,
    // Free text for an open task's marking scheme; "" for a closed one.
    rubric: str,
    testedSkill: str,
    subStandard: str,
    criterion: str,
    // The citation. Page LABELS are strings ("124", "iv"), and the task number is
    // a string too ("8", "12a") — there is no integer page anywhere to disagree.
    printedPageLabel: str,
    sourceTaskNo: str,
    // At least 40 characters copied VERBATIM from that page, so the server can
    // match the claim against the pinned bytes rather than trusting it.
    sourceExcerpt: str,
  },
  required: [
    "no", "variant", "statement", "choices", "correctIndex", "answer", "solution",
    "rubric", "testedSkill", "subStandard", "criterion",
    "printedPageLabel", "sourceTaskNo", "sourceExcerpt",
  ],
};

const MSO_BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { tasks: { type: "array", items: TASK } },
  required: ["tasks"],
};

const MSO_BATCH_GEMINI_SCHEMA = toGeminiSchema(MSO_BATCH_SCHEMA);

module.exports = { MSO_BATCH_SCHEMA, MSO_BATCH_GEMINI_SCHEMA, TASK };
