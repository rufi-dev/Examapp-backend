/*
 * CR-125 — the REAL register route (/api/users/register + registerUser) captures
 * and binds a ?ref=<code> referral. Real sockets + in-memory Mongo. A valid code
 * durably binds referredBy + creates a pending referral row; an invalid code
 * never fails registration; flag-off performs no binding.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-regref";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-tsj-regref";

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const TeacherReferral = require("../../models/teacherReferralModel");
const { generateCode } = require("../../services/teacherReferralService");

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, x ? JSON.stringify(x) : ""); } };

function request(server, { method = "POST", path, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "User-Agent": "regref-test" } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })() })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

let seq = 0;
const registerBody = (over = {}) => ({ name: "New Teacher", email: `regref${seq++}@e.com`, password: "passw0rd1", phone: "+994501112233", role: "teacher", ...over });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Promise.all([User.createIndexes(), TeacherReferral.createIndexes()]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/users", require("../../routes/userRoute"));
  app.use(require("../../middleware/errorMiddleware"));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const referrer = await User.create({ name: "Ref", email: "referrer@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true, referralCode: generateCode() });

  // ── Flag ON: valid code binds durably ──
  process.env.TEACHER_SUCCESS_JOURNEY_ENABLED = "1";
  const b = registerBody();
  const reg = await request(server, { path: "/api/users/register", body: { ...b, ref: referrer.referralCode } });
  ok("registration succeeds (201)", reg.status === 201, reg.body);
  const referee = await User.findOne({ email: b.email.toLowerCase() });
  ok("referee.referredBy bound to the referrer", referee && String(referee.referredBy) === String(referrer._id));
  ok("a pending referral row was created", !!(await TeacherReferral.findOne({ refereeId: referee._id, state: "pending" })));

  // ── Invalid code never fails registration + creates no binding ──
  const b2 = registerBody();
  const reg2 = await request(server, { path: "/api/users/register", body: { ...b2, ref: "not-a-real-code" } });
  ok("registration with a bad code still succeeds (201)", reg2.status === 201);
  const referee2 = await User.findOne({ email: b2.email.toLowerCase() });
  ok("bad code leaves referredBy unset + no referral row", referee2 && !referee2.referredBy && !(await TeacherReferral.exists({ refereeId: referee2._id })));

  // ── Flag OFF: no binding even with a valid code ──
  process.env.TEACHER_SUCCESS_JOURNEY_ENABLED = "0";
  const b3 = registerBody();
  await request(server, { path: "/api/users/register", body: { ...b3, ref: referrer.referralCode } });
  const referee3 = await User.findOne({ email: b3.email.toLowerCase() });
  ok("flag off: no referral binding", referee3 && !referee3.referredBy);

  delete process.env.TEACHER_SUCCESS_JOURNEY_ENABLED;
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
