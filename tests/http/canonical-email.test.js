/*
 * AUD-008 CR-050 — canonical identity. `Teacher@Example.com` and
 * `teacher@example.com` (and whitespace variants) are ONE account across register,
 * password login, code login/send, forgot, and Google reconciliation; the
 * rate-limit key is canonical too.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud008-canon";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud008-canon";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-google";

const sendEmailMod = require("../../utils/sendEmail");
sendEmailMod.sendEmail = async () => ({ mocked: true });
const userController = require("../../controllers/userController");

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const errorHandler = require("../../middleware/errorMiddleware");
const authLimit = require("../../middleware/authLimit");
const { emailBucketKey } = require("../../utils");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function request(server, { method = "POST", path, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "User-Agent": "canon" } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })() })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await User.createIndexes(); // build the unique email index
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/users", require("../../routes/userRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  authLimit.__setForTest({ login: { max: 1e9 }, register: { max: 1e9 }, email: { max: 1e9 }, emailIp: { max: 1e9 } });

  // ── register stores the canonical (lower-cased) email ──
  const reg = await request(server, { path: "/api/users/register", body: { name: "R", email: "  Teacher@Example.COM ", password: "goodpass1", phone: "+99450", grade: "11", role: "student" } });
  ok("register accepted (201)", reg.status === 201);
  ok("stored email is canonical (lowercased/trimmed)", reg.body.email === "teacher@example.com");
  ok("exactly one user row exists", (await User.countDocuments({})) === 1);

  // ── a case/whitespace-variant registration is a DUPLICATE (same identity) ──
  const dup = await request(server, { path: "/api/users/register", body: { name: "R2", email: "TEACHER@example.com", password: "goodpass1", phone: "+99450", grade: "11", role: "student" } });
  ok("case-variant re-register is rejected as duplicate (400)", dup.status === 400);
  ok("still exactly one user (no case-variant duplicate)", (await User.countDocuments({})) === 1);

  // ── password login works with a different-case email ──
  const login = await request(server, { path: "/api/users/login", body: { email: "Teacher@Example.com", password: "goodpass1" } });
  ok("login succeeds with a case-variant email (200)", login.status === 200);

  // ── forgot works with a case variant (generic 200) and finds the account ──
  const forgot = await request(server, { path: "/api/users/forgotPasswordEmail", body: { email: "  TEACHER@EXAMPLE.COM " } });
  ok("forgot returns 200 for a case-variant of a real account", forgot.status === 200);

  // ── Google reconciliation matches the existing account by canonical email ──
  userController.__setGoogleVerifyForTest(async () => ({ name: "G", email: "Teacher@Example.COM", picture: "http://x/p", sub: "s" }));
  const go = await request(server, { path: "/api/users/google/callback", body: { code: "x" } });
  ok("Google login reconciles to the SAME account (200)", go.status === 200);
  ok("Google did NOT create a case-variant duplicate", (await User.countDocuments({})) === 1);
  userController.__setGoogleVerifyForTest(null);

  // ── the rate-limit key is canonical + HMAC (no raw email) ──
  ok("emailBucketKey is case/whitespace-insensitive", emailBucketKey("Teacher@Example.com") === emailBucketKey("  teacher@example.com "));
  ok("emailBucketKey does not contain the raw address", !emailBucketKey("teacher@example.com").includes("teacher"));

  authLimit.__resetForTest();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
