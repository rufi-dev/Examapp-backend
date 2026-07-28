/*
 * AUD-008 (T1) — identity endpoints do NOT enumerate accounts. Over the REAL
 * /api/users router, an existing vs a non-existing email must yield an IDENTICAL
 * status + body for login, forgotPasswordEmail, sendLoginCode, and loginWithCode.
 * Rate limits are set high so repeated probes don't 429 mid-test.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud008-enum";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud008-enum";

const sendEmailMod = require("../../utils/sendEmail");
sendEmailMod.sendEmail = async () => ({ mocked: true });

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const Cryptr = require("cryptr");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Token = require("../../models/tokenModel");
const errorHandler = require("../../middleware/errorMiddleware");
const authLimit = require("../../middleware/authLimit");
const cryptr = new Cryptr(process.env.CRYPTR_KEY);

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function request(server, { method = "POST", path, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "User-Agent": "aud008-enum" } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
const stableBody = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    delete parsed.requestId; // per-request correlation is intentionally unique
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
};
const same = (a, b) =>
  a.status === b.status && stableBody(a.body) === stableBody(b.body);

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

  // Disable rate limits for this suite so repeated probes don't 429.
  authLimit.__setForTest({ login: { max: 1e9 }, register: { max: 1e9 }, email: { max: 1e9 }, emailIp: { max: 1e9 }, reset: { max: 1e9 } });

  const existing = "real@e.com";
  const user = await User.create({ name: "R", email: existing, password: "passWord12", phone: "+99450", role: "student", grade: "11", isVerified: true, userAgent: [] });
  // A live login-code token for the existing user (so the send path is exercised).
  await Token.create({ userId: user._id, lToken: cryptr.encrypt("135790"), createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
  const missing = "ghost@e.com";

  // ── login: unknown email vs wrong password are indistinguishable ──
  const lMissing = await request(server, { path: "/api/users/login", body: { email: missing, password: "whatever12" } });
  const lWrong = await request(server, { path: "/api/users/login", body: { email: existing, password: "wrongPass9" } });
  ok("login unknown-email == wrong-password (status+body identical)", same(lMissing, lWrong));
  ok("login failure is 400", lMissing.status === 400);

  // ── forgotPasswordEmail: existing vs non-existing identical ──
  const fExisting = await request(server, { path: "/api/users/forgotPasswordEmail", body: { email: existing } });
  const fMissing = await request(server, { path: "/api/users/forgotPasswordEmail", body: { email: missing } });
  ok("forgotPassword existing == non-existing (identical)", same(fExisting, fMissing));
  ok("forgotPassword returns 200 generic", fExisting.status === 200 && /qeydiyyatdadırsa/.test(fExisting.body));

  // ── sendLoginCode: existing vs non-existing identical ──
  const cExisting = await request(server, { method: "POST", path: `/api/users/sendLoginCode/${existing}` });
  const cMissing = await request(server, { method: "POST", path: `/api/users/sendLoginCode/${missing}` });
  ok("sendLoginCode existing == non-existing (identical)", same(cExisting, cMissing));
  ok("sendLoginCode returns 200 generic", cExisting.status === 200 && /mövcuddursa/.test(cExisting.body));

  // Re-seed a fresh login-code token (forgotPasswordEmail above replaces the
  // user's token with a reset token, so the code token no longer exists).
  await Token.deleteMany({ userId: user._id });
  await Token.create({ userId: user._id, lToken: cryptr.encrypt("135790"), createdAt: Date.now(), expiresAt: Date.now() + 3600000 });

  // ── loginWithCode: unknown email vs wrong code identical ──
  const wMissing = await request(server, { method: "POST", path: `/api/users/loginWithCode/${missing}`, body: { loginCode: "000000" } });
  const wWrong = await request(server, { method: "POST", path: `/api/users/loginWithCode/${existing}`, body: { loginCode: "000000" } });
  ok("loginWithCode unknown-email == wrong-code (identical)", same(wMissing, wWrong));
  ok("loginWithCode failure is 400", wMissing.status === 400);
  // sanity: the CORRECT code still logs in (uniformity didn't break the happy path)
  const wGood = await request(server, { method: "POST", path: `/api/users/loginWithCode/${existing}`, body: { loginCode: "135790" } });
  ok("loginWithCode with the correct code succeeds (200)", wGood.status === 200);

  authLimit.__resetForTest();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
