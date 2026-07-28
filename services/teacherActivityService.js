/*
 * Teacher Success Journey — server-authoritative activity metrics (ADR §6).
 *
 * Recompute from the source of truth (Exam + Result), so the numbers are
 * inherently idempotent and DRAFT-PROOF: only PUBLISHED exams (activeVersionId
 * set) and REAL completed attempts (Result rows, one per attemptId, from real
 * student accounts) count. Duplicate/retried events cannot inflate anything
 * because we count DISTINCT persisted rows, never events. Self-actions are
 * excluded (the teacher's own id is filtered out).
 */
const mongoose = require("mongoose");
const Exam = require("../models/examModel");
const ExamVersion = require("../models/examVersionModel");
const Result = require("../models/resultModel");
const User = require("../models/userModel");
const Material = require("../models/materialModel");
const AiCreditLedger = require("../models/aiCreditLedgerModel");
const TeacherActivityDaily = require("../models/teacherActivityDailyModel");
const { MATERIAL_QUALIFIED_USES } = require("../config/teacherSuccess/xp");

const oid = (id) => (typeof id === "string" ? new mongoose.Types.ObjectId(id) : id);

// Total questions in every published exam's ACTIVE immutable version (bounded).
async function publishedQuestionCount(teacherId) {
  const activeVersionIds = await Exam.find({ owner: teacherId, activeVersionId: { $ne: null } }).distinct("activeVersionId");
  if (!activeVersionIds.length) return 0;
  const [row] = await ExamVersion.aggregate([
    { $match: { _id: { $in: activeVersionIds } } },
    { $project: { n: { $size: { $ifNull: ["$questions", []] } } } },
    { $group: { _id: null, total: { $sum: "$n" } } },
  ]);
  return row ? row.total : 0;
}

// Uploaded material count + "useful" count (>= MATERIAL_QUALIFIED_USES distinct student
// viewers, recorded idempotently on real in-app material access).
async function materialMetrics(teacherId) {
  const [row] = await Material.aggregate([
    { $match: { owner: oid(teacherId) } },
    { $project: { viewers: { $size: { $ifNull: ["$viewers", []] } } } },
    { $group: { _id: null, uploaded: { $sum: 1 }, useful: { $sum: { $cond: [{ $gte: ["$viewers", MATERIAL_QUALIFIED_USES] }, 1, 0] } } } },
  ]);
  return row ? { materialsUploaded: row.uploaded, usefulMaterials: row.useful } : { materialsUploaded: 0, usefulMaterials: 0 };
}

// How many genuine AI generations the teacher has committed (for the AI achievement).
async function aiGenerationCount(teacherId) {
  return AiCreditLedger.countDocuments({ teacherId, kind: "commit", operation: { $in: ["ai.generate.questions", "ai.extract.questions"] } });
}

const dayKey = (d) => new Date(d).toISOString().slice(0, 10); // UTC YYYY-MM-DD
function isoWeekKey(d) {
  const dt = new Date(Date.UTC(new Date(d).getUTCFullYear(), new Date(d).getUTCMonth(), new Date(d).getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const EMPTY = { publishedExams: 0, publishedQuestions: 0, completedAttempts: 0, distinctRealStudents: 0, uniqueStudents: 0, examsWithCompletedAttempt: 0, distinctActiveDays: 0, distinctActiveWeeks: 0, organicCompletedAttempts: 0, materialsUploaded: 0, usefulMaterials: 0 };

/*
 * CR-128#2/#3: BOUNDED, server-authoritative metrics computed with DB
 * aggregation — never loads every historical exam/result into app memory.
 * Counts DISTINCT official attemptIds (one completed attempt per attemptId),
 * DISTINCT real students, exams-with-a-completion, and applies the EXACT rolling
 * 60-day boundary for distinct active weeks.
 */
async function computeActivityMetrics(teacherId, now = new Date()) {
  const publishedExams = await Exam.countDocuments({ owner: teacherId, activeVersionId: { $ne: null } });
  const publishedQuestions = await publishedQuestionCount(teacherId);
  const materials = await materialMetrics(teacherId);
  const ownedIds = await Exam.find({ owner: teacherId }).distinct("_id"); // bounded per teacher
  if (!ownedIds.length) return { ...EMPTY, publishedExams, publishedQuestions, ...materials };

  // Real student ids among those who attempted the teacher's exams (bounded).
  const attemptStudentIds = await Result.distinct("userId", { examId: { $in: ownedIds }, userId: { $ne: teacherId } });
  const realStudentIds = attemptStudentIds.length
    ? await User.find({ _id: { $in: attemptStudentIds }, role: "student" }).distinct("_id")
    : [];
  if (!realStudentIds.length) {
    // Still count publish days for the distinct-active-days signal.
    const pubDays = await publishDays(teacherId);
    return { ...EMPTY, publishedExams, publishedQuestions, ...materials, distinctActiveDays: pubDays.length };
  }

  const windowStart = new Date(now.getTime() - 60 * 86400000);
  const [agg] = await Result.aggregate([
    { $match: { examId: { $in: ownedIds }, userId: { $in: realStudentIds }, attemptId: { $exists: true } } },
    { $group: { _id: "$attemptId", userId: { $first: "$userId" }, examId: { $first: "$examId" }, createdAt: { $first: "$createdAt" } } },
    { $facet: {
      total: [{ $count: "n" }],
      students: [{ $group: { _id: "$userId" } }, { $count: "n" }],
      exams: [{ $group: { _id: "$examId" } }, { $count: "n" }],
      days: [{ $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } } } }],
      weeks: [{ $match: { createdAt: { $gte: windowStart } } }, { $group: { _id: { y: { $isoWeekYear: "$createdAt" }, w: { $isoWeek: "$createdAt" } } } }, { $count: "n" }],
    } },
  ]);
  const first = (a) => (a && a.length ? a[0].n : 0);
  const completedAttempts = first(agg.total);
  const completionDays = new Set((agg.days || []).map((d) => d._id));
  for (const d of await publishDays(teacherId)) completionDays.add(d);

  const distinctRealStudents = first(agg.students);
  return {
    publishedExams,
    publishedQuestions,
    completedAttempts,
    distinctRealStudents,
    uniqueStudents: distinctRealStudents, // game-spec name for the same metric
    examsWithCompletedAttempt: first(agg.exams),
    distinctActiveDays: completionDays.size,
    distinctActiveWeeks: first(agg.weeks),
    organicCompletedAttempts: completedAttempts,
    ...materials,
  };
}

