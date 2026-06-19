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
        type: {
          // Cm = single-choice, Cs = multi-select, Co/Cd = open, Cma = matching.
          type: String,
          enum: ["Cm", "Cs", "Co", "Cd", "Cma"],
          required: true,
        },
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
