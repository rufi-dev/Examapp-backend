/*
 * A lesson plan (dərs planı) — the editable DRAFT. Published snapshots live in
 * lessonPlanVersionModel.js and never change.
 *
 * Named lessonPlanModel, not lessonModel: lessonModel is already the CALENDAR
 * lesson (owner, class, startAt, attendanceCode) and carries no content.
 *
 * Content is STRUCTURED JSON, never provider-generated HTML — all rich text is
 * sanitised with a strict allow-list on write (helper/lessonPlanContent.js).
 *
 * `classes: []` is NOT "all students" on this model. An unshared plan is visible
 * to its owner only; sharing is explicit.
 */
const mongoose = require("mongoose");
const { Schema } = mongoose;

const stageSchema = new Schema(
  {
    name: { type: String, default: "" },
    minutes: { type: Number, default: 0 },
    teacher: { type: String, default: "" },
    student: { type: String, default: "" },
    resources: { type: String, default: "" },
    checks: { type: String, default: "" },
    differentiation: { type: String, default: "" },
  },
  { _id: false }
);

// Every citation carries its full lineage. printedPageLabel and sourceTaskNo are
// STRINGS and are the ONLY page/task authorities — there is deliberately no flat
// sourcePage/sourceNo pair to disagree with them (CR-MSO-009).
const evidenceSchema = new Schema(
  {
    source: { type: Schema.Types.ObjectId, ref: "CurriculumSource", default: undefined },
    sourceVersion: { type: Schema.Types.ObjectId, ref: "CurriculumSourceVersion", default: undefined },
    sourceHash: { type: String, default: "" },
    filePageIndex: { type: Number, default: undefined },
    printedPageLabel: { type: String, default: "" },
    sourceTaskNo: { type: String, default: "" },
    excerpt: { type: String, default: "" },
    cropBox: { type: Schema.Types.Mixed, default: undefined },
    cropAssetKey: { type: String, default: "" },
    cropHash: { type: String, default: "" },
    verifyStatus: {
      type: String,
      enum: ["unverified", "machine_matched", "teacher_verified", "rejected"],
      default: "unverified",
    },
    verifyReason: { type: String, default: "" },
  },
  { _id: false }
);

const taskSchema = new Schema(
  {
    statement: { type: String, default: "" },
    solution: { type: String, default: "" },
    bloom: { type: String, default: "" },
    sourceMode: { type: String, enum: ["verbatim", "adapted", "original"], default: "original" },
    sourceEvidence: { type: evidenceSchema, default: undefined },
    reviewStatus: {
      type: String,
      enum: ["pending", "accepted", "needs_teacher_review"],
      default: "pending",
    },
    reviewNotes: { type: [String], default: undefined },
  },
  { _id: false }
);

const lessonPlanSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    ownerName: { type: String, default: "" },
    classes: { type: [{ type: Schema.Types.ObjectId, ref: "Class" }], default: undefined },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    grade: { type: String, default: "" },
    subject: { type: String, default: "" },
    topic: { type: String, default: "" },
    subStandards: { type: [String], default: undefined },
    objectives: { type: [String], default: undefined },
    criteria: { type: [String], default: undefined },
    motivation: { type: String, default: "" },
    // An invented hook is labelled as such and may NEVER carry a citation.
    motivationOrigin: { type: String, enum: ["ai", "teacher"], default: "teacher" },
    stages: { type: [stageSchema], default: undefined },
    tasks: { type: [taskSchema], default: undefined },
    reflection: { type: String, default: "" },
    homework: { type: String, default: "" },
    materials: { type: [String], default: undefined },
    lessonMinutes: { type: Number, default: 45 },
    // Pinned sources — an ARRAY, because a chapter can span several uploads.
    sourceVersions: { type: [{ type: Schema.Types.ObjectId, ref: "CurriculumSourceVersion" }], default: undefined },
    sourceMode: { type: String, enum: ["none", "textbook_preferred", "textbook_only"], default: "none" },

    status: { type: String, enum: ["draft", "reviewed", "published", "archived"], default: "draft" },
    // Draft-side CAS. Two tabs cannot overwrite each other; a write with a stale
    // revision gets 409 lesson_plan_conflict.
    revision: { type: Number, default: 0 },
    activeVersion: { type: Schema.Types.ObjectId, ref: "LessonPlanVersion", default: null },
    activeVersionNumber: { type: Number, default: 0 },
    // CR-MSO-016: archive is PARENT-side visibility. It never touches versions and
    // never releases a source reference.
    archivedAt: { type: Date, default: null },
    // "Yoxla" reveals a solution in the TEACHER's projector view at any time; this
    // flag is what lets a STUDENT see one. Default false, and the student
    // serializer omits solutions entirely until it is true — the visibility rule is
    // the server's, never the UI's.
    solutionsReleased: { type: Boolean, default: false },
    // An AI regeneration lands here as a PROPOSAL + diff; it never overwrites the
    // teacher's edits in place.
    proposal: { type: Schema.Types.Mixed, default: undefined },
    aiMeta: { type: Schema.Types.Mixed, default: undefined },
    schemaVersion: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    autoCreate: false,
    collection: "lesson_plans",
  }
);

lessonPlanSchema.index({ owner: 1, updatedAt: -1 }, { name: "owner_1_updatedAt_-1" });

module.exports = mongoose.model("LessonPlan", lessonPlanSchema);
module.exports.stageSchema = stageSchema;
module.exports.taskSchema = taskSchema;
module.exports.evidenceSchema = evidenceSchema;
