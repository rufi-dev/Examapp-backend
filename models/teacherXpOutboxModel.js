const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * Teacher Journey — durable XP award outbox. When a committed business action (exam
 * publish, attempt completion, material use, ...) tries to award XP and the ledger
 * write transiently FAILS, we enqueue the intent here instead of rolling back the
 * business action. A flag-gated worker drains it with backoff; the award idempotency
 * key guarantees draining is safe even if the original write actually succeeded.
 *
 * autoIndex/autoCreate off — the Journey migration owns the collection + indexes.
 */
const teacherXpOutboxSchema = new Schema(
  {
    idempotencyKey: { type: String, required: true }, // same key the eventual award uses
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true },
    sourceId: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: undefined }, // { meta, ... } for the award
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    deadLetter: { type: Boolean, default: false },
    lastError: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true, minimize: false, autoIndex: false, autoCreate: false, collection: "tsj_xp_outbox" }
);

teacherXpOutboxSchema.index({ idempotencyKey: 1 }, { name: "uniq_outbox_key", unique: true }); // enqueue once
teacherXpOutboxSchema.index({ deadLetter: 1, nextAttemptAt: 1 }, { name: "outbox_due" }); // drain due rows

module.exports = mongoose.model("TeacherXpOutbox", teacherXpOutboxSchema);
