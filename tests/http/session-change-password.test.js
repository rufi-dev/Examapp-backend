/*
 * AUD-002 Gate 2 (Queue 1A) — change-password atomic guarded-write + caller
 * rebind. HTTP through the REAL production router/controller + service-level
 * fault injection. Written test-first: fails against the pre-Queue-1A
 * changePassword (which neither bumps the epoch nor rebinds the session).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud002-chpw";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-chpw";

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Session = require("../../models/sessionModel");
const PendingSecurityAction = require("../../models/pendingSecurityActionModel");
const errorHandler = require("../../middleware/errorMiddleware");
const { _setForTest } = require("../../config/featureFlags");
const svc = require("../../services/sessionService");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function request(server, { method = "GET", path, token, cookie, body, origin }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(origin ? { Origin: origin } : {}),
        } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, setCookie: res.headers["set-cookie"] || [], body: (() => { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; } })() }));
      });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const cookieVal = (setCookie, name) => {
  const m = setCookie.filter((s) => s.startsWith(name + "="));
  for (let i = m.length - 1; i >= 0; i--) { const v = m[i].split(";")[0].slice(name.length + 1); if (v) return v; }
  return null;
};
const RT = "__Secure-exq_rt";
const ORIGIN = "https://examopia.com";

async function login(server, email, password) {
  const r = await request(server, { method: "POST", path: "/api/users/login", body: { email, password } });
  return { token: r.body.token, rt: cookieVal(r.setCookie, RT), status: r.status };
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

  // ---- Flag ON: successful change keeps caller signed in; old creds + siblings die ----
  {
    _setForTest({ flags: { SESSION_MODEL_ENABLED: true, ISSUE_NEW_MODEL: true, HONOR_EXISTING_REFRESH: true, EMERGENCY_REAUTH: false } });
    await User.create({ name: "C", email: "chpw@e.com", password: "origPass12", role: "student", isVerified: true });
    const caller = await login(server, "chpw@e.com", "origPass12");   // device A
    const sibling = await login(server, "chpw@e.com", "origPass12");  // device B
    ok("setup: two logins issued access tokens", !!caller.token && !!sibling.token);

    const ch = await request(server, { method: "PATCH", path: "/api/users/changePassword", token: caller.token, origin: ORIGIN, body: { oldPassword: "origPass12", password: "newPass345" } });
    ok("change-password ⇒ 200 with a NEW access token (caller stays signed in)", ch.status === 200 && !!ch.body.token);
    const newRt = cookieVal(ch.setCookie, RT);
    ok("change-password rotates the caller's refresh cookie", !!newRt && newRt !== caller.rt);

    // New caller token works; OLD caller token now fails (epoch advanced). EXACT
    // status (CR-016: `!== 200` would also accept an accidental 500).
    ok("caller's NEW access token authenticates (200)", (await request(server, { method: "GET", path: "/api/users/getUser", token: ch.body.token })).status === 200);
    ok("caller's OLD access token now fails (exactly 401)", (await request(server, { method: "GET", path: "/api/users/getUser", token: caller.token })).status === 401);
    ok("sibling access token fails (exactly 401)", (await request(server, { method: "GET", path: "/api/users/getUser", token: sibling.token })).status === 401);
    ok("sibling refresh cookie fails (exactly 401)", (await request(server, { method: "POST", path: "/api/users/refresh", cookie: `${RT}=${sibling.rt}`, origin: ORIGIN })).status === 401);
    // The caller's OLD cookie is the immediately-previous generation of the just-
    // rebound session ⇒ strict Contract A returns 409 (mints NOTHING); after the
    // grace window a replay becomes theft. It can never rotate.
    const oldCallerRefresh = await request(server, { method: "POST", path: "/api/users/refresh", cookie: `${RT}=${caller.rt}`, origin: ORIGIN });
    ok("caller OLD refresh cookie ⇒ 409, no token", oldCallerRefresh.status === 409 && !oldCallerRefresh.body.token);
    ok("caller NEW refresh cookie rotates (200)", (await request(server, { method: "POST", path: "/api/users/refresh", cookie: `${RT}=${newRt}`, origin: ORIGIN })).status === 200);
    // The new password actually works for a fresh login; the old one does not.
    ok("new password logs in", (await login(server, "chpw@e.com", "newPass345")).status === 200);
    ok("old password no longer logs in", (await login(server, "chpw@e.com", "origPass12")).status !== 200);
  }

  // CR-016 — two concurrent change-password through the REAL controller ⇒ exactly
  // one 200 and one 409, epoch advances exactly once.
  {
    await User.create({ name: "CC", email: "cc@e.com", password: "origPass12", role: "student", isVerified: true });
    const c = await login(server, "cc@e.com", "origPass12");
    const [x, y] = await Promise.all([
      request(server, { method: "PATCH", path: "/api/users/changePassword", token: c.token, origin: ORIGIN, body: { oldPassword: "origPass12", password: "newPassAAA1" } }),
      request(server, { method: "PATCH", path: "/api/users/changePassword", token: c.token, origin: ORIGIN, body: { oldPassword: "origPass12", password: "newPassBBB2" } }),
    ]);
    const codes = [x.status, y.status].sort((a, b) => a - b);
    ok("CR-016 concurrent change-password ⇒ exactly one 200 + one 409", codes[0] === 200 && codes[1] === 409);
    const cc = await User.findOne({ email: "cc@e.com" });
    ok("CR-016 concurrent change-password advances the epoch exactly once", (cc.sessionVersion || 0) === 1);
  }

  // CR-016 — a post-commit rebind failure through the REAL controller ⇒ exactly
  // 401 AND clears the credential cookies (refresh/rollback/legacy).
  {
    await User.create({ name: "RF", email: "rf@e.com", password: "origPass12", role: "student", isVerified: true });
    const c = await login(server, "rf@e.com", "origPass12");
    const orig = Session.findOneAndUpdate;
    Session.findOneAndUpdate = async () => null; // force the caller rebind to fail
    let resp;
    try { resp = await request(server, { method: "PATCH", path: "/api/users/changePassword", token: c.token, origin: ORIGIN, body: { oldPassword: "origPass12", password: "newPass999" } }); }
    finally { Session.findOneAndUpdate = orig; }
    ok("CR-016 rebind-failure ⇒ exactly 401", resp.status === 401);
    ok("CR-016 rebind-failure clears the refresh cookie", resp.setCookie.some((s) => s.startsWith(RT + "=") && /Expires=Thu, 01 Jan 1970|Max-Age=0/.test(s)));
    ok("CR-016 rebind-failure clears the rollback + legacy cookies", resp.setCookie.some((s) => s.startsWith("__Host-exq_sess=")) && resp.setCookie.some((s) => s.startsWith("token=")));
    ok("CR-016 rebind-failure preserved the epoch (no rollback)", ((await User.findOne({ email: "rf@e.com" })).sessionVersion || 0) === 1);
  }

  // CR-018 — a post-commit rebind that THROWS (not returns null) must still hit
  // the re-auth fail-safe: exact 401, cookies cleared, epoch committed, caller
  // session contained (revoked). It must NEVER escape to 500.
  {
    await User.create({ name: "TH", email: "throw@e.com", password: "origPass12", role: "student", isVerified: true });
    const c = await login(server, "throw@e.com", "origPass12");
    const callerSid = require("jsonwebtoken").decode(c.token).sid;
    const orig = Session.findOneAndUpdate;
    Session.findOneAndUpdate = async () => { throw new Error("injected rebind storage failure"); };
    let resp;
    try { resp = await request(server, { method: "PATCH", path: "/api/users/changePassword", token: c.token, origin: ORIGIN, body: { oldPassword: "origPass12", password: "newPass777" } }); }
    finally { Session.findOneAndUpdate = orig; }
    ok("CR-018 post-commit rebind THROW ⇒ exact 401 (not 500)", resp.status === 401);
    ok("CR-018 rebind-throw clears all credential cookies", resp.setCookie.some((s) => s.startsWith(RT + "=")) && resp.setCookie.some((s) => s.startsWith("__Host-exq_sess=")) && resp.setCookie.some((s) => s.startsWith("token=")));
    ok("CR-018 rebind-throw committed the password/epoch (no rollback)", ((await User.findOne({ email: "throw@e.com" })).sessionVersion || 0) === 1);
    ok("CR-018 rebind-throw contains the caller Session (revoked)", !!(await Session.findById(callerSid)).revokedAt);
    ok("CR-018 new password works, old does not", (await login(server, "throw@e.com", "newPass777")).status === 200 && (await login(server, "throw@e.com", "origPass12")).status !== 200);
  }

  // ---- Flag OFF: legacy response unchanged, no epoch bump ----
  {
    _setForTest({ flags: { SESSION_MODEL_ENABLED: false } });
    const u = await User.create({ name: "L", email: "chpwoff@e.com", password: "origPass12", role: "student", isVerified: true });
    const before = (await User.findById(u._id)).sessionVersion || 0;
    const legacyLogin = await login(server, "chpwoff@e.com", "origPass12");
    const ch = await request(server, { method: "PATCH", path: "/api/users/changePassword", token: legacyLogin.token, body: { oldPassword: "origPass12", password: "newPass345" } });
    ok("flag-off change-password ⇒ 200 legacy message", ch.status === 200 && /re-login/i.test(ch.body.message || ""));
    ok("flag-off change-password does NOT bump sessionVersion", ((await User.findById(u._id)).sessionVersion || 0) === before);
  }

  server.close();

  // ---- Service-level fault injection (flag on) ----
  _setForTest({ flags: { SESSION_MODEL_ENABLED: true, ISSUE_NEW_MODEL: true } });

  // Concurrent change-password ⇒ exactly one guarded winner (epoch advances once).
  {
    const u = await User.create({ name: "R", email: "race@e.com", password: "origPass12", role: "student" });
    const s = await svc.createSession(u, {});
    const fresh = await User.findById(u._id);
    const [a, b] = await Promise.all([
      svc.changePasswordAtomic(fresh, "hash-A", 0, s.sid),
      svc.changePasswordAtomic(fresh, "hash-B", 0, s.sid),
    ]);
    const winners = [a, b].filter((r) => r && r.ok && r.accessToken).length;
    const conflicts = [a, b].filter((r) => r && r.ok === false && r.conflict === true).length;
    ok("concurrent change-password ⇒ exactly one guarded winner", winners === 1);
    ok("concurrent change-password ⇒ the loser is a guarded conflict", conflicts === 1);
    ok("concurrent change-password advances the epoch exactly once", ((await User.findById(u._id)).sessionVersion || 0) === 1);
  }

  // CR-016 — a refresh landing after the epoch commit but BEFORE caller rebind
  // must NOT rotate the old family or mint a current-epoch token.
  {
    const u = await User.create({ name: "B", email: "boundary@e.com", password: "origPass12", role: "student" });
    const caller = await svc.createSession(u, {}); // authVersion 0
    // Simulate the atomic guarded write having committed (epoch → 1) while the
    // caller's Session is still at authVersion 0 (rebind not yet applied).
    await User.updateOne({ _id: u._id }, { $inc: { sessionVersion: 1 } });
    const r = await svc.refreshSession(caller.refreshToken);
    ok("CR-016 refresh at the epoch/rebind boundary ⇒ superseded_401 (no rotation)", r.status === 401 && r.outcome === "superseded_401");
    ok("CR-016 boundary refresh did not advance the caller's session gen", (await Session.findById(caller.sid)).refreshGen === 0);
  }

  // CR-015 — epoch-scoped cleanup revokes an ABSENT-authVersion legacy session
  // (treated as 0) but NEVER a current-epoch session.
  {
    const u = await User.create({ name: "LG", email: "legacycl@e.com", password: "origPass12", role: "student" });
    // Raw legacy session with NO authVersion field.
    await Session.collection.insertOne({ _id: "legSid", userId: u._id, refreshHash: "lh", refreshGen: 0, createdAt: new Date(), refreshExpiresAt: new Date(Date.now() + 1e9), absoluteExpiresAt: new Date(Date.now() + 1e9), revokedAt: null });
    const current = await svc.createSession(await User.findById(u._id), {}); // authVersion 0
    // Simulate a reset to epoch 1 then cleanup with target 1.
    await User.updateOne({ _id: u._id }, { $inc: { sessionVersion: 1 } });
    const curNow = await svc.createSession(await User.findById(u._id), {}); // authVersion 1 (current)
    await svc.revokeAllSessions(u._id, 1);
    ok("CR-015 absent-authVersion legacy session is revoked (treated as 0)", !!(await Session.findById("legSid")).revokedAt);
    ok("CR-015 old-epoch (authVersion 0) session is revoked", !!(await Session.findById(current.sid)).revokedAt);
    ok("CR-015 current-epoch session is NOT revoked", !(await Session.findById(curNow.sid)).revokedAt);
  }

  // CR-015 — a targeted revoke-session (theft cleanup) revokes ONLY its sid.
  {
    const worker = require("../../jobs/outboxWorker");
    await PendingSecurityAction.deleteMany({});
    const u = await User.create({ name: "TG", email: "targeted@e.com", password: "origPass12", role: "student" });
    const victim = await svc.createSession(u, {});
    const bystander = await svc.createSession(await User.findById(u._id), {});
    await svc.enqueuePending("revoke-session", { userId: u._id, sid: victim.sid, reason: "refresh-reuse" });
    await worker.drainOnce({ workerId: "wTg" });
    ok("CR-015 targeted revoke-session revokes its sid", !!(await Session.findById(victim.sid)).revokedAt);
    ok("CR-015 targeted revoke-session leaves the bystander alone", !(await Session.findById(bystander.sid)).revokedAt);
  }

  // CR-015 — a malformed account cleanup (revoke-before-epoch with NO target)
  // must NEVER become a broad revoke; the worker dead-letters it.
  {
    const worker = require("../../jobs/outboxWorker");
    await PendingSecurityAction.deleteMany({});
    const u = await User.create({ name: "MF", email: "malformed@e.com", password: "origPass12", role: "student" });
    const live = await svc.createSession(u, {});
    await PendingSecurityAction.create({ _id: "revoke-before-epoch:bad:0", action: "revoke-before-epoch", userId: u._id, targetVersion: null, attempts: 0, nextAttemptAt: new Date(), deadLetter: false, createdAt: new Date() });
    await worker.drainOnce({ workerId: "wMf" });
    ok("CR-015 malformed account cleanup does NOT revoke any live session", !(await Session.findById(live.sid)).revokedAt);
    ok("CR-015 malformed account cleanup is dead-lettered", (await PendingSecurityAction.findById("revoke-before-epoch:bad:0")).deadLetter === true);
  }

  // CR-019 — a STALE worker completing an invalid action must report "stale"
  // (another worker owns the lease), NOT "dead"; the record stays active.
  {
    const worker = require("../../jobs/outboxWorker");
    await PendingSecurityAction.deleteMany({});
    const u = await User.create({ name: "SM", email: "stalemal@e.com", password: "origPass12", role: "student" });
    const _id = "revoke-before-epoch:sm:0";
    await PendingSecurityAction.create({ _id, action: "revoke-before-epoch", userId: u._id, targetVersion: null, attempts: 1, nextAttemptAt: new Date(), leaseOwner: "worker-b", leaseUntil: new Date(Date.now() + 60000), deadLetter: false, createdAt: new Date() });
    const rec = await PendingSecurityAction.findById(_id); // stale worker A's snapshot
    const outcome = await worker.applyOne(rec, new Date(), "worker-a"); // A does NOT own the lease
    ok("CR-019 stale worker on an invalid action returns 'stale' (not 'dead')", outcome === "stale");
    const still = await PendingSecurityAction.findById(_id);
    ok("CR-019 stale worker did NOT dead-letter another owner's record", still.deadLetter === false && still.leaseOwner === "worker-b");
  }

  // CR-019 — a DELAYED revoke-before-epoch drained by the worker must preserve a
  // Session created at the target epoch before the drain (not just the sync path).
  {
    const worker = require("../../jobs/outboxWorker");
    await PendingSecurityAction.deleteMany({});
    const u = await User.create({ name: "DL", email: "delayed@e.com", password: "origPass12", role: "student" });
    const oldSess = await svc.createSession(u, {}); // authVersion 0
    // Simulate a reset to epoch 2, enqueue the delayed cleanup for target 2.
    await User.updateOne({ _id: u._id }, { $set: { sessionVersion: 2 } });
    await svc.enqueuePending("revoke-before-epoch", { userId: u._id, targetVersion: 2 });
    // A NEW current-epoch session is created BEFORE the delayed cleanup drains.
    const curSess = await svc.createSession(await User.findById(u._id), {}); // authVersion 2
    await worker.drainOnce({ workerId: "wDelay" });
    ok("CR-019 delayed cleanup revokes the old-epoch session", !!(await Session.findById(oldSess.sid)).revokedAt);
    ok("CR-019 delayed cleanup PRESERVES a current-epoch session created before drain", !(await Session.findById(curSess.sid)).revokedAt);
  }

  // Sibling cleanup failure is recovered by the worker.
  {
    const worker = require("../../jobs/outboxWorker");
    await PendingSecurityAction.deleteMany({});
    const u = await User.create({ name: "S", email: "sib@e.com", password: "origPass12", role: "student" });
    const caller = await svc.createSession(u, {});
    const sibling = await svc.createSession(await User.findById(u._id), {});
    const fresh = await User.findById(u._id);
    const origMany = Session.updateMany;
    Session.updateMany = () => { throw new Error("sibling-cleanup-fail"); };
    let out;
    try { out = await svc.changePasswordAtomic(fresh, "hash-new", 0, caller.sid); } finally { Session.updateMany = origMany; }
    ok("change-password still succeeds despite sibling-cleanup failure", !!out && out.ok && !!out.accessToken);
    ok("sibling-cleanup failure enqueued a durable revoke-before-epoch", (await PendingSecurityAction.countDocuments({ action: "revoke-before-epoch" })) >= 1);
    await worker.drainOnce({ workerId: "wChpw" });
    ok("worker recovered the sibling revoke", !!(await Session.findById(sibling.sid)).revokedAt);
    // CR-015 INVARIANT: the epoch-scoped recovery must NOT revoke the rebound caller.
    ok("CR-015 worker recovery preserves the rebound caller (not revoked)", !(await Session.findById(caller.sid)).revokedAt);
    ok("CR-015 rebound caller stays at the NEW epoch", (await Session.findById(caller.sid)).authVersion === 1);
  }

  // Post-commit rebind failure ⇒ caller logged out safely, epoch NOT rolled back.
  {
    const u = await User.create({ name: "P", email: "rebindfail@e.com", password: "origPass12", role: "student" });
    const s = await svc.createSession(u, {});
    const fresh = await User.findById(u._id);
    // sid that does not belong to a live session ⇒ rebind returns null
    const out = await svc.changePasswordAtomic(fresh, "hash-new", 0, "no-such-sid");
    ok("post-commit rebind failure ⇒ result flagged reauth (no tokens)", !!out && out.ok && out.reauth === true && !out.accessToken);
    ok("post-commit rebind failure preserves the bumped epoch (no rollback)", ((await User.findById(u._id)).sessionVersion || 0) === 1);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
