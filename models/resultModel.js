const mongoose = require("mongoose");
const { Schema } = mongoose;

const resultSchema = Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    examId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Exam",
    },
    attempts: {
      type: Number,
      required: true,
      default: 1,
    },
    earnPoints: {
      type: Number,
      required: true,
    },
    selectedAnswers: [
      {
        type: {
          type: String,
        },
        // Mixed: a string (Cm letter / open text), a number/array of indices
        // (structured single/multi), or a {leftIdx: rightId} map (matching).
        answer: {
          type: Schema.Types.Mixed,
        },
        // Optional student-uploaded photo of their worked solution for this
        // question (only when the exam enables studentSolutionPhotos).
        photo: {
          type: String,
        },
      },
    ],
    correctAnswers: [
      {
        type: {
          type: String,
          required: true,
        },
        // Mixed (see above). A renderable "correct value" for the review screen.
        answer: {
          type: Schema.Types.Mixed,
        },
      },
    ],
    photos: [
      {
        type: String,
        required: false,
      }
    ],
    correctAnswersByType: [
      {
        type: {
          type: String,
          required: true,
        },
        count: {
          type: Number,
          required: true,
          default: 0,
        },
      },
    ],
    // Anti-cheat: number of detected violations (tab switch / minimize /
    // second monitor) during the attempt. 0 when anti-cheat is off.
    violations: {
      type: Number,
      default: 0,
    },
    // True when the exam was auto-submitted because the violation limit was hit.
    terminated: {
      type: Boolean,
      default: false,
    },
    // The attempt this result belongs to. The single idempotency key: at most one
    // Result per attempt (enforced by the partial-unique index below). REQUIRED for
    // every NEW Result (guards against a future code path creating one without it);
    // `isNew`-gated so LEGACY docs (which lack it) still re-save fine.
    attemptId: {
      type: Schema.Types.ObjectId,
      ref: "Attempt",
      required: function () {
        return this.isNew;
      },
    },
    // True when the SERVER auto-created this Result (finalizer / expired-resume /
    // migration) from autosave, NOT a real client submit. Observability ONLY — it is
    // NOT used to allow replacing the result. An already-scored Result is
    // authoritative and is only ever reconciled (violations/termination merged
    // monotonically), never overwritten (anti-cheat: a late client submit must not
    // be able to replace a finalized result).
    autoSubmitted: {
      type: Boolean,
      default: false,
    },
    // Set once a termination-upgrade notification has been confirmed-delivered, so
    // a retry (or a crash-recovered pass) never double-sends the staff alert. This
    // is ONLY the termination marker, not a general "finished notified" gate.
    terminationNotifiedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    minimize: false,
    // Indexes are built explicitly at startup-verify time via the offline
    // migration (backfillAttemptId.js), NOT auto-created on boot: the unique
    // attemptId index must build against migrated data, and startup only verifies.
    autoIndex: false,
  }
);

// Indexes for the hot result queries: per-user-per-exam (maxTry counts, a
// student's results, the rank "best score" reads) and per-exam (rankings,
// results-by-exam). Without these, countDocuments/find full-scan the collection
// and get slower as results grow.
resultSchema.index({ userId: 1, examId: 1, createdAt: 1 });
resultSchema.index({ examId: 1 });

// At most ONE Result per attempt. Partial (only docs that HAVE an objectId
// attemptId) so legacy Results without attemptId never collide on null, and a
// stray string attemptId can't silently escape uniqueness ($type:"objectId").
resultSchema.index(
  { attemptId: 1 },
  {
    unique: true,
    name: "uniq_result_attempt",
    partialFilterExpression: { attemptId: { $exists: true, $type: "objectId" } },
  }
);

const ResultModel = mongoose.model("Result", resultSchema);

module.exports = ResultModel;
