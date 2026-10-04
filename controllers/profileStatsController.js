const asyncHandler = require("express-async-handler");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const Exam = require("../models/examModel");
const Result = require("../models/resultModel");
const Assignment = require("../models/assignmentModel");
const Submission = require("../models/submissionModel");
const Lesson = require("../models/lessonModel");
const Attendance = require("../models/attendanceModel");
const Material = require("../models/materialModel");
const ParentLink = require("../models/parentLinkModel");
const { hasTeacherCapability } = require("../services/teacherCapability");

/*
 * What a person has actually done on Examopia, for their own profile page: the
 * numbers that describe them (a teacher's classes, students and exams; a
 * student's exams, scores and homework) and a year of activity, day by day.
 *
 * Only ever about the signed-in user, and only counts and their own exam
 * names, so nothing here reaches beyond what they can already see elsewhere.
 */

// Days are Baku days (UTC+4, no daylight saving), so a lesson at 01:00 local
// time lands on the day the teacher remembers it.
const TZ = "+04:00";
// A year of weeks plus the partial week at either end.
const WINDOW_DAYS = 372;

const dayKey = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: `$${field}`, timezone: TZ } });

// How many of a thing happened on each day of the window, as [{ _id: day, n }].
const perDay = (Model, match, field, from, to) =>
  Model.aggregate([
    { $match: { ...match, [field]: { $gte: from, $lte: to } } },
    { $group: { _id: dayKey(field), n: { $sum: 1 } } },
  ]);

// Folds { kind: [{ _id: day, n }] } into { day: { kind: n } }.
const foldDays = (byKind) => {
  const days = {};
  for (const [kind, rows] of Object.entries(byKind)) {
    for (const { _id, n } of rows) {
      if (!_id || !n) continue;
      (days[_id] = days[_id] || {})[kind] = n;
    }
  }
  return days;
};

const GRADED = { terminated: { $ne: true }, earnPoints: { $ne: null } };

// Percent of the exam's total, for each graded result in the match.
const scoredResults = (match) => [
  { $match: { ...match, ...GRADED } },
  { $lookup: { from: "exams", localField: "examId", foreignField: "_id", as: "_exam" } },
  { $unwind: "$_exam" },
  { $match: { "_exam.totalMarks": { $gt: 0 } } },
  { $addFields: { pct: { $multiply: [{ $divide: ["$earnPoints", "$_exam.totalMarks"] }, 100] } } },
];

const clampPct = (v) => (v == null || !Number.isFinite(v) ? null : Math.max(0, Math.min(100, Math.round(v))));

async function teacherStats(userId, from, to) {
  const now = to;
  const classIds = (await Class.find({ owner: userId, deletedAt: null }).select("_id").lean()).map((c) => c._id);
  const exams = await Exam.find({ owner: userId, deletedAt: null }).select("_id name").lean();
  const examIds = exams.map((e) => e._id);

  const [students, attempts, assignments, reviewed, lessons, materials, scoreAgg, topExam] = await Promise.all([
    classIds.length ? Enrollment.distinct("student", { class: { $in: classIds }, status: "approved" }) : [],
    examIds.length ? Result.countDocuments({ examId: { $in: examIds } }) : 0,
    Assignment.countDocuments({ owner: userId, deletedAt: null }),
    Submission.countDocuments({ gradedBy: userId, gradedAt: { $ne: null } }),
    Lesson.countDocuments({ owner: userId, deletedAt: null, startAt: { $lte: now } }),
    Material.countDocuments({ owner: userId }),
    examIds.length
      ? Result.aggregate([...scoredResults({ examId: { $in: examIds } }), { $group: { _id: null, avg: { $avg: "$pct" }, n: { $sum: 1 } } }])
      : [],
    examIds.length
      ? Result.aggregate([
          // By how many different students sat it, not by attempts.
          { $match: { examId: { $in: examIds } } },
          { $group: { _id: { exam: "$examId", user: "$userId" } } },
          { $group: { _id: "$_id.exam", n: { $sum: 1 } } },
          { $sort: { n: -1, _id: -1 } },
          { $limit: 1 },
        ])
      : [],
  ]);

  const [examDays, homeworkDays, reviewDays, lessonDays, materialDays] = await Promise.all([
    perDay(Exam, { owner: userId, deletedAt: null }, "createdAt", from, to),
    perDay(Assignment, { owner: userId, deletedAt: null }, "createdAt", from, to),
    perDay(Submission, { gradedBy: userId }, "gradedAt", from, to),
    perDay(Lesson, { owner: userId, deletedAt: null }, "startAt", from, to),
    perDay(Material, { owner: userId }, "createdAt", from, to),
  ]);

  const top = topExam[0];
  const topName = top ? exams.find((e) => String(e._id) === String(top._id))?.name : null;

  return {
    kind: "teacher",
    totals: {
      classes: classIds.length,
      students: students.length,
      exams: exams.length,
      attempts,
      averagePct: clampPct(scoreAgg[0]?.avg),
      assignments,
      reviewed,
      lessons,
      materials,
    },
    highlight: top && topName ? { name: topName, count: top.n } : null,
    days: foldDays({ exam: examDays, homework: homeworkDays, review: reviewDays, lesson: lessonDays, material: materialDays }),
  };
}

