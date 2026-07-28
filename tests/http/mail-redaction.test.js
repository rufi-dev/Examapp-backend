/*
 * CR-109 — a mail send/render failure must NEVER leak SMTP/provider detail into any
 * retained channel. We inject an error stuffed with canaries (host, username, password,
 * recipient, subject, message body, raw SMTP response) and assert none of them reach
 * DebugLog, console, the HTTP response, or metrics — across the login-code,
 * forgot-password, password-changed and role-changed paths. Only an allowlisted
 * category + a fixed event name are persisted; best-effort/no-rollback is preserved.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-redact";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-redact";
process.env.EMAIL_ENABLED = "true";
process.env.EMAIL_HOST = "smtp.example.test";
process.env.EMAIL_PORT = "587";
process.env.EMAIL_USER = "mailer@example.test";
process.env.EMAIL_PASS = "smtp-pass";
process.env.FRONTEND_URL = "https://app.example.test";

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const nodemailer = require("nodemailer");

// Canaries that a leak would carry. classify() will read the message (→ smtp_auth),
// but NONE of these strings may be persisted anywhere.
const CANARIES = ["smtp.secret-host.test", "leaked-smtp-user", "SUPERSECRETPASS", "victim@recipient.test", "TOP-SECRET-SUBJECT", "SECRET-MESSAGE-BODY", "RAW-SMTP-535-RESPONSE"];
function canaryError() {
  const e = new Error(`535 auth failed host=smtp.secret-host.test user=leaked-smtp-user pass=SUPERSECRETPASS to=victim@recipient.test subject=TOP-SECRET-SUBJECT body=SECRET-MESSAGE-BODY`);
  e.code = "EAUTH";
  e.response = "RAW-SMTP-535-RESPONSE";
  return e;
}
nodemailer.createTransport = () => ({ use() {}, sendMail: async () => { throw canaryError(); } });

// CR-112: exercise the REAL DebugLog Mongoose model (no mocked create), so a schema
// that silently drops op/category is caught, and we can inspect the RAW documents.
const DebugLog = require("../../models/debugLogModel");
const consoleOut = [];
for (const m of ["log", "warn", "error", "info", "debug"]) { const orig = console[m]; console[m] = (...a) => { consoleOut.push(a.map(String).join(" ")); }; }

const User = require("../../models/userModel");
const Token = require("../../models/tokenModel");
const Cryptr = require("cryptr");
const cryptr = new Cryptr(process.env.CRYPTR_KEY);
const authMetrics = require("../../utils/authMetrics");
const { generateToken } = require("../../utils");
const { protect, adminOnly } = require("../../middleware/authMiddleware");
const { sendLoginCode, forgotPasswordEmail, changePassword, upgradeUser } = require("../../controllers/userController");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
// We shadowed console above (to capture leaks); write our own report straight to stdout.
const report = process.stdout.write.bind(process.stdout);
const emit = (n, c) => { if (c) { passed++; report(`  ✓ ${n}\n`); } else { failed++; report(`  ✗ FAIL: ${n}\n`); } };

const containsCanary = (s) => CANARIES.some((c) => String(s).includes(c));
const anyCanaryIn = (obj) => containsCanary(JSON.stringify(obj));

function req(server, { method = "GET", path: p, token, body }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) };
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, raw: Buffer.concat(c).toString() }));
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
  // a login-code token so sendLoginCode reaches the send path
  await Token.create({ userId: target._id, lToken: cryptr.encrypt("123456"), createdAt: Date.now(), expiresAt: Date.now() + 3600_000 });
  const tok = (u) => generateToken(u._id, u.sessionVersion);

  const app = express();
  app.get("/loginCode/:email", express.json(), sendLoginCode);
  app.post("/forgot", express.json(), forgotPasswordEmail);
  app.patch("/changePassword", protect, express.json(), changePassword);
  app.post("/upgradeUser", protect, adminOnly, express.json(), upgradeUser);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const responses = [];
  responses.push(await req(server, { method: "GET", path: `/loginCode/${encodeURIComponent("tgt@e.com")}` }));
  responses.push(await req(server, { method: "POST", path: "/forgot", body: { email: "tgt@e.com" } }));
  responses.push(await req(server, { method: "PATCH", path: "/changePassword", token: tok(target), body: { oldPassword: "OldPass1!", password: "NewPass2!" } }));
  responses.push(await req(server, { method: "POST", path: "/upgradeUser", token: tok(admin), body: { role: "teacher", id: String(target._id) } }));

  // CR-112: poll the REAL DebugLog collection (writes are fire-and-forget).
  const MAIL_KINDS = ["login_code_send_failed", "forgot_email_send_failed", "notify_failed"];
  let mailDocs = [];
  for (let i = 0; i < 40; i++) {
    mailDocs = await DebugLog.find({ kind: { $in: MAIL_KINDS } }).lean();
    if (mailDocs.length >= 4) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // 1) all four paths completed (best-effort — a mail failure never breaks the flow).
  emit("CR-109: all four mail paths returned a normal status despite the send failure", responses.every((r) => r.status === 200));
  // 2) EXACTLY four mail-failure events were persisted through the real model.
  emit("CR-112: exactly four mail-failure events persisted (loginCode, forgot, notify×2)", mailDocs.length === 4);
  // 3) CR-112 — op/category were RETAINED (not silently stripped by the schema).
  const notify = mailDocs.filter((d) => d.kind === "notify_failed");
  emit("CR-112: notify_failed events RETAINED op (passwordChanged + roleChanged) — not stripped", notify.length === 2 && notify.every((d) => ["passwordChanged", "roleChanged"].includes(d.op)) && new Set(notify.map((d) => d.op)).size === 2);
  emit("CR-112: every mail event RETAINED an allowlisted smtp_* category", mailDocs.every((d) => /^smtp_(timeout|auth|tls|unavailable)$/.test(d.category)));
  // 4) NO canary + NO raw fields in the RAW persisted documents.
  emit("CR-109: NO SMTP/provider canary in any raw DebugLog document", !mailDocs.some(anyCanaryIn));
  emit("CR-109: no raw `message`/`stack`/`response` field on any mail document", mailDocs.every((d) => d.message == null && d.stack == null && d.response == null));
  // 5) NO canary reached console output.
  emit("CR-109: NO canary reached console output", !consoleOut.some(containsCanary));
  // 6) NO canary reached any HTTP response body.
  emit("CR-109: NO canary reached any HTTP response body", !responses.some((r) => containsCanary(r.raw)));
  // 7) metrics are counters only — no canary.
  emit("CR-109: metrics snapshot carries no canary (counters only)", !anyCanaryIn(authMetrics.snapshot()));
  // 8) the committed domain changes still happened (best-effort preserved).
  emit("CR-109: password change still committed (no rollback on notify failure)", await bcrypt.compare("NewPass2!", (await User.findById(target._id).select("+password")).password));
  emit("CR-109: role change still committed", (await User.findById(target._id)).role === "teacher");

  await mongoose.disconnect();
  await mem.stop();
  await new Promise((r) => server.close(r));
  report(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { report(`TEST CRASH: ${e && e.message}\n`); process.exit(2); });
