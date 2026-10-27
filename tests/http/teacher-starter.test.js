/*
 * The free start (owner, 2026-10-27): a teacher who never paid gets 7 days with
 * ONE exam on the free tier's limits (1 class, 10 students) before the card wall.
 * Whichever comes first, the days running out or reaching past a limit, ends with
 * the wall and its 7-day card trial.
 *
 * Drives the real user router and auth middleware over sockets against in-memory
 * Mongo: sign-up (form and Google), the wall on a live teacher route, the exam
 * allowance, a teacher from before the change whose start begins on their next
 * visit, and the one-time migration that marks those teachers.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-starter";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-starter";
process.env.TEACHER_PAYWALL = "on";

const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Exam = require("../../models/examModel");
const { generateToken } = require("../../utils");
const { protect, teacherOnly } = require("../../middleware/authMiddleware");
const errorHandler = require("../../middleware/errorMiddleware");
const PL = require("../../helper/planLimits");

let passed = 0, failed = 0;
const ok = (n, c, extra = "") => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, extra); } };
const DAY = 86400000;
const near = (date, ms) => !!date && Math.abs(new Date(date).getTime() - ms) < 60000;

function request(server, { method = "POST", path: p, body, token }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data),
        "User-Agent": "starter-test", ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({
        status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })(),
      })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

function buildServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/users", require("../../routes/userRoute"));
  app.get("/probe/teacher", protect, teacherOnly, (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return http.createServer(app);
}

const tok = (u) => generateToken(u._id, u.sessionVersion);
const throws402 = async (fn, resource) => {
  try { await fn(); return false; } catch (e) { return e.statusCode === 402 && e.details?.resource === resource; }
};

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // ── sign-up on the form ──
  console.log("sign-up");
  let r = await request(server, { path: "/api/users/register", body: { name: "Nərmin", email: "new@e.com", password: "passWord12", phone: "501234567", role: "teacher" } });
  let u = await User.findOne({ email: "new@e.com" });
  ok("a new teacher gets the free start: 7 days", r.status === 201 && near(u.starterUntil, Date.now() + 7 * DAY));
  ok("…one exam, and the welcome credits for writing it with AI", u.examCreatesLeft === 1 && u.aiCredits === 60);
  ok("…and the app is told: no wall, and when the free start ends", r.body.paywall === false && near(r.body.starterUntil, Date.now() + 7 * DAY));
  r = await request(server, { method: "GET", path: "/probe/teacher", token: tok(u) });
  ok("…so teacher routes are open to them", r.status === 200);
  r = await request(server, { method: "GET", path: "/api/users/getUser", token: tok(u) });
  ok("…and the account data says the same", r.status === 200 && r.body.paywall === false && !!r.body.starterUntil);
  ok("…with the free start's one exam in the usage", r.body.usage?.examCreates?.limit === 1 && r.body.usage?.examCreates?.left === 1, JSON.stringify(r.body.usage?.examCreates));
  await request(server, { path: "/api/users/register", body: { name: "Şagird", email: "pupil@e.com", password: "passWord12", phone: "501234568", grade: "9", role: "student" } });
  const pupil = await User.findOne({ email: "pupil@e.com" });
  ok("a student gets no free start (students are never walled)", !pupil.starterUntil && pupil.examCreatesLeft === null);

  // ── the one exam ──
  console.log("\nthe one exam");
  ok("the first exam is allowed", (await PL.assertExamCreate(u)) === undefined);
  await PL.consumeExamCreate(u);
  u = await User.findById(u._id);
  ok("…and spends the free start's only exam", u.examCreatesLeft === 0);
  ok("a second exam is refused with the plan-limit 402 the app turns into the wall", await throws402(() => PL.assertExamCreate(u), "exams"));
  const usage = await PL.usageFor(u);
  ok("the plan page shows 0 of 1 left, not the free tier's 3", usage.examCreates.left === 0 && usage.examCreates.limit === 1);
  ok("…and the free tier's 1 class and 10 students", usage.classes.limit === 1 && usage.students.limit === 10);

  // ── the days run out ──
  console.log("\nthe days run out");
  await User.updateOne({ _id: u._id }, { $set: { starterUntil: new Date(Date.now() - 1000) } });
  r = await request(server, { method: "GET", path: "/probe/teacher", token: tok(u) });
  ok("after 7 days the wall is up on teacher routes", r.status === 402 && r.body.code === "subscription_required");
  r = await request(server, { method: "GET", path: "/api/users/getUser", token: tok(u) });
  ok("…and the account data tells the app to show it", r.body.paywall === true && !!r.body.starterUntil);

  // ── a teacher from before the free start ──
  console.log("\na teacher from before");
  const old = await User.create({ name: "Köhnə", email: "old@e.com", password: "passWord12", role: "teacher", teacherApproval: "approved", starterPending: true, aiCredits: 5, examCreatesLeft: 3 });
  r = await request(server, { method: "GET", path: "/probe/teacher", token: tok(old) });
  let o = await User.findById(old._id).lean();
  ok("their next visit gets through", r.status === 200);
  ok("…and starts their 7 days from now", near(o.starterUntil, Date.now() + 7 * DAY) && o.starterPending === undefined);
  ok("…with one exam and at least the welcome credits", o.examCreatesLeft === 1 && o.aiCredits === 60);
  const rich = await User.create({ name: "Kreditli", email: "rich@e.com", password: "passWord12", role: "teacher", teacherApproval: "approved", starterPending: true, aiCredits: 200 });
  await request(server, { method: "GET", path: "/probe/teacher", token: tok(rich) });
  o = await User.findById(rich._id).lean();
  ok("credits they already had are kept, not cut to the welcome amount", o.aiCredits === 200 && !!o.starterUntil);
  r = await request(server, { method: "GET", path: "/probe/teacher", token: tok(old) });
  o = await User.findById(old._id).lean();
  ok("a second visit does not restart the days", r.status === 200 && near(o.starterUntil, Date.now() + 7 * DAY) && o.examCreatesLeft === 1);

  // ── who the free start is not for ──
  console.log("\nnot for everyone");
  const lapsed = await User.create({ name: "Ödəmiş", email: "paid@e.com", password: "passWord12", role: "teacher", teacherApproval: "approved", plan: "pro", planExpiresAt: new Date(Date.now() - DAY) });
  r = await request(server, { method: "GET", path: "/probe/teacher", token: tok(lapsed) });
  ok("a teacher whose paid plan ended gets no free start: walled", r.status === 402);
  const payer = await User.create({ name: "Pro", email: "pro@e.com", password: "passWord12", role: "teacher", teacherApproval: "approved", plan: "pro", planExpiresAt: new Date(Date.now() + 20 * DAY), starterUntil: new Date(Date.now() + 3 * DAY) });
  ok("a paying teacher's exams stay unlimited even with a free start on record", (await PL.usageFor(payer)).examCreates.limit === null);

  // ── Google sign-up: the role is picked after the account exists ──
  console.log("\nGoogle sign-up");
  const g = await User.create({ name: "Google", email: "g@e.com", password: "passWord12", role: "student", onboarded: false });
  r = await request(server, { method: "PATCH", path: "/api/users/updateUser", token: tok(g), body: { role: "teacher", phone: "501234569" } });
  const gu = await User.findById(g._id).lean();
  ok("choosing «Müəllim» gives the same free start", r.status === 200 && gu.role === "teacher" && near(gu.starterUntil, Date.now() + 7 * DAY) && gu.examCreatesLeft === 1);
  ok("…and the app is told it is not walled", r.body.paywall === false && !!r.body.starterUntil);

  // ── the wall switched off: the free tier is back to its own exam allowance ──
  delete process.env.TEACHER_PAYWALL;
  const fresh = await User.findById(gu._id);
  ok("with the wall off, the free tier's 3 exams apply again", (await PL.usageFor(fresh)).examCreates.limit === 3);
  process.env.TEACHER_PAYWALL = "on";

  // ── the one-time migration ──
  console.log("\nthe migration");
  await User.deleteMany({});
  await Exam.collection.deleteMany({});
  const mk = (o) => User.collection.insertOne({ password: "x", teacherApproval: "approved", role: "teacher", ...o });
  const never = (await mk({ email: "never@e.com" })).insertedId;
  const made = (await mk({ email: "made@e.com" })).insertedId;
  await mk({ email: "trial@e.com", stripeTrialUsedAt: new Date() });
  await mk({ email: "admin-plan@e.com", plan: "premium" });
  await mk({ email: "dropped@e.com", planDowngradedAt: new Date() });
  await mk({ email: "started@e.com", starterUntil: new Date(Date.now() + DAY) });
  await mk({ email: "kid@e.com", role: "student" });
  const draftOnly = (await mk({ email: "draft@e.com" })).insertedId;
  await Exam.collection.insertOne({ owner: made, name: "Real", deletedAt: new Date() });
  await Exam.collection.insertOne({ owner: draftOnly, name: "Draft", provisional: true });
  const run = (mode) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(__dirname, "../../migrations/2026-10-27-teacher-starter.js"), `--${mode}`], { env: { ...process.env, MONGO_URI: `${mem.getUri()}test` }, encoding: "utf8" }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout || "") };
    }
  };
  let m = run("dry-run");
  ok("dry run: counts the two who never paid and never made an exam", /"wouldMark":2/.test(m.out), m.out);
  ok("…and changes nothing", (await User.countDocuments({ starterPending: true })) === 0);
  m = run("verify");
  ok("verify fails while they are unmarked", m.code === 1);
  m = run("apply");
  const marked = (await User.find({ starterPending: true }).lean()).map((x) => String(x._id)).sort();
  ok("apply marks exactly them (a deleted real exam counts as made; a draft does not)", /"marked":2/.test(m.out) && marked.join() === [String(never), String(draftOnly)].sort().join(), m.out);
  ok("re-running marks nobody twice", /"marked":0/.test(run("apply").out));
  ok("verify passes", run("verify").code === 0);

  server.close();
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
