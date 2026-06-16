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
        answer: {
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
        answer: {
          type: String,
          required: true,
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
  },
  {
    timestamps: true,
    minimize: false,
  }
);

const ResultModel = mongoose.model("Result", resultSchema);

module.exports = ResultModel;
