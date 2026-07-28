/*
 * AUD-003 (CR-034/035/036) — immutable exam versions with a real draft/publish
 * boundary and an enforced integrity contract. Grading/finalization/review read
 * the ACTIVE published version bound at start, never the live draft. Covers:
 * T1 (start V1, publish V2, score/review on V1), T2 (review survives draft
 * deletion), publish race → distinct version numbers, edit-fork, archived review,
 * finalizer-uses-version, CR-034 start-mid-edit gets complete old version, and
 * CR-035 integrity (missing/corrupt bound version fails closed; unique numbers).
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const ExamVersion = require("../models/examVersionModel");
const User = require("../models/userModel");
const { publishExam, verifyIntegrity } = require("../helper/examVersion");
const {
  startAttempt, addResult, autosaveAttempt, finalizeExpiredAttempts, reviewByResult,
} = require("../controllers/quizController");

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
  if (err) throw err;
  return res;
}
// Some paths throw (auth/integrity) — capture the thrown error + status.
async function callThrows(fn, { params = {}, body = {}, userId }) {
  const req = { params, body, user: { _id: userId } };
  const res = mkRes();
  let err = null;
  await fn(req, res, (e) => (err = e));
  return { res, err };
}

let seq = 0;
async function mkTeacher() {
  return User.create({ name: "T", email: `t${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
}
async function mkStudent(examId) {
  const u = await User.create({ name: "S", email: `s${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true });
  if (examId) { u.exams.push(examId); await u.save(); }
  return u;
}
async function mkExam(owner, { correct1 = [0] } = {}) {
  const exam = await Exam.create({
    name: "E", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50,
    mode: "structured", class: new mongoose.Types.ObjectId(),
    showScore: true, showCorrectAnswers: true, revealAfterEnd: false,
  });
  const q = await Question.create({
    exam: exam._id,
    correctAnswers: [
      { type: "Cm", text: "Q1", choices: [{ text: "a" }, { text: "b" }], correct: correct1 },
      { type: "Cm", text: "Q2", choices: [{ text: "a" }, { text: "b" }], correct: [1] },
    ],
  });
  exam.questions = q._id;
  await exam.save();
  return { exam, q };
}
// Publish the exam's current draft as the active version (the builder save commit).
async function publish(examId) {
  const exam = await Exam.findById(examId).populate("questions");
  return publishExam(exam, exam.questions, ExamVersion, Exam);
}
// Edit the live draft's answer key WITHOUT publishing (mid-edit draft state).
async function editDraft(q, correct1) {
  await Question.findByIdAndUpdate(q._id, { $set: { "correctAnswers.0.correct": correct1 } });
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();
  await ExamVersion.createIndexes();

  // ── T1: start on V1, publish V2, submit → scored & reviewed on V1 ──
  {
    const teacher = await mkTeacher();
    const { exam, q } = await mkExam(teacher, { correct1: [0] });
    const student = await mkStudent(exam._id);
    const started = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    const attemptId = started.body.attemptId;
    const v1 = (await Attempt.findById(attemptId)).examVersionId;
    ok("T1: attempt bound to the active version at start", !!v1);

    await editDraft(q, [1]);
    await publish(exam._id); // publish V2 AFTER the student started

    const submit = await call(addResult, {
      params: { examId: String(exam._id) }, userId: student._id,
      body: { attemptId, selectedAnswers: [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }] },
    });
    ok("T1: submit succeeded", submit.statusCode === 200);
    const result = await Result.findOne({ attemptId });
    ok("T1: graded on V1 (full marks, not the V2 key)", result.earnPoints === 100);
    ok("T1: result bound to V1", String(result.examVersionId) === String(v1));
    ok("T1: exam now has 2 versions", (await ExamVersion.countDocuments({ examId: exam._id })) === 2);

    const review = await call(reviewByResult, { params: { resultId: String(result._id) }, userId: teacher._id });
    ok("T1: review shows the frozen V1 key", JSON.stringify(review.body.examId.questions.correctAnswers[0].correct) === JSON.stringify([0]));
  }

  // ── CR-034: a start landing mid-edit binds the COMPLETE old version ──
  {
    const teacher = await mkTeacher();
    const { exam, q } = await mkExam(teacher, { correct1: [0] });
    const v1 = await publish(exam._id); // active V1 published (complete)
    await editDraft(q, [1]); // teacher is mid-edit; NOT published
    const student = await mkStudent(exam._id);
    const started = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    const bound = (await Attempt.findById(started.body.attemptId)).examVersionId;
    ok("CR-034: mid-edit start binds the active V1, not the draft", String(bound) === String(v1._id));
    ok("CR-034: no new version was forked by a start", (await ExamVersion.countDocuments({ examId: exam._id })) === 1);
    const boundV = await ExamVersion.findById(bound).lean();
    ok("CR-034: bound version has the ORIGINAL key (draft edit not published)", JSON.stringify(boundV.questions[0].correct) === JSON.stringify([0]));
  }

  // ── CR-035: two concurrent publishes of DIFFERENT content → distinct numbers ──
  {
    const teacher = await mkTeacher();
    const { exam, q } = await mkExam(teacher, { correct1: [0] });
    await publish(exam._id); // V1
    // Two racing publishes with genuinely different content.
    const examA = await Exam.findById(exam._id).populate("questions");
    examA.questions.correctAnswers[0].correct = [1];
    const examB = await Exam.findById(exam._id).populate("questions");
    examB.questions.correctAnswers[0].correct = [0];
    examB.questions.correctAnswers[1].correct = [0];
    const [rA, rB] = await Promise.all([
      publishExam(examA, examA.questions, ExamVersion, Exam),
      publishExam(examB, examB.questions, ExamVersion, Exam),
    ]);
    const nums = await ExamVersion.find({ examId: exam._id }).distinct("versionNumber");
    ok("CR-035: distinct version numbers (no duplicate v1)", nums.length === (await ExamVersion.countDocuments({ examId: exam._id })));
    ok("CR-035: racing different publishes got different numbers", rA.versionNumber !== rB.versionNumber);
  }

  // ── edit-fork via publish: A on V1, publish V2, B on V2 ──
  {
    const teacher = await mkTeacher();
    const { exam, q } = await mkExam(teacher, { correct1: [0] });
    const a = await mkStudent(exam._id);
    const b = await mkStudent(exam._id);
    const ra = await call(startAttempt, { params: { examId: String(exam._id) }, userId: a._id });
    await editDraft(q, [1]);
    await publish(exam._id); // V2
    const rb = await call(startAttempt, { params: { examId: String(exam._id) }, userId: b._id });
    const va = (await Attempt.findById(ra.body.attemptId)).examVersionId;
    const vb = (await Attempt.findById(rb.body.attemptId)).examVersionId;
    ok("edit-fork: A and B bound to DIFFERENT versions", String(va) !== String(vb));
  }

  // ── T2: delete the live draft after a result → review still complete ──
  {
    const teacher = await mkTeacher();
    const { exam, q } = await mkExam(teacher, { correct1: [0] });
    const student = await mkStudent(exam._id);
    const started = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    const attemptId = started.body.attemptId;
    await call(addResult, { params: { examId: String(exam._id) }, userId: student._id, body: { attemptId, selectedAnswers: [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }] } });
    const result = await Result.findOne({ attemptId });
    await Question.findByIdAndDelete(q._id);
    await Exam.findByIdAndUpdate(exam._id, { $unset: { questions: 1 } });
    const review = await call(reviewByResult, { params: { resultId: String(result._id) }, userId: teacher._id });
    const rq = review.body.examId.questions.correctAnswers;
    ok("T2: review returns both frozen questions after draft deletion", Array.isArray(rq) && rq.length === 2 && rq[0].text === "Q1");
  }

  // ── CR-035: a MISSING bound version fails closed at grading (no live fallback) ──
  {
    const teacher = await mkTeacher();
    const { exam } = await mkExam(teacher, { correct1: [0] });
    const student = await mkStudent(exam._id);
    const started = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    const attemptId = started.body.attemptId;
    // Simulate a corrupt store: delete the bound version.
    const bound = (await Attempt.findById(attemptId)).examVersionId;
    // CR-035: published versions are immutable via the model — simulate store
    // damage with the NATIVE collection escape.
    await ExamVersion.collection.deleteOne({ _id: bound });
    const { res } = await callThrows(addResult, { params: { examId: String(exam._id) }, userId: student._id, body: { attemptId, selectedAnswers: [{ type: "Cm", answer: 0 }] } });
    ok("CR-035: grading a missing bound version is blocked (409 integrity)", res.statusCode === 409 && res.body && res.body.reason === "version_integrity");
    ok("CR-035: no result was created for the integrity failure", (await Result.countDocuments({ attemptId })) === 0);
  }

  // ── CR-035: a CORRUPT bound version (tampered content) fails integrity verify ──
  {
    const teacher = await mkTeacher();
    const { exam } = await mkExam(teacher, { correct1: [0] });
    const v = await publish(exam._id);
    const stored = await ExamVersion.findById(v._id).lean();
    ok("integrity: a pristine version verifies", verifyIntegrity(stored).ok === true);
    // Tamper with the stored key without updating the hash.
    // Native escape: the model blocks updates to a published version (CR-035).
    await ExamVersion.collection.updateOne({ _id: v._id }, { $set: { "questions.0.correct": [1] } });
    const tampered = await ExamVersion.findById(v._id).lean();
    ok("integrity: a tampered version FAILS verification", verifyIntegrity(tampered).ok === false);
  }

  // ── finalizer uses the bound version, not the edited live draft ──
  {
    const teacher = await mkTeacher();
    const { exam, q } = await mkExam(teacher, { correct1: [0] });
    const student = await mkStudent(exam._id);
    const started = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    const attemptId = started.body.attemptId;
    await call(autosaveAttempt, { params: { examId: String(exam._id) }, userId: student._id, body: { attemptId, selectedAnswers: [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }], clientRevision: 1, requestId: "r1" } });
    await editDraft(q, [1]);
    await publish(exam._id);
    await Attempt.updateOne({ _id: attemptId }, { $set: { expiresAt: new Date(Date.now() - 5 * 60 * 1000) } });
    await Exam.findByIdAndUpdate(exam._id, { $set: { endDate: new Date(Date.now() - 5 * 60 * 1000) } });
    await finalizeExpiredAttempts();
    const result = await Result.findOne({ attemptId });
    ok("finalizer: graded on the bound version (full marks under V1)", result && result.earnPoints === 100);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
