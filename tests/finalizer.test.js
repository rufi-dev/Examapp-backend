/*
 * Verifies the finalizer: RESULT-FIRST (no pre-claim, never submitted-without-Result),
 * shortened-endDate coverage, and idempotence. Against in-memory Mongo.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const User = require("../models/userModel");
const Question = require("../models/questionModel");
const { finalizeExpiredAttempts } = require("../controllers/quizController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

async function mkExam(endDate) {
  const user = await User.create({ name: "S", email: `s${Date.now()}${Math.floor(process.hrtime()[1])}@e.com`, password: "xxxxxxxx" });
  const exam = await Exam.create({
    name: "E", owner: user._id, duration: 600, price: 0, totalMarks: 100,
    passingMarks: 50, class: new mongoose.Types.ObjectId(), ...(endDate ? { endDate } : {}),
  });
  const q = await Question.create({
    exam: exam._id,
    correctAnswers: [
      { type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] },
      { type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [1] },
    ],
  });
  exam.questions = q._id;
  await exam.save();
  return { user, exam };
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();
  const now = Date.now();

  // (a) RESULT-FIRST: an expired unsubmitted attempt is finalized with a Result and
  //     ends submitted:true (never submitted:true-with-no-Result).
  const A = await mkExam(null);
  const expiredAttempt = await Attempt.create({
    userId: A.user._id, examId: A.exam._id, startedAt: new Date(now - 7200e3),
    expiresAt: new Date(now - 3600e3),
    answers: [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }],
  });
  const n1 = await finalizeExpiredAttempts();
  const at1 = await Attempt.findById(expiredAttempt._id).lean();
  const res1 = await Result.findOne({ attemptId: expiredAttempt._id }).lean();
  ok("finalizer processed the expired attempt", n1 >= 1);
  ok("expired attempt: Result created (result-first)", !!res1);
  ok("expired attempt: submitted:true", at1.submitted === true);
  ok("expired attempt: NOT unscorable (invariant intact)", at1.unscorable !== true);
  ok("expired attempt: scored from autosave (>0)", res1.earnPoints > 0);

  // (b) SHORTENED endDate: raw expiresAt is in the FUTURE, but the exam's endDate
  //     has passed -> the sweep must still finalize it.
  const B = await mkExam(new Date(now - 1800e3));
  const futureRawAttempt = await Attempt.create({
    userId: B.user._id, examId: B.exam._id, startedAt: new Date(now - 3600e3),
    expiresAt: new Date(now + 3600e3),
    answers: [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }],
  });
  await finalizeExpiredAttempts();
  const resB = await Result.findOne({ attemptId: futureRawAttempt._id }).lean();
  const atB = await Attempt.findById(futureRawAttempt._id).lean();
  ok("shortened endDate: attempt finalized despite future raw expiresAt", !!resB && atB.submitted === true);

  // (c) IDEMPOTENT finalizer: re-run doesn't create duplicates.
  await finalizeExpiredAttempts();
  ok("finalizer idempotent: still one Result for the attempt", (await Result.countDocuments({ attemptId: expiredAttempt._id })) === 1);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
