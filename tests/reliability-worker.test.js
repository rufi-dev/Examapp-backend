"use strict";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Attempt = require("../models/attemptModel");
const Result = require("../models/resultModel");
const Exam = require("../models/examModel");
const User = require("../models/userModel");
const Question = require("../models/questionModel");
const { finalizeExpiredAttempts } = require("../controllers/quizController");
const {
  runDueExamReports,
  claimDueExam,
  completeClaim,
  LEASE_MS,
} = require("../jobs/examReports");
const { SPECS } = require("../helper/reliabilityIndexes");

let passed = 0;
let failed = 0;
function ok(label, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

async function makeScorableAttempt(now) {
  const user = await User.create({
    name: "Worker student",
    email: `worker-${new mongoose.Types.ObjectId()}@example.com`,
    password: "Password1",
  });
  const exam = await Exam.create({
    name: "Worker exam",
    owner: user._id,
    duration: 600,
    price: 0,
    totalMarks: 100,
    passingMarks: 50,
    class: new mongoose.Types.ObjectId(),
    endDate: new Date(now.getTime() - 120_000),
  });
  const question = await Question.create({
    exam: exam._id,
    correctAnswers: [
      { type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] },
    ],
  });
  await Exam.updateOne({ _id: exam._id }, { $set: { questions: question._id } });
  const attempt = await Attempt.create({
    userId: user._id,
    examId: exam._id,
    startedAt: new Date(now.getTime() - 600_000),
    expiresAt: new Date(now.getTime() - 120_000),
    answers: [{ type: "Cm", answer: 0 }],
  });
  return { user, exam, attempt };
}

async function main() {
  process.env.FINALIZE_GRACE_MS = "0";
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  try {
    await Attempt.createIndexes();
    await Result.createIndexes();
    await Exam.createIndexes();
    const now = new Date();

    const reportExam = await Exam.create({
      name: "Due report",
      owner: new mongoose.Types.ObjectId(),
      duration: 600,
      price: 0,
      totalMarks: 100,
      passingMarks: 50,
      class: new mongoose.Types.ObjectId(),
      endDate: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
    });
    const [workerA, workerB] = await Promise.all([
      runDueExamReports({ workerId: "report-a", now, enabled: true, max: 1 }),
      runDueExamReports({ workerId: "report-b", now, enabled: true, max: 1 }),
    ]);
    ok("two report workers claim one logical job",
      workerA.claimed + workerB.claimed === 1);
    ok("the one report job completes once",
      workerA.completed + workerB.completed === 1 &&
      !!(await Exam.findById(reportExam._id)).reportSentAt);

    const staleExam = await Exam.create({
      name: "Stale lease",
      owner: new mongoose.Types.ObjectId(),
      duration: 600,
      price: 0,
      totalMarks: 100,
      passingMarks: 50,
      class: new mongoose.Types.ObjectId(),
      endDate: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      reportLeaseOwner: "dead-worker",
      reportLeaseUntil: new Date(now.getTime() - 1),
    });
    const stale = await runDueExamReports({
      workerId: "report-restart",
      now,
      enabled: true,
      max: 1,
    });
    ok("stale report lease is reclaimed after process loss",
      stale.claimed === 1 && stale.completed === 1 &&
      !!(await Exam.findById(staleExam._id)).reportSentAt);

    const fencedExam = await Exam.create({
      name: "Lease owner fence",
      owner: new mongoose.Types.ObjectId(),
      duration: 600,
      price: 0,
      totalMarks: 100,
      passingMarks: 50,
      class: new mongoose.Types.ObjectId(),
      endDate: new Date(now.getTime() - 1_000),
    });
    const owned = await claimDueExam({ now, workerId: "owner", leaseMs: LEASE_MS });
    const staleCompletion = await completeClaim(owned, "not-owner", now);
    ok("a stale report worker cannot complete another worker's lease",
      staleCompletion === "stale" &&
      !(await Exam.findById(fencedExam._id)).reportSentAt);
    ok("the lease owner can complete the report",
      (await completeClaim(owned, "owner", now)) === "completed");

    const scorable = await makeScorableAttempt(now);
    const [finalA, finalB] = await Promise.all([
      finalizeExpiredAttempts(),
      finalizeExpiredAttempts(),
    ]);
    ok("two finalizer workers converge on one submitted attempt",
      finalA + finalB === 1 &&
      (await Attempt.findById(scorable.attempt._id)).submitted === true);
    ok("two finalizer workers create one logical Result",
      await Result.countDocuments({ attemptId: scorable.attempt._id }) === 1);

    const attemptSpec = SPECS.find((spec) => spec.name === "due_attempt_finalizer");
    await mongoose.connection.db.collection("attempts").dropIndex(attemptSpec.name).catch(() => {});
    await mongoose.connection.db.collection("attempts").createIndex(
      attemptSpec.key,
      attemptSpec.options
    );
    const bulk = Array.from({ length: 300 }, (_, index) => ({
      userId: new mongoose.Types.ObjectId(),
      examId: new mongoose.Types.ObjectId(),
      startedAt: now,
      expiresAt: new Date(now.getTime() + index + 60_000),
      submitted: true,
      unscorable: false,
      finalizeState: "open",
      createdAt: now,
      updatedAt: now,
    }));
    await mongoose.connection.db.collection("attempts").insertMany(bulk);
    const explain = await mongoose.connection.db.collection("attempts")
      .find({
        submitted: false,
        unscorable: { $ne: true },
        expiresAt: { $lt: new Date(now.getTime() + 1) },
      })
      .hint(attemptSpec.name)
      .explain("executionStats");
    ok("due finalizer explain uses the migration-owned index",
      JSON.stringify(explain.queryPlanner.winningPlan).includes(attemptSpec.name));
    ok("partial index excludes submitted history from keys examined",
      explain.executionStats.totalKeysExamined < 20);
  } finally {
    await mongoose.disconnect();
    await mem.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
