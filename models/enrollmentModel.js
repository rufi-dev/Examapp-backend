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
    /*
     * Set when a student was moved back to the waitlist because the TEACHER's plan
     * no longer covers them — not because the teacher rejected them. Two different
     * things that would otherwise look identical in the UI, and only one of them is
     * the teacher's decision.
     *
     * `default: undefined` so no existing enrollment is rewritten. Declared here
     * because Mongoose strict mode drops undeclared keys before the write reaches
     * Mongo — silently, which is how the question flags were lost.
     */
    frozenByPlan: { type: Boolean, default: undefined },
  },
  { timestamps: true, minimize: false }
);

// One enrollment per (student, class).
enrollmentSchema.index({ student: 1, class: 1 }, { unique: true });

module.exports = mongoose.model("Enrollment", enrollmentSchema);
