const mongoose = require("mongoose");
const { Schema } = mongoose;

const questionSchema = Schema(
  {
    correctAnswers: [
      {
        answer: {
          type: String,
          required: true,
        },
        type: {
          type: String,
          enum: ["Cm", "Co", "Cd", "Cma"], // Add other possible types if needed
          required: true,
        },
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
