/*
 * Analytics fields stay with the admin, and no response carries a password hash.
 *   node tests/analytics-privacy.test.js
 *
 * 2026-11-14 (analytics ported from Examopia): accounts now keep the IP they
 * signed up from, their latest IP and where they came from (utm / referrer).
 * The teacher-facing endpoints used to return whole user documents — the
 * exam results list (populated userId) and getUserById — which also meant the
 * student's bcrypt password hash reached the teacher's browser. Now: never a
 * hash, and IPs / source only for an admin.
 */
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-analytics";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-analytics";
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/userModel");
const Result = require("../models/resultModel");
const Enrollment = require("../models/enrollmentModel");
const VisitorSession = require("../models/visitorSessionModel");
const qc = require("../controllers/quizController");
const uc = require("../controllers/userController");

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
      headers: {},
      status(c) {
        this.statusCode = c;
        return this;
      },
      cookie() {
        return this;
      },
      set(k, v) {
        this.headers[k] = v;
        return this;
      },
      json(b) {
        resolve({ code: this.statusCode, body: JSON.parse(JSON.stringify(b)) });
        return this;
      },
    };
    fn(req, res, (err) => resolve({ code: res.statusCode, err: err && err.message }));
  });
const PRIVATE = ["password", "signupIp", "lastIp", "acquisition", "lastActiveAt"];
const leaks = (u) => PRIVATE.filter((k) => u && Object.prototype.hasOwnProperty.call(u, k));

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const db = mongoose.connection.db;
  const stamp = Date.now();
  const teacher = await User.create({ name: "T", email: `t${stamp}@x.az`, password: "xxxxxxxx", role: "teacher" });
  const admin = await User.create({ name: "A", email: `a${stamp}@x.az`, password: "xxxxxxxx", role: "admin" });

  // ── sign-up records where the account came from ──
  const reg = await call(uc.registerUser, {
    body: {
      name: "Şagird",
      email: `s${stamp}@x.az`,
      password: "Passw0rd1",
      phone: "+994501112233",
      grade: "9",
      acquisition: { source: "instagram", campaign: "noyabr", referrer: "https://l.instagram.com/", landing: "/" },
    },
    headers: { "user-agent": "Mozilla/5.0" },
    ip: "5.191.1.2",
  });
  ok("registration succeeds", reg.code === 201, reg);
  const student = await User.findOne({ email: `s${stamp}@x.az` }).lean();
  ok("sign-up IP and latest IP are stored", student.signupIp === "5.191.1.2" && student.lastIp === "5.191.1.2", student);
  ok("where they came from is stored", student.acquisition && student.acquisition.source === "instagram" && student.acquisition.campaign === "noyabr", student.acquisition);
  ok("registration response carries no hash or IP", leaks(reg.body).length === 0, leaks(reg.body));

  const organic = await call(uc.registerUser, {
    body: { name: "B", email: `b${stamp}@x.az`, password: "Passw0rd1", phone: "+994501112244", grade: "9", acquisition: { source: "(direct)", landing: "/" } },
    headers: { "user-agent": "Mozilla/5.0" },
    ip: "5.191.1.3",
  });
  const b = await User.findOne({ email: `b${stamp}@x.az` }).lean();
  ok("a direct visit stores no source", organic.code === 201 && !b.acquisition?.source, b.acquisition);

  // the student joins the teacher's class
  const klass = await db.collection("classes").insertOne({ name: "9A", owner: teacher._id });
  await Enrollment.create({ student: student._id, class: klass.insertedId, teacher: teacher._id, status: "approved" });

  // ── exam results list (teacher) ──
  const q = await db.collection("questions").insertOne({ correctAnswers: [{ type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [1] }] });
  const exam = await db.collection("exams").insertOne({ name: "Variant A", owner: teacher._id, questions: q.insertedId, deletedAt: null });
  await Result.create({ userId: student._id, examId: exam.insertedId, attemptId: new mongoose.Types.ObjectId(), earnPoints: 50, grades: [1] });
  const rows = await call(qc.getResultsByExam, { params: { examId: String(exam.insertedId) }, user: teacher });
  const row = Array.isArray(rows.body) ? rows.body[0] : null;
  ok("teacher sees the results list", rows.code === 200 && row && row.userId && row.userId.name === "Şagird", rows);
  ok("…with NO password hash, IP or source in the student", row && leaks(row.userId).length === 0, row && leaks(row.userId));
  ok("…but still the name, email, phone and grade", row && row.userId.email && row.userId.phone && row.userId.grade === "9", row && row.userId);

  // ── one student (getUserById) ──
  const asTeacher = await call(uc.getUserById, { params: { id: String(student._id) }, user: teacher });
  ok("teacher opens a student: no hash, IP or source", asTeacher.code === 200 && leaks(asTeacher.body).length === 0, leaks(asTeacher.body || {}));
  const asAdmin = await call(uc.getUserById, { params: { id: String(student._id) }, user: admin });
  ok("admin opens a student: IPs and source, still no hash", asAdmin.code === 200 && asAdmin.body.lastIp === "5.191.1.2" && asAdmin.body.acquisition && !("password" in asAdmin.body), asAdmin.body && leaks(asAdmin.body));

  // ── the user directory ──
  const tl = await call(uc.getUsers, { user: teacher });
  ok("teacher's student list: their student, without hash/IP/source", tl.code === 200 && tl.body.length === 1 && leaks(tl.body[0]).length === 0, tl.body && tl.body.map(leaks));
  const al = await call(uc.getUsers, { user: admin });
  const sRow = al.body.find((u) => u.email === `s${stamp}@x.az`);
  ok("admin's directory: IPs and source, no hash", sRow && sRow.lastIp && sRow.acquisition && !al.body.some((u) => "password" in u), sRow);

  // an older account with no stored source picks it up from a signed-in visit
  await VisitorSession.create({ sessionId: `v${stamp}`, userId: b._id, affiliate: "tiktok", campaign: "qış", firstSeen: new Date() });
  const al2 = await call(uc.getUsers, { user: admin });
  const bRow = al2.body.find((u) => u.email === `b${stamp}@x.az`);
  ok("admin's directory: «came from» matched from the visit", bRow && bRow.acquisitionMatched && bRow.acquisitionMatched.source === "tiktok", bRow && bRow.acquisitionMatched);

  // ── teacher setup funnel ──
  const f = await call(uc.getSetupFunnel, { user: admin });
  ok("setup funnel counts the teacher as finished (class, exam with content, a student)", f.code === 200 && f.body.total === 1 && f.body.finished === 1 && f.body.notStarted === 0, f.body);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
