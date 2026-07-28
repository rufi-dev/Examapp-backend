/*
 * Teacher Success Journey — shared deterministic seed used by BOTH the local
 * preview (journeyPreview.cjs) and the disposable E2E launcher. Seeds an admin +
 * pending-Spark + approved-Momentum + Impact teacher with REAL source activity
 * (published exams + versions, completed attempts across distinct days, useful
 * materials) and a genuine XP ledger (awarded through the real service, so the
 * projected state / feed / missions / achievements are all self-consistent).
 * Idempotent-ish for a fresh throwaway DB. Requires an ALREADY-CONNECTED mongoose.
 */
const mongoose = require("mongoose");

const PASSWORD = "PreviewPass1"; // letter + digit, >= 8 (passes validatePassword)

async function seedJourney({ frontendUrl } = {}) {
  const User = require("../models/userModel");
  const Exam = require("../models/examModel");
  const ExamVersion = require("../models/examVersionModel");
  const Result = require("../models/resultModel");
  const Material = require("../models/materialModel");
  const TeacherReferral = require("../models/teacherReferralModel");
  const AiCreditPeriod = require("../models/aiCreditPeriodModel");
  const referralSvc = require("../services/teacherReferralService");
  const xpSvc = require("../services/teacherXpService");
  const { utcMonthKey } = require("../services/aiCreditService");
  const { allowanceFor } = require("../config/teacherSuccess/allowances");
  const { ObjectId } = mongoose.Types;
  const period = utcMonthKey(new Date());
  const now = Date.now();
  const daysAgo = (d) => new Date(now - d * 86400000);

  const mk = (over) => User.create({ name: over.name, email: over.email, password: PASSWORD, phone: "+994500000000", isVerified: true, journeyWelcomeSeenAt: over.role === "teacher" ? daysAgo(2) : null, ...over });
  const admin = await mk({ name: "Preview Admin", email: "admin@preview.local", role: "admin" });
  // Auto-approval: a self-registered teacher is approved immediately, so the seeded
  // Spark teacher is APPROVED (Spark is the Journey LEVEL, independent of approval).
  const spark = await mk({ name: "Spark Teacher", email: "spark@preview.local", role: "teacher", teacherApproval: "approved", teacherLevel: "spark", referralCode: referralSvc.generateCode() });
  const momentum = await mk({ name: "Momentum Teacher", email: "momentum@preview.local", role: "teacher", teacherApproval: "approved", teacherLevel: "momentum", referralCode: referralSvc.generateCode() });
  const impact = await mk({ name: "Impact Teacher", email: "impact@preview.local", role: "teacher", teacherApproval: "approved", teacherLevel: "impact", referralCode: referralSvc.generateCode() });
  // A brand-new teacher whose one-time onboarding is NOT completed (journeyWelcomeSeenAt
  // null) — logging in as this account lands on the cinematic /teacher-journey/welcome
  // intro (the onboarding gate), so the flow can be reviewed end-to-end.
  await mk({ name: "New Teacher", email: "newteacher@preview.local", role: "teacher", teacherApproval: "approved", teacherLevel: "spark", journeyWelcomeSeenAt: null, referralCode: referralSvc.generateCode() });
  // A pool of real student accounts (uniqueStudents counts role==="student").
  const students = [];
  for (let i = 0; i < 12; i++) students.push(await mk({ name: `Student ${i + 1}`, email: `student${i + 1}@preview.local`, role: "student" }));
  const [s1, s2] = students;

  // ── Publish N exams for a teacher (each with a real active version of `qs`
  //    questions), award the publish + per-question XP through the real service. ──
  async function publishExams(teacher, count, qs, atBase) {
    const exams = [];
    for (let e = 0; e < count; e++) {
      // ExamVersion is immutable once created, so the exam must exist FIRST (to own the
      // version's examId); the mutable Exam then points at the version as active.
      const exam = await Exam.create({ name: `${teacher.name} Exam ${e + 1}`, owner: teacher._id, duration: 3600, price: 0, totalMarks: 100, passingMarks: 50, mode: "structured", class: new ObjectId(), typePoints: { Cm: 50 }, activeVersionId: null });
      const version = await ExamVersion.create({
        examId: exam._id, versionNumber: 1, contentHash: `seed-${teacher._id}-${e}-${qs}`,
        author: teacher._id, publishedAt: daysAgo(atBase - e), state: "published",
        questions: Array.from({ length: qs }, (_, i) => ({ text: `Q${i + 1}`, type: "single", choices: [], correct: [0] })),
      });
      await Exam.updateOne({ _id: exam._id }, { $set: { activeVersionId: version._id } });
      await xpSvc.award({ teacherId: teacher._id, type: e === 0 ? "exam.publish.first" : "exam.publish", sourceId: String(exam._id), at: daysAgo(atBase - e) });
      for (let i = 0; i < qs; i++) await xpSvc.award({ teacherId: teacher._id, type: "question.published", sourceId: `${exam._id}:q${i}`, at: daysAgo(atBase - e) });
      exams.push(exam);
    }
    return exams;
  }

  // ── Complete `count` attempts spread across `dayCount` distinct days by the first
  //    `studentCount` students; award attempt + first-completion XP + active-day XP. ──
  async function completeAttempts(teacher, exams, studentCount, count, dayCount) {
    const firstSeen = new Set();
    const activeDays = new Set();
    for (let a = 0; a < count; a++) {
      const stu = students[a % studentCount];
      const exam = exams[a % exams.length];
      const day = a % dayCount + 1;
      const at = daysAgo(day);
      const attemptId = new ObjectId();
      await Result.create({ userId: stu._id, examId: exam._id, attempts: 1, earnPoints: 55 + (a % 40), attemptId, createdAt: at });
      await xpSvc.award({ teacherId: teacher._id, type: "attempt.completed", sourceId: `att:${attemptId}`, at });
      if (!firstSeen.has(String(stu._id))) { firstSeen.add(String(stu._id)); await xpSvc.award({ teacherId: teacher._id, type: "student.first_completion", sourceId: `stu:${stu._id}`, at }); }
      const dk = xpSvc.utcDayKey(at);
      if (!activeDays.has(dk)) { activeDays.add(dk); await xpSvc.award({ teacherId: teacher._id, type: "active.day", sourceId: `day:${dk}`, at }); }
    }
  }

  // ── A useful material (>=3 distinct viewers → qualified) + its XP + achievement. ──
  async function usefulMaterial(teacher, viewers) {
    const m = await Material.create({ title: `${teacher.name} Study Notes`, kind: "pdf", fileName: `notes-${teacher._id}.pdf`, owner: teacher._id, ownerName: teacher.name, viewers: viewers.map((v) => v._id) });
    await xpSvc.award({ teacherId: teacher._id, type: "material.uploaded", sourceId: `mat:${m._id}`, at: daysAgo(4) });
    if (viewers.length >= 3) await xpSvc.award({ teacherId: teacher._id, type: "material.qualified_use", sourceId: `matq:${m._id}`, at: daysAgo(3) });
    return m;
  }

  // ── SPARK: meets the five spark→momentum activity requirements; XP topped over the
  //    500 gate via ONE audited admin correction (also showcases that feature in the
  //    feed) so the flagship account renders the amber "ready for review" state. ──
  const sparkExams = await publishExams(spark, 3, 20, 8); // 3 exams · 60 questions
  await completeAttempts(spark, sparkExams, 10, 20, 6);   // 10 students · 20 attempts · 6 days
  await usefulMaterial(spark, [students[0], students[1], students[2]]);
  const sparkState = await xpSvc.state(spark._id);
  const gap = 520 - (sparkState.lifetimeXp || 0);
  if (gap > 0) await xpSvc.adminCorrect({ teacherId: spark._id, amount: gap, reason: "Preview seed — showcase ready-for-review", actor: admin._id, correctionId: `seed-spark-${spark._id}` });

  // ── MOMENTUM: solid progress toward Impact + one qualified referral (bonus met). ──
  const momExams = await publishExams(momentum, 5, 22, 20); // 5 exams · 110 questions
  await completeAttempts(momentum, momExams, 12, 40, 12);    // 12 students · 40 attempts
  await usefulMaterial(momentum, students.slice(0, 5));

  // ── IMPACT: top level — representative history, nothing to unlock. ──
  const impExams = await publishExams(impact, 6, 24, 30);
  await completeAttempts(impact, impExams, 12, 30, 10);

  // Qualified (rewardable) referrals. The browser matrix runs the SAME "admin rewards
  // a referral" scenario on chromium, firefox AND webkit sequentially against this one
  // shared DB, and rewarding consumes a row — so seed several DISTINCT rewardable
  // referrers (one per browser project, plus headroom).
  await TeacherReferral.create({ referrerId: momentum._id, refereeId: new ObjectId(), code: momentum.referralCode, state: "qualified", qualifiedAt: new Date() });
  await xpSvc.award({ teacherId: momentum._id, type: "referral.qualified", sourceId: `ref:${momentum._id}:seed`, at: daysAgo(5) });
  for (let i = 0; i < 4; i++) {
    const r = await mk({ name: `Referral Teacher ${i}`, email: `refteacher${i}@preview.local`, role: "teacher", teacherApproval: "approved", teacherLevel: "momentum", referralCode: referralSvc.generateCode() });
    await TeacherReferral.create({ referrerId: r._id, refereeId: new ObjectId(), code: r.referralCode, state: "qualified", qualifiedAt: new Date() });
  }

  // Representative AI balances per level.
  const bal = (t, level, used) => AiCreditPeriod.updateOne({ teacherId: t._id, periodMonthUtc: period }, { $set: { teacherId: t._id, periodMonthUtc: period, baseAllowance: allowanceFor(level), used, reserved: 0, tempGranted: 0, levelAtOpen: level } }, { upsert: true });
  await bal(spark, "spark", 28);
  await bal(momentum, "momentum", 50);
  await bal(impact, "impact", 50);

  return { password: PASSWORD, frontendUrl, users: { admin, spark, momentum, impact, s1, s2 } };
}

module.exports = { seedJourney, PASSWORD };
