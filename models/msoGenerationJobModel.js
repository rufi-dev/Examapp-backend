/*
 * CR-MSO-003 / CR-MSO-004 — a resumable, fenced, exactly-once-settled MSO job.
 *
 * Two variants x 20 tasks, each with statement, choices, answer, solution/rubric,
 * Bloom, sub-standard, criterion and a citation, will not fit reliably in one
 * 8,000-token response. So the work unit is a deterministic A/B PAIR and the job
 * advances in bounded batches, persisting each accepted batch before the next.
 *
 * FENCING — `leaseOwner` alone is not enough: an expired worker can wake up and
 * write after another has claimed the job. Every job write is therefore
 *   findOneAndUpdate({_id, leaseToken, attemptNo}, ...)
 * with an UNPREDICTABLE leaseToken, so a worker that lost its lease cannot write
 * at all. The lease is renewed on a heartbeat across long provider calls.
 *
 * SETTLEMENT — services/aiCreditService.recoverStaleReservations() releases
 * expired reservations, so it must NOT decide a document job's outcome:
 *   output persisted -> crash before commit -> generic recovery forgives the charge.
 * The job therefore carries a durable settlement intent
 *   reserved -> output_persisted -> commit_owed -> settled (or released)
 * moved in the SAME transaction that persists a batch, and its own recovery worker
 * inspects business outcome: usable output => commit, none => release.
 * `documentReservation: true` marks these reservations so the generic reaper skips
 * them.
 */
const mongoose = require("mongoose");
const { Schema } = mongoose;

const batchSchema = new Schema(
  {
    index: { type: Number, required: true },
    pairIds: { type: [String], default: undefined },
    state: {
      type: String,
      enum: ["pending", "running", "accepted", "failed"],
      default: "pending",
    },
    // Deterministic task identities `${jobId}:${pairId}:${variant}` already
    // persisted. Resume reconciles against these BEFORE any provider retry, so
    // accepted work is never regenerated even if the checkpoint was lost.
    acceptedTaskIds: { type: [String], default: undefined },
    failureCode: { type: String, default: "" },
    // One reservation per BATCH: the 10-minute reservation TTL would otherwise
    // expire mid-job, and a crashed batch then releases only its own slice.
    reservationId: { type: String, default: "" },
    settlement: {
      type: String,
      enum: ["none", "reserved", "output_persisted", "commit_owed", "settled", "released"],
      default: "none",
    },
    attempts: { type: Number, default: 0 },
  },
  { _id: false }
);

const msoGenerationJobSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    blueprint: { type: Schema.Types.ObjectId, ref: "MsoBlueprint", required: true },
    document: { type: Schema.Types.ObjectId, ref: "MsoDocument", default: null },
    sourceVersions: { type: [{ type: Schema.Types.ObjectId, ref: "CurriculumSourceVersion" }], default: undefined },
    // Client-supplied idempotency key. Bounded by the same rule aiCreditService
    // already enforces, so a retry or reconnect resumes instead of duplicating.
    clientReqId: { type: String, required: true },

    state: {
      type: String,
      enum: ["queued", "running", "needs_review", "failed", "done", "cancelled"],
      default: "queued",
    },
    batches: { type: [batchSchema], default: undefined },

    // ---- lease fencing ----
    leaseOwner: { type: String, default: null },
    leaseToken: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    attemptNo: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    deadLetterAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: () => new Date() },

    failureCode: { type: String, default: "" },
    finishedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    autoCreate: false,
    collection: "mso_generation_jobs",
  }
);

// A retry or reconnect with the same key must find the SAME job, never start a
// second one.
msoGenerationJobSchema.index({ owner: 1, clientReqId: 1 }, { name: "uniq_owner_clientReqId", unique: true });
// The claim query: runnable, not dead-lettered, lease free or expired.
msoGenerationJobSchema.index(
  { state: 1, nextAttemptAt: 1, leaseUntil: 1 },
  { name: "state_1_nextAttemptAt_1_leaseUntil_1" }
);

module.exports = mongoose.model("MsoGenerationJob", msoGenerationJobSchema);
