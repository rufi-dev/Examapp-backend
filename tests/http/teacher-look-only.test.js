/*
 * Looking around is free (owner, 2026-10-28): a teacher without a plan can open
 * every page and read what is there; the card is asked for the moment they DO
 * something (any write, opening a board, linking WhatsApp), and their students
 * cannot start an exam until they have a plan. The free start is off.
 *
 * Drives the real sign-up and auth middleware over sockets, the real exam start
 * and the real chat card handler, against in-memory Mongo.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-look-only";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-look-only";
process.env.TEACHER_PAYWALL = "on";
delete process.env.STARTER_DAYS;

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Class = require("../../models/classModel");
const Exam = require("../../models/examModel");
const Question = require("../../models/questionModel");
const Attempt = require("../../models/attemptModel");
const Message = require("../../models/messageModel");
const { generateToken } = require("../../utils");
const { protect } = require("../../middleware/authMiddleware");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c, extra = "") => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, extra); } };
const DAY = 86400000;

function request(server, { method = "GET", path: p, body, token }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path: p, headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data),
        "User-Agent": "look-only-test", ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({
        status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })(),
      })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

// The real sign-up, then every other path behind the real protect: what the wall
// lets through answers 200 here, whatever the route would really do.
function buildServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/users", require("../../routes/userRoute"));
  app.all(/^\/api\/.*/, protect, (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return http.createServer(app);
}

const tok = (u) => generateToken(u._id, u.sessionVersion);

