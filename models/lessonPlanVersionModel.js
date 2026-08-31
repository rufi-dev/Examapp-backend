/*
 * An immutable published snapshot of a lesson plan.
 *
 * There is deliberately NO state field: an immutable row cannot transition, so
 * "archived" lives on the parent (LessonPlan.archivedAt). Archiving therefore
 * releases no source reference — the bytes a published citation pins stay pinned
 * for as long as this row exists (CR-MSO-016).
 *
 * `sourceVersions` + `sourceHashes` pin the exact bytes. A hash mismatch at read
 * time is corruption, and is the ONLY thing that may invalidate a citation.
 */
const mongoose = require("mongoose");
const { Schema } = mongoose;
const { makeImmutable, guardBulkWrite } = require("../helper/immutableVersion");

const lessonPlanVersionSchema = new Schema(
  {
    docId: { type: Schema.Types.ObjectId, ref: "LessonPlan", required: true },
    versionNumber: { type: Number, required: true, min: 1 },
    contentHash: { type: String, required: true },
    author: { type: Schema.Types.ObjectId, ref: "User", default: null },
    publishedAt: { type: Date, default: Date.now },
    // The whole frozen document. Mixed on purpose: the snapshot must survive any
    // later schema change exactly as it was published.
    content: { type: Schema.Types.Mixed, required: true },
    sourceVersions: { type: [{ type: Schema.Types.ObjectId, ref: "CurriculumSourceVersion" }], default: undefined },
    sourceHashes: { type: [String], default: undefined },
    schemaVersion: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    autoCreate: false,
    collection: "lesson_plan_versions",
  }
);

lessonPlanVersionSchema.index({ docId: 1, versionNumber: 1 }, { name: "uniq_plan_version", unique: true });
lessonPlanVersionSchema.index({ docId: 1, contentHash: 1 }, { name: "uniq_plan_content", unique: true });

makeImmutable(lessonPlanVersionSchema, "LessonPlanVersion");

module.exports = guardBulkWrite(
  mongoose.model("LessonPlanVersion", lessonPlanVersionSchema),
  "LessonPlanVersion"
);
