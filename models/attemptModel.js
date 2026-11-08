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
    // Every time the student left the exam screen (screen off, another app/tab,
    // focus lost): when, why, for how long and whether it COUNTED. A short absence
    // (an accidental screen-off, a notification) is forgiven — not a violation —
    // but it is still written here so the teacher sees it and can judge. Only the
    // newest 60 are kept.
    awayLog: {
      type: [
        new Schema(
          {
            at: Date,
            // hidden (screen off / another app or tab) | blur (another window took
            // focus) | photo_timeout | reload (came back via a reload) | back
            // (returned after a counted absence; awayMs = the whole absence)
            reason: String,
            awayMs: Number,
            counted: Boolean,
            // The phone's own screen time-out (no screen lock held + no touch for a
            // while before it), so a longer grace applied.
            autoOff: Boolean,
            // Counted by the timer while the student was STILL away.
            stillAway: Boolean,
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    awayCount: { type: Number, default: 0 }, // absences (forgiven + counted)
    awayMs: { type: Number, default: 0 }, // their total length
    // The device could not keep fullscreen; the exam ran without it (reported by
    // the runner so the teacher knows it was a weaker session). One-way.
    fsUnavailable: { type: Boolean, default: false },
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