const call = async (handler, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let thrown = null;
  await handler(req, res, (e) => { thrown = e; }).catch((e) => { thrown = e; });
  return { res, thrown };
};

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  console.log("sign-up: no free start");
  let r = await request(server, { method: "POST", path: "/api/users/register", body: { name: "Nərmin", email: "new@e.com", password: "passWord12", phone: "501234567", role: "teacher" } });
  const fresh = await User.findOne({ email: "new@e.com" }).lean();
  ok("a new teacher gets no free start", r.status === 201 && !fresh.starterUntil, JSON.stringify(r.body).slice(0, 200));
  ok("…and the app is told they have no plan", r.body.paywall === true);

  const mk = (email, extra = {}) => User.create({ name: email.split("@")[0], email, password: "passWord12", role: "teacher", teacherApproval: "approved", isVerified: true, phone: "501234567", ...extra });
  const walled = await mk("walled@e.com");
  const midStart = await mk("midstart@e.com", { starterUntil: new Date(Date.now() + 3 * DAY), examCreatesLeft: 1 });
  const payer = await mk("payer@e.com", { plan: "pro", planExpiresAt: new Date(Date.now() + 20 * DAY) });
  const lapsed = await mk("lapsed@e.com", { plan: "pro", planExpiresAt: new Date(Date.now() - DAY) });
  const student = await User.create({ name: "Şagird", email: "pupil@e.com", password: "passWord12", role: "student", isVerified: true, phone: "501234567", grade: "9" });
  const admin = await User.create({ name: "Admin", email: "admin@e.com", password: "passWord12", role: "admin", isVerified: true });
  const t = tok(walled);

  console.log("\nlooking around stays open");
  for (const p of ["/api/users/getUser", "/api/quiz/getExams", "/api/quiz/teacher/classes", "/api/materials", "/api/lesson-docs", "/api/boards/", "/api/boards/class/c1", "/api/boards/b1/files/f1", "/api/lessons/l1", "/api/billing/status"]) {
    r = await request(server, { path: p, token: t });
    ok(`GET ${p}`, r.status === 200, `status ${r.status}`);
  }

  console.log("\ndoing something asks for the card (402 subscription_required)");
  const doing = [
    ["POST", "/api/quiz/addClass"], ["POST", "/api/quiz/addExam/c1"], ["POST", "/api/quiz/duplicate/e1"],
    ["PATCH", "/api/quiz/editExam/e1"], ["DELETE", "/api/quiz/deleteExam/e1"], ["POST", "/api/quiz/class/c1/addStudent"],
    ["POST", "/api/materials"], ["POST", "/api/boards"], ["PATCH", "/api/boards/b1"], ["POST", "/api/lesson-docs"],
    ["POST", "/api/lesson-plans"], ["POST", "/api/assignments"], ["PATCH", "/api/assignments/a1/submissions/s1"],
    ["POST", "/api/quiz/generateQuestions"], ["POST", "/api/quiz/exam/e1/start"],
  ];
  for (const [method, p] of doing) {
    r = await request(server, { method, path: p, token: t, body: {} });
    ok(`${method} ${p}`, r.status === 402 && r.body.code === "subscription_required", `status ${r.status}`);
  }
  console.log("…and so do the reads that are doing something");
  for (const p of ["/api/boards/b1", "/api/boards/b1/live", "/api/boards/b1?x=1", "/api/whatsapp/teacher/qr"]) {
    r = await request(server, { path: p, token: t });
    ok(`GET ${p}`, r.status === 402, `status ${r.status}`);
  }

  console.log("\nnot doing anything: account, subscribing, the chat, background calls");
  const open = [
    ["PATCH", "/api/users/updateUser"], ["POST", "/api/users/onboarding"], ["PATCH", "/api/users/changePassword"],
    ["POST", "/api/users/push/subscribe"], ["POST", "/api/users/app-installed"], ["POST", "/api/users/logoutAll"],
    ["POST", "/api/billing/checkout"], ["POST", "/api/billing/pay-due"], ["POST", "/api/chat/ping"],
    ["POST", "/api/chat/conversations/c1/messages"], ["POST", "/api/rec/start"], ["POST", "/api/updates/seen"],
    ["POST", "/api/teacher-success/welcome-seen"], ["POST", "/api/assignments/a1/submissions/s1/seen"],
    ["POST", "/api/whatsapp/teacher/logout"],
  ];
  for (const [method, p] of open) {
    // /api/users/* are the real routes (an empty body may get their own 400): the wall's 402 is what must not come.
    r = await request(server, { method, path: p, token: t, body: {} });
    ok(`${method} ${p}`, p.startsWith("/api/users/") ? r.status !== 402 && r.status < 500 : r.status === 200, `status ${r.status}`);
  }
  r = await request(server, { method: "POST", path: "/api/users/updateUserX", token: t, body: {} });
  ok("an open path does not open its look-alikes", r.status === 402, `status ${r.status}`);

  console.log("\nwho the wall is for");
  r = await request(server, { method: "POST", path: "/api/quiz/addClass", token: tok(midStart), body: {} });
  ok("a teacher in the middle of yesterday's free start: off now, so walled too", r.status === 402);
  r = await request(server, { method: "POST", path: "/api/quiz/addClass", token: tok(lapsed), body: {} });
  ok("a plan that has ended: walled", r.status === 402);
  r = await request(server, { method: "POST", path: "/api/quiz/addClass", token: tok(payer), body: {} });
  ok("a paying teacher works", r.status === 200);
  r = await request(server, { path: "/api/boards/b1", token: tok(payer) });
  ok("…and opens boards", r.status === 200);
  r = await request(server, { method: "POST", path: "/api/quiz/exam/e1/start", token: tok(student), body: {} });
  ok("students are never walled", r.status === 200);
  r = await request(server, { method: "POST", path: "/api/quiz/addClass", token: tok(admin), body: {} });
  ok("admins are never walled", r.status === 200);
  delete process.env.TEACHER_PAYWALL;
  r = await request(server, { method: "POST", path: "/api/quiz/addClass", token: t, body: {} });
  ok("TEACHER_PAYWALL off: nobody is walled", r.status === 200);
  process.env.TEACHER_PAYWALL = "on";

  console.log("\nstudents sit exams only while their teacher has a plan");
  const ctl = require("../../controllers/quizController");
  const examFor = async (owner) => {
    const cls = await Class.create({ name: `9A-${owner.email}`, owner: owner._id, requireCode: false });
    const exam = await Exam.create({ name: "Biologiya", owner: owner._id, class: cls._id, duration: 1800, price: 0, totalMarks: 10, passingMarks: 5 });
    const q = await Question.create({ exam: exam._id, correctAnswers: [{ answer: "A", type: "Cm" }] });
    await Exam.updateOne({ _id: exam._id }, { $set: { questions: q._id } });
    await User.updateOne({ _id: student._id }, { $addToSet: { exams: exam._id } });
    return exam;
  };
  const asStudent = (exam) => ({ user: { _id: student._id, role: "student" }, params: { examId: String(exam._id) }, body: { start: true } });
  const noPlanExam = await examFor(walled);
  let sit = await call(ctl.startAttempt, asStudent(noPlanExam));
  ok("teacher without a plan: the student cannot start (403 teacher_plan)", sit.res.statusCode === 403 && sit.res.body?.reason === "teacher_plan", JSON.stringify(sit.res.body || sit.thrown?.message));
  ok("…and is told why", /müəllimin Examopia planı aktiv deyil/.test(sit.res.body?.message || ""));
  const paidExam = await examFor(payer);
  sit = await call(ctl.startAttempt, asStudent(paidExam));
  ok("teacher with a plan: the student starts", sit.res.statusCode === 200 && !!sit.res.body?.attemptId, JSON.stringify(sit.res.body || sit.thrown?.message).slice(0, 200));
  const lapsedExam = await examFor(lapsed);
  await Attempt.create({ userId: student._id, examId: lapsedExam._id, startedAt: new Date(), expiresAt: new Date(Date.now() + 20 * 60000) });
  sit = await call(ctl.startAttempt, asStudent(lapsedExam));
  ok("an exam already under way when the plan ended still resumes", sit.res.statusCode === 200 && !!sit.res.body?.attemptId, JSON.stringify(sit.res.body || sit.thrown?.message).slice(0, 200));
  const adminExam = await examFor(admin);
  sit = await call(ctl.startAttempt, asStudent(adminExam));
  ok("an admin's exam is never stopped", sit.res.statusCode === 200, JSON.stringify(sit.res.body || sit.thrown?.message).slice(0, 200));

  console.log("\nthe chat's «Təsdiq et» cards");
  const chat = require("../../controllers/chatController");
  const card = (to) => Message.create({ conversation: new mongoose.Types.ObjectId(), from: admin._id, to: to._id, ai: true, text: "Hazırladım", action: { kind: "update_exam", params: {}, title: "Test" } });
  let m = await card(walled);
  let out = await call(chat.decideAction, { user: walled, params: { id: String(m._id) }, body: { decision: "confirm" } });
  ok("no plan: confirming asks for the card (402)", out.thrown?.statusCode === 402 || out.thrown?.status === 402, String(out.thrown?.message));
  ok("…and the card stays pending for after they subscribe", (await Message.findById(m._id).lean()).action.status === "pending");
  out = await call(chat.decideAction, { user: walled, params: { id: String(m._id) }, body: { decision: "cancel" } });
  ok("…cancelling it is not doing anything", out.res.body?.action?.status === "cancelled", JSON.stringify(out.res.body));

  server.close();
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });
