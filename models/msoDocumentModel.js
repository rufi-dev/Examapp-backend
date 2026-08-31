/*
 * A generated MSO — the editable DRAFT holding BOTH variants. Published snapshots
 * live in msoVersionModel.js and never change.
 *
 * Variant A and B are paired by `pairId`: same blueprint row, deliberately the
 * same structure, only approved variables differ. CR-MSO-014 therefore exempts a
 * pair from the cross-variant duplicate rule while REQUIRING that it differ in at
 * least one validated variable.
 *
 * The answer key, worked solutions, points summary, 20-row analytics table and the
 * printable paper are all RENDERED FROM `tasks`. None is a second AI call, so none
 * can contradict the paper.
 */
const mongoose = require("mongoose");
const { Schema } = mongoose;
const { evidenceSchema } = require("./lessonPlanModel");

// CR-MSO-007 / CR-MSO-013 / CR-MSO-017: a numeric adaptation is only ever
// verified by a SERVER-OWNED template, pinned by an immutable id + hash.
// `expression` is DISPLAY ONLY and is never executed.
const adaptationSchema = new Schema(
  {
    templateId: { type: String, default: "" },
    templateHash: { type: String, default: "" },
    evaluatorVersion: { type: String, default: "" },
    variables: {
      type: [
        new Schema(
          { name: { type: String, required: true }, value: { type: Number, required: true }, unit: { type: String, default: "" } },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    rounding: { type: String, default: "none" },
    computed: { type: Number, default: undefined },
    computedUnit: { type: String, default: "" },
    expression: { type: String, default: "" },
  },
  { _id: false }
);

const msoTaskSchema = new Schema(
  {
    no: { type: Number, required: true, min: 1 },
    variant: { type: String, enum: ["A", "B"], required: true },
    pairId: { type: String, required: true },
    questionType: { type: String, enum: ["closed4", "short", "extended"], required: true },
    points: { type: Number, required: true, min: 0 },
    bloom: { type: String, default: "" },
    subStandard: { type: String, default: "" },
    criterion: { type: String, default: "" },
    testedSkill: { type: String, default: "" },
    difficulty: { type: String, default: "" },
    statement: { type: String, default: "" },
    choices: { type: [String], default: undefined },
    correctIndex: { type: Number, default: undefined },
    answer: { type: String, default: "" },
    solution: { type: String, default: "" },
    rubric: { type: String, default: "" },
    sourceMode: { type: String, enum: ["verbatim", "adapted", "original"], default: "original" },
    sourceEvidence: { type: evidenceSchema, default: undefined },
    adaptation: { type: adaptationSchema, default: undefined },
    reviewStatus: {
      type: String,
      enum: ["pending", "accepted", "needs_teacher_review", "rejected"],
      default: "pending",
    },
    reviewNotes: { type: [String], default: undefined },
  },
  { _id: false }
);

const msoDocumentSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    blueprint: { type: Schema.Types.ObjectId, ref: "MsoBlueprint", required: true },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    classes: { type: [{ type: Schema.Types.ObjectId, ref: "Class" }], default: undefined },
    sourceVersions: { type: [{ type: Schema.Types.ObjectId, ref: "CurriculumSourceVersion" }], default: undefined },
    tasks: { type: [msoTaskSchema], default: undefined },
    // Teacher documentation by default: a page number on a student's paper points
    // straight at the textbook answer key.
    showCitationsToStudents: { type: Boolean, default: false },
    status: { type: String, enum: ["draft", "reviewed", "published", "archived"], default: "draft" },
    revision: { type: Number, default: 0 },
    activeVersion: { type: Schema.Types.ObjectId, ref: "MsoVersion", default: null },
    activeVersionNumber: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
    schemaVersion: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    autoCreate: false,
    collection: "mso_documents",
  }
);

msoDocumentSchema.index({ owner: 1, updatedAt: -1 }, { name: "owner_1_updatedAt_-1" });

const Model = mongoose.model("MsoDocument", msoDocumentSchema);
Model.msoTaskSchema = msoTaskSchema;
Model.adaptationSchema = adaptationSchema;
module.exports = Model;
