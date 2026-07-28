const mongoose = require("mongoose");
const { Schema } = mongoose;
const { EVENT_TYPES } = require("../config/teacherSuccess/xp");

/*
 * Teacher Journey — the IMMUTABLE XP event ledger. Every point award is one
 * append-only row traceable to exactly one real, committed source event.
 *
 * The client can never write here: awards are made server-side by teacherXpService
 * from committed domain events. A UNIQUE `idempotencyKey` (HMAC of teacher | type |
 * sourceId) makes a retried / duplicated / concurrent award a no-op — the point is
 * granted exactly once. An admin correction is a signed-amount row of type
 * "admin.correction" with an actor + reason (audited, reversible only this way).
 * The teacher's lifetime XP is ALWAYS reconstructable as SUM(amount) over these rows.
 *
 * autoIndex/autoCreate off — the Journey migration owns the collection + indexes.
 */
const teacherXpEventSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    amount: { type: Number, required: true }, // XP; may be negative ONLY for admin.correction
    // The stable id of the ONE real source event (e.g. examId, resultId, refereeId,
    // "<examId>:<questionId>", "day:<YYYY-MM-DD>"). Combined with teacher+type it forms
    // the idempotency identity — a re-fired event with the same source never re-awards.
    sourceId: { type: String, required: true },
    idempotencyKey: { type: String, required: true }, // HMAC digest (server-derived)
    periodMonthUtc: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    dayKey: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null }, // admin for corrections
    reason: { type: String, default: null, maxlength: 500 },
    meta: { type: Schema.Types.Mixed, default: undefined }, // bounded, non-sensitive
  },
  { timestamps: true, minimize: false, autoIndex: false, autoCreate: false, collection: "teacher_xp_event" }
);

// Migration-owned; mirrored in helper/teacherSuccessIndexes.js.
teacherXpEventSchema.index({ idempotencyKey: 1 }, { name: "uniq_xp_idem", unique: true }); // award once
teacherXpEventSchema.index({ teacherId: 1, createdAt: -1 }, { name: "xp_teacher_time" }); // feed
teacherXpEventSchema.index({ teacherId: 1, type: 1 }, { name: "xp_teacher_type" }); // cap counts
teacherXpEventSchema.index({ teacherId: 1, periodMonthUtc: 1 }, { name: "xp_teacher_period" }); // monthly caps

module.exports = mongoose.model("TeacherXpEvent", teacherXpEventSchema);
