const mongoose = require("mongoose");
const { Schema } = mongoose;

// A server-tracked exam attempt. The server owns startedAt/expiresAt so the
// timer can't be tampered with client-side.
const attemptSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    examId: { type: Schema.Types.ObjectId, ref: "Exam", required: true },
    startedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    submitted: { type: Boolean, default: false },
    // Anti-cheat is server-owned: each leave-the-page event is reported and
    // counted here, and the server flips `terminated` once the limit is hit.
    // The client can't lower these by editing storage/JS or by reloading.
    violations: { type: Number, default: 0 },
    terminated: { type: Boolean, default: false },
    // Per-attempt structured choice shuffle (only when exam.shuffleOptions). Maps
    // a question index -> permutation array, where perm[displayPos] = originalIdx.
    // Generated once at start, reused on resume (stable order), and used at submit
    // to map the student's display-order picks back to original indices.
    optionOrder: { type: Schema.Types.Mixed, default: undefined },
    // Latest autosaved DISPLAY-order selections (same shape the client would
    // submit). The browser pushes these periodically so that, if the student
    // never submits, the server-side finalizer can auto-submit THESE answers
    // when the timer runs out. The student can never escape an attempt without a
    // scored result.
    answers: { type: Schema.Types.Mixed, default: undefined },
  },
  // Indexes are built explicitly at startup (after a one-time dedup) so the
  // unique partial index below can't fail to build on legacy duplicate data.
  { timestamps: true, autoIndex: false }
);

attemptSchema.index({ userId: 1, examId: 1 });

// At most ONE active (unsubmitted) attempt per user/exam, enforced by the DB so
// parallel /start requests can't race past maxTry by creating several live
// attempts. (Submitted attempts are excluded, so retries are still allowed.)
attemptSchema.index(
  { userId: 1, examId: 1 },
  {
    unique: true,
    partialFilterExpression: { submitted: false },
    // Distinct name: without it, this collides with the index above (same key
    // pattern) and MongoDB rejects it with IndexKeySpecsConflict, silently
    // leaving NO uniqueness — which defeats the whole single-active-attempt fix.
    name: "uniq_active_attempt",
  }
);

module.exports = mongoose.model("Attempt", attemptSchema);
