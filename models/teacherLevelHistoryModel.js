const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * Teacher Success Journey — IMMUTABLE promotion/correction audit trail (ADR §9).
 * Append-only: one row per level change, never updated. A normal promotion moves
 * exactly one step; an exceptional correction/reversal is recorded with kind
 * "correction". Every row carries the acting admin, reason, and before/after
 * level + levelVersion so concurrent/retried clicks are auditable.
 *
 * autoIndex/autoCreate off — the Journey migration owns the collection + indexes.
 */
const teacherLevelHistorySchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    fromLevel: { type: String, enum: ["spark", "momentum", "impact"], required: true },
    toLevel: { type: String, enum: ["spark", "momentum", "impact"], required: true },
    source: { type: String, enum: ["activity", "referral", "admin", "subscription"], required: true },
    kind: { type: String, enum: ["promotion", "correction"], default: "promotion" },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true }, // the admin
    levelVersionBefore: { type: Number, required: true },
    levelVersionAfter: { type: Number, required: true },
  },
  { timestamps: true, minimize: false, autoIndex: false, autoCreate: false, collection: "teacher_level_history" }
);

// Migration-owned (autoIndex:false); mirrored in helper/teacherSuccessIndexes.js.
teacherLevelHistorySchema.index({ teacherId: 1, createdAt: -1 }, { name: "hist_teacher_time" });
// CR-126: the reached version is the DETERMINISTIC operation id — history is
// written at most once per promotion/correction, so a crash + retry REPAIRS the
// missing row instead of duplicating it.
teacherLevelHistorySchema.index({ teacherId: 1, levelVersionAfter: 1 }, { name: "uniq_teacher_version", unique: true });

module.exports = mongoose.model("TeacherLevelHistory", teacherLevelHistorySchema);
