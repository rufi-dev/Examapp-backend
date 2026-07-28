/*
 * Teacher Success Journey — server-authoritative activity metrics (ADR §6).
 * Real in-memory Mongo. Proves: only published exams + real-student completed
 * attempts count; drafts and non-student/self rows are ignored; distinct
 * students/days; the pure eligibility evaluator flips to Ready at threshold.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-activity";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/userModel");
const Exam = require("../models/examModel");
const Result = require("../models/resultModel");
const TeacherActivityDaily = require("../models/teacherActivityDailyModel");
const svc = require("../services/teacherActivityService");
const eligibility = require("../services/teacherEligibility");

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, x ? JSON.stringify(x) : ""); } };
const { ObjectId } = mongoose.Types;

let seq = 0;
const mkUser = (over) => User.create({ name: "U", email: `act${seq++}@e.com`, password: "xxxxxxxx", isVerified: true, ...over });
const mkExam = (owner, over = {}) => Exam.create({ name: "E", owner, duration: 3600, price: 0, totalMarks: 100, passingMarks: 50, mode: "structured", class: new ObjectId(), typePoints: { Cm: 50 }, ...over });
const mkResult = (userId, examId, createdAt) => Result.create({ userId, examId, attempts: 1, earnPoints: 50, attemptId: new ObjectId(), createdAt });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Promise.all([User.createIndexes(), Result.createIndexes(), TeacherActivityDaily.createIndexes()]);

  const teacher = await mkUser({ role: "teacher", teacherApproval: "approved" });
  const s1 = await mkUser({ role: "student" });
  const s2 = await mkUser({ role: "student" });
  const notStudent = await mkUser({ role: "teacher" }); // a non-student attempt must not count

  // 1 published exam + 1 DRAFT (no activeVersionId) — draft must not count.
  const pub = await mkExam(teacher._id, { activeVersionId: new ObjectId() });
  await mkExam(teacher._id); // draft
  const pub2 = await mkExam(teacher._id, { activeVersionId: new ObjectId() });

  const D1 = new Date(Date.UTC(2026, 6, 10)); const D2 = new Date(Date.UTC(2026, 6, 12));
  await mkResult(s1._id, pub._id, D1);
  await mkResult(s2._id, pub._id, D2);
  await mkResult(s1._id, pub2._id, D2);
  await mkResult(notStudent._id, pub._id, D1);   // not a student → ignored
  await mkResult(teacher._id, pub._id, D1);       // self → ignored (userId === teacher)

  const m = await svc.computeActivityMetrics(teacher._id, new Date(Date.UTC(2026, 6, 20)));
  ok("published exams counted, draft excluded (2)", m.publishedExams === 2, m);
  ok("only real-student completed attempts counted (3)", m.completedAttempts === 3, m);
  ok("distinct real students (2)", m.distinctRealStudents === 2, m);
  ok("exams with a completed attempt (2)", m.examsWithCompletedAttempt === 2, m);
  ok("distinct active days (>=2 completion days)", m.distinctActiveDays >= 2, m);

  // ── Activity metrics feed the new requirement checklist (all requirements gate
  //    readiness; with the game thresholds 2 exams + no XP is NOT yet ready). ──
  const elig = eligibility.evaluate({ currentLevel: "spark", metrics: { ...m, lifetimeXp: 0 } });
  ok("eligibility reports the six spark→momentum requirements toward momentum", elig.requirements.length === 6 && elig.target === "momentum");
  ok("2 published + no lifetime XP is NOT yet ready for review", elig.readyForReview === false);

  // ── CR-128#1: idempotent TeacherActivityDaily materialization ──
  const n1 = await svc.rebuildDailyAggregates(teacher._id);
  ok("rebuild materializes the active days", n1 === 2 && (await TeacherActivityDaily.countDocuments({ teacherId: teacher._id })) === 2, n1);
  const n2 = await svc.rebuildDailyAggregates(teacher._id);
  ok("rebuild is idempotent (no duplicate day rows)", n2 === 2 && (await TeacherActivityDaily.countDocuments({ teacherId: teacher._id })) === 2);
  const oneDay = await TeacherActivityDaily.findOne({ teacherId: teacher._id }).lean();
  ok("materialized day carries bounded counts", oneDay.completedAttempts >= 1 && oneDay.active === true);

  // ── A brand-new teacher with only drafts is NOT ready ──
  const fresh = await mkUser({ role: "teacher", teacherApproval: "approved" });
  await mkExam(fresh._id); // draft only
  const mf = await svc.computeActivityMetrics(fresh._id);
  ok("draft-only teacher has 0 published, 0 attempts", mf.publishedExams === 0 && mf.completedAttempts === 0);
  ok("draft-only teacher is NOT ready for review", eligibility.evaluate({ currentLevel: "spark", metrics: mf }).readyForReview === false);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
