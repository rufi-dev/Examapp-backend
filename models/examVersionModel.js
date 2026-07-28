const mongoose = require("mongoose");
const { Schema } = mongoose;

// AUD-003 — an IMMUTABLE published version of an exam. Everything needed to
// reproduce grading and review is frozen here at publish time. Attempts bind to a
// version at start; grading/finalization/review read THIS snapshot, never the
// live (mutable) Exam/Question. A version that has an attempt/result is never
// edited or deleted — editing the exam forks a NEW version on the next publish.
//
// Publishing is LAZY: startAttempt calls ensurePublishedVersion(), which reuses
// the exam's current version when the live draft's content hash is unchanged, and
// forks a new immutable version when the teacher has edited the draft. There is
// no separate "publish" button, so the existing teacher workflow is unchanged.
const examVersionSchema = new Schema(
  {
    examId: { type: Schema.Types.ObjectId, ref: "Exam", required: true, index: true },
    // Monotonic per exam (1, 2, 3, …). Assigned at publish time.
    versionNumber: { type: Number, required: true },
    // sha256 over the canonical {questions, grading} snapshot. Two publishes with
    // identical grading content share a hash, so an unchanged draft is NOT forked.
    contentHash: { type: String, required: true, index: true },
    // Who published (exam owner at publish time) and when.
    author: { type: Schema.Types.ObjectId, ref: "User", default: null },
    publishedAt: { type: Date, required: true },
    // "published" = the live grading target; "archived" = retained only because a
    // result/history references it (the exam was retired or the version superseded
    // while attempts existed). Never hard-deleted while referenced.
    state: { type: String, enum: ["published", "archived"], default: "published" },

    // --- frozen grading evidence ---
    // The full correctAnswers[] array (answer key + question content) as it stood
    // at publish. Mixed: identical shape to Question.correctAnswers.
    questions: { type: [Schema.Types.Mixed], default: [] },
    // CR-035: the resolved per-question point plan + the correctness-evaluator
    // version, FROZEN at publish, so the score is reproducible even if the in-code
    // presets/legacy split or evaluator later change.
    pointsPlan: { type: [Number], default: [] },
    evaluatorVersion: { type: String, default: "1" },
    // Every scoring input, frozen. Grading reads ONLY these, never the live exam.
    grading: {
      preset: { type: String, default: "" },
      typePoints: { type: Schema.Types.Mixed, default: undefined },
      partialCredit: { type: Boolean, default: false },
      negativeMarking: { type: Boolean, default: false },
      wrongPerPenalty: { type: Number, default: 3 },
      correctPerPenalty: { type: Number, default: 1 },
      negMarkUntil: { type: Number, default: 0 },
      totalMarks: { type: Number, default: 0 },
      passingMarks: { type: Number, default: 0 },
      shuffleOptions: { type: Boolean, default: false },
      mode: { type: String, default: "pdf" },
    },
    // Reveal/review policy, frozen (so a later toggle can't retro-change what a
    // graded attempt was told).
    reveal: {
      showScore: { type: Boolean, default: true },
      showCorrectAnswers: { type: Boolean, default: false },
      revealAfterEnd: { type: Boolean, default: true },
      // CR-036: the exam's end timestamp AT publish, so `revealAfterEnd` uses the
      // policy the student was graded under even if the live exam is later edited
      // or hard-deleted. null = no end date (reveal not gated on end).
      endDate: { type: Date, default: null },
    },
    // Display + runner metadata needed to render the paper faithfully. CR-034:
    // EVERY attempt-affecting/runner-visible setting is frozen here so a start uses
    // one coherent version, never live mutable metadata.
    display: {
      name: { type: String, default: "" },
      duration: { type: Number, default: 0 },
      questionsPerPage: { type: Number, default: 0 },
      forwardOnly: { type: Boolean, default: false },
      antiCheat: { type: Boolean, default: false },
      studentSolutionPhotos: { type: Boolean, default: false },
      listeningAudio: { type: String, default: "" },
    },
  },
  { timestamps: true, minimize: false, autoIndex: false }
);

// CR-035: at most ONE row per (exam, versionNumber) — atomic version-number
// allocation relies on this to reject a duplicate number under a publish race.
examVersionSchema.index({ examId: 1, versionNumber: 1 }, { unique: true, name: "uniq_exam_versionnumber" });

// AUD-003: at most ONE version per (exam, content hash) — makes publish idempotent
// (re-publishing identical content reuses the row) and the fork race-safe.
examVersionSchema.index({ examId: 1, contentHash: 1 }, { unique: true, name: "uniq_exam_contenthash" });

// CR-035: a published version is IMMUTABLE through the application. Every mutation
// and delete surface — QUERY (updateOne/updateMany/findOneAndUpdate/replaceOne/
// findOneAndReplace/deleteOne/deleteMany/findOneAndDelete), DOCUMENT
// (doc.save / doc.deleteOne), and bulkWrite — is blocked unless it runs inside an
// AUTHORIZED, AUDITED maintenance context (services/versionMaintenance.performMaintenance,
// which requires actor + reason + authorization and writes a durable audit FIRST).
// There is NO public `{ maintenance: true }` option any more. Corruption/repair
// TESTS simulate damage via the NATIVE collection (ExamVersion.collection.*), which
// bypasses Mongoose middleware by design.
const IMMUTABLE_MSG = "ExamVersion is immutable: published versions cannot be modified or deleted via the app (use an audited maintenance operation).";
function block(next) {
  const { isAuthorizedContext } = require("../services/versionMaintenance");
  if (isAuthorizedContext()) return next();
  next(new Error(IMMUTABLE_MSG));
}
examVersionSchema.pre("save", function (next) {
  const { isAuthorizedContext } = require("../services/versionMaintenance");
  // New documents (publishing) are allowed; re-saving an existing published row is not.
  if (this.isNew || isAuthorizedContext()) return next();
  next(new Error("ExamVersion is immutable: a published version cannot be re-saved."));
});
// QUERY middleware.
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteMany", "findOneAndDelete"]) {
  examVersionSchema.pre(op, block);
}
// deleteOne exists as BOTH query and document middleware — register both so
// doc.deleteOne() is blocked too (the previously-missed surface).
examVersionSchema.pre("deleteOne", { query: true, document: false }, block);
examVersionSchema.pre("deleteOne", { document: true, query: false }, function (next) {
  const { isAuthorizedContext } = require("../services/versionMaintenance");
  if (isAuthorizedContext()) return next();
  next(new Error(IMMUTABLE_MSG));
});
// bulkWrite has no schema hook; guard by overriding the model method below.

const ExamVersion = mongoose.model("ExamVersion", examVersionSchema);

const _bulkWrite = ExamVersion.bulkWrite.bind(ExamVersion);
ExamVersion.bulkWrite = function (ops, options, cb) {
  const { isAuthorizedContext } = require("../services/versionMaintenance");
  if (!isAuthorizedContext()) {
    const err = new Error(IMMUTABLE_MSG);
    if (typeof options === "function") return options(err);
    if (typeof cb === "function") return cb(err);
    return Promise.reject(err);
  }
  return _bulkWrite(ops, options, cb);
};

module.exports = ExamVersion;
