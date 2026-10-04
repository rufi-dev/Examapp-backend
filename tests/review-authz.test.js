/*
 * AUD-003 CR-036 (+ CR-039 resume) — reviewByResult authorization matrix and
 * reveal policy, and the startAttempt resume revision floor. The reveal policy
 * now follows the LIVE exam for every result (a teacher's toggle reaches students
 * who already finished); only a deleted exam falls back to the version's copy.
 * Authz matrix: student owner, other student, exam-owner teacher, other teacher,
 * admin, soft-deleted exam, hard-deleted live exam, pre-end vs post-end reveal.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const ExamVersion = require("../models/examVersionModel");
const User = require("../models/userModel");
const { startAttempt, addResult, autosaveAttempt, reviewByResult } = require("../controllers/quizController");
const { publishExam } = require("../helper/examVersion");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function mkRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(fn, { params = {}, body = {}, userId }) {
  const req = { params, body, user: { _id: userId } };
  const res = mkRes();
  let err = null;
  await fn(req, res, (e) => (err = e));
  return { res, err, status: err && err.statusCode ? err.statusCode : res.statusCode };
}
let seq = 0;
// AUD-005: a "teacher" here is an APPROVED teacher (has the granted capability);
// the review authz gate now derives staff status from teacherApproval.
const mkUser = (role) => User.create({ name: role, email: `${role}${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role, teacherApproval: role === "teacher" ? "approved" : "none", isVerified: true });
async function mkExam(owner, over = {}) {
  const exam = await Exam.create({
    name: "E", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50,
    mode: "structured", class: new mongoose.Types.ObjectId(),
    showScore: true, showCorrectAnswers: true, revealAfterEnd: false, ...over,
  });
  const q = await Question.create({ exam: exam._id, correctAnswers: [{ type: "Cm", text: "Q1", choices: [{ text: "a" }, { text: "b" }], correct: [0] }] });
  exam.questions = q._id; await exam.save();
  return exam;
}
async function takeExam(exam, student) {
  student.exams.push(exam._id); await student.save();
  const started = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
  const attemptId = started.res.body.attemptId;
  await call(addResult, { params: { examId: String(exam._id) }, userId: student._id, body: { attemptId, selectedAnswers: [{ type: "Cm", answer: 0 }] } });
  return { attemptId, result: await Result.findOne({ attemptId }) };
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();
  await ExamVersion.createIndexes();

  // ── authorization matrix ──
  {
    const teacher = await mkUser("teacher");
    const otherTeacher = await mkUser("teacher");
    const admin = await mkUser("admin");
    const student = await mkUser("student");
    const otherStudent = await mkUser("student");
    const exam = await mkExam(teacher);
    const { result } = await takeExam(exam, student);
    const review = (uid) => call(reviewByResult, { params: { resultId: String(result._id) }, userId: uid });

    ok("student OWNER allowed", (await review(student._id)).status === 200);
    ok("OTHER student denied (403)", (await review(otherStudent._id)).status === 403);
    ok("exam-owner teacher allowed", (await review(teacher._id)).status === 200);
    ok("OTHER teacher denied (403)", (await review(otherTeacher._id)).status === 403);
    ok("admin allowed", (await review(admin._id)).status === 200);

    // soft-deleted exam → review still works (frozen) for the owner teacher.
    await Exam.findByIdAndUpdate(exam._id, { $set: { deletedAt: new Date() } });
    ok("soft-deleted exam: owner teacher still allowed", (await review(teacher._id)).status === 200);

    // hard-deleted live exam → other teacher STILL denied (frozen author governs).
    await Exam.findByIdAndDelete(exam._id);
    ok("hard-deleted exam: OTHER teacher still denied (frozen author governs)", (await review(otherTeacher._id)).status === 403);
    ok("hard-deleted exam: owner teacher (frozen author) allowed", (await review(teacher._id)).status === 200);
    ok("hard-deleted exam: student owner still allowed", (await review(student._id)).status === 200);
  }

  // ── frozen reveal policy: revealAfterEnd + future endDate hides answers ──
  {
    const teacher = await mkUser("teacher");
    const student = await mkUser("student");
    // Exam is currently OPEN (endDate in the future), answers gated on end.
    const exam = await mkExam(teacher, { showCorrectAnswers: true, revealAfterEnd: true, endDate: new Date(Date.now() + 3600e3) });
    const { result } = await takeExam(exam, student);
    const pre = await call(reviewByResult, { params: { resultId: String(result._id) }, userId: student._id });
    ok("pre-end: answers hidden from the student (frozen policy)", pre.res.body.correctAnswers === null);

    // A result bound to a version whose frozen endDate is already PAST reveals
    // answers. Built directly (startAttempt correctly refuses to START a past-end
    // exam), which is exactly the historical-review case.
    const student2 = await mkUser("student");
    const exam2 = await mkExam(teacher, { showCorrectAnswers: true, revealAfterEnd: true, endDate: new Date(Date.now() - 3600e3) });
    const pop = await Exam.findById(exam2._id).populate("questions");
    const v2 = await publishExam(pop, pop.questions, ExamVersion, Exam);
    const at2 = await Attempt.create({ userId: student2._id, examId: exam2._id, examVersionId: v2._id, startedAt: new Date(Date.now() - 7200e3), expiresAt: new Date(Date.now() - 3600e3), submitted: true });
    const res2 = await Result.create({ userId: student2._id, examId: exam2._id, examVersionId: v2._id, gradingSnapshotHash: v2.contentHash, earnPoints: 100, attemptId: at2._id, correctAnswers: [{ type: "Cm", answer: 0 }], selectedAnswers: [{ type: "Cm", answer: 0 }] });
    const post = await call(reviewByResult, { params: { resultId: String(res2._id) }, userId: student2._id });
    ok("post-end: answers revealed to the student (frozen policy)", Array.isArray(post.res.body.correctAnswers));
  }

  /*
   * ── A teacher's change reaches the students who ALREADY finished ──
   *
   * Teachers open a finished exam and turn on "show score" / "show correct
   * answers" for the students who sat it. CR-036 had frozen the reveal policy
   * into the version each student took, so none of them saw the change — only
   * students who started afterwards. Reveal is a disclosure decision, not
   * grading, so it now follows the live exam; the answer KEY shown is still the
   * version's, the one the paper was graded against.
   */
  {
    const teacher = await mkUser("teacher");
    const student = await mkUser("student");
    const exam = await mkExam(teacher, { showScore: false, showCorrectAnswers: false, revealAfterEnd: false });
    const { result } = await takeExam(exam, student);
    ok("the result is bound to a published version (the path that was frozen)", !!result.examVersionId);
    const review = () => call(reviewByResult, { params: { resultId: String(result._id) }, userId: student._id });

    const before = await review();
    ok("before: the student sees no score", before.res.body.earnPoints === null);
    ok("before: ...and no answers", before.res.body.correctAnswers === null);

    // The teacher edits the live exam. No new version is published, no new attempt.
    await Exam.updateOne({ _id: exam._id }, { $set: { showScore: true, showCorrectAnswers: true } });
    const after = await review();
    ok("after the teacher turns it on: the finished student sees the score", typeof after.res.body.earnPoints === "number");
    ok("...and the correct answers", Array.isArray(after.res.body.correctAnswers));
    ok("...from the version they were graded against", after.res.body.gradedVersion && after.res.body.gradedVersion.number >= 1);

    // ...and it is the teacher's current decision in both directions.
    await Exam.updateOne({ _id: exam._id }, { $set: { showCorrectAnswers: false } });
    const hiddenAgain = await review();
    ok("turned back off: answers are hidden again", hiddenAgain.res.body.correctAnswers === null);
    ok("...while the score stays visible", typeof hiddenAgain.res.body.earnPoints === "number");

    // The teacher always sees everything, whatever the students are shown.
    const asTeacher = await call(reviewByResult, { params: { resultId: String(result._id) }, userId: teacher._id });
    ok("the teacher still sees the answers", Array.isArray(asTeacher.res.body.correctAnswers));
  }

  /*
   * ── "Reveal after the end" still holds — against the LIVE end date ──
   *
   * The protection CR-036 was about: answers must not reach a finished student
   * while others are still writing. The frozen end date got this wrong in one
   * direction — extend the exam and the old date would open the answers early.
   */
  {
    const teacher = await mkUser("teacher");
    const student = await mkUser("student");
    const exam = await mkExam(teacher, { showCorrectAnswers: true, revealAfterEnd: true, endDate: new Date(Date.now() - 3600e3) });
    const pop = await Exam.findById(exam._id).populate("questions");
    const v = await publishExam(pop, pop.questions, ExamVersion, Exam);
    const at = await Attempt.create({ userId: student._id, examId: exam._id, examVersionId: v._id, startedAt: new Date(Date.now() - 7200e3), expiresAt: new Date(Date.now() - 3600e3), submitted: true });
    const res = await Result.create({ userId: student._id, examId: exam._id, examVersionId: v._id, gradingSnapshotHash: v.contentHash, earnPoints: 100, attemptId: at._id, correctAnswers: [{ type: "Cm", answer: 0 }], selectedAnswers: [{ type: "Cm", answer: 0 }] });
    const review = () => call(reviewByResult, { params: { resultId: String(res._id) }, userId: student._id });

    ok("ended exam, reveal after end: answers shown", Array.isArray((await review()).res.body.correctAnswers));

    // The teacher reopens the exam for another day. Others may now be writing.
    await Exam.updateOne({ _id: exam._id }, { $set: { endDate: new Date(Date.now() + 86400e3) } });
    ok("exam extended: answers hidden again until the NEW end (the frozen date would have leaked them)",
      (await review()).res.body.correctAnswers === null);

    // Hard-deleted exam: nothing live to read, so the frozen policy governs.
    await Exam.findByIdAndDelete(exam._id);
    ok("exam deleted: falls back to the version's own policy", Array.isArray((await review()).res.body.correctAnswers));
  }

  // ── CR-039: resume returns the acknowledged revision floor + saved answers ──
  {
    const teacher = await mkUser("teacher");
    const student = await mkUser("student");
    const exam = await mkExam(teacher);
    student.exams.push(exam._id); await student.save();
    const s1 = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    const attemptId = s1.res.body.attemptId;
    ok("fresh start: storedRevision is 0", s1.res.body.storedRevision === 0);
    await call(autosaveAttempt, { params: { examId: String(exam._id) }, userId: student._id, body: { attemptId, selectedAnswers: [{ type: "Cm", answer: 0 }], clientRevision: 3, requestId: "r3" } });
    // Resume (a reload): the SAME active attempt is returned with the floor + answers.
    const s2 = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    ok("resume: storedRevision floor is 3 (not reset to 0)", s2.res.body.storedRevision === 3);
    ok("resume: saved answers are returned", Array.isArray(s2.res.body.savedAnswers) && s2.res.body.savedAnswers.length === 1 && Number(s2.res.body.savedAnswers[0].answer) === 0);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
