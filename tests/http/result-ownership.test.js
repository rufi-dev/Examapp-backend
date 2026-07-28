/*
 * AUD-006 regression (AUD-006-T1/T2): only the exam OWNER (or an admin) may
 * append a photo to a result. Full HTTP stack — a minimal Express app mounting
 * the REAL route (protect + teacherOnly + addPhotoToResult) + the real error
 * middleware — exercised over real sockets against in-memory Mongo.
 *
 * Tenant matrix: owner, admin, unrelated teacher, student, anonymous, missing
 * resource, invalid id, and invalid media. Authorization is server-side (from
 * req.user + the result's exam owner), never client-provided identity. An
 * unauthorized caller and a missing result get the SAME 404 (no existence leak).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud006";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-key-aud006";
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Exam = require("../../models/examModel");
const Result = require("../../models/resultModel");
const { generateToken } = require("../../utils");
const { protect, teacherOnly } = require("../../middleware/authMiddleware");
const { addPhotoToResult } = require("../../controllers/quizController");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function buildServer() {
  const app = express();
  app.use(express.json());
  app.post("/api/quiz/addPhotoToResult/:resultId", protect, teacherOnly, addPhotoToResult);
  app.use(errorHandler);
  return http.createServer(app);
}

function request(server, { token, resultId, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      {
        host: "127.0.0.1", port, method: "POST",
        path: `/api/quiz/addPhotoToResult/${resultId}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const PHOTO = "https://res.cloudinary.com/x/solution.jpg";

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const teacherA = await User.create({ name: "A", email: "a@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved" });
  const teacherB = await User.create({ name: "B", email: "b@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved" });
  const admin = await User.create({ name: "Ad", email: "ad@e.com", password: "xxxxxxxx", role: "admin" });
  const student = await User.create({ name: "S", email: "s@e.com", password: "xxxxxxxx", role: "student" });
  const exam = await Exam.create({
    name: "E", owner: teacherA._id, duration: 600, price: 0,
    totalMarks: 100, passingMarks: 50, class: new mongoose.Types.ObjectId(),
  });
  const result = await Result.create({
    userId: student._id, examId: exam._id, attempts: 1, earnPoints: 10,
    attemptId: new mongoose.Types.ObjectId(),
  });

  const tok = (u) => generateToken(u._id, u.sessionVersion);
  const rid = String(result._id);
  const missingId = String(new mongoose.Types.ObjectId());

  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // --- anonymous / student / role gate ---
  const anon = await request(server, { resultId: rid, body: { photo: PHOTO } });
  ok("anonymous is rejected (401)", anon.status === 401);
  const stud = await request(server, { token: tok(student), resultId: rid, body: { photo: PHOTO } });
  ok("student is rejected by role gate (401)", stud.status === 401);

  // --- IDOR: unrelated teacher must NOT mutate another owner's result ---
  const unrelatedExisting = await request(server, { token: tok(teacherB), resultId: rid, body: { photo: PHOTO } });
  ok("unrelated teacher is denied (404, not 200)", unrelatedExisting.status === 404);

  // --- no existence leak: unrelated-on-existing == anyone-on-missing ---
  const unrelatedMissing = await request(server, { token: tok(teacherB), resultId: missingId, body: { photo: PHOTO } });
  ok("missing result returns 404", unrelatedMissing.status === 404);
  const stableError = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      delete parsed.requestId; // correlation is intentionally unique per request
      return JSON.stringify(parsed);
    } catch {
      return raw;
    }
  };
  ok("no existence leak: denied-existing and missing are indistinguishable",
    unrelatedExisting.status === unrelatedMissing.status &&
      stableError(unrelatedExisting.body) === stableError(unrelatedMissing.body));

  // --- invalid id + invalid media ---
  const badId = await request(server, { token: tok(teacherA), resultId: "not-a-valid-id", body: { photo: PHOTO } });
  ok("invalid result id returns 400 (not 500)", badId.status === 400);
  const badMedia = await request(server, { token: tok(teacherA), resultId: rid, body: { photo: "javascript:alert(1)" } });
  ok("invalid media is rejected (400)", badMedia.status === 400);

  // --- confirm NO mutation happened on any denied/invalid attempt so far ---
  const midState = await Result.findById(result._id).lean();
  ok("no photo was stored by any denied/invalid request", (midState.photos || []).length === 0);

  // --- owner + admin succeed ---
  const ownerRes = await request(server, { token: tok(teacherA), resultId: rid, body: { photo: PHOTO } });
  ok("exam owner succeeds (200)", ownerRes.status === 200);
  const adminRes = await request(server, { token: tok(admin), resultId: rid, body: { photo: PHOTO + "2" } });
  ok("admin succeeds (200)", adminRes.status === 200);

  const finalState = await Result.findById(result._id).lean();
  ok("owner + admin photos were stored (2)", (finalState.photos || []).length === 2);

  // --- minimal DTO: response must not echo answers/score ---
  let dto = {};
  try { dto = JSON.parse(ownerRes.body); } catch { /* ignore */ }
  ok("success response is a minimal DTO (no selectedAnswers/correctAnswers/earnPoints)",
    dto.selectedAnswers === undefined && dto.correctAnswers === undefined && dto.earnPoints === undefined && Array.isArray(dto.photos));

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
