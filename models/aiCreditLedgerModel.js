const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * Teacher Success Journey — append-only AI credit ledger (ADR §8.3).
 *
 * Every reserve/commit/release/grant is one immutable row with a UNIQUE
 * idempotencyKey, so a retried/reconnected/duplicated request keyed by the same
 * value is a no-op (no double-charge, no double-release). Bounded metadata only
 * (no PII-heavy/high-cardinality labels). Temporary admin grants are ledger
 * rows of kind "grant" with a reason, actor, and expiry, and add to the
 * period's tempGranted.
 *
 * autoIndex/autoCreate off — the Journey migration owns the collection + indexes.
 */
const aiCreditLedgerSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    periodMonthUtc: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    // Stable idempotency key: for a reserve/commit/release triad the same
    // base operation key is suffixed by kind so all three are distinct rows but
    // a retry of any one is deduplicated.
    // CR-121: a SERVER-DERIVED HMAC digest of the FULL idempotency identity
    // (teacherId | periodMonthUtc | operation | clientReqId | kind). A globally
    // reusable raw client key can never collide across teachers/periods/operations
    // or bypass a reservation, and the unique index makes each identity charge once.
    idempotencyKey: { type: String, required: true },
    // The bounded client request id (validated) — the stable id of ONE logical AI
    // action, reused across retry/SSE-reconnect/refresh so they settle once.
    clientReqId: { type: String, default: null },
    operation: { type: String, required: true }, // stable AI operation name
    kind: { type: String, enum: ["reserve", "commit", "release", "grant"], required: true },
    amount: { type: Number, required: true }, // credits (positive)
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null }, // admin for grants
    reason: { type: String, default: null, maxlength: 500 },
    // CR-122: a reservation intent expires; a crash that strands it is reclaimed by
    // the recovery worker so credits can never be permanently stranded.
    expiresAt: { type: Date, default: null }, // reservation TTL / grant expiry
    // CR-123: grant expiry marker (idempotent; reconcile excludes expired grants so
    // the same grant can never be subtracted twice).
    settledAt: { type: Date, default: null },
    meta: { type: Schema.Types.Mixed, default: undefined }, // bounded
  },
  { timestamps: true, minimize: false, autoIndex: false, autoCreate: false, collection: "ai_credit_ledger" }
);

// Migration-owned; mirrored in helper/teacherSuccessIndexes.js. Unique
// idempotency key = no double-charge; period feed; grant-expiry sweep.
aiCreditLedgerSchema.index({ idempotencyKey: 1 }, { name: "uniq_idem", unique: true });
aiCreditLedgerSchema.index({ teacherId: 1, periodMonthUtc: 1, createdAt: -1 }, { name: "ledger_teacher_period" });
aiCreditLedgerSchema.index(
  { expiresAt: 1 },
  { name: "grant_expiry", partialFilterExpression: { kind: "grant" } }
);

module.exports = mongoose.model("AiCreditLedger", aiCreditLedgerSchema);
