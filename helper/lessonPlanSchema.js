/*
 * The lesson-plan JSON schema, OpenAI-strict-valid at every nesting level.
 *
 * Strict mode means: additionalProperties:false on every object AND every property
 * listed in `required`. There are no optionals — "not applicable" is "" or [] — so
 * a field that does not apply is present and empty rather than absent.
 *
 * Counts (exactly 2 objectives, 3 criteria) CANNOT be expressed: minItems does not
 * exist in the strict subset. They are asked for in the prompt and ENFORCED in
 * helper/lessonPlanContent.normalizeLessonPlan, which pads and truncates.
 *
 * Kept flat and shallow on purpose — the strict subset caps nesting depth and total
 * property count, and a nested per-task evidence object would push it over.
 */
const { toGeminiSchema, BLOOM_LEVELS, SOURCE_MODES } = require("./curriculumSchema");

const str = { type: "string" };

const LESSON_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: str,
    grade: str,
    subject: str,
    topic: str,
    // Echo the teacher's codes only. A curriculum code the teacher did not supply
    // is filtered out server-side; inventing one is the worst hallucination here
    // because it looks authoritative and nobody checks it.
    subStandards: { type: "array", items: str },
    objectives: { type: "array", items: str },
    criteria: { type: "array", items: str },
    motivation: str,
    stages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: str,
          minutes: { type: "integer" },
          teacher: str,
          student: str,
          resources: str,
          checks: str,
          differentiation: str,
        },
        required: ["name", "minutes", "teacher", "student", "resources", "checks", "differentiation"],
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          statement: str,
          solution: str,
          // "" is REQUIRED in the enum: without it the model is forced to assign a
          // Bloom level to a task that has none.
          bloom: { type: "string", enum: BLOOM_LEVELS },
          sourceMode: { type: "string", enum: SOURCE_MODES },
          // Page LABELS are strings ("124", "iv", "A-12"), and there is no integer
          // page field anywhere to disagree with them.
          printedPageLabel: str,
          sourceTaskNo: str,
          // At least 40 characters of VERBATIM page text when a source is attached,
          // so the server can match it against the pinned bytes. "" otherwise.
          sourceExcerpt: str,
        },
        required: ["statement", "solution", "bloom", "sourceMode", "printedPageLabel", "sourceTaskNo", "sourceExcerpt"],
      },
    },
    reflection: str,
    homework: str,
    materials: { type: "array", items: str },
  },
  required: [
    "title", "grade", "subject", "topic", "subStandards", "objectives", "criteria",
    "motivation", "stages", "tasks", "reflection", "homework", "materials",
  ],
};

const LESSON_PLAN_GEMINI_SCHEMA = toGeminiSchema(LESSON_PLAN_SCHEMA);
const LESSON_PLAN_VERSION = 1;

module.exports = { LESSON_PLAN_SCHEMA, LESSON_PLAN_GEMINI_SCHEMA, LESSON_PLAN_VERSION };
