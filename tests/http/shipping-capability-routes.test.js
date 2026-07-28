/*
 * CR-124 — the SHIPPING quiz router (routes/quizRoute.js, NOT a reconstruction)
 * gates own-scope routes with requireCapability and keeps risky/admin routes
 * gated. Proves over real sockets + in-memory Mongo that, with the flag ON, a new
 * pending Spark teacher REACHES an own-scope route (capability gate passes) but is
 * refused a gated (other-owner/global) route and an admin route; and that with the
 * flag OFF the pending teacher is refused own-scope (today's behavior preserved),
 * while an approved teacher always passes.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-ship";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-tsj-ship";

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const { generateToken } = require("../../utils");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, x != null ? `(got ${x})` : ""); } };
const { ObjectId } = mongoose.Types;

function request(server, { method, path, token, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

let seq = 0;
const mkUser = (over) => User.create({ name: "U", email: `ship${seq++}@e.com`, password: "xxxxxxxx", isVerified: true, ...over });
const notAuth = (s) => s === 401 || s === 403; // capability/authz denial
const passedGate = (s) => !notAuth(s); // reached the controller (any other status)

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await User.createIndexes();

  const app = express();
  app.use(express.json());
  app.use("/api/quiz", require("../../routes/quizRoute")); // the REAL shipping router
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const spark = await mkUser({ role: "teacher", teacherApproval: "pending", teacherLevel: "spark" });
  const approved = await mkUser({ role: "teacher", teacherApproval: "approved" });
  const tok = (u) => generateToken(u._id, u.sessionVersion);
  const OWN = { method: "POST", path: "/api/quiz/addClass", body: { name: "My Class" } };       // requireCapability class:manage:own
  const GATED = { method: "POST", path: `/api/quiz/addExamToUserById/${new ObjectId()}`, body: {} }; // teacherOnly (approved)
  const ADMIN = { method: "GET", path: "/api/quiz/aiUsage" };                                    // adminOnly

  // ── Flag ON: pending Spark reaches own-scope, denied gated + admin ──
  process.env.TEACHER_SUCCESS_JOURNEY_ENABLED = "1";
  const own = await request(server, { ...OWN, token: tok(spark) });
  ok("Spark ON: reaches own-scope addClass (capability gate passes)", passedGate(own.status), own.status);
  const gated = await request(server, { ...GATED, token: tok(spark) });
  ok("Spark ON: denied gated addExamToUserById (403)", gated.status === 403, gated.status);
  const admin = await request(server, { ...ADMIN, token: tok(spark) });
  ok("Spark ON: denied admin aiUsage (401)", admin.status === 401, admin.status);

  // ── Flag OFF: pending Spark denied own-scope (today's behavior) ──
  process.env.TEACHER_SUCCESS_JOURNEY_ENABLED = "0";
  const ownOff = await request(server, { ...OWN, token: tok(spark) });
  ok("Spark OFF: own-scope addClass denied (403) — preserved", ownOff.status === 403, ownOff.status);

  // ── Approved teacher always passes own-scope (both flag states) ──
  const appOff = await request(server, { ...OWN, token: tok(approved) });
  ok("approved OFF: reaches own-scope addClass", passedGate(appOff.status), appOff.status);
  process.env.TEACHER_SUCCESS_JOURNEY_ENABLED = "1";
  const appOn = await request(server, { ...OWN, token: tok(approved) });
  ok("approved ON: reaches own-scope addClass", passedGate(appOn.status), appOn.status);

  delete process.env.TEACHER_SUCCESS_JOURNEY_ENABLED;
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
