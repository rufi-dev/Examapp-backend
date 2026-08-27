const mongoose = require("mongoose");
const { Schema } = mongoose;

// A monthly recurring fee for one student in a class. A daily sweep
// (paymentController.runRecurringSweep) materialises a real Payment for the current
// month once per period, so the teacher's ledger and the parent view fill in
// automatically. Deleting/deactivating stops future generation but keeps past Payments.
const recurringPaymentSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true }, // teacher
    class: { type: Schema.Types.ObjectId, ref: "Class", required: true, index: true },
    student: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    studentName: { type: String, default: "" },
    label: { type: String, default: "" }, // blank => "<Month> ayı" at generation time
    amount: { type: Number, default: 0, min: 0 },
    dayOfMonth: { type: Number, default: 1, min: 1, max: 28 }, // due day; capped at 28 (every month has it)
    active: { type: Boolean, default: true, index: true },
    // "YYYY-MM" of the last period a Payment was generated — the idempotency key so a
    // daily sweep never double-charges within a month.
    lastGeneratedPeriod: { type: String, default: null },
  },
  { timestamps: true, minimize: false }
);

// One active plan per (student, class) — a teacher sets a single monthly fee per class.
recurringPaymentSchema.index({ student: 1, class: 1 }, { unique: true });
recurringPaymentSchema.index({ active: 1 });

module.exports = mongoose.model("RecurringPayment", recurringPaymentSchema);
