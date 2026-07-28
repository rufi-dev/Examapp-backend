/*
 * Teacher Journey — mission progress + achievement derivation. Real in-memory Mongo.
 * Proves: missions derive from REAL committed data (classes/exams/questions/published/
 * attempts/materials); completion is stamped and stable; the onboarding chain awards
 * its bonus XP exactly once; achievements are granted from server metrics idempotently
 * and never client-claimed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-mission";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/userModel");
const ClassModel = require("../models/classModel");
const Exam = require("../models/examModel");
const ExamVersion = require("../models/examVersionModel");
const Question = require("../models/questionModel");
const Result = require("../models/resultModel");
const Material = require("../models/materialModel");
const TeacherXpEvent = require("../models/teacherXpEventModel");
const TeacherXpState = require("../models/teacherXpStateModel");
const TeacherXpOutbox = require("../models/teacherXpOutboxModel");
const TeacherMissionProgress = require("../models/teacherMissionProgressModel");
const TeacherAchievement = require("../models/teacherAchievementModel");
const missionSvc = require("../services/teacherMissionService");
const achievementSvc = require("../services/teacherAchievementService");
const xpSvc = require("../services/teacherXpService");

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, x ? JSON.stringify(x) : ""); } };
const { ObjectId } = mongoose.Types;

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Promise.all([TeacherXpEvent.createIndexes(), TeacherXpState.createIndexes(), TeacherXpOutbox.createIndexes(), TeacherMissionProgress.createIndexes(), TeacherAchievement.createIndexes()]);

  // ── a fresh teacher: everything at zero ──
  const t = await User.create({ name: "T", email: "t@x.io", password: "x", role: "teacher" });
  const empty = await missionSvc.progressFor(t._id, t);
  const emptyById = Object.fromEntries(empty.missions.map((m) => [m.id, m]));
  ok("fresh teacher: a not-yet-reached mission is locked", emptyById["material.share"].status === "locked" && emptyById["result.first"].status === "locked");
  ok("fresh teacher: no mission is falsely complete before its action", emptyById["exam.publish"].status !== "complete" && emptyById["material.share"].status !== "complete");
  ok("fresh teacher: chain not complete", empty.allComplete === false);

  // ── seed REAL data to satisfy the chain ──
  await User.updateOne({ _id: t._id }, { $set: { phone: "+994500000000" } }); // profile.complete
  await ClassModel.create({ name: "C", owner: t._id }); // class.create
  const exam = await Exam.create({ name: "E", owner: t._id, duration: 3600, price: 0, totalMarks: 100, passingMarks: 50, mode: "structured", class: new ObjectId(), typePoints: { Cm: 100 }, activeVersionId: null });
  const ver = await ExamVersion.create({ examId: exam._id, versionNumber: 1, contentHash: "h1", publishedAt: new Date(), questions: Array.from({ length: 12 }, (_, i) => ({ q: i })) });
  await Exam.updateOne({ _id: exam._id }, { $set: { activeVersionId: ver._id } });
  await Question.insertMany(Array.from({ length: 12 }, () => ({ exam: exam._id }))); // questions.ten
  const s1 = await User.create({ name: "S1", email: "s1@x.io", password: "x", role: "student" });
  await Result.create({ userId: s1._id, examId: exam._id, attempts: 1, earnPoints: 60, attemptId: new ObjectId() }); // invite + result.first
  await Material.create({ title: "M", fileName: "m.pdf", kind: "pdf", owner: t._id, viewers: [new ObjectId(), new ObjectId(), new ObjectId()] }); // material.share + useful

  const full = await missionSvc.progressFor(t._id, await User.findById(t._id));
  const byId = Object.fromEntries(full.missions.map((m) => [m.id, m]));
  ok("profile mission complete", byId["profile.complete"].status === "complete");
  ok("class mission complete", byId["class.create"].status === "complete");
  ok("questions mission shows 10/10 (capped at target)", byId["questions.ten"].progressCurrent === 10 && byId["questions.ten"].status === "complete");
  ok("publish mission complete", byId["exam.publish"].status === "complete");
  ok("result mission complete", byId["result.first"].status === "complete");
  ok("material mission complete", byId["material.share"].status === "complete");
  ok("whole onboarding chain complete", full.allComplete === true);
  ok("mission carries an honest xpReward for its action", byId["exam.publish"].xpReward === 40 && byId["result.first"].xpReward === 10);

  // ── chain bonus XP awarded exactly once ──
  ok("chain bonus (50 XP) awarded once", (await svcTotal(t._id)) === 50);
  await missionSvc.progressFor(t._id, await User.findById(t._id)); // re-run
  ok("re-running does NOT re-award the chain bonus", (await svcTotal(t._id)) === 50);
  ok("exactly one onboarding_chain ledger row", (await TeacherXpEvent.countDocuments({ teacherId: t._id, type: "mission.onboarding_chain" })) === 1);

  // ── completedAt is stable across recomputation ──
  const at1 = (await TeacherMissionProgress.findOne({ teacherId: t._id, missionId: "exam.publish" })).completedAt;
  await new Promise((r) => setTimeout(r, 10));
  await missionSvc.progressFor(t._id, await User.findById(t._id));
  const at2 = (await TeacherMissionProgress.findOne({ teacherId: t._id, missionId: "exam.publish" })).completedAt;
  ok("completedAt is stable across recomputation", +new Date(at1) === +new Date(at2));

  // ── achievements derive from metrics; idempotent grant ──
  const metrics = { publishedExams: 3, publishedQuestions: 100, uniqueStudents: 10, distinctActiveWeeks: 1, usefulMaterials: 1, qualifiedReferrals: 1, aiGenerations: 1 };
  const ach1 = await achievementSvc.evaluate(t._id, metrics);
  const earned1 = ach1.filter((a) => a.earned).map((a) => a.id).sort();
  ok("all eight achievements earned when metrics qualify", earned1.length === 8, earned1);
  ok("each earned achievement has a date", ach1.filter((a) => a.earned).every((a) => a.earnedAt));
  const ach2 = await achievementSvc.evaluate(t._id, metrics);
  ok("re-evaluate does not duplicate achievements", (await TeacherAchievement.countDocuments({ teacherId: t._id })) === 8);
  const partial = await achievementSvc.evaluate(new ObjectId(), { publishedExams: 1 });
  ok("only qualifying achievements earn (first_step at 1 exam)", partial.find((a) => a.id === "first_step").earned && !partial.find((a) => a.id === "exam_author").earned);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function svcTotal(id) { return xpSvc.total(id); }
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
