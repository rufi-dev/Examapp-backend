/*
 * Security test for the late-submit cutoff in addResult (against in-memory Mongo):
 *   - WITHIN grace  -> the CLIENT's submitted answers are scored.
 *   - PAST grace     -> the SERVER's deadline-cut autosave is scored; the late
 *                       client payload is IGNORED (can't inject post-deadline answers).
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const User = require("../models/userModel");
const Question = require("../models/questionModel");
const { addResult } = require("../controllers/quizController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

async function mkExam() {
  const user = await User.create({ name: "S", email: `s${Date.now()}${Math.floor(process.hrtime()[1])}@e.com`, password: "xxxxxxxx" });
  const exam = await Exam.create({
    name: "E", owner: user._id, duration: 600, price: 0, totalMarks: 100,
    passingMarks: 50, class: new mongoose.Types.ObjectId(),
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

// Invoke the asyncHandler addResult with a mock req/res.
async function callAddResult(examId, userId, body) {
  const req = { params: { examId: String(examId) }, body, user: { _id: userId } };
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let err = null;
  await addResult(req, res, (e) => (err = e));
  if (err) throw err;
  return res;
}

// A blank Result key: firstQuestion answer as stored (0-based index string/number).
const firstAnswer = (r) => r && r.selectedAnswers && r.selectedAnswers[0] && r.selectedAnswers[0].answer;

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();
  const now = Date.now();

  // ── WITHIN grace: client answers win ───────────────────────────────────────
  const A = await mkExam();
  const graceAttempt = await Attempt.create({
    userId: A.user._id, examId: A.exam._id, startedAt: new Date(now - 60e3),
    expiresAt: new Date(now + 300e3), // NOT expired
    answers: [{ type: "Cm", answer: 1 }, { type: "Cm", answer: 0 }], // autosave = WRONG
  });
  const res1 = await callAddResult(A.exam._id, A.user._id, {
    attemptId: String(graceAttempt._id),
    selectedAnswers: [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }], // client = CORRECT
    violations: 0, terminated: false,
  });
  const r1 = await Result.findOne({ attemptId: graceAttempt._id }).lean();
  ok("within grace: 200", res1.statusCode === 200);
  ok("within grace: scored the CLIENT answers (>0, autosave was wrong)", r1.earnPoints > 0);
  ok("within grace: stored answers are the CLIENT's (q1 = 0)", Number(firstAnswer(r1)) === 0);

  // ── PAST grace: autosave wins, late client payload ignored ─────────────────
  const B = await mkExam();
  const lateAttempt = await Attempt.create({
    userId: B.user._id, examId: B.exam._id, startedAt: new Date(now - 3600e3),
    expiresAt: new Date(now - 3600e3), // expired an hour ago (>> grace)
    answers: [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }], // autosave = CORRECT
  });
  const res2 = await callAddResult(B.exam._id, B.user._id, {
    attemptId: String(lateAttempt._id),
    selectedAnswers: [{ type: "Cm", answer: 1 }, { type: "Cm", answer: 0 }], // client = WRONG (forged, post-deadline)
    violations: 0, terminated: false,
  });
  const r2 = await Result.findOne({ attemptId: lateAttempt._id }).lean();
  ok("past grace: 200 late:true", res2.statusCode === 200 && res2.body && res2.body.late === true);
  ok("past grace: scored the AUTOSAVE (>0, client payload was wrong)", r2.earnPoints > 0);
  ok("past grace: stored answers are the AUTOSAVE's (q1 = 0), NOT the late client (1)", Number(firstAnswer(r2)) === 0);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
