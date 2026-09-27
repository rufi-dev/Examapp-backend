/*
 * Pausing a student must never take away what they already earned.
 *
 * When a teacher's plan lapses, students over the new cap go back to the
 * waitlist and lose access to that teacher's classes. That is the intended
 * enforcement and it is about what they may DO NEXT - sit an exam, open a
 * paper. It must not reach backwards into results they already have. A grade is
 * the student's record of their own work, and a billing event between two other
 * parties is not a reason to take it off them.
 *
 * The same holds for an exam blocked by the cap: it cannot be SAT, but a result
 * already earned on it still opens.
 *
 * Asserted against the real handlers and a real Mongo rather than by reading the
 * code, because this exact question - "is the read path gated?" - has been
 * answered wrongly from a reading before.
 */
process.env.NODE_ENV = "test";

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const call = async (handler, req) => {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let thrown = null;
  await handler(req, res, (e) => { thrown = e; }).catch((e) => { thrown = e; });
  return { res, thrown };
};

async function main() {
  console.log("a paused student keeps their results");

  const mongoose = require("mongoose");
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "pausedresults" });

  const User = require("../models/userModel");
  const Class = require("../models/classModel");
  const Exam = require("../models/examModel");
  const Question = require("../models/questionModel");
  const Result = require("../models/resultModel");
  const Enrollment = require("../models/enrollmentModel");
  const ctl = require("../controllers/quizController");

  const mk = (name, role) =>
    User.create({ name, email: `${name}@t.test`, password: "x".repeat(12), role, isVerified: true });

  const teacher = await mk("teacher", "teacher");
  const student = await mk("student", "student");
  const cls = await Class.create({ name: "9A", owner: teacher._id });

  // The exam first, because a question belongs to one.
  const exam = await Exam.create({
    name: "Biology",
    owner: teacher._id,
    class: cls._id,
    duration: 1800,
    price: 0,
    totalMarks: 10,
    passingMarks: 5,
    showScore: true,
    showCorrectAnswers: true,
  });
  const q = await Question.create({
    exam: exam._id,
    correctAnswers: [{ answer: "A", type: "Cm" }],
  });
  await Exam.updateOne({ _id: exam._id }, { $set: { questions: q._id } });

  const result = await Result.create({
    userId: student._id,
    examId: exam._id,
    attempts: 1,
    attemptId: new mongoose.Types.ObjectId(),
    earnPoints: 8,
    legacyUnversioned: true,
  });

  /*
   * The lapse: the student goes back to the waitlist and the exam is blocked.
   * Exactly the state a teacher's expiry leaves behind.
   */
  await Enrollment.create({
    class: cls._id,
    student: student._id,
    teacher: teacher._id,
    status: "pending",
    frozenByPlan: true,
  });
  await Exam.updateOne({ _id: exam._id }, { $set: { blockedByPlan: true } });

  const asStudent = { user: { _id: student._id }, params: {}, query: {} };

  const list = await call(ctl.getResultsByUser, { ...asStudent });
  const items = Array.isArray(list.res.body) ? list.res.body : list.res.body?.items;
  ok("their results list still returns the result", Array.isArray(items) && items.length === 1,
    JSON.stringify(list.res.body)?.slice(0, 160));
  ok("and it still carries the score they earned", items?.[0]?.earnPoints === 8, JSON.stringify(items?.[0]?.earnPoints));

  const byExam = await call(ctl.getResultsByUserByExam, {
    ...asStudent,
    params: { examId: String(exam._id) },
  });
  const rows = Array.isArray(byExam.res.body) ? byExam.res.body : byExam.res.body?.items;
  ok("opening that exam's result works", byExam.res.statusCode === 200 && rows?.length === 1,
    `status ${byExam.res.statusCode}`);

  const review = await call(ctl.reviewByResult, {
    ...asStudent,
    params: { resultId: String(result._id) },
  });
  ok("and the full review opens", review.res.statusCode === 200 && !review.thrown,
    review.thrown?.message || `status ${review.res.statusCode}`);

  /*
   * The other half of the bargain: the enforcement itself must still hold. If
   * pausing stopped meaning anything, the cap would be unenforceable.
   */
  const sit = await call(ctl.startAttempt, {
    ...asStudent,
    params: { examId: String(exam._id) },
    body: {},
  });
  ok("but they still cannot SIT the blocked exam",
    sit.res.statusCode === 403 || /əlçatan deyil/.test(sit.thrown?.message || ""),
    sit.thrown?.message || `status ${sit.res.statusCode}`);

  // And the teacher keeps seeing it too - their roster shrank, their record did not.
  const teacherView = await call(ctl.getResultsByExam, {
    user: { _id: teacher._id, role: "teacher", teacherApproval: "approved" },
    params: { examId: String(exam._id) },
    query: {},
  });
  const tRows = Array.isArray(teacherView.res.body) ? teacherView.res.body : teacherView.res.body?.items;
  ok("the teacher still sees it on their side", tRows?.length === 1, `status ${teacherView.res.statusCode}`);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });
