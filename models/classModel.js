const mongoose = require("mongoose");
const { Schema } = mongoose;

const classSchema = Schema(
  {
    // Free-text class label (e.g. "11-ci sinif", "Abituriyent qrupu", "9A").
    name: {
      type: String,
      trim: true,
    },
    // Legacy numeric level — kept for old classes; new ones use `name`.
    level: {
      type: Number,
      required: false,
      unique: false,
    },
    // The teacher/admin who owns this class. Students only see it once enrolled.
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    // Short code students enter to join this class.
    joinCode: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    // false = a join is a PENDING request the teacher approves; true = students
    // who enter the code are enrolled immediately.
    autoApprove: {
      type: Boolean,
      default: false,
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
