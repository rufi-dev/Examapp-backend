const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * Teacher Success Journey — one BOUNDED idempotent activity aggregate per
 * teacher per UTC day (ADR §6, §11.2). Unique {teacherId, date}. Counts only
 * meaningful SERVER-AUTHORITATIVE outcomes (published exams, completed attempts
 * from real students) — never page views, clicks, drafts, or duplicated events.
 *
 * `date` is the UTC calendar day as "YYYY-MM-DD" so distinct active days/weeks
 * are countable directly. Counters are recomputed idempotently by the activity
 * service from the source-of-truth (Result/Exam/Attempt), so reprocessing a day
 * yields the same values — a retry storm cannot inflate progress.
 *
 * autoIndex/autoCreate off — the Journey migration owns the collection + indexes.
 */
const teacherActivityDailySchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // UTC day
    publishedExams: { type: Number, default: 0, min: 0 },
    completedAttempts: { type: Number, default: 0, min: 0 },
    distinctStudents: { type: Number, default: 0, min: 0 },
    // True once ANY qualifying outcome happened this day — the signal for
    // "distinct active day" counting (kept explicit so an all-zero day never
    // counts as active).
    active: { type: Boolean, default: false },
  },
  { timestamps: true, minimize: false, autoIndex: false, autoCreate: false, collection: "teacher_activity_daily" }
);

// Migration-owned; mirrored in helper/teacherSuccessIndexes.js.
teacherActivityDailySchema.index({ teacherId: 1, date: 1 }, { name: "uniq_teacher_day", unique: true });

module.exports = mongoose.model("TeacherActivityDaily", teacherActivityDailySchema);
