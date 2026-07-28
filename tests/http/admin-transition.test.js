/*
 * AUD-005 CR-042 — admin role/capability transitions are consistent across BOTH
 * real admin routes (single upgradeUser + batch /bulk), which share one
 * server-side transition service. Invariant proven end-to-end over real sockets:
 *   non-teacher → "none" (meta cleared); admin promotion → "approved" (+provenance);
 *   "approved_legacy" is migration-owned and can NEVER be produced by the API.
 * Complements the pending-teacher CR-044 flow (approve/revoke + immediate effect).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud005-tx";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud005-tx";

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const { generateToken } = require("../../utils");
const { protect, teacherOnly, adminOnly } = require("../../middleware/authMiddleware");
const { upgradeUser, bulkUsers } = require("../../controllers/userController");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

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
  app.post("/api/users/upgradeUser", protect, adminOnly, upgradeUser);
  app.patch("/api/users/bulk", protect, adminOnly, bulkUsers);
  app.get("/probe/teacher", protect, teacherOnly, (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return http.createServer(app);
}

let seq = 0;
const mk = (over) => User.create({ name: over.email, email: over.email, password: "xxxxxxxx", ...over });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const admin = await mk({ email: `ad${seq++}@e.com`, role: "admin" });
  const student = await mk({ email: `s${seq++}@e.com`, role: "student" });
  const approvedT = await mk({ email: `t${seq++}@e.com`, role: "teacher", teacherApproval: "approved", teacherApprovalMeta: { method: "admin" } });
  const forgedT = await mk({ email: `f${seq++}@e.com`, role: "student" });

  const tok = (u) => generateToken(u._id, u.sessionVersion);
  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const doc = (id) => User.findById(id).lean();
  const probe = (u) => request(server, { method: "GET", path: "/probe/teacher", token: tok(u) });

  // ── BULK PROMOTE: student → teacher grants capability + provenance ──
  await request(server, { method: "PATCH", path: "/api/users/bulk", token: tok(admin), body: { ids: [String(student._id)], action: "role", role: "teacher" } });
  const promoted = await doc(student._id);
  ok("bulk promote: role=teacher", promoted.role === "teacher");
  ok("bulk promote: teacherApproval=approved (capable, no latent none)", promoted.teacherApproval === "approved");
  ok("bulk promote: admin provenance stamped", promoted.teacherApprovalMeta && promoted.teacherApprovalMeta.method === "admin");
  ok("bulk-promoted teacher passes the capability gate (200)", (await probe({ _id: student._id, sessionVersion: 0 })).status === 200);

  // ── BULK DEMOTE: teacher → student clears capability + provenance ──
  await request(server, { method: "PATCH", path: "/api/users/bulk", token: tok(admin), body: { ids: [String(approvedT._id)], action: "role", role: "student" } });
  const demoted = await doc(approvedT._id);
  ok("bulk demote: role=student", demoted.role === "student");
  ok("bulk demote: teacherApproval=none", demoted.teacherApproval === "none");
  ok("bulk demote: stale provenance cleared", !demoted.teacherApprovalMeta || demoted.teacherApprovalMeta.method == null);
  ok("demoted account denied by teacher gate (401)", (await probe({ _id: approvedT._id, sessionVersion: 0 })).status === 401);

  // ── INVARIANT: upgradeUser cannot mint the migration-owned approved_legacy ──
  await request(server, { method: "POST", path: "/api/users/upgradeUser", token: tok(admin), body: { id: String(forgedT._id), role: "teacher", teacherApproval: "approved_legacy" } });
  const forged = await doc(forgedT._id);
  ok("forged approved_legacy via API collapses to approved", forged.teacherApproval === "approved");
  ok("forged transition still records ADMIN provenance (not migration)", forged.teacherApprovalMeta && forged.teacherApprovalMeta.method === "admin");

  // ── upgradeUser can HOLD a teacher at pending (admin override) ──
  await request(server, { method: "POST", path: "/api/users/upgradeUser", token: tok(admin), body: { id: String(forgedT._id), role: "teacher", teacherApproval: "pending" } });
  const held = await doc(forgedT._id);
  ok("upgradeUser admin can hold at pending (non-capable)", held.teacherApproval === "pending");
  ok("held teacher denied by the gate (403)", (await probe({ _id: forgedT._id, sessionVersion: 0 })).status === 403);

  // ── upgradeUser demote clears capability ──
  await request(server, { method: "POST", path: "/api/users/upgradeUser", token: tok(admin), body: { id: String(forgedT._id), role: "student" } });
  const upDemoted = await doc(forgedT._id);
  ok("upgradeUser demote → none", upDemoted.teacherApproval === "none");
  ok("upgradeUser demote clears provenance", !upDemoted.teacherApprovalMeta || upDemoted.teacherApprovalMeta.method == null);

  // ── invalid role is rejected ──
  const bad = await request(server, { method: "POST", path: "/api/users/upgradeUser", token: tok(admin), body: { id: String(forgedT._id), role: "wizard" } });
  ok("upgradeUser rejects an invalid role (400)", bad.status === 400);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
