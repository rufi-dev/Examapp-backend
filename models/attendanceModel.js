const mongoose = require("mongoose");
const { Schema } = mongoose;

// One student's attendance for one lesson. Created by a QR self-check-in or set
// manually by the teacher in the lesson roster. One row per (lesson, student).
const attendanceSchema = new Schema(
  {
    lesson: { type: Schema.Types.ObjectId, ref: "Lesson", required: true, index: true },
    class: { type: Schema.Types.ObjectId, ref: "Class", required: true, index: true }, // denormalised
    student: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    studentName: { type: String, default: "" },
    status: { type: String, enum: ["present", "late", "absent"], default: "present", index: true },
    method: { type: String, enum: ["qr", "manual"], default: "qr" },
    at: { type: Date, default: Date.now }, // when checked in / marked
  },
  { timestamps: true, minimize: false }
);

attendanceSchema.index({ lesson: 1, student: 1 }, { unique: true });
// A student's attendance history across lessons (parent view).
attendanceSchema.index({ student: 1, at: -1 });

module.exports = mongoose.model("Attendance", attendanceSchema);
