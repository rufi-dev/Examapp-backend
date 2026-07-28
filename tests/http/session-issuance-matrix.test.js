/*
 * AUD-002 Gate 2 — five-entry-point × three-mode issuance matrix. Drives the REAL
 * production router/controllers for register / password-login / code-login /
 * Google-new / Google-existing in flag-on, flag-off, and rollback modes.
 *
 * External identity is mocked LOCALLY (no real email, no real Google): the
 * Google verifier is injected via the TEST-ONLY `__setGoogleVerifyForTest` seam
 * (guarded by NODE_ENV==="test"), sendEmail is neutralized, and the login code is
 * seeded directly (cryptr). The default verifier is restored at the end.
 */
process.env.NODE_ENV = "test"; // required by the test-only Google seam
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud002-issuance";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-issuance";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-google-client";

const sendEmailMod = require("../../utils/sendEmail");
sendEmailMod.sendEmail = async () => ({ mocked: true }); // never send a real email
let googlePayload = { name: "G", email: "g@e.com", picture: "http://example.com/p.png", sub: "s" };
const userController = require("../../controllers/userController");
userController.__setGoogleVerifyForTest(async () => googlePayload);

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const Cryptr = require("cryptr");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Token = require("../../models/tokenModel");
const { _setForTest } = require("../../config/featureFlags");
const errorHandler = require("../../middleware/errorMiddleware");
const cryptr = new Cryptr(process.env.CRYPTR_KEY);

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function request(server, { method = "POST", path, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, setCookie: res.headers["set-cookie"] || [], body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })() })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
// LIVE (non-cleared, non-empty) value of a cookie — CR-020 requires proving a
// credential was issued, not just that a header name is present (clears count too).
const liveCookie = (sc, name) => {
  for (let i = sc.length - 1; i >= 0; i--) {
    if (!sc[i].startsWith(name + "=")) continue;
    if (/Expires=Thu, 01 Jan 1970|Max-Age=0/.test(sc[i])) continue;
    const v = sc[i].split(";")[0].slice(name.length + 1);
    if (v) return sc[i];
  }
  return null;
};

const ENTRIES = ["register", "password", "code", "google-new", "google-existing"];
const CODE = { register: "reg", password: "pw", code: "cd", "google-new": "gnew", "google-existing": "gold" };

