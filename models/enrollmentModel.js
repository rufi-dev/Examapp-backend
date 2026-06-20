const mongoose = require("mongoose");
const { Schema } = mongoose;

// A student's membership in a class. This is the unit of access: a student sees
// (and can take) a class's exams — and the category above it appears as a
// filtered folder — only via an APPROVED enrollment here.
const enrollmentSchema = Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    class: { type: Schema.Types.ObjectId, ref: "Class", required: true, index: true },
    // Denormalised so we can scope/list by teacher without a join.
    teacher: { type: Schema.Types.ObjectId, ref: "User", index: true },
    status: {
      type: String,
      enum: ["pending", "approved"],
      default: "pending",
      index: true,
    },
  },
  { timestamps: true, minimize: false }
);

// One enrollment per (student, class).
enrollmentSchema.index({ student: 1, class: 1 }, { unique: true });

module.exports = mongoose.model("Enrollment", enrollmentSchema);
