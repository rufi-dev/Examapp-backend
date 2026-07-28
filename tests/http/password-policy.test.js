/*
 * AUD-008 — the shared password policy (utils.validatePassword) is the single
 * source of truth for register / resetPassword / changePassword (all three import
 * it). This proves the policy directly AND enforced at the public /register
 * endpoint: >=8 chars with at least one letter and one digit; trivial repeats
 * rejected. Modest by design so a classroom isn't locked out.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud008-pw";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud008-pw";

const sendEmailMod = require("../../utils/sendEmail");
sendEmailMod.sendEmail = async () => ({ mocked: true });

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const errorHandler = require("../../middleware/errorMiddleware");
const authLimit = require("../../middleware/authLimit");
const { validatePassword } = require("../../utils");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function request(server, { path, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "User-Agent": "aud008-pw" } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode })); });
    req.on("error", reject); req.write(data); req.end();
  });
}

async function main() {
  // ── unit: the shared validator (used by all three endpoints) ──
  ok("rejects a non-string", validatePassword(12345678).ok === false);
  ok("rejects < 8 chars", validatePassword("abc1").ok === false && validatePassword("short1a").ok === false);
  ok("rejects no-digit", validatePassword("abcdefgh").ok === false);
  ok("rejects no-letter", validatePassword("12345678").ok === false);
  ok("rejects a single repeated char", validatePassword("aaaaaaaa").ok === false);
  ok("accepts a strong password (>=8, letter+digit)", validatePassword("goodpass1").ok === true);
  ok("accepts an Azerbaijani-letter password", validatePassword("şifrə1234").ok === true);

  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/users", require("../../routes/userRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  authLimit.__resetForTest();
  authLimit.__setForTest({ register: { max: 1e9 } });

  const reg = (password, email) => request(server, { path: "/api/users/register", body: { name: "R", email, password, phone: "+99450", grade: "11", role: "student" } });

  // ── endpoint: /register enforces the policy ──
  ok("register rejects a 6-char password (400)", (await reg("short1", "a@e.com")).status === 400);
  ok("register rejects a no-digit password (400)", (await reg("abcdefgh", "b@e.com")).status === 400);
  ok("register rejects a no-letter password (400)", (await reg("12345678", "c@e.com")).status === 400);
  ok("register accepts a strong password (201)", (await reg("goodpass1", "d@e.com")).status === 201);

  authLimit.__resetForTest();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
