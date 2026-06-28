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
        // Open "complete the table": an editable grid the student fills in place.
        // 2D array of cells { text, blank, colspan, rowspan, answers? }. Blank
        // cells (row-major) map 1:1 to `blanks`/`blankAnswers`, so scoring reuses
        // the multi-blank all-or-nothing path. Cell `answers` are SERVER-ONLY and
        // stripped before the grid is sent to students.
        table: { type: Schema.Types.Mixed, default: undefined },
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
        // Optional teacher note shown to the student in their review (only after
        // answers are revealable). SERVER-ONLY in any pre-reveal payload.
        explanation: { type: String },

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
