const mongoose = require("mongoose");
const { Schema } = mongoose;

// A server-tracked exam attempt. The server owns startedAt/expiresAt so the
// timer can't be tampered with client-side.
const attemptSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    examId: { type: Schema.Types.ObjectId, ref: "Exam", required: true },
    // AUD-003: the immutable published version this attempt was started on.
    // Grading/review read THIS snapshot, never the live (mutable) exam. Null on a
    // legacy attempt started before versioning — such an attempt is explicitly
    // legacy-unversioned and grades against the live exam (best-effort).
    examVersionId: { type: Schema.Types.ObjectId, ref: "ExamVersion", default: null },
    startedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    // AUD-016: a real server-assigned try ordinal. It is assigned when the
    // attempt is created, not inferred from answered questions.
    attemptOrdinal: { type: Number, default: null },
    submitted: { type: Boolean, default: false },
    // AUD-004 (CR-037): monotonic autosave revision. `autosaveRev` is the revision
    // of the answers currently stored in `answers`; the server accepts only a
    // STRICTLY newer revision. `lastAutosaveReqId` is the stable identity of the
    // request that stored the current revision — a duplicate is acknowledged ONLY
    // when BOTH the revision and this id match (same revision + different body is a
    // typed conflict, never a false "duplicate"). `autosaveProtocol` is the
    // per-attempt cutover: once a VERSIONED save is accepted (protocol 1), a legacy
    // unversioned write can never replace the tracked answers.
    autosaveRev: { type: Number, default: 0 },
    lastAutosaveReqId: { type: String, default: null },
    // CR-037: hash of the answers stored at autosaveRev. A duplicate is a SUCCESS
    // only when the revision, requestId AND payload hash all match — the same
    // revision/requestId with a DIFFERENT body is a typed conflict, never a false
    // "duplicate".
    lastAutosavePayloadHash: { type: String, default: null },
    autosaveProtocol: { type: Number, default: 0 },
    // AUD-004 (CR-038): durable finalization freeze. When the deadline finalizer
    // (or a submit) claims the attempt, it ATOMICALLY copies the current answers +
    // revision into frozen* and flips finalizeState to "frozen" in ONE operation.
    // Autosave is rejected once frozen, so the graded snapshot can't move after the
    // claim; a crash after the freeze is recovered by re-scoring frozenAnswers
    // deterministically (never re-opening a possibly-committed result).
    finalizeState: { type: String, enum: ["open", "frozen"], default: "open" },
    frozenAnswers: { type: Schema.Types.Mixed, default: undefined },
    frozenRev: { type: Number, default: null },
    // Anti-cheat is server-owned: each leave-the-page event is reported and
    // counted here, and the server flips `terminated` once the limit is hit.
    // The client can't lower these by editing storage/JS or by reloading.
    violations: { type: Number, default: 0 },
    terminated: { type: Boolean, default: false },
    // Terminal exception to the "every submitted attempt has a Result" invariant:
    // an attempt that can never be scored (its exam/user was deleted, or it was a
    // retired duplicate / a legacy ghost). Excluded from ALL counts. NOTE: only
    // `unscorable === true` is terminal; `legacy_unlinked` is an observability tag
    // on a real Result and MUST NOT set unscorable:true.
    unscorable: { type: Boolean, default: false },
    unscorableReason: {
      type: String,
      enum: [
        "deleted_exam",
        "deleted_user",
        "retired_duplicate",
        "ghost_no_result",
        "legacy_unlinked",
      ],
      default: undefined,
    },
    // AUD-017: bounded durable-worker claim/retry state. A stale lease may be
    // reclaimed; failures remain eligible until success or dead-letter.
    finalizeLeaseOwner: { type: String, default: null, select: false },
    finalizeLeaseUntil: { type: Date, default: null, select: false },
    finalizeNextAttemptAt: { type: Date, default: null, select: false },
    finalizeAttempts: { type: Number, default: 0, select: false },
    finalizeDeadLetterAt: { type: Date, default: null, select: false },
    // Per-attempt structured choice shuffle (only when exam.shuffleOptions). Maps
    // a question index -> permutation array, where perm[displayPos] = originalIdx.
    // Generated once at start, reused on resume (stable order), and used at submit
    // to map the student's display-order picks back to original indices.
    optionOrder: { type: Schema.Types.Mixed, default: undefined },
    // Per-attempt QUESTION display order (block-safe permutation): questionOrder
    // [displayPos] = canonicalIndex. Generated once at start, reused on resume, and
    // used at submit to map display-order answers back to canonical for scoring.
    questionOrder: { type: [Number], default: undefined },
    // Latest autosaved DISPLAY-order selections (same shape the client would
    // submit). The browser pushes these periodically so that, if the student
    // never submits, the server-side finalizer can auto-submit THESE answers
    // when the timer runs out. The student can never escape an attempt without a
    // scored result.
    answers: { type: Schema.Types.Mixed, default: undefined },
    // Live-watch telemetry: the question the student is currently on (1-based
    // display index), how many they've answered, and the last heartbeat time.
    // Pushed by the runner alongside autosave; read by the teacher's live view.
    currentQuestion: { type: Number, default: 0 },
    answeredCount: { type: Number, default: 0 },
    lastSeenAt: { type: Date, default: null },
  },
  // Indexes are built explicitly at startup (after a one-time dedup) so the
  // unique partial index below can't fail to build on legacy duplicate data.
  { timestamps: true, autoIndex: false }
);

// CR-119: EXPLICIT name (matches the mongoose default, so no prod rename) so this
// non-unique performance index is an unambiguous entry in the shared index contract
// distinct from the same-key uniq_active_attempt below.
attemptSchema.index({ userId: 1, examId: 1 }, { name: "userId_1_examId_1" });

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

// AUD-017: the minute finalizer reads only open, due attempts. The partial
// predicate keeps submitted history out of the hot index while the key order
// supports the due/lease/retry sweep without scanning submitted history.
attemptSchema.index(
  {
    unscorable: 1,
    expiresAt: 1,
    finalizeNextAttemptAt: 1,
    finalizeLeaseUntil: 1,
  },
  {
    name: "due_attempt_finalizer",
    partialFilterExpression: { submitted: false },
  }
);

module.exports = mongoose.model("Attempt", attemptSchema);
