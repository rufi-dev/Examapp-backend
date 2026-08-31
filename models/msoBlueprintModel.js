/*
 * The MSO blueprint — 20 rows the teacher reviews BEFORE any AI call.
 *
 * The source prompt's task list and points ladder describe 15 questions while its
 * Bloom sequence runs to 20. The owner ruled the BLOOM SEQUENCE AUTHORITATIVE, so
 * the assessment has 20 questions and every "15" in that prompt is stale.
 *
 * Rows 1-15 are prefilled as EDITABLE DEFAULTS from the source prompt. Rows 16-20
 * have NO defaults: their question type and points are owner decisions that must
 * not be invented, inferred, or copied from row 15. `readyToGenerate()` reports
 * exactly which rows are still incomplete, and the route refuses with 422 until
 * they are all answered.
 *
 * `totalPoints` is an explicit field validated against sum(points). It is NOT
 * hard-coded to 100: rows 1-15 already total exactly 100, so adding 16-20 means
 * either the total rises or 1-15 is redistributed — and that is the owner's call.
 */
const mongoose = require("mongoose");
const { Schema } = mongoose;

const { BLOOM_LEVELS, DEFAULT_PRESET, presetIds } = require("../config/msoPresets");

const QUESTION_TYPES = Object.freeze(["closed4", "short", "extended"]);
const GRADING_MODES = Object.freeze(["auto", "rubric", "manual"]);

const rowSchema = new Schema(
  {
    no: { type: Number, required: true, min: 1 },
    // Seeded from the chosen preset and locked in the UI by default, but stored
    // per row so a teacher can move a level without a code change.
    bloom: { type: String, enum: BLOOM_LEVELS, required: true },
    // undefined = NOT YET DECIDED. Never defaulted for rows 16-20.
    questionType: { type: String, enum: QUESTION_TYPES, default: undefined },
    points: { type: Number, default: undefined, min: 0 },
    subStandard: { type: String, default: "" },
    criterion: { type: String, default: "" },
    testedSkill: { type: String, default: "" },
    difficulty: { type: String, default: "" },
    sourceRequirement: {
      type: String,
      enum: ["textbook_only", "textbook_preferred", "any"],
      default: "textbook_preferred",
    },
    gradingMode: { type: String, enum: GRADING_MODES, default: undefined },
  },
  { _id: false }
);

const msoBlueprintSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    assessmentType: { type: String, default: "MSO" },
    grade: { type: String, default: "" },
    subject: { type: String, default: "" },
    standard: { type: String, default: "" },
    subStandards: { type: [String], default: undefined },
    textbookEdition: { type: String, default: "" },
    // The structure is DATA. `presetId` records which shape seeded this blueprint;
    // `rowCount` is the authority afterwards, so a 15-, 20- or 12-task paper all
    // work without touching code.
    presetId: { type: String, default: DEFAULT_PRESET },
    rowCount: { type: Number, default: undefined, min: 1, max: 200 },
    sourceVersions: { type: [{ type: Schema.Types.ObjectId, ref: "CurriculumSourceVersion" }], default: undefined },
    // Explicit, validated against sum(points). NOT assumed to be 100.
    totalPoints: { type: Number, default: undefined, min: 1 },
    rows: { type: [rowSchema], default: undefined },
    revision: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    autoCreate: false,
    collection: "mso_blueprints",
  }
);

msoBlueprintSchema.index({ owner: 1, updatedAt: -1 }, { name: "owner_1_updatedAt_-1" });

const Model = mongoose.model("MsoBlueprint", msoBlueprintSchema);

Model.BLOOM_LEVELS = BLOOM_LEVELS;
Model.QUESTION_TYPES = QUESTION_TYPES;
Model.GRADING_MODES = GRADING_MODES;
Model.PRESET_IDS = presetIds();

module.exports = Model;
