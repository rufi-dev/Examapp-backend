const mongoose = require("mongoose");
const { Schema } = mongoose;

// A student's request to buy a PAID exam via manual bank transfer. When an
// admin (or the exam's owning teacher) approves it, the exam is granted to the
// student (pushed into user.exams + exam.users) and they can take it.
const examPaymentRequestSchema = Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    exam: { type: Schema.Types.ObjectId, ref: "Exam", required: true, index: true },
    // Snapshot of the exam price at request time.
    amount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["open", "done", "rejected"],
      default: "open",
      index: true,
    },
    // The student pressed "Ödədim" (I paid) — a claim, verified manually.
    paidClaimed: { type: Boolean, default: false },
    paidClaimedAt: { type: Date, default: null },
    note: { type: String, maxlength: 1000, default: "" },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// At most ONE open request per (student, exam) — pressing buy twice reuses it.
examPaymentRequestSchema.index(
  { student: 1, exam: 1 },
  { unique: true, partialFilterExpression: { status: "open" } }
);

module.exports = mongoose.model("ExamPaymentRequest", examPaymentRequestSchema);
