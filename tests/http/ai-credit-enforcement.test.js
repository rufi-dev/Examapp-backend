/*
 * Teacher Success Journey — AI credit enforcement + explicit settlement (CR-122).
 * Real sockets + in-memory Mongo. Settlement is driven by req.aiCredit.usable(),
 * NEVER by HTTP status. Proves: provider-success commits; error-after-200-headers,
 * empty output and disconnect-before-done RELEASE; SSE done-then-close commits;
 * retried idempotency key does not double-charge; exhausted → typed 429; manual
 * route never blocked; admin/flag-off unmetered.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-aienf";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-tsj-aienf";
process.env.TSJ_AI_ALLOWANCE_SPARK = "10"; // 2 gens (weight 5) exhaust

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const AiCreditPeriod = require("../../models/aiCreditPeriodModel");
const AiCreditLedger = require("../../models/aiCreditLedgerModel");
const { generateToken } = require("../../utils");
const { protect } = require("../../middleware/authMiddleware");
const { chargeAi } = require("../../middleware/aiCredit");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, x ? JSON.stringify(x) : ""); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function usedFor(t) { const p = await AiCreditPeriod.findOne({ teacherId: t }); return p ? { used: p.used, reserved: p.reserved } : { used: 0, reserved: 0 }; }
async function settle(t, wantUsed, wantReserved = 0) { for (let i = 0; i < 60; i++) { const u = await usedFor(t); if (u.used === wantUsed && u.reserved === wantReserved) return u; await sleep(20); } return usedFor(t); }

function request(server, { method, path, token, headers = {}, abortAfterBytes }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } },
      (res) => {
        let got = 0; const c = [];
        res.on("data", (d) => { c.push(d); got += d.length; if (abortAfterBytes != null && got >= abortAfterBytes) { req.destroy(); resolve({ status: res.statusCode, aborted: true }); } });
        res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })() }));
      });
    req.on("error", () => resolve({ status: 0, aborted: true })); req.end();
  });
}

let seq = 0;
const mkUser = (over) => User.create({ name: "U", email: `aienf${seq++}@e.com`, password: "xxxxxxxx", isVerified: true, ...over });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Promise.all([AiCreditPeriod.createIndexes(), AiCreditLedger.createIndexes()]);

  const app = express();
  app.use(express.json());
  // provider success — validates output THEN marks usable.
  app.post("/ai/success", protect, chargeAi("ai.generate.questions"), (req, res) => { req.aiCredit && req.aiCredit.usable(); res.json({ questions: [1, 2] }); });
  // error after 200 headers — never marks usable.
  app.post("/ai/error200", protect, chargeAi("ai.generate.questions"), (req, res) => { res.status(200); res.write("{\"partial\":true"); res.end(); });
  // empty/invalid output — 200 but not usable.
  app.post("/ai/empty", protect, chargeAi("ai.generate.questions"), (req, res) => { res.json({}); });
  // SSE done-then-close — marks usable after the authoritative done.
  app.post("/ai/sse-done", protect, chargeAi("ai.generate.questions"), (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: {\"q\":1}\n\n");
    req.aiCredit && req.aiCredit.usable();
    res.write("data: {\"done\":true}\n\n");
    res.end();
  });
  // SSE that streams but the client disconnects before done — not usable.
  app.post("/ai/sse-hang", protect, chargeAi("ai.generate.questions"), (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: {\"q\":1}\n\n"); // then never sends done; client aborts
  });
  app.post("/manual", protect, (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const teacher = await mkUser({ role: "teacher", teacherApproval: "pending", teacherLevel: "spark" });
  const admin = await mkUser({ role: "admin" });
  const tok = (u) => generateToken(u._id, u.sessionVersion);
  const H = (id) => ({ "x-ai-idempotency-key": id });

  // ── Flag OFF: unmetered ──
  delete process.env.TEACHER_SUCCESS_JOURNEY_ENABLED;
  const off = await request(server, { method: "POST", path: "/ai/success", token: tok(teacher) });
  ok("flag off: works, no charge", off.status === 200 && (await AiCreditPeriod.countDocuments({ teacherId: teacher._id })) === 0);

  process.env.TEACHER_SUCCESS_JOURNEY_ENABLED = "1";

  // ── provider success commits (usable) ──
  const s1 = await request(server, { method: "POST", path: "/ai/success", token: tok(teacher), headers: H("act.success.0001") });
  ok("success (usable) commits, used=5", s1.status === 200 && (await settle(teacher._id, 5)).used === 5);

  // ── error after 200 headers RELEASES (not usable) ──
  await request(server, { method: "POST", path: "/ai/error200", token: tok(teacher), headers: H("act.err200.0001") });
  ok("error-after-200 releases (used still 5)", (await settle(teacher._id, 5)).used === 5);

  // ── empty output RELEASES ──
  await request(server, { method: "POST", path: "/ai/empty", token: tok(teacher), headers: H("act.empty.0001") });
  ok("empty output releases (used still 5)", (await settle(teacher._id, 5)).used === 5);

  // ── disconnect-before-done RELEASES ──
  await request(server, { method: "POST", path: "/ai/sse-hang", token: tok(teacher), headers: H("act.hang.0001"), abortAfterBytes: 1 });
  ok("disconnect-before-done releases (used still 5)", (await settle(teacher._id, 5)).used === 5);

  // ── SSE done-then-close COMMITS ──
  await request(server, { method: "POST", path: "/ai/sse-done", token: tok(teacher), headers: H("act.sse.0001") });
  ok("SSE done commits (used=10)", (await settle(teacher._id, 10)).used === 10);

  // ── retried idempotency key does NOT double-charge ──
  await request(server, { method: "POST", path: "/ai/success", token: tok(teacher), headers: H("act.sse.0001") }); // same key as SSE done
  await sleep(200);
  ok("retry with a settled key does not double-charge (used=10)", (await usedFor(teacher._id)).used === 10);

  // ── exhausted → typed 429 ──
  const ex = await request(server, { method: "POST", path: "/ai/success", token: tok(teacher), headers: H("act.over.0001") });
  ok("exhausted → typed 429", ex.status === 429 && ex.body.code === "ai_credit_exhausted" && ex.body.remaining === 0 && !!ex.body.resetAt, ex.body);

  // ── manual never blocked ──
  ok("manual works when AI exhausted", (await request(server, { method: "POST", path: "/manual", token: tok(teacher) })).status === 200);

  // ── admin unmetered ──
  const adm = await request(server, { method: "POST", path: "/ai/success", token: tok(admin), headers: H("act.admin.0001") });
  ok("admin unmetered", adm.status === 200 && (await AiCreditPeriod.countDocuments({ teacherId: admin._id })) === 0);

  delete process.env.TEACHER_SUCCESS_JOURNEY_ENABLED;
  delete process.env.TSJ_AI_ALLOWANCE_SPARK;
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
