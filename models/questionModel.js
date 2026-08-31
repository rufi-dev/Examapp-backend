const mongoose = require("mongoose");
const { Schema } = mongoose;

// One choice for a structured single/multi-select question.
const choiceSchema = new Schema(
  {
    text: { type: String, default: "" },
    image: { type: String },
    latex: { type: String },
  },
  { _id: false }
);

// One matching row: left item is paired with its correct right item.
const pairSchema = new Schema(
  {
    left: { type: String, default: "" },
    leftLatex: { type: String },
    leftImage: { type: String },
    right: { type: String, default: "" },
    rightLatex: { type: String },
    rightImage: { type: String },
  },
  { _id: false }
);

const questionSchema = Schema(
  {
    correctAnswers: [
      {
        // Legacy/open answer key (PDF Cm = correct letter; Co/Cd = correct text).
        // NOT required: structured single/multi/matching store the key in
        // `correct`/`pairs` instead. The builder mirrors a canonical string here
        // anyway so legacy readers never see undefined.
        answer: {
          type: String,
        },
        // Open (Co/Cd): additional accepted answers. A typed answer matching ANY
        // of these (case-insensitive) is correct. `answer` stays the primary.
        answers: { type: [String], default: undefined },
        type: {
          // Cm = single-choice, Cs = multi-select, Co/Cd = open, Cma = matching
          // (text pairs), Cmu = correspondence (numbers -> letters, one-to-many),
          // reading = a passage block (not a question; never scored, shown on its
          // own page before the related questions; `text` holds the passage body
          // and `title` an optional heading).
          type: String,
          enum: ["Cm", "Cs", "Co", "Cd", "Cma", "Cmu", "reading"],
          required: true,
        },
        // Reading passage heading (only for type "reading").
        title: { type: String },
        // Section block (type "reading") kind: "reading" (text passage) or
        // "listening" (audio). Both are non-scored section blocks.
        kind: { type: String },
        // Section block: optional listening audio (Cloudinary URL) and `covers` =
        // how many following questions belong to this section (0/unset = until the
        // next block). Display content; sent to students.
        audio: { type: String },
        covers: { type: Number },
        // Open (Co/Cd): number of separate answer boxes the student fills (e.g.
        // a "complete the table" question with a photo + N blanks). 1 / unset =
        // a single answer. Graded manually when > 1.
        blanks: { type: Number, default: undefined },
        // Open multi-blank: accepted answers per blank ([[...],[...]]). SERVER-
        // ONLY (the answer key — never sent to students).
        blankAnswers: { type: Schema.Types.Mixed, default: undefined },
        // Manual grading (MANUAL_GRADING_ENABLED): when true this open question is
        // NOT auto-scored — it is held for the teacher to grade by hand (Doğru /
        // Yanlış / qismən). Frozen into the ExamVersion snapshot + contentHash like
        // any question field, so the grade stays reproducible.
        manualGrade: { type: Boolean, default: false },
        // Open "complete the table": an editable grid the student fills in place.
        // 2D array of cells { text, blank, colspan, rowspan, answers? }. Blank
        // cells (row-major) map 1:1 to `blanks`/`blankAnswers`, so scoring reuses
        // the multi-blank all-or-nothing path. Cell `answers` are SERVER-ONLY and
        // stripped before the grid is sent to students.
        table: { type: Schema.Types.Mixed, default: undefined },
        // Gap-fill flags. BOTH are load-bearing for scoring, so they must be
        // declared here: `correctAnswers` is a typed subdocument array, and strict
        // mode drops any undeclared key BEFORE the write reaches Mongo (on
        // Question.create AND on the builder's findOneAndUpdate($set)).
        //   inline  -> an inline gap-fill whose text is already anonymised. It may
        //              have a SINGLE blank and is still graded per-blank against
        //              blankAnswers (isMultiBlank, quizController.js).
        //   gapfill -> a gap-fill reading (cloze): a "reading" block that IS scored,
        //              so isRead() (helper/scoring.js) must see it and give it points.
        inline: { type: Boolean, default: undefined },
        gapfill: { type: Boolean, default: undefined },
        // Listening-section playback rules (type "reading", kind "listening").
        // maxPlays is bounded so a malformed/hostile payload can neither disable the
        // limit nor store a fractional count the player cannot honour. ABSENT is the
        // only way to say "unlimited" -- `null` is REJECTED, because the player reads
        // `Number(maxPlays) > 0` (LimitedAudio.jsx) and Number(null) is 0, so a stored
        // null would silently lift the very limit the teacher set. The builder already
        // sends undefined for unlimited (StructuredBuilder.jsx buildPayload).
        maxPlays: {
          type: Number,
          default: undefined,
          validate: {
            validator: (v) => v === undefined || (Number.isSafeInteger(v) && v >= 1 && v <= 20),
            message: "maxPlays 1..20 araliginda tam eded olmalidir",
          },
        },
        allowPause: { type: Boolean, default: undefined },
        // ---- curriculum metadata (optional; absent on ordinary exams) ----
        // Declared HERE for the same reason as the gap-fill flags above: strict mode
        // drops undeclared keys on both write paths, so an undeclared field would be
        // saved by the builder, read by the server, and silently never persisted.
        //
        // There is deliberately NO flat sourcePage/sourceNo pair. `sourceEvidence`
        // is the single citation authority, and its page is a STRING label
        // (printedPageLabel) because real books use "iv", "A-12" and "124a".
        subStandard: { type: String, default: undefined },
        bloom: { type: String, default: undefined },
        criterion: { type: String, default: undefined },
        sourceMode: { type: String, enum: ["verbatim", "adapted", "original"], default: undefined },
        sourceEvidence: { type: Schema.Types.Mixed, default: undefined },

        // Legacy PDF letters (a/b/c/d) for Cm in pdf mode.
        options: {
          type: [String],
          default: undefined,
        },

        // ---- structured content (all optional; absent on PDF exams) ----
        text: { type: String },
        image: { type: String },
        images: { type: [String], default: undefined },
        latex: { type: String },

        // single (Cm) / multi (Cs): the choices shown + the correct index/indices
        // (SERVER-ONLY; stripped before sending to students).
        choices: { type: [choiceSchema], default: undefined },
        correct: { type: [Number], default: undefined },

        // matching (Cma): correct mapping is implicit pairs[k].left <-> pairs[k].right
        // (SERVER-ONLY).
        pairs: { type: [pairSchema], default: undefined },

        // correspondence (Cmu): the question's numbers/letters live in the PDF;
        // the answer key only stores the sizes + the correct letter indices per
        // number. `leftCount` numbers (1..N), `rightCount` letters (a..M), and
        // `key[i]` = the array of correct letter indices for number i+1
        // (SERVER-ONLY — only leftCount/rightCount are sent to students).
        leftCount: { type: Number, default: undefined },
        rightCount: { type: Number, default: undefined },
        key: { type: Schema.Types.Mixed, default: undefined },
      },
    ],
    exam: {
      type: Schema.Types.ObjectId,
      ref: "Exam",
      required: true,
    },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

const QuestionModel = mongoose.model("Question", questionSchema);

module.exports = QuestionModel;
