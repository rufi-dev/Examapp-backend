const mongoose = require("mongoose");
const { Schema } = mongoose;

// A server-tracked exam attempt. The server owns startedAt/expiresAt so the
// timer can't be tampered with client-side.
const attemptSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    examId: { type: Schema.Types.ObjectId, ref: "Exam", required: true },
    startedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    submitted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

attemptSchema.index({ userId: 1, examId: 1 });

module.exports = mongoose.model("Attempt", attemptSchema);