async function studentStats(userId, from, to) {
  const [examIds, attempts, classes, homework, attendance, scoreAgg, bestRows] = await Promise.all([
    Result.distinct("examId", { userId }),
    Result.countDocuments({ userId }),
    Enrollment.countDocuments({ student: userId, status: "approved" }),
    Submission.countDocuments({ student: userId }),
    Attendance.aggregate([{ $match: { student: userId } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    Result.aggregate([...scoredResults({ userId }), { $group: { _id: null, avg: { $avg: "$pct" }, best: { $max: "$pct" }, n: { $sum: 1 } } }]),
    Result.aggregate([
      ...scoredResults({ userId }),
      { $sort: { pct: -1, createdAt: -1 } },
      { $limit: 1 },
      { $project: { pct: 1, createdAt: 1, name: "$_exam.name" } },
    ]),
  ]);

  const [examDays, homeworkDays, lessonDays] = await Promise.all([
    perDay(Result, { userId }, "createdAt", from, to),
    perDay(Submission, { student: userId }, "submittedAt", from, to),
    perDay(Attendance, { student: userId, status: { $in: ["present", "late"] } }, "at", from, to),
  ]);

  const seen = Object.fromEntries(attendance.map((a) => [a._id, a.n]));
  const marked = (seen.present || 0) + (seen.late || 0) + (seen.absent || 0);
  const best = bestRows[0];

  return {
    kind: "student",
    totals: {
      exams: examIds.length,
      attempts,
      averagePct: clampPct(scoreAgg[0]?.avg),
      bestPct: clampPct(scoreAgg[0]?.best),
      classes,
      homework,
      lessons: (seen.present || 0) + (seen.late || 0),
      attendancePct: marked ? Math.round((((seen.present || 0) + (seen.late || 0)) / marked) * 100) : null,
    },
    highlight: best ? { name: best.name || "", pct: clampPct(best.pct), at: best.createdAt } : null,
    days: foldDays({ exam: examDays, homework: homeworkDays, lesson: lessonDays }),
  };
}

async function parentStats(userId) {
  const children = await ParentLink.countDocuments({ parent: userId, status: "approved" });
  return { kind: "parent", totals: { children }, highlight: null, days: {} };
}

const getProfileStats = asyncHandler(async (req, res) => {
  const user = req.user;
  const to = new Date();
  const from = new Date(to.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  let stats;
  if (hasTeacherCapability(user)) stats = await teacherStats(user._id, from, to);
  else if (user.role === "parent") stats = await parentStats(user._id);
  else stats = await studentStats(user._id, from, to);

  res.status(200).json({
    ...stats,
    since: user.createdAt || null,
    lastActiveAt: user.lastActiveAt || null,
    today: new Date(to.getTime() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10),
  });
});

module.exports = { getProfileStats, foldDays, WINDOW_DAYS };
