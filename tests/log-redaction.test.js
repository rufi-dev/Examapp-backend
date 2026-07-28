/*
 * AUD-007 regression: the login path must not write the password hash (or the
 * full user document) to logs. Captures console output while exercising the
 * real loginUser controller (success + wrong-password) against in-memory Mongo.
 *
 * Test ID: AUD-007-T1.
 */
// Dummy secrets so userController's module-load initializers (JWT / Cryptr) don't
// throw. These are test-only and never touch production config.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud007";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-key-aud007";
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/userModel");
const { loginUser } = require("../controllers/userController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function mockRes() {
  return {
    statusCode: 200,
    _json: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this._json = p; return this; },
    cookie() { return this; },
  };
}

// Capture everything written to console during a block.
async function capture(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const grab = (...a) => { lines.push(a.map((x) => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return String(x); } }).join(" ")); };
  console.log = grab; console.warn = grab; console.error = grab; console.info = grab;
  try { await fn(); } finally { Object.assign(console, orig); }
  return lines.join("\n");
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const PLAIN = "corr3ctH0rse!";
  const u = await User.create({ name: "L", email: "login@e.com", password: PLAIN, role: "student" });
  const hash = (await User.findById(u._id).select("+password")).password;
  ok("precondition: a bcrypt hash exists", typeof hash === "string" && hash.startsWith("$2"));

  const req = { body: { email: "login@e.com", password: PLAIN }, headers: { "user-agent": "jest" }, ip: "127.0.0.1" };

  // Successful login
  const okLogs = await capture(async () => { await loginUser(req, mockRes(), (e) => { if (e) throw e; }); });
  ok("successful login logs do NOT contain the bcrypt hash", !okLogs.includes(hash));
  ok("successful login logs do NOT contain the plaintext password", !okLogs.includes(PLAIN));
  ok("successful login logs do NOT dump the whole user doc ('login user')", !/login user/i.test(okLogs));

  // Wrong-password login (failure path / catch)
  const badReq = { body: { email: "login@e.com", password: "wrongwrong" }, headers: { "user-agent": "jest" }, ip: "127.0.0.1" };
  const badLogs = await capture(async () => { await loginUser(badReq, mockRes(), (e) => { if (e) throw e; }); });
  ok("failed login logs do NOT contain the bcrypt hash", !badLogs.includes(hash));

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
