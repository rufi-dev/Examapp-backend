/*
 * AUD-005-T1 — server-derived capability matrix. Six principals
 * (anonymous, student, pending-teacher, approved-teacher, legacy-teacher, admin)
 * exercised over real sockets against in-memory Mongo through:
 *
 *   • the REAL teacherOnly gate (protect + teacherOnly) — the SINGLE enforcement
 *     point shared by all ~63 teacher routes across 7 routers, so one probe
 *     faithfully represents every one of them;
 *   • the REAL adminOnly gate — shared by all ~9 admin routes;
 *   • the REAL achievements router — whose mutations AUD-005 moved from
 *     teacherOnly to adminOnly (global, unscoped platform content), with reads
 *     left public.
 *
 * Authority is derived on the SERVER from persisted approval state, never from
 * the bare role string. A pending teacher is authenticated but has NO teacher
 * capability (403). Only approved/legacy teachers (and admins) pass teacherOnly;
 * only admins pass adminOnly.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud005-matrix";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud005-matrix";

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Achivement = require("../../models/achivementModel");
const { generateToken } = require("../../utils");
const { protect, teacherOnly, adminOnly } = require("../../middleware/authMiddleware");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function request(server, { method = "GET", path, body, token }) {
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
  app.use(cookieParser());
  app.get("/probe/teacher", protect, teacherOnly, (req, res) => res.json({ ok: true }));
  app.get("/probe/admin", protect, adminOnly, (req, res) => res.json({ ok: true }));
  app.use("/api/achievements", require("../../routes/achivementRoute"));
  app.use(errorHandler);
  return http.createServer(app);
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const mk = (over) => User.create({ name: over.email, email: over.email, password: "xxxxxxxx", ...over });
  const student = await mk({ email: "s@e.com", role: "student" });
  const pending = await mk({ email: "pt@e.com", role: "teacher", teacherApproval: "pending" });
  const approved = await mk({ email: "at@e.com", role: "teacher", teacherApproval: "approved" });
  const legacy = await mk({ email: "lt@e.com", role: "teacher", teacherApproval: "approved_legacy" });
  const admin = await mk({ email: "ad@e.com", role: "admin" });
  const tok = (u) => generateToken(u._id, u.sessionVersion);

  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // Principal → expected status. Anonymous carries no token.
  const principals = [
    ["anonymous", null],
    ["student", tok(student)],
    ["pending-teacher", tok(pending)],
    ["approved-teacher", tok(approved)],
    ["legacy-teacher", tok(legacy)],
    ["admin", tok(admin)],
  ];

  // ── teacherOnly gate ──
  const teacherExpect = { "anonymous": 401, "student": 401, "pending-teacher": 403, "approved-teacher": 200, "legacy-teacher": 200, "admin": 200 };
  for (const [name, token] of principals) {
    const r = await request(server, { path: "/probe/teacher", token });
    ok(`teacherOnly: ${name} → ${teacherExpect[name]}`, r.status === teacherExpect[name]);
  }

  // ── adminOnly gate (only admin passes; a teacher of any approval does not) ──
  const adminExpect = { "anonymous": 401, "student": 401, "pending-teacher": 401, "approved-teacher": 401, "legacy-teacher": 401, "admin": 200 };
  for (const [name, token] of principals) {
    const r = await request(server, { path: "/probe/admin", token });
    ok(`adminOnly: ${name} → ${adminExpect[name]}`, r.status === adminExpect[name]);
  }

  // ── achievements: mutations are admin-only; a teacher can no longer touch
  //    global content. Reads stay public. (End-to-end on the REAL router.) ──
  const seed = await Achivement.create({ title: "T", about: "a", photo: "p", size: "s" });
  // approved teacher — highest teacher authority — must be DENIED the mutation.
  const teacherAdd = await request(server, { method: "POST", path: "/api/achievements/addAchivement", token: tok(approved), body: { title: "X", about: "a", photo: "p", size: "s" } });
  ok("achievements: approved teacher CANNOT create (401)", teacherAdd.status === 401);
  const teacherDel = await request(server, { method: "DELETE", path: `/api/achievements/deleteAchivement/${seed._id}`, token: tok(approved) });
  ok("achievements: approved teacher CANNOT delete (401)", teacherDel.status === 401);
  ok("achievements: teacher's denied delete did NOT remove the record", await Achivement.countDocuments({ _id: seed._id }) === 1);

  // admin can manage global content.
  const adminAdd = await request(server, { method: "POST", path: "/api/achievements/addAchivement", token: tok(admin), body: { title: "X", about: "a", photo: "p", size: "s" } });
  ok("achievements: admin CAN create (200/201)", adminAdd.status === 200 || adminAdd.status === 201);
  const adminDel = await request(server, { method: "DELETE", path: `/api/achievements/deleteAchivement/${seed._id}`, token: tok(admin) });
  ok("achievements: admin CAN delete (200)", adminDel.status === 200);

  // reads remain public — even anonymous.
  const anonRead = await request(server, { method: "GET", path: "/api/achievements/getAchivements" });
  ok("achievements: anonymous CAN read (200)", anonRead.status === 200);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
