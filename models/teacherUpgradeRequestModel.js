const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * Teacher Success Journey — teacher-initiated "request the next level" (ADR §10).
 *
 * At most ONE open request per {teacher, target} (unique partial index on
 * open state), so retried submissions are idempotent. A request NEVER grants a
 * level or any security capability — it is admin review/demand signal only.
 *
 * autoIndex/autoCreate off — the Journey migration owns the collection + indexes.
 */
const teacherUpgradeRequestSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    currentLevel: { type: String, enum: ["spark", "momentum", "impact"], required: true },
    targetLevel: { type: String, enum: ["spark", "momentum", "impact"], required: true },
    status: { type: String, enum: ["open", "approved", "denied", "info_requested"], default: "open" },
    // Structured product-demand capture (bounded).
    classStudentSize: { type: Number, default: null, min: 0 },
    intendedUse: { type: String, default: "", maxlength: 1000 },
    requestedBenefit: { type: String, default: "", maxlength: 500 },
    reason: { type: String, default: "", maxlength: 1000 },
    contactPreference: { type: String, default: "", maxlength: 200 },
    // Snapshot of activity/referral evidence at submission time (bounded).
    evidenceSnapshot: { type: Schema.Types.Mixed, default: undefined },
    // Decision audit.
    reviewer: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decisionReason: { type: String, default: null, maxlength: 1000 },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false, autoIndex: false, autoCreate: false, collection: "teacher_upgrade_request" }
);

// Migration-owned; mirrored in helper/teacherSuccessIndexes.js. One OPEN request
// per {teacher, target} (partial unique); status feed for the admin inbox.
teacherUpgradeRequestSchema.index(
  { teacherId: 1, targetLevel: 1 },
  { name: "uniq_open_request", unique: true, partialFilterExpression: { status: "open" } }
);
teacherUpgradeRequestSchema.index({ status: 1, createdAt: -1 }, { name: "upreq_status" });

module.exports = mongoose.model("TeacherUpgradeRequest", teacherUpgradeRequestSchema);
