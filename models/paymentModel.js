const mongoose = require("mongoose");
const { Schema } = mongoose;

// A payment record the teacher tracks for a student — a monthly fee, a lesson fee,
// or any labelled charge. Not a real payment gateway: it is a paid/unpaid ledger the
// teacher marks by hand and the parent can see.
const paymentSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true }, // teacher
    class: { type: Schema.Types.ObjectId, ref: "Class", default: null, index: true },
    student: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    studentName: { type: String, default: "" },
    // Optional link to a specific lesson (per-lesson fee); otherwise it's a standalone
    // charge described by `label` (e.g. "Avqust ayı").
    lesson: { type: Schema.Types.ObjectId, ref: "Lesson", default: null, index: true },
    label: { type: String, default: "" },
    amount: { type: Number, default: 0, min: 0 },
    paid: { type: Boolean, default: false, index: true },
    paidAt: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

// The teacher's ledger for a student, and the parent view (by student, newest first).
paymentSchema.index({ student: 1, deletedAt: 1, createdAt: -1 });
paymentSchema.index({ owner: 1, class: 1, deletedAt: 1 });

module.exports = mongoose.model("Payment", paymentSchema);