/*
 * The UNIFIED server-authoritative metrics an eligibility / mission / achievement /
 * controller read needs: activity + lifetime XP + qualified referrals + AI generations.
 * All draft/self/duplicate-proof and computed from the source of truth.
 */
async function metricsFor(teacherId, now = new Date()) {
  const activity = await computeActivityMetrics(teacherId, now);
  // Lazy requires avoid a config/require cycle at module load.
  const xpSvc = require("./teacherXpService");
  const referralSvc = require("./teacherReferralService");
  const lifetimeXp = await xpSvc.total(teacherId).catch(() => 0);
  const qualifiedReferrals = await referralSvc.qualifiedCount(teacherId).catch(() => 0);
  const aiGenerations = await aiGenerationCount(teacherId).catch(() => 0);
  return { ...activity, lifetimeXp, qualifiedReferrals, aiGenerations };
}

// Distinct UTC day strings on which the teacher PUBLISHED an exam (bounded).
async function publishDays(teacherId) {
  const rows = await Exam.aggregate([
    { $match: { owner: typeof teacherId === "string" ? new (require("mongoose").Types.ObjectId)(teacherId) : teacherId, activeVersionId: { $ne: null } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } } } },
  ]);
  return rows.map((r) => r._id);
}

/*
 * CR-128#1: bounded, IDEMPOTENT materialization of the daily aggregate. Recompute
 * per-day counts from the source and upsert one row per {teacherId, date}
 * (unique). Re-running sets the same absolute values — a retry/duplicate event
 * can never inflate progress. Returns the number of active days materialized.
 * This is the authoritative repair/recompute command's core.
 */
async function rebuildDailyAggregates(teacherId) {
  const ownedIds = await Exam.find({ owner: teacherId }).distinct("_id");
  if (!ownedIds.length) return 0;
  const attemptStudentIds = await Result.distinct("userId", { examId: { $in: ownedIds }, userId: { $ne: teacherId } });
  const realStudentIds = attemptStudentIds.length ? await User.find({ _id: { $in: attemptStudentIds }, role: "student" }).distinct("_id") : [];
  if (!realStudentIds.length) return 0;
  const perDay = await Result.aggregate([
    { $match: { examId: { $in: ownedIds }, userId: { $in: realStudentIds }, attemptId: { $exists: true } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } }, attempts: { $addToSet: "$attemptId" }, students: { $addToSet: "$userId" } } },
  ]);
  for (const d of perDay) {
    await TeacherActivityDaily.updateOne(
      { teacherId, date: d._id },
      { $set: { completedAttempts: d.attempts.length, distinctStudents: d.students.length, active: true } },
      { upsert: true }
    );
  }
  return perDay.length;
}

module.exports = { computeActivityMetrics, metricsFor, publishedQuestionCount, materialMetrics, aiGenerationCount, rebuildDailyAggregates, dayKey, isoWeekKey };
