/*
 * Teacher Success Journey — router permission matrix (ADR §4.2).
 *
 * Proves, over real sockets against in-memory Mongo, mounting the REAL `protect`
 * + REAL `requireCapability` middleware and a faithful `ownsOrAdmin` ownership
 * check (mirroring quizController), that:
 *   - Journey ON: a new Spark teacher (teacherApproval:"pending") CAN create and
 *     publish THEIR OWN exam, but CANNOT touch another teacher's exam, cannot
 *     read other-owner data, and cannot reach admin routes.
 *   - Forging teacherLevel in the body grants nothing.
 *   - Journey OFF: the same pending teacher is denied own-scope (today's behavior
 *     is preserved).
 *   - An admin passes every gate.
 *
 * SCOPE NOTE: like pending-teacher-capability.test.js this mounts the real
 * middleware on a reconstructed chain; that the same gates ride the shipping
 * routers is a separate wiring concern (router-registration).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-matrix";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-tsj-matrix";

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Exam = require("../../models/examModel");
const { generateToken } = require("../../utils");
const { protect } = require("../../middleware/authMiddleware");
const { requireCapability } = require("../../helper/teacherCapabilities");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const { ObjectId } = mongoose.Types;

const APPROVED = new Set(["approved", "approved_legacy"]);
const isAdmin = (u) => !!u && u.role === "admin";
// Faithful mirror of quizController.ownsOrAdmin.
function ownsOrAdmin(user, doc) {
  if (isAdmin(user)) return true;
  if (!doc) return false;
  if (!doc.owner) return true;
  return String(doc.owner) === String(user._id);
}

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

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const minimalExam = (owner, over = {}) => ({ name: "E", owner, duration: 3600, price: 0, totalMarks: 100, passingMarks: 50, mode: "structured", class: new ObjectId(), typePoints: { Cm: 50 }, ...over });

function buildServer() {
  const app = express();
  app.use(express.json());
  // own-scope: create — no ownership needed (creating a new object owned by caller)
  app.post("/exam", protect, requireCapability("exam:create:own"), asyncH(async (req, res) => {
    // Server assigns ownership from the authenticated user, never the body.
    const exam = await Exam.create(minimalExam(req.user._id));
    res.status(201).json({ id: String(exam._id), owner: String(exam.owner) });
  }));
  // own-scope: publish — capability THEN ownership.
  app.post("/exam/:id/publish", protect, requireCapability("exam:publish:own"), asyncH(async (req, res) => {
    const exam = await Exam.findById(req.params.id);
    if (!ownsOrAdmin(req.user, exam)) { res.status(403); return res.json({ reason: "not_owned" }); }
    res.status(200).json({ id: String(exam._id), published: true });
  }));
  // gated: read another owner's data.
  app.get("/results/:examId", protect, requireCapability("data:access:other-owner"), asyncH(async (req, res) => {
    res.status(200).json({ ok: true });
  }));
  // admin: an administrative action.
  app.post("/admin/promoteAnyone", protect, requireCapability("admin"), asyncH(async (req, res) => {
    res.status(200).json({ ok: true });
  }));
  // gated: global mutation onto another account.
  app.post("/grantExamTo/:userId", protect, requireCapability("mutation:global"), asyncH(async (req, res) => {
    res.status(200).json({ ok: true });
  }));
  app.use(errorHandler);
  return http.createServer(app);
}

let seq = 0;
const mkUser = (over) => User.create({ name: "U", email: `tsjm${seq++}@e.com`, password: "xxxxxxxx", isVerified: true, ...over });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const spark = await mkUser({ role: "teacher", teacherApproval: "pending" }); // a brand-new Spark teacher
  const other = await mkUser({ role: "teacher", teacherApproval: "approved" });
  const admin = await mkUser({ role: "admin" });
  const otherExam = await Exam.create(minimalExam(other._id));

  const tok = (u) => generateToken(u._id, u.sessionVersion);
  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // ── Journey ON ──
  process.env.TEACHER_SUCCESS_JOURNEY_ENABLED = "1";

  const create = await request(server, { method: "POST", path: "/exam", token: tok(spark), body: { owner: String(other._id), teacherLevel: "impact" } });
  ok("Spark ON: creates OWN exam (201)", create.status === 201);
  ok("Spark ON: server assigns ownership to the caller (body owner/level ignored)", create.body.owner === String(spark._id));

  const pubOwn = await request(server, { method: "POST", path: `/exam/${create.body.id}/publish`, token: tok(spark), body: {} });
  ok("Spark ON: publishes OWN exam (200)", pubOwn.status === 200 && pubOwn.body.published === true);

  const pubOther = await request(server, { method: "POST", path: `/exam/${otherExam._id}/publish`, token: tok(spark), body: {} });
  ok("Spark ON: CANNOT publish another teacher's exam (403 not_owned)", pubOther.status === 403 && pubOther.body.reason === "not_owned");

  const readOther = await request(server, { method: "GET", path: `/results/${otherExam._id}`, token: tok(spark) });
  ok("Spark ON: CANNOT read other-owner data (403)", readOther.status === 403);

  const adminHit = await request(server, { method: "POST", path: "/admin/promoteAnyone", token: tok(spark), body: {} });
  ok("Spark ON: CANNOT reach admin route (403)", adminHit.status === 403);

  const globalHit = await request(server, { method: "POST", path: `/grantExamTo/${other._id}`, token: tok(spark), body: {} });
  ok("Spark ON: CANNOT global-mutate onto another account (403)", globalHit.status === 403);

  // ── Forged level does not help even on gated routes ──
  const forged = await request(server, { method: "POST", path: "/admin/promoteAnyone", token: tok(spark), body: { teacherLevel: "impact", role: "admin" } });
  ok("Spark ON: forged teacherLevel/role in body grants no admin (403)", forged.status === 403);

  // ── Admin passes every gate ──
  ok("admin: publishes any exam (200)", (await request(server, { method: "POST", path: `/exam/${otherExam._id}/publish`, token: tok(admin), body: {} })).status === 200);
  ok("admin: reads other-owner data (200)", (await request(server, { method: "GET", path: `/results/${otherExam._id}`, token: tok(admin) })).status === 200);
  ok("admin: reaches admin route (200)", (await request(server, { method: "POST", path: "/admin/promoteAnyone", token: tok(admin), body: {} })).status === 200);

  // ── Journey OFF: pending teacher loses own-scope (today's behavior preserved) ──
  process.env.TEACHER_SUCCESS_JOURNEY_ENABLED = "0";
  const createOff = await request(server, { method: "POST", path: "/exam", token: tok(spark), body: {} });
  ok("Spark OFF: create own exam DENIED (403) — unchanged legacy behavior", createOff.status === 403);
  ok("approved teacher OFF: still creates own exam (201)", (await request(server, { method: "POST", path: "/exam", token: tok(other), body: {} })).status === 201);

  delete process.env.TEACHER_SUCCESS_JOURNEY_ENABLED;
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
