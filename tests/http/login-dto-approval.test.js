/*
 * AUD-005 CR-046 — EVERY identity/login DTO carries `teacherApproval`, so a
 * pending teacher who signs in by ANY path hydrates the capability state the
 * frontend gate depends on (previously only register + getUser included it, so a
 * normal login left teacherApproval undefined and the gate never showed).
 *
 * Drives the REAL /api/users router over real sockets for register, password
 * login, code login, Google new-user, Google existing-user, and getUser. Google
 * is mocked via the TEST-ONLY seam; email is neutralized; the code is seeded.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud005-dto";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud005-dto";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-google-client";

const sendEmailMod = require("../../utils/sendEmail");
sendEmailMod.sendEmail = async () => ({ mocked: true });
const userController = require("../../controllers/userController");

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const Cryptr = require("cryptr");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Token = require("../../models/tokenModel");
const { generateToken } = require("../../utils");
const errorHandler = require("../../middleware/errorMiddleware");
const cryptr = new Cryptr(process.env.CRYPTR_KEY);

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function request(server, { method = "POST", path, body, token }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data),
        "User-Agent": "dto-test", ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({
        status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })(),
      })); });
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

  // helper: seed a PENDING teacher (the case that previously failed to hydrate)
  const seedPendingTeacher = (email) => User.create({ name: "T", email, password: "passWord12", phone: "+99450", role: "teacher", teacherApproval: "pending", isVerified: true, userAgent: [] });

  // 1) REGISTER (self-service teacher → auto-approved)
  {
    const r = await request(server, { path: "/api/users/register", body: { name: "R", email: "reg@e.com", password: "passWord12", phone: "12345", role: "teacher" } });
    ok("register DTO carries teacherApproval='approved' (auto-approval)", r.body.teacherApproval === "approved");
  }

  // 2) PASSWORD LOGIN
  {
    await seedPendingTeacher("pw@e.com");
    const r = await request(server, { path: "/api/users/login", body: { email: "pw@e.com", password: "passWord12" } });
    ok("password-login DTO carries teacherApproval", r.body.teacherApproval === "pending");
  }

  // 3) CODE LOGIN
  {
    const u = await seedPendingTeacher("code@e.com");
    await Token.create({ userId: u._id, lToken: cryptr.encrypt("246810"), createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
    const r = await request(server, { path: "/api/users/loginWithCode/code@e.com", body: { loginCode: "246810" } });
    ok("code-login DTO carries teacherApproval", r.body.teacherApproval === "pending");
  }

  // 4) GOOGLE existing-user (seed a pending teacher, then Google-login as them)
  {
    await seedPendingTeacher("gexist@e.com");
    userController.__setGoogleVerifyForTest(async () => ({ name: "G", email: "gexist@e.com", picture: "http://x/p.png", sub: "s1" }));
    const r = await request(server, { path: "/api/users/google/callback", body: { code: "x" } });
    ok("Google existing-user DTO carries teacherApproval", r.body.teacherApproval === "pending");
  }

  // 5) GOOGLE new-user (fresh → student/none, but the field must be PRESENT)
  {
    userController.__setGoogleVerifyForTest(async () => ({ name: "G2", email: "gnew@e.com", picture: "http://x/p.png", sub: "s2" }));
    const r = await request(server, { path: "/api/users/google/callback", body: { code: "y" } });
    ok("Google new-user DTO includes teacherApproval ('none')", r.body.teacherApproval === "none");
  }

  // 6) getUser (canonical DTO)
  {
    const u = await seedPendingTeacher("me@e.com");
    const r = await request(server, { method: "GET", path: "/api/users/getUser", token: generateToken(u._id, u.sessionVersion) });
    ok("getUser DTO carries teacherApproval", r.body.teacherApproval === "pending");
  }

  userController.__setGoogleVerifyForTest(null);
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
