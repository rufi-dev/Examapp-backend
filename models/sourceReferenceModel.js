/*
 * CR-MSO-001 — the DELETION AUTHORITY for curriculum source versions.
 *
 * `CurriculumSource.refCount` is a cached projection and drifts under crashes and
 * concurrency; it is never consulted to decide whether bytes may be removed. This
 * collection is: a version may be deleted only when it holds NO row here.
 *
 * Holders deliberately include work in progress, not just published documents —
 * deleting a source out from under an active generation job or an unpublished
 * draft destroys work just as surely as breaking a published citation:
 *   published_version  an immutable published MSO/lesson-plan version
 *   draft              an unpublished document still being edited
 *   job                a running generation job
 *
 * A `published_version` reference is NEVER released by archiving (CR-MSO-016) —
 * it lives exactly as long as its immutable version row, and is released only when
 * that row is genuinely removed through authorized maintenance.
 */
const mongoose = require("mongoose");
const { Schema } = mongoose;

const sourceReferenceSchema = new Schema(
  {
    sourceVersion: { type: Schema.Types.ObjectId, ref: "CurriculumSourceVersion", required: true },
    holderKind: { type: String, enum: ["published_version", "draft", "job"], required: true },
    holderId: { type: Schema.Types.ObjectId, required: true },
    // Denormalised so the "why can't I delete this?" message can name the owner
    // without a second lookup. Not authoritative.
    holderLabel: { type: String, default: "" },
  },
  {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    autoCreate: false,
    collection: "curriculum_source_references",
  }
);

// One row per (version, holder). Makes claiming idempotent and makes "is this
// version referenced?" a single indexed existence check.
sourceReferenceSchema.index(
  { sourceVersion: 1, holderKind: 1, holderId: 1 },
  { name: "uniq_source_holder", unique: true }
);
sourceReferenceSchema.index({ holderKind: 1, holderId: 1 }, { name: "holderKind_1_holderId_1" });

module.exports = mongoose.model("SourceReference", sourceReferenceSchema);
