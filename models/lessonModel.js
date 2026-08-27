const mongoose = require("mongoose");
const { Schema } = mongoose;

// A scheduled lesson for a class (the tutor's calendar). Attendance hangs off it
// (attendanceModel), and per-lesson payments may reference it (paymentModel).
const lessonSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true }, // teacher
    class: { type: Schema.Types.ObjectId, ref: "Class", required: true, index: true },
    title: { type: String, default: "" },
    note: { type: String, default: "" },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, default: null },
    // Optional per-lesson fee (manat). Display only; payment tracking is paymentModel.
    price: { type: Number, default: null, min: 0 },
    // Attendance check-in. `code` is a stable per-lesson token embedded in the QR the
    // teacher displays (as a /checkin/<code> URL, so any phone camera works). `open`
    // gates whether a scan is accepted right now (teacher opens/closes it).
    attendanceCode: { type: String, default: null, index: true },
    attendanceOpen: { type: Boolean, default: false },
    // Set when this lesson belongs to a weekly-recurring series (lessonSeriesModel).
    series: { type: Schema.Types.ObjectId, ref: "LessonSeries", default: null, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, minimize: false }
);

// The calendar query: a class's lessons in a time range, newest-time first.
lessonSchema.index({ class: 1, deletedAt: 1, startAt: -1 });
lessonSchema.index({ owner: 1, deletedAt: 1, startAt: -1 });

module.exports = mongoose.model("Lesson", lessonSchema);
