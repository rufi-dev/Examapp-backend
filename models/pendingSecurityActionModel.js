const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// AUD-002 (ADR-018): durable outbox for the retryable half of security actions
// (a sessionVersion bump that could not apply synchronously, or a cleanup
// revoke). The _id IS the idempotency key, so a duplicate enqueue is a no-op.
// Applied by a worker with a crash-safe lease; monotonic $lt guards make
// re-application safe. See docs/adr/AUD-002-session-lifecycle.md §12.
const pendingSecurityActionSchema = new Schema({
  _id: { type: String }, // idempotency key: `<action>:<sid|userId>:<targetVersion>`
  action: { type: String, enum: ["sv-bump", "revoke-session", "revoke-before-epoch"], required: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  sid: { type: String, default: null },
  targetVersion: { type: Number, default: null }, // for sv-bump; re-applied with $lt guard
  reason: { type: String }, // "refresh-reuse" | "reset" | "logout-all" | ...
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, required: true },
  leaseOwner: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
  deadLetter: { type: Boolean, default: false },
  createdAt: { type: Date, required: true },
}, {
  // CR-007: collection/index creation is owned by the migration, not model init.
  autoCreate: false,
  autoIndex: false,
});

pendingSecurityActionSchema.index({ deadLetter: 1, nextAttemptAt: 1 }); // drain query
pendingSecurityActionSchema.index({ leaseUntil: 1 }); // reclaim expired leases

module.exports = mongoose.model("PendingSecurityAction", pendingSecurityActionSchema);