// Perform one entry point in the given mode-suffix; returns { email, resp }.
async function runEntry(server, entry, suffix) {
  const email = `${CODE[entry]}${suffix}@e.com`;
  if (entry === "register") {
    return { email, resp: await request(server, { path: "/api/users/register", body: { name: "R", email, password: "passWord12", phone: "12345", grade: "11", role: "student" } }) };
  }
  if (entry === "password") {
    await User.create({ name: "P", email, password: "passWord12", role: "student", isVerified: true });
    return { email, resp: await request(server, { path: "/api/users/login", body: { email, password: "passWord12" } }) };
  }
  if (entry === "code") {
    const u = await User.create({ name: "C", email, password: "passWord12", role: "student", isVerified: true, userAgent: [] });
    await Token.create({ userId: u._id, lToken: cryptr.encrypt("246810"), createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
    return { email, resp: await request(server, { path: `/api/users/loginWithCode/${email}`, body: { loginCode: "246810" } }) };
  }
  if (entry === "google-new") {
    googlePayload = { name: "GN", email, picture: "http://example.com/p.png", sub: `sub-${suffix}-new` };
    return { email, resp: await request(server, { path: "/api/users/google/callback/", body: { code: "fake-code" } }) };
  }
  // google-existing
  await User.create({ name: "GE", email, password: "x".repeat(12), role: "student", isVerified: true, userAgent: [] });
  googlePayload = { name: "GE", email, picture: "http://example.com/p.png", sub: `sub-${suffix}-old` };
  return { email, resp: await request(server, { path: "/api/users/google/callback/", body: { code: "fake-code" } }) };
}

async function assertOn(entry, resp, email) {
  const n = `on/${entry}`;
  const okStatus = (resp.status === 200 || resp.status === 201) && !!resp.body.token;
  ok(`${n}: 200/201 with a token`, okStatus);
  let d = {}; try { d = jwt.verify(resp.body.token, process.env.JWT_SECRET); } catch (_) { /* */ }
  ok(`${n}: access JWT has exp + type=access + sid`, !!d.exp && d.type === "access" && !!d.sid);
  const u = await User.findOne({ email });
  ok(`${n}: sv matches user's current epoch`, d.sv === (u && (u.sessionVersion || 0)));
  ok(`${n}: live __Secure-exq_rt issued`, !!liveCookie(resp.setCookie, "__Secure-exq_rt"));
  ok(`${n}: no live legacy 'token' cookie`, !liveCookie(resp.setCookie, "token"));
}

async function assertOff(entry, resp) {
  const n = `off/${entry}`;
  ok(`${n}: 200/201 with a legacy token`, (resp.status === 200 || resp.status === 201) && !!resp.body.token);
  const d = jwt.decode(resp.body.token) || {};
  ok(`${n}: legacy token has NO exp, NO type`, d.exp === undefined && d.type === undefined);
  const legacy = liveCookie(resp.setCookie, "token");
  ok(`${n}: live legacy 'token' cookie, no __Secure-exq_rt`, !!legacy && !liveCookie(resp.setCookie, "__Secure-exq_rt"));
  // Historical expiry contract: register/password = session cookie (no Expires);
  // code + both Google branches = ~1-day cookie (Expires ≈ now + 24h).
  const expMatch = /Expires=([^;]+)/i.exec(legacy || "");
  if (entry === "register" || entry === "password") {
    ok(`${n}: session cookie (no Expires)`, !expMatch);
  } else {
    const deltaH = expMatch ? (new Date(expMatch[1]).getTime() - Date.now()) / 3600000 : 0;
    ok(`${n}: ~24h cookie (Expires 23–25h out, not just present)`, !!expMatch && deltaH > 23 && deltaH < 25);
  }
}

async function assertRollback(entry, resp) {
  const n = `rollback/${entry}`;
  ok(`${n}: 200/201 but NO JSON credential`, (resp.status === 200 || resp.status === 201) && !resp.body.token);
  ok(`${n}: live __Host-exq_sess only (no live __Secure-exq_rt / legacy)`,
    !!liveCookie(resp.setCookie, "__Host-exq_sess") && !liveCookie(resp.setCookie, "__Secure-exq_rt") && !liveCookie(resp.setCookie, "token"));
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
  await new Promise((r) => server.listen(0, r));

  // FLAG ON — all five entry points issue the new model
  _setForTest({ flags: { SESSION_MODEL_ENABLED: true, ISSUE_NEW_MODEL: true, HONOR_EXISTING_REFRESH: true, EMERGENCY_REAUTH: false } });
  for (const e of ENTRIES) { const { email, resp } = await runEntry(server, e, "On"); await assertOn(e, resp, email); }

  // FLAG OFF — legacy JSON token/cookie contract for all five
  _setForTest({ flags: { SESSION_MODEL_ENABLED: false } });
  for (const e of ENTRIES) { const { resp } = await runEntry(server, e, "Off"); await assertOff(e, resp); }

  // ROLLBACK — cookie-only bounded rollback for all five
  _setForTest({ flags: { SESSION_MODEL_ENABLED: true, ISSUE_NEW_MODEL: false } });
  for (const e of ENTRIES) { const { resp } = await runEntry(server, e, "Rb"); await assertRollback(e, resp); }

  _setForTest({ flags: { SESSION_MODEL_ENABLED: false, ISSUE_NEW_MODEL: true } });
  userController.__setGoogleVerifyForTest(null); // restore the default verifier
  server.close();
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
