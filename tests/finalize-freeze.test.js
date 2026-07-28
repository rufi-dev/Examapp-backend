/*
 * AUD-004 CR-038 — atomic finalization freeze. Reproduces the stale-read race
 * (the finalizer holds an Attempt object read at revision 1 while revision 2 was
 * acknowledged) and proves the freeze grades the ACKNOWLEDGED revision, that an
 * autosave after the freeze is rejected, that two concurrent finalizers produce
 * one result, and that a crash after the freeze is recovered deterministically.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const User = require("../models/userModel");
const { autosaveAttempt, finalizeAttempt } = require("../controllers/quizController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function mkRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function save(examId, userId, body) {
  const res = mkRes();
  let err = null;
  await autosaveAttempt({ params: { examId: String(examId) }, body, user: { _id: userId } }, res, (e) => (err = e));
  if (err) throw err;
  return res.body;
}
let seq = 0;
async function setup() {
  const owner = await User.create({ name: "T", email: `t${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const student = await User.create({ name: "S", email: `s${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true });
  const exam = await Exam.create({ name: "E", owner: owner._id, duration: 3600, price: 0, totalMarks: 100, passingMarks: 50, mode: "structured", class: new mongoose.Types.ObjectId(), typePoints: { Cm: 50 } });
  const q = await Question.create({ exam: exam._id, correctAnswers: [{ type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] }, { type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [1] }] });
  exam.questions = q._id; await exam.save();
  // bind a version explicitly (as startAttempt would) so grading is versioned.
  const { publishExam } = require("../helper/examVersion");
  const populated = await Exam.findById(exam._id).populate("questions");
  const v = await publishExam(populated, populated.questions, ExamVersionModel(), Exam);
  const attempt = await Attempt.create({ userId: student._id, examId: exam._id, examVersionId: v._id, startedAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  return { exam, student, attempt };
}
function ExamVersionModel() { return require("../models/examVersionModel"); }
const ans = (v) => [{ type: "Cm", answer: v }, { type: "Cm", answer: 1 }];

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();
  await ExamVersionModel().createIndexes();

  // ── stale-read race: finalize the ACKNOWLEDGED revision, not the stale object ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    // Acknowledge rev 1 (q1 wrong: answer 1) — earns only q2 (50).
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1), clientRevision: 1, requestId: "r1" });
    // The finalizer reads a STALE Attempt object at revision 1.
    const stale = await Attempt.findById(id);
    // Then rev 2 is acknowledged (q1 correct: answer 0) — should earn both (100).
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 2, requestId: "r2" });

    // Finalize with the STALE object. The freeze must re-read rev 2 from the DB.
    await finalizeAttempt(stale, { reason: "finalizer" });
    const result = await Result.findOne({ attemptId: id });
    ok("freeze graded the ACKNOWLEDGED rev 2 (100), not the stale rev 1 (50)", result.earnPoints === 100);
    ok("result records gradedRevision 2", result.gradedRevision === 2);
    const a = await Attempt.findById(id).lean();
    ok("attempt is frozen after finalize", a.finalizeState === "frozen" && a.frozenRev === 2);
  }

  // ── an autosave in the FROZEN-but-not-yet-submitted window is rejected ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 1, requestId: "r1" });
    // Freeze WITHOUT submitting (the crash window between freeze and result).
    await Attempt.updateOne({ _id: id }, [{ $set: { finalizeState: "frozen", frozenAnswers: "$answers", frozenRev: "$autosaveRev" } }]);
    const inWindow = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1), clientRevision: 2, requestId: "r2" });
    ok("autosave in the frozen window rejected (outcome finalized)", inWindow.ok === false && inWindow.outcome === "finalized");
    const a = await Attempt.findById(id).lean();
    ok("frozen answers unchanged by the rejected autosave", a.frozenRev === 1);
  }

  // ── after a completed finalize the attempt is submitted → autosave finds no active attempt ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 1, requestId: "r1" });
    await finalizeAttempt(await Attempt.findById(id), { reason: "finalizer" });
    const late = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1), clientRevision: 2, requestId: "r2" });
    ok("post-finalize autosave rejected (submitted attempt, not active)", late.ok === false);
    const result = await Result.findOne({ attemptId: id });
    ok("graded snapshot unchanged after the rejected late autosave", result.gradedRevision === 1);
  }

  // ── two concurrent finalizers → exactly ONE result on the same frozen snapshot ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 3, requestId: "r3" });
    const o1 = await Attempt.findById(id);
    const o2 = await Attempt.findById(id);
    await Promise.all([finalizeAttempt(o1, { reason: "f1" }), finalizeAttempt(o2, { reason: "f2" })]);
    ok("two concurrent finalizers → exactly ONE result", (await Result.countDocuments({ attemptId: id })) === 1);
    ok("the single result is on the frozen revision 3", (await Result.findOne({ attemptId: id })).gradedRevision === 3);
  }

  // ── crash recovery: frozen but no result → a later finalize re-scores it ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 4, requestId: "r4" });
    // Simulate a crash right after the freeze but before the result: freeze manually.
    await Attempt.updateOne({ _id: id }, [{ $set: { finalizeState: "frozen", frozenAnswers: "$answers", frozenRev: "$autosaveRev" } }]);
    ok("precondition: frozen with no result", (await Result.countDocuments({ attemptId: id })) === 0);
    // A later finalizer pass heals it from the frozen snapshot (deterministic).
    await finalizeAttempt(await Attempt.findById(id), { reason: "recovery" });
    const result = await Result.findOne({ attemptId: id });
    ok("recovery created the result from the frozen snapshot", !!result && result.gradedRevision === 4 && result.earnPoints === 100);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
