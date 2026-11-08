/*
 * Per-question verdicts ("grades"), against in-memory Mongo.  node tests/grades.test.js
 *
 * 2026-11-08: the results PDF showed a 25/25 student as "22 right, 3 wrong" — it
 * compared "5" to the stored key text "5 / m=5" (several accepted answers) instead
 * of asking the scorer. On the real exam it miscounted 116 of 183 students. Now the
 * scorer's own verdict per question is stored on every Result and every report
 * reads it. Covers:
 *   - verdicts for every case (several accepted answers, blank, wrong, partial)
 *   - the verdicts always rebuild the exact score
 *   - a new Result stores them (also when terminated: the truth, not the 0)
 *   - an OLD Result (no verdicts) gets them on the teacher's results endpoint
 *   - a student who may not see the answers never gets them either
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const User = require("../models/userModel");
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

// The real exam's tricky questions: several accepted answers per open question.
const KEY = [
  { type: "Cm", choices: [{ text: "3" }, { text: "4" }], correct: [1] },
  { type: "Co", answer: "5", answers: ["5", "m=5"] },
  { type: "Co", answer: "2,5", answers: ["2,5", "2.5", "5/2"] },
  { type: "Co", answer: "30", answers: ["30", "30%"] },
  { type: "Cs", choices: [{ text: "a" }, { text: "b" }, { text: "c" }], correct: [0, 2] },
];

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();

  // ── pure verdicts ──
  const exam = { questions: { correctAnswers: KEY }, partialCredit: true };
  const perfect = [{ answer: 1 }, { answer: "5" }, { answer: "2.5" }, { answer: "30%" }, { answer: [0, 2] }];
  let g = qc.gradeSelections(exam, perfect);
  ok("every accepted form counts as right (5 / 2.5 / 30%)", JSON.stringify(g.grades) === "[1,1,1,1,1]", g.grades);
  ok("…and the score is full", g.earnedPoints === 100, g.earnedPoints);
  g = qc.gradeSelections(exam, [{ answer: 0 }, { answer: "" }, { answer: " M=5 " }, { answer: "31" }, { answer: [0] }]);
  ok("wrong = 0, blank = null, case/space-insensitive, partial credit = fraction", JSON.stringify(g.grades) === "[0,null,0,0,0.5]", g.grades);
  g = qc.gradeSelections(exam, [{ answer: 1 }, { answer: "m=5" }]);
  ok("missing answers at the end are blank (null)", g.grades.length === 5 && g.grades[2] === null && g.grades[1] === 1, g.grades);

  // ── stored on a new Result; a terminated result keeps the real verdicts ──
  const teacher = await User.create({ name: "T", email: `t${Date.now()}@e.az`, password: "xxxxxxxx", role: "teacher" });
  const student = await User.create({ name: "Murad", email: `m${Date.now()}@e.az`, password: "xxxxxxxx" });
  const Question = require("../models/questionModel");
  const q = await Question.collection.insertOne({ correctAnswers: KEY });
  const examDoc = await Exam.create({
    name: "Sınaq",
    owner: teacher._id,
    duration: 600,
    price: 0,
    totalMarks: 100,
    passingMarks: 50,
    class: new mongoose.Types.ObjectId(),
    questions: q.insertedId,
    showCorrectAnswers: false,
  });
  const examLike = { _id: examDoc._id, questions: { correctAnswers: KEY }, results: [] };
  const mkAttempt = () =>
    Attempt.create({ userId: student._id, examId: examDoc._id, startedAt: new Date(), expiresAt: new Date(Date.now() + 6e5), submitted: true });
  const a1 = await mkAttempt();
  await qc.scoreAndCreateResult(examLike, student, a1, perfect, { suppressNotifications: true });
  const r1 = await Result.findOne({ attemptId: a1._id }).lean();
  ok("a new Result stores the verdicts", JSON.stringify(r1.grades) === "[1,1,1,1,1]", r1.grades);
  const a2 = await mkAttempt();
  await qc.scoreAndCreateResult(examLike, student, a2, perfect, { terminated: true, suppressNotifications: true });
  const r2 = await Result.findOne({ attemptId: a2._id }).lean();
  ok("a terminated Result scores 0 but keeps the real verdicts", r2.earnPoints === 0 && JSON.stringify(r2.grades) === "[1,1,1,1,1]", r2);

  // ── an OLD Result without verdicts: filled in on the teacher's endpoint ──
  const legacy = await Result.create({
    userId: student._id,
    examId: examDoc._id,
    attemptId: new mongoose.Types.ObjectId(),
    earnPoints: 100,
    selectedAnswers: perfect.map((p, i) => ({ type: KEY[i].type, answer: p.answer })),
    correctAnswers: KEY.map((k) => ({ type: k.type, answer: k.answers ? k.answers.join(" / ") : k.correct })),
  });
  await Result.updateOne({ _id: legacy._id }, { $unset: { grades: 1 } });
  const list = await call(qc.getResultsByExam, { params: { examId: String(examDoc._id) }, user: teacher });
  const lr = (list.body || []).find((r) => String(r._id) === String(legacy._id));
  ok("an old result gets its verdicts on the teacher's results page", lr && JSON.stringify(lr.grades) === "[1,1,1,1,1]", lr && lr.grades);
  ok("…stored verdicts are served as stored", (list.body || []).every((r) => Array.isArray(r.grades)));

  // ── a student who may not see the answers doesn't get the verdicts ──
  const mine = await call(qc.getResultsByUserByExam, { params: { examId: String(examDoc._id) }, user: student });
  const rows = Array.isArray(mine.body) ? mine.body : [];
  ok("student view (answers hidden): no per-question verdicts", rows.length > 0 && rows.every((r) => r.grades == null), rows.map((r) => r.grades));

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
