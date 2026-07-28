const mongoose = require("mongoose");
const { Schema } = mongoose;

const classSchema = Schema(
  {
    // Free-text class label (e.g. "11-ci sinif", "Abituriyent qrupu", "9A").
    name: {
      type: String,
      trim: true,
    },
    // Optional banner the teacher picks when creating the class. Display-only
    // (a hosted Cloudinary URL), so it is safe to send to students.
    coverImage: {
      type: String,
      default: "",
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
    // Visibility. false = PUBLIC: every signed-in user sees the class and can
    // take its free exams (no code/enrollment needed). true = CODE-ONLY: hidden
    // unless the student joined with the code. Intentionally has NO default, so
    // existing classes (field absent) stay code-only — ONLY the strict value
    // `false`, written by new/edited classes, makes a class public.
    requireCode: {
      type: Boolean,
    },
    // false = a join is a PENDING request the teacher approves; true = students
    // who enter the code are enrolled immediately.
    autoApprove: {
      type: Boolean,
      default: false,
    },
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    // Scalar summary only. The authoritative relationship is Exam.class; the
    // former unbounded `exams[]` compatibility array is removed by migration.
    examCount: {
      type: Number,
      default: 0,
      min: 0,
    },
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
