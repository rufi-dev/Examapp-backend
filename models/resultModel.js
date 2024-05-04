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
  },
  {
    timestamps: true,
    minimize: false,
  }
);

const ResultModel = mongoose.model("Result", resultSchema);

module.exports = ResultModel;
