/*
 * AUD-008 (T3) — identity endpoints are rate-limited. Over the REAL /api/users
 * router: a per-IP cap on /login and a per-EMAIL cap on /forgotPasswordEmail
 * return 429 + Retry-After once exceeded; a fresh window (reset) allows again;
 * and — proving NAT-safety — a DIFFERENT email is NOT blocked by another email's
 * per-recipient cap.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud008-rl";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud008-rl";

const sendEmailMod = require("../../utils/sendEmail");
sendEmailMod.sendEmail = async () => ({ mocked: true });

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const errorHandler = require("../../middleware/errorMiddleware");
const authLimit = require("../../middleware/authLimit");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function request(server, { method = "POST", path, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "User-Agent": "aud008-rl" } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, retryAfter: res.headers["retry-after"] })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/users", require("../../routes/userRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // ── /login per-IP cap = 3 ──
  authLimit.__resetForTest();
  authLimit.__setForTest({ login: { max: 3, windowMs: 60000 }, email: { max: 1e9 }, emailIp: { max: 1e9 } });
  const login = () => request(server, { path: "/api/users/login", body: { email: "x@e.com", password: "whatever12" } });
  const l1 = await login(), l2 = await login(), l3 = await login(), l4 = await login();
  ok("first 3 logins are NOT rate-limited (400 auth failure, not 429)", l1.status !== 429 && l2.status !== 429 && l3.status !== 429);
  ok("4th login over the per-IP cap is 429", l4.status === 429);
  ok("429 carries a Retry-After header (seconds)", Number(l4.retryAfter) > 0);

  // ── reset clears the window ──
  authLimit.__resetForTest();
  const afterReset = await login();
  ok("after reset, login is allowed again (not 429)", afterReset.status !== 429);

  // ── /forgotPasswordEmail per-EMAIL cap = 2; a different email is unaffected ──
  authLimit.__resetForTest();
  authLimit.__setForTest({ email: { max: 2, windowMs: 60000 }, emailIp: { max: 1e9 }, login: { max: 1e9 } });
  const forgot = (e) => request(server, { path: "/api/users/forgotPasswordEmail", body: { email: e } });
  const a1 = await forgot("victim@e.com"), a2 = await forgot("victim@e.com"), a3 = await forgot("victim@e.com");
  ok("first 2 forgot-password sends for an email are allowed (200)", a1.status === 200 && a2.status === 200);
  ok("3rd send to the SAME email is 429", a3.status === 429);
  const other = await forgot("someone-else@e.com");
  ok("NAT-safe: a DIFFERENT email is not blocked by the victim's cap (200)", other.status === 200);

  // ── per-IP spray guard on the email route (emailIp) still catches many addresses ──
  authLimit.__resetForTest();
  authLimit.__setForTest({ email: { max: 1e9 }, emailIp: { max: 2, windowMs: 60000 } });
  const s1 = await forgot("a1@e.com"), s2 = await forgot("a2@e.com"), s3 = await forgot("a3@e.com");
  ok("per-IP spray guard: 3rd send across different emails from one IP is 429", s1.status === 200 && s2.status === 200 && s3.status === 429);

  authLimit.__resetForTest();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
