/*
 * CR-108 — the client-controlled /sendAutomatedEmail endpoint is GONE; password- and
 * role-changed notices are emitted SERVER-SIDE with the correct typed template, and a
 * notification failure NEVER rolls back the committed domain change.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-mail";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-mail";
// Enable mail so sendNotification really runs (transporter is mocked below).
process.env.EMAIL_ENABLED = "true";
process.env.EMAIL_HOST = "smtp.example.test";
process.env.EMAIL_PORT = "587";
process.env.EMAIL_USER = "mailer@example.test";
process.env.EMAIL_PASS = "secret-pass";
process.env.FRONTEND_URL = "https://app.example.test";

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const nodemailer = require("nodemailer");

// Mock the SHARED transporter (createMailTransporter → nodemailer.createTransport).
let captured = [];
let failSend = false;
nodemailer.createTransport = () => ({
  use() {},
  sendMail: async (opts) => { captured.push(opts); if (failSend) { failSend = false; throw new Error("SMTP unavailable"); } return { messageId: "m" }; },
});

const User = require("../../models/userModel");
const { generateToken } = require("../../utils");
const { protect, adminOnly } = require("../../middleware/authMiddleware");
const userController = require("../../controllers/userController");
const { changePassword, upgradeUser } = userController;
const userRoute = require("../../routes/userRoute");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function req(server, { method = "GET", path: p, token, body }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) };
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })() }));
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const bcrypt = require("bcryptjs");
  const admin = await User.create({ name: "Adm", email: "adm@e.com", password: "OldPass1!", role: "admin", isVerified: true });
  const target = await User.create({ name: "Tgt", email: "tgt@e.com", password: "OldPass1!", role: "student", isVerified: true });
  const tok = (u) => generateToken(u._id, u.sessionVersion);

  const app = express();
  app.patch("/changePassword", protect, express.json(), changePassword);
  app.post("/upgradeUser", protect, adminOnly, express.json(), upgradeUser);
  app.use("/api/users", userRoute); // the REAL router — to prove the endpoint is gone
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // 1) the removed client endpoint no longer exists.
  ok("CR-108: userController exports NO sendAutomatedEmail", userController.sendAutomatedEmail === undefined);
  const gone = await req(server, { method: "POST", path: "/api/users/sendAutomatedEmail", token: tok(admin), body: { subject: "x", send_to: "tgt@e.com", reply_to: "e@e.com", template: "changeRole" } });
  ok("CR-108: POST /api/users/sendAutomatedEmail is 404 (route removed)", gone.status === 404);

  // 2) changePassword emits the SERVER-OWNED passwordChanged notice.
  captured = [];
  const cp = await req(server, { method: "PATCH", path: "/changePassword", token: tok(admin), body: { oldPassword: "OldPass1!", password: "NewPass2!" } });
  ok("CR-108: changePassword succeeds (200)", cp.status === 200);
  ok("CR-108: it sent the passwordChanged template (server-owned, not client-selected)", captured.length === 1 && captured[0].template === "changePassword");
  ok("CR-108: the new password is committed in the DB", await bcrypt.compare("NewPass2!", (await User.findById(admin._id).select("+password")).password));

  // 3) a NOTIFICATION failure does not roll back the committed password change.
  captured = []; failSend = true;
  const cp2 = await req(server, { method: "PATCH", path: "/changePassword", token: tok(target), body: { oldPassword: "OldPass1!", password: "NewPass3!" } });
  ok("CR-108: changePassword still 200 even when the notification send THROWS", cp2.status === 200);
  ok("CR-108: the password change is STILL committed (no rollback on notify failure)", await bcrypt.compare("NewPass3!", (await User.findById(target._id).select("+password")).password));

  // 4) upgradeUser emits the SERVER-OWNED roleChanged notice.
  captured = []; failSend = false;
  const up = await req(server, { method: "POST", path: "/upgradeUser", token: tok(admin), body: { role: "teacher", id: String(target._id) } });
  ok("CR-108: upgradeUser succeeds (200)", up.status === 200);
  ok("CR-108: it sent the changeRole template (server-owned)", captured.length === 1 && captured[0].template === "changeRole");
  ok("CR-108: the role change is committed", (await User.findById(target._id)).role === "teacher");

  // 5) a role-notice failure does not roll back the committed role change.
  captured = []; failSend = true;
  const up2 = await req(server, { method: "POST", path: "/upgradeUser", token: tok(admin), body: { role: "student", id: String(target._id) } });
  ok("CR-108: upgradeUser still 200 when the notice THROWS; role still committed", up2.status === 200 && (await User.findById(target._id)).role === "student");

  await mongoose.disconnect();
  await mem.stop();
  await new Promise((r) => server.close(r));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
