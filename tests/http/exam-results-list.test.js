/*
 * The "İmtahan nəticələri" list: each exam carries how its class's scores
 * spread (ten buckets of the total), when the latest result came in, and the
 * class name — over the real router, against a real (in-memory) database.
 *
 * The page used to plot `stats.scores`, a field the server never sent, so every
 * card showed one average marker on an empty strip.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-results-list";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-results-list";

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log("  ✓", label);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", label, extra ? `- ${extra}` : "");
  }
};

async function main() {
  console.log("the exam results list");
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "resultslist" });

  const User = require("../../models/userModel");
  const Exam = require("../../models/examModel");
  const { generateToken } = require("../../utils");
  const errorHandler = require("../../middleware/errorMiddleware");

  const teacher = await User.create({
    name: "T",
    email: "t@results.test",
    password: "xxxxxxxxxxxx",
    role: "teacher",
    teacherApproval: "approved",
    isVerified: true,
  });
  const db = mongoose.connection.db;
  const classId = new mongoose.Types.ObjectId();
  await db.collection("classes").insertOne({ _id: classId, name: "11 класс", owner: teacher._id });

  const examId = new mongoose.Types.ObjectId();
  const questionId = new mongoose.Types.ObjectId();
  await db.collection("questions").insertOne({ _id: questionId, exam: examId, correctAnswers: [{ type: "Cm", answer: 0 }] });
  await db.collection("exams").insertOne({
    _id: examId, name: "Triqonometriya", duration: 3600, price: 0, totalMarks: 50, passingMarks: 25,
    owner: teacher._id, class: classId, questions: questionId, deletedAt: null, createdAt: new Date(),
  });
  const at = (d) => new Date(Date.UTC(2026, 9, d, 9));
  const result = (points, d, extra = {}) => ({ userId: new mongoose.Types.ObjectId(), examId, attempts: 1, earnPoints: points, createdAt: at(d), ...extra });
  await db.collection("results").insertMany([
    result(0, 1),      // 0%   -> bucket 0
    result(12, 2),     // 24%  -> bucket 2
    result(25, 3),     // 50%  -> bucket 5
    result(26, 3),     // 52%  -> bucket 5
    result(50, 4),     // 100% -> bucket 9 (a full score lands in the last bucket)
    result(49, 5, { terminated: true }), // stopped for violations: counted, not plotted
  ]);
  await Exam.syncIndexes().catch(() => {});

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/quiz", require("../../routes/quizRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const token = generateToken(teacher._id, teacher.sessionVersion);

  const res = await fetch(`http://127.0.0.1:${port}/api/quiz/getExams`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  const list = Array.isArray(body) ? body : body.items || [];
  const exam = list.find((e) => String(e._id) === String(examId));

  ok("the list answers", res.status === 200 && !!exam, `status ${res.status}`);
  const s = exam?.stats || {};
  ok("counts everyone who sat it, the stopped attempt included", s.count === 6, `count ${s.count}`);
  ok("grades only the attempts that were not stopped", s.graded === 5, `graded ${s.graded}`);
  ok("spreads the graded scores over ten buckets of the total", JSON.stringify(s.buckets) === JSON.stringify([1, 0, 1, 0, 0, 2, 0, 0, 0, 1]), JSON.stringify(s.buckets));
  ok("puts a full score in the last bucket", s.buckets?.[9] === 1);
  ok("says when the latest result came in", s.lastAt && new Date(s.lastAt).getTime() === at(5).getTime(), String(s.lastAt));
  ok("names the class, leaving `class` as the id", exam?.className === "11 класс" && String(exam?.class) === String(classId), `${exam?.className} / ${exam?.class}`);
  ok("keeps the existing figures", s.averagePct === 45 && s.topPct === 100 && s.passRatePct === 60, JSON.stringify({ a: s.averagePct, t: s.topPct, p: s.passRatePct }));

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
