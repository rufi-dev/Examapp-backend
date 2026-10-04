/*
 * The profile page's numbers: what a teacher and a student have actually done,
 * and a year of activity by Baku day — over the real router, against a real
 * (in-memory) database.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-profile-stats";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-profile-stats";

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
  console.log("profile stats");
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "profilestats" });

  const User = require("../../models/userModel");
  const { generateToken } = require("../../utils");
  const errorHandler = require("../../middleware/errorMiddleware");

  const teacher = await User.create({ name: "T", email: "t@profile.test", password: "xxxxxxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const student = await User.create({ name: "S", email: "s@profile.test", password: "xxxxxxxxxxxx", role: "student", isVerified: true });
  const other = await User.create({ name: "O", email: "o@profile.test", password: "xxxxxxxxxxxx", role: "student", isVerified: true });

  const db = mongoose.connection.db;
  const oid = () => new mongoose.Types.ObjectId();
  const now = Date.now();
  const daysAgo = (d, hourUtc = 9) => {
    const t = new Date(now - d * 86400000);
    t.setUTCHours(hourUtc, 0, 0, 0);
    return t;
  };
  const bakuDay = (date) => new Date(date.getTime() + 4 * 3600000).toISOString().slice(0, 10);

  const classA = oid();
  const classGone = oid();
  await db.collection("classes").insertMany([
    { _id: classA, name: "9A", owner: teacher._id, deletedAt: null },
    { _id: classGone, name: "old", owner: teacher._id, deletedAt: new Date() },
  ]);
  await db.collection("enrollments").insertMany([
    { student: student._id, class: classA, status: "approved" },
    { student: other._id, class: classA, status: "approved" },
    { student: oid(), class: classA, status: "pending" },
    { student: oid(), class: classGone, status: "approved" },
  ]);

  const examA = oid();
  const examB = oid();
  await db.collection("exams").insertMany([
    { _id: examA, name: "Kəsrlər", totalMarks: 50, passingMarks: 25, owner: teacher._id, deletedAt: null, createdAt: daysAgo(3) },
    { _id: examB, name: "Faizlər", totalMarks: 20, passingMarks: 10, owner: teacher._id, deletedAt: null, createdAt: daysAgo(3) },
    { _id: oid(), name: "silinib", totalMarks: 10, owner: teacher._id, deletedAt: new Date(), createdAt: daysAgo(3) },
  ]);
  await db.collection("results").insertMany([
    { userId: student._id, examId: examA, earnPoints: 40, createdAt: daysAgo(2) }, // 80%
    { userId: student._id, examId: examB, earnPoints: 19, createdAt: daysAgo(1) }, // 95%
    { userId: student._id, examId: examB, earnPoints: 2, terminated: true, createdAt: daysAgo(1) }, // stopped: not scored
    { userId: other._id, examId: examA, earnPoints: 10, createdAt: daysAgo(2) }, // 20%
  ]);
  await db.collection("assignments").insertOne({ class: classA, owner: teacher._id, title: "Ev işi", deletedAt: null, createdAt: daysAgo(5) });
  await db.collection("submissions").insertMany([
    { assignment: oid(), student: student._id, submittedAt: daysAgo(4), gradedBy: teacher._id, gradedAt: daysAgo(4), grade: 9 },
    { assignment: oid(), student: other._id, submittedAt: daysAgo(4) },
  ]);
  // A lesson at 22:30 UTC is 02:30 the next morning in Baku.
  const lateLesson = daysAgo(6, 22);
  await db.collection("lessons").insertMany([
    { owner: teacher._id, class: classA, startAt: lateLesson, deletedAt: null },
    { owner: teacher._id, class: classA, startAt: new Date(now + 3 * 86400000), deletedAt: null }, // not held yet
  ]);
  await db.collection("attendances").insertMany([
    { lesson: oid(), class: classA, student: student._id, status: "present", at: lateLesson },
    { lesson: oid(), class: classA, student: student._id, status: "absent", at: daysAgo(13) },
  ]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/users", require("../../routes/userRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const get = async (u) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/users/profile-stats`, {
      headers: u ? { Authorization: `Bearer ${generateToken(u._id, u.sessionVersion)}` } : {},
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const anon = await get(null);
  ok("needs a signed-in user", anon.status === 401, `status ${anon.status}`);

  const t = await get(teacher);
  const tt = t.body.totals || {};
  ok("answers a teacher", t.status === 200 && t.body.kind === "teacher", `${t.status} ${t.body.kind}`);
  ok("counts live classes only", tt.classes === 1, `classes ${tt.classes}`);
  ok("counts approved students of live classes", tt.students === 2, `students ${tt.students}`);
  ok("counts live exams only", tt.exams === 2, `exams ${tt.exams}`);
  ok("counts every paper handed in", tt.attempts === 4, `attempts ${tt.attempts}`);
  ok("averages the graded scores as a percent", tt.averagePct === 65, `avg ${tt.averagePct}`); // (80+95+20)/3
  ok("counts homework set, reviewed, and lessons already held", tt.assignments === 1 && tt.reviewed === 1 && tt.lessons === 1, JSON.stringify(tt));
  ok("names the exam most sat", t.body.highlight?.name === "Kəsrlər" && t.body.highlight?.count === 2, JSON.stringify(t.body.highlight));
  const td = t.body.days || {};
  ok("puts exams on the day they were made", td[bakuDay(daysAgo(3))]?.exam === 2, JSON.stringify(td[bakuDay(daysAgo(3))]));
  ok("files a late lesson under the Baku day", td[bakuDay(lateLesson)]?.lesson === 1 && bakuDay(lateLesson) !== lateLesson.toISOString().slice(0, 10), JSON.stringify(td));
  ok("leaves the upcoming lesson out", !Object.values(td).some((d) => d.lesson > 1));
  ok("says which day is today in Baku", t.body.today === bakuDay(new Date()), t.body.today);

  const s = await get(student);
  const st = s.body.totals || {};
  ok("answers a student", s.status === 200 && s.body.kind === "student");
  ok("counts distinct exams and every attempt", st.exams === 2 && st.attempts === 3, JSON.stringify(st));
  ok("averages and bests only their own scored attempts, skipping a stopped one", st.averagePct === 88 && st.bestPct === 95, JSON.stringify(st));
  ok("counts classes, homework and lessons attended", st.classes === 1 && st.homework === 1 && st.lessons === 1, JSON.stringify(st));
  ok("works out attendance", st.attendancePct === 50, `att ${st.attendancePct}`);
  ok("names the best result", s.body.highlight?.name === "Faizlər" && s.body.highlight?.pct === 95, JSON.stringify(s.body.highlight));
  ok("shows a student's exam days", s.body.days?.[bakuDay(daysAgo(1))]?.exam === 2, JSON.stringify(s.body.days));

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
