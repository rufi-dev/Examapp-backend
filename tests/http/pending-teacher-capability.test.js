/*
 * AUD-005 CR-044 / CR-047 — a PENDING teacher exercised through the changed
 * `quizController.isStaffUser` capability paths, over real sockets against
 * in-memory Mongo.
 *
 * SCOPE NOTE (CR-047): this test mounts the REAL middleware (protect / teacherOnly
 * / verifiedOnly / adminOnly), the REAL controllers, and the REAL error handler on
 * a RECONSTRUCTED route chain — it does NOT load the production route FILES. That
 * the SAME gates are registered on the production routers is proven separately by
 * `router-registration.test.js`. Together they show: the capability enforcement is
 * wired on the shipping routes AND behaves correctly in the controllers.
 *
 * Capability is derived on the server from teacherApproval on every request, so a
 * token stays valid across an admin transition and the effect is immediate. Matrix:
 *   pending → denied on a teacherOnly route; cannot start an UNOWNED or HIDDEN exam
 *   via the staff bypass; denied review authorization on BOTH a legacy result and a
 *   FROZEN-VERSION (frozen-author) result.
 *   → real admin APPROVE → all allowed (incl. the frozen-author branch + hidden start).
 *   → real admin REVOKE → all denied again on the next request.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud005-cr044";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud005-cr044";

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Exam = require("../../models/examModel");
const Question = require("../../models/questionModel");
const Result = require("../../models/resultModel");
const Attempt = require("../../models/attemptModel");
const ExamVersion = require("../../models/examVersionModel");
const { publishExam } = require("../../helper/examVersion");
const { generateToken } = require("../../utils");
const { protect, teacherOnly, verifiedOnly, adminOnly } = require("../../middleware/authMiddleware");
const { startAttempt, reviewByResult, getResultsByExam } = require("../../controllers/quizController");
const { upgradeUser, bulkUsers } = require("../../controllers/userController");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const { ObjectId } = mongoose.Types;

function request(server, { method, path, token, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  app.post("/api/quiz/exam/:examId/start", protect, startAttempt);
  app.get("/api/quiz/getResultsByExam/:examId", protect, teacherOnly, getResultsByExam);
  app.get("/api/quiz/reviewByResult/:resultId", protect, verifiedOnly, reviewByResult);
  app.post("/api/users/upgradeUser", protect, adminOnly, upgradeUser);
  app.patch("/api/users/bulk", protect, adminOnly, bulkUsers);
  app.use(errorHandler);
  return http.createServer(app);
}

let seq = 0;
async function startableExam(owner, over = {}) {
  const exam = await Exam.create({ name: "E", owner: owner._id, duration: 3600, price: 0, totalMarks: 100, passingMarks: 50, mode: "structured", class: new ObjectId(), typePoints: { Cm: 50 }, ...over });
  const q = await Question.create({ exam: exam._id, correctAnswers: [{ type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] }, { type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [1] }] });
  exam.questions = q._id; await exam.save();
  const pop = await Exam.findById(exam._id).populate("questions");
  const version = await publishExam(pop, pop.questions, ExamVersion, Exam);
  return { exam, version };
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();
  await ExamVersion.createIndexes();

  const admin = await User.create({ name: "Ad", email: `ad${seq++}@e.com`, password: "xxxxxxxx", role: "admin", isVerified: true });
  const other = await User.create({ name: "O", email: `o${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const student = await User.create({ name: "S", email: `s${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true });
  const T = await User.create({ name: "T", email: `t${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "pending", isVerified: true });

  const { exam: examByT, version: vByT } = await startableExam(T);
  const { exam: examUnowned } = await startableExam(other);
  const { exam: examHidden } = await startableExam(other, { hidden: true });       // pending + revoked deny cases
  const { exam: examHiddenStaff } = await startableExam(other, { hidden: true });   // approved staff-bypass case

  const answers = [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }];
  // A legacy (unversioned) result AND a FROZEN-VERSION result of T's exam.
  const legacyResult = await Result.create({ userId: student._id, examId: examByT._id, attempts: 1, earnPoints: 50, attemptId: new ObjectId(), selectedAnswers: answers });
  const versionedResult = await Result.create({ userId: student._id, examId: examByT._id, examVersionId: vByT._id, gradingSnapshotHash: vByT.contentHash, attempts: 1, earnPoints: 50, attemptId: new ObjectId(), selectedAnswers: answers });

  const tok = (u) => generateToken(u._id, u.sessionVersion);
  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const results = (examId, token) => request(server, { method: "GET", path: `/api/quiz/getResultsByExam/${examId}`, token });
  const start = (examId, token) => request(server, { method: "POST", path: `/api/quiz/exam/${examId}/start`, token, body: {} });
  const review = (resultId, token) => request(server, { method: "GET", path: `/api/quiz/reviewByResult/${resultId}`, token });

  // ── PHASE 1: pending — no staff capability anywhere ──
  ok("pending: denied on teacherOnly getResultsByExam (403)", (await results(examByT._id, tok(T))).status === 403);
  const p1u = await start(examUnowned._id, tok(T));
  ok("pending: cannot start UNOWNED exam via staff bypass (not_owned)", p1u.status === 403 && p1u.body.reason === "not_owned");
  const p1h = await start(examHidden._id, tok(T));
  ok("pending: cannot start HIDDEN exam via staff bypass (not_started)", p1h.status === 403 && p1h.body.reason === "not_started");
  ok("pending: denied review on a LEGACY result (403)", (await review(legacyResult._id, tok(T))).status === 403);
  ok("pending: denied review on a FROZEN-VERSION result (frozen-author branch, 403)", (await review(versionedResult._id, tok(T))).status === 403);

  // ── TRANSITION: real admin approve ──
  const approve = await request(server, { method: "POST", path: "/api/users/upgradeUser", token: tok(admin), body: { id: String(T._id), role: "teacher" } });
  ok("admin approve via real /upgradeUser (200)", approve.status === 200);
  const afterApprove = await User.findById(T._id).lean();
  ok("CR-042: approval → teacherApproval='approved' + admin provenance", afterApprove.teacherApproval === "approved" && afterApprove.teacherApprovalMeta && afterApprove.teacherApprovalMeta.method === "admin");

  // ── PHASE 2: approved — capability everywhere ──
  ok("approved: getResultsByExam allowed (200)", (await results(examByT._id, tok(T))).status === 200);
  const p2u = await start(examUnowned._id, tok(T));
  ok("approved: staff bypass starts the UNOWNED exam (200)", p2u.status === 200 && p2u.body.reason === undefined);
  const p2h = await start(examHiddenStaff._id, tok(T));
  ok("approved: staff bypass starts a HIDDEN exam (200)", p2h.status === 200 && p2h.body.reason === undefined);
  const p2rl = await review(legacyResult._id, tok(T));
  ok("approved: review LEGACY result authorized + answers visible", p2rl.status === 200 && Array.isArray(p2rl.body.selectedAnswers) && p2rl.body.selectedAnswers.length === 2);
  const p2rv = await review(versionedResult._id, tok(T));
  ok("approved: review FROZEN-VERSION result authorized (frozen-author branch)", p2rv.status === 200 && Array.isArray(p2rv.body.selectedAnswers));

  // ── TRANSITION: real admin revoke ──
  const revoke = await request(server, { method: "PATCH", path: "/api/users/bulk", token: tok(admin), body: { ids: [String(T._id)], action: "revoke" } });
  ok("admin revoke via real /bulk (200)", revoke.status === 200);
  ok("CR-042: revoke → teacherApproval='pending'", (await User.findById(T._id).lean()).teacherApproval === "pending");

  // ── PHASE 3: revoked — capability lost on the next request ──
  ok("revoked: getResultsByExam denied (403) — immediate", (await results(examByT._id, tok(T))).status === 403);
  ok("revoked: review LEGACY result denied (403)", (await review(legacyResult._id, tok(T))).status === 403);
  ok("revoked: review FROZEN-VERSION result denied (403)", (await review(versionedResult._id, tok(T))).status === 403);
  const p3h = await start(examHidden._id, tok(T));
  ok("revoked: HIDDEN exam start denied again (not_started)", p3h.status === 403 && p3h.body.reason === "not_started");

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
