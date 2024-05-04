const mongoose = require("mongoose");
const { Schema } = mongoose;

const classSchema = Schema(
  {
    level: {
      type: Number,
      required: true,
      unique: false,
    },
    exams: [
      {
        type: Schema.Types.ObjectId,
        ref: "Exam",
      },
    ],
    tag: {
      type: Schema.Types.ObjectId,
      ref: "Tag",
    },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

const ClassModel = mongoose.model("Class", classSchema);

module.exports = ClassModel;
