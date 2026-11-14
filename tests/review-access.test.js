/*
 * Who may open a result's review (reviewByResult).   node tests/review-access.test.js
 *
 * 2026-11-14: a student pressing the eye icon on their own result got «Bu nəticəyə
 * icazəniz yoxdur». The result's userId is populated (for the teacher's header), and
 * the owner check compared the populated document's toString() — the whole record —
 * with the student's id, so EVERY student was refused since 2026-06-20.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/userModel");
const Result = require("../models/resultModel");
const qc = require("../controllers/quizController");

let passed = 0,
  failed = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failed++;
    console.log("  ✗ FAIL:", name, extra !== undefined ? JSON.stringify(extra) : "");
  }
};
const call = (fn, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        resolve({ code: this.statusCode, body: b });
        return this;
      },
    };
    fn(req, res, (err) => resolve({ code: res.statusCode, err: err && err.message }));
  });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const db = mongoose.connection.db;
  const teacher = await User.create({ name: "T", email: `t${Date.now()}@x.az`, password: "xxxxxxxx", role: "teacher" });
  const otherTeacher = await User.create({ name: "T2", email: `t2${Date.now()}@x.az`, password: "xxxxxxxx", role: "teacher" });
  const admin = await User.create({ name: "A", email: `a${Date.now()}@x.az`, password: "xxxxxxxx", role: "admin" });
  const student = await User.create({ name: "S", email: `s${Date.now()}@x.az`, password: "xxxxxxxx", role: "student" });
  const other = await User.create({ name: "O", email: `o${Date.now()}@x.az`, password: "xxxxxxxx", role: "student" });
  const q = await db.collection("questions").insertOne({ correctAnswers: [{ type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [1] }] });
  const exam = await db.collection("exams").insertOne({ name: "Variant A", owner: teacher._id, questions: q.insertedId, showScore: true, showCorrectAnswers: true });
  const r = await Result.create({ userId: student._id, examId: exam.insertedId, attemptId: new mongoose.Types.ObjectId(), earnPoints: 50, grades: [1] });
  const open = (u) => call(qc.reviewByResult, { params: { resultId: String(r._id) }, user: { _id: u._id } });

  const own = await open(student);
  ok("the student opens the review of their OWN result", own.code === 200 && own.body && own.body.userId && own.body.userId.name === "S", own);
  ok("…and sees the answers when the exam reveals them", own.code === 200 && Array.isArray(own.body.grades), own.body && own.body.grades);
  ok("the teacher who owns the exam opens it", (await open(teacher)).code === 200);
  ok("an admin opens it", (await open(admin)).code === 200);
  ok("ANOTHER student is refused", (await open(other)).code === 403);
  ok("another teacher is refused", (await open(otherTeacher)).code === 403);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
