/*
 * AUD-002 hardening regression — the failure-safety fixes from Codex CR-007..
 * CR-014. Service/model + migration-process integration against in-memory Mongo.
 * Complements session-core.test.js (which covers the happy/precedence paths).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud002-hardening";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud002-hardening";

const path = require("path");
const jwt = require("jsonwebtoken");
const { spawnSync } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Session = require("../../models/sessionModel");
const PendingSecurityAction = require("../../models/pendingSecurityActionModel");
const { _setForTest, params, flags } = require("../../config/featureFlags");
const svc = require("../../services/sessionService");
const { resolveSessionUser } = require("../../middleware/authMiddleware");
const authCtl = require("../../controllers/authSessionController");
const { generateAccessToken, generateRollbackToken } = require("../../utils/refreshToken");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const mkUser = () => User.create({ name: "U", email: `u${Math.random().toString(36).slice(2)}@e.com`, password: "origPass12", role: "student" });

async function main() {
  const mem = await MongoMemoryServer.create();
  const uri = mem.getUri();
  await mongoose.connect(uri);
  _setForTest({ params: { RING_DEPTH: 3, GRACE_WINDOW_MS: 10 * 1000 } });

  // CR-007 — merely importing the models + connecting must NOT create collections
  // or indexes (this assertion runs BEFORE any createSession in this process).
  {
    const before = await mongoose.connection.db.listCollections().toArray();
    const names = before.map((c) => c.name);
    ok("CR-007 no 'sessions' collection from model import/connect", !names.includes("sessions"));
    ok("CR-007 no 'pendingsecurityactions' collection from model import/connect", !names.includes("pendingsecurityactions"));
  }

  // CR-008 — concurrent ancestor replay bumps sessionVersion exactly ONCE
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    let cur = (await svc.refreshSession(s.refreshToken)).refreshToken; // gen1
    cur = (await svc.refreshSession(cur)).refreshToken; // gen2 (gen0 still ringed with N=3)
    await Session.updateOne({ _id: s.sid }, { $set: { lastRotatedAt: new Date(Date.now() - 60000) } });
    const [a, b] = await Promise.all([svc.refreshSession(s.refreshToken), svc.refreshSession(s.refreshToken)]);
    const outcomes = [a.outcome, b.outcome].sort();
    ok("CR-008 concurrent theft ⇒ exactly one theft_403 + one revoked_401",
      outcomes[0] === "revoked_401" && outcomes[1] === "theft_403");
    const fresh = await User.findById(u._id);
    ok("CR-008 sessionVersion bumped EXACTLY once (not twice)", (fresh.sessionVersion || 0) === 1);
  }

  // CR-009 — a theft-path bump FAILURE is durably enqueued, not lost
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    let cur = (await svc.refreshSession(s.refreshToken)).refreshToken;
    cur = (await svc.refreshSession(cur)).refreshToken; // gen2
    await Session.updateOne({ _id: s.sid }, { $set: { lastRotatedAt: new Date(Date.now() - 60000) } });
    const orig = User.findOneAndUpdate;
    User.findOneAndUpdate = () => { throw new Error("bump-fail"); }; // inject conditional-bump infra failure
    let r;
    try { r = await svc.refreshSession(s.refreshToken); } finally { User.findOneAndUpdate = orig; }
    ok("CR-009 theft still returns 403 despite bump failure", r.status === 403 && r.outcome === "theft_403");
    ok("CR-009 offending session was revoked (containment held)", !!(await Session.findById(s.sid)).revokedAt);
    const outbox = await PendingSecurityAction.countDocuments({ action: "sv-bump", sid: s.sid });
    ok("CR-009 failed bump enqueued a durable sv-bump outbox record", outbox === 1);
  }

  // CR-012 — a reset (epoch bump) beats theft: an ancestor in the ring on a
  // superseded family is classified 401 superseded, NOT 403 theft.
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    await svc.refreshSession(s.refreshToken); // gen1 (gen0 ringed)
    await User.updateOne({ _id: u._id }, { $inc: { sessionVersion: 1 } }); // reset bumps epoch
    const r = await svc.refreshSession(s.refreshToken); // present gen0 (ancestor in ring)
    ok("CR-012 ancestor on superseded family ⇒ 401 superseded (not theft)", r.outcome === "superseded_401");
    const sess = await Session.findById(s.sid);
    ok("CR-012 no theft revoke happened", !sess.revokedAt);
  }

  // CR-012 (mid-flight boundary) — a reset that lands AFTER classification but
  // BEFORE the theft revoke must NOT produce false theft or a second bump.
  // Materialized deterministically: call handleTheft with the epoch we classified
  // (0) while the user has ALREADY been bumped to 1 (the reset raced in).
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    await svc.refreshSession(s.refreshToken); // gen1, gen0 ringed
    const sessionDoc = await Session.findById(s.sid);
    await User.updateOne({ _id: u._id }, { $inc: { sessionVersion: 1 } }); // reset lands mid-flight (sv 0→1)
    const r = await svc.handleTheft(sessionDoc, 0); // classified epoch was 0; user is now 1
    ok("CR-012 mid-flight reset ⇒ superseded_401 (no false theft)", r.status === 401 && r.outcome === "superseded_401");
    const fresh = await User.findById(u._id);
    ok("CR-012 mid-flight: sessionVersion is 1 (reset only), NOT advanced to 2", (fresh.sessionVersion || 0) === 1);
    ok("CR-012 mid-flight: offending session still revoked (containment)", !!(await Session.findById(s.sid)).revokedAt);
  }

  // Outbox WORKER (CR-009) — leased, idempotent, monotonic, dead-letter
  {
    const worker = require("../../jobs/outboxWorker");
    await PendingSecurityAction.deleteMany({}); // isolate from earlier-test records
    const u = await mkUser(); // sessionVersion 0
    await svc.enqueuePending("sv-bump", { userId: u._id, sid: "sidW", targetVersion: 1, reason: "refresh-reuse" });
    const sum1 = await worker.drainOnce({ workerId: "wA" });
    ok("worker applies the sv-bump fence", (await User.findById(u._id)).sessionVersion === 1 && sum1.done === 1);
    ok("worker deletes the drained record", (await PendingSecurityAction.countDocuments({ _id: "sv-bump:sidW:1" })) === 0);
    // Duplicate/stale delivery is a monotonic no-op (never lowers the version)
    await User.updateOne({ _id: u._id }, { $set: { sessionVersion: 5 } });
    await svc.enqueuePending("sv-bump", { userId: u._id, sid: "sidW", targetVersion: 3, reason: "dup" });
    await worker.drainOnce({ workerId: "wA" });
    ok("worker never lowers the version (monotonic $lt guard)", (await User.findById(u._id)).sessionVersion === 5);
    // Dead-letter after MAX_ATTEMPTS when the action keeps failing
    const badId = "revoke-session:sidBad:0";
    await PendingSecurityAction.create({
      _id: badId, action: "revoke-session", userId: u._id, sid: "sidBad",
      attempts: worker.MAX_ATTEMPTS, nextAttemptAt: new Date(0), deadLetter: false, createdAt: new Date(),
    });
    const origUpd = Session.updateOne;
    Session.updateOne = () => { throw new Error("revoke-fail"); };
    try { await worker.drainOnce({ workerId: "wB" }); } finally { Session.updateOne = origUpd; }
    const dead = await PendingSecurityAction.findById(badId);
    ok("worker dead-letters after MAX_ATTEMPTS", dead && dead.deadLetter === true);
    ok("worker does not re-claim a dead-lettered record", (await worker.drainOnce({ workerId: "wC" })).done === 0);
  }

  // Helper: insert a RAW legacy User doc WITHOUT a sessionVersion field (bypasses
  // the Mongoose schema default) to reproduce pre-existing production documents.
  const insertLegacyUser = async () => {
    const r = await mongoose.connection.db.collection("users").insertOne({
      name: "L", email: `l${Math.random().toString(36).slice(2)}@e.com`, role: "student", userAgent: [],
    });
    return r.insertedId;
  };

  // CR-012 — a legacy User (absent sessionVersion) replaying a real ancestor is
  // CONFIRMED THEFT, not a false superseded_401. The fence must apply.
  {
    const uid = await insertLegacyUser();
    const raw0 = await mongoose.connection.db.collection("users").findOne({ _id: uid });
    ok("CR-012 legacy user has NO stored sessionVersion", raw0.sessionVersion === undefined);
    const u = await User.findById(uid); // hydrates sessionVersion = 0
    const s = await svc.createSession(u, {});
    await svc.refreshSession(s.refreshToken); // gen1, gen0 ringed
    await Session.updateOne({ _id: s.sid }, { $set: { lastRotatedAt: new Date(Date.now() - 60000) } });
    const r = await svc.refreshSession(s.refreshToken); // replay gen0 ancestor
    ok("CR-012 legacy-user ancestor replay ⇒ 403 theft (not superseded)", r.status === 403 && r.outcome === "theft_403");
    const rawAfter = await mongoose.connection.db.collection("users").findOne({ _id: uid });
    ok("CR-012 legacy-user fence applied (sessionVersion now 1)", rawAfter.sessionVersion === 1);
  }

  // CR-009 — the worker applies an sv-bump to a legacy User (absent field) via
  // $max, not skipping it.
  {
    const worker = require("../../jobs/outboxWorker");
    await PendingSecurityAction.deleteMany({});
    const uid = await insertLegacyUser();
    await svc.enqueuePending("sv-bump", { userId: uid, sid: "sidL", targetVersion: 1, reason: "refresh-reuse" });
    await worker.drainOnce({ workerId: "wLegacy" });
    const raw = await mongoose.connection.db.collection("users").findOne({ _id: uid });
    ok("CR-009 worker applies fence to a legacy absent-field user", raw.sessionVersion === 1);
    ok("CR-009 worker consumed the record only after applying", (await PendingSecurityAction.countDocuments({ _id: "sv-bump:sidL:1" })) === 0);
  }

  // CR-009 — a STALE worker (lease reclaimed by another) must NOT complete the
  // record: its completion is ownership-gated.
  {
    const worker = require("../../jobs/outboxWorker");
    await PendingSecurityAction.deleteMany({});
    const u = await mkUser();
    const _id = "sv-bump:sidStale:1";
    await PendingSecurityAction.create({
      _id, action: "sv-bump", userId: u._id, sid: "sidStale", targetVersion: 1,
      attempts: 1, nextAttemptAt: new Date(), leaseOwner: "worker-B", leaseUntil: new Date(Date.now() + 60000),
      deadLetter: false, createdAt: new Date(),
    });
    const rec = await PendingSecurityAction.findById(_id); // stale worker A holds this snapshot
    const outcome = await worker.applyOne(rec, new Date(), "worker-A"); // A is NOT the current owner
    ok("CR-009 stale worker completion returns 'stale' (not done)", outcome === "stale");
    const still = await PendingSecurityAction.findById(_id);
    ok("CR-009 stale worker did NOT delete the record", !!still);
    ok("CR-009 stale worker did NOT clear the current owner's lease", still.leaseOwner === "worker-B");
  }

  // CR-009 — a theft REVOKE-write failure still fences, enqueues, and alerts.
  {
    await PendingSecurityAction.deleteMany({});
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    await svc.refreshSession(s.refreshToken); // gen1, gen0 ringed
    await Session.updateOne({ _id: s.sid }, { $set: { lastRotatedAt: new Date(Date.now() - 60000) } });
    const origUpd = Session.updateOne;
    Session.updateOne = () => { throw new Error("revoke-write-fail"); }; // revokeSession throws
    let r;
    try { r = await svc.refreshSession(s.refreshToken); } finally { Session.updateOne = origUpd; }
    ok("CR-009 revoke-failure on confirmed replay ⇒ still 403 theft", r.status === 403 && r.outcome === "theft_403");
    ok("CR-009 revoke-failure still applied the account-wide fence", (await User.findById(u._id)).sessionVersion === 1);
    ok("CR-009 revoke-failure enqueued a durable revoke-session cleanup", (await PendingSecurityAction.countDocuments({ action: "revoke-session", sid: s.sid })) === 1);
  }

  // CR-009 (crash window) — a crash AFTER the atomic theft revoke but BEFORE the
  // inline fence must be recoverable. The fence intent is committed atomically
  // with the revoke (theftFenceTarget), and the worker's sweep applies it.
  {
    const worker = require("../../jobs/outboxWorker");
    await PendingSecurityAction.deleteMany({});
    const u = await mkUser(); // sessionVersion 0
    const s = await svc.createSession(u, {});
    const won = await svc.revokeForTheft(s.sid, 1); // atomic commit point only, then "crash"
    ok("crash-window: revokeForTheft won the CAS", won === true);
    const mid = await Session.findById(s.sid);
    ok("crash-window: revoke + fence marker persisted in ONE document", !!mid.revokedAt && mid.theftFenceTarget === 1);
    ok("crash-window: sessionVersion NOT yet bumped (inline fence never ran)", (await User.findById(u._id)).sessionVersion === 0);
    const sum = await worker.drainOnce({ workerId: "wCrash" });
    ok("crash recovery: worker applied the account-wide fence", (await User.findById(u._id)).sessionVersion === 1 && sum.fenced >= 1);
    ok("crash recovery: fence marker cleared after apply", (await Session.findById(s.sid)).theftFenceTarget == null);
  }

  // A NORMAL successful theft leaves NO residual fence marker (inline path clears it)
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    let cur = (await svc.refreshSession(s.refreshToken)).refreshToken;
    cur = (await svc.refreshSession(cur)).refreshToken; // gen2
    await Session.updateOne({ _id: s.sid }, { $set: { lastRotatedAt: new Date(Date.now() - 60000) } });
    const t = await svc.refreshSession(s.refreshToken);
    ok("normal theft ⇒ 403 and fence marker cleared (no residual)", t.status === 403 && (await Session.findById(s.sid)).theftFenceTarget == null);
  }

  // GATE 0 — the PARTIAL TTL must NOT delete a Session carrying a pending fence.
  // TTL sweeping is background (~60s) so we assert the index's SELECTION SET (what
  // MongoDB would delete) deterministically, plus the real index options.
  {
    const worker = require("../../jobs/outboxWorker");
    await Session.createIndexes(); // build the partial TTL + sparse marker indexes
    const now = new Date(), past = new Date(Date.now() - 3600000);
    const u1 = await mkUser(), u2 = await mkUser();
    await Session.create({ _id: "ttlNormal", userId: u1._id, authVersion: 0, refreshHash: "h-normal", refreshGen: 0, createdAt: past, refreshExpiresAt: past, absoluteExpiresAt: past });
    await Session.create({ _id: "ttlMarked", userId: u2._id, authVersion: 0, refreshHash: "h-marked", refreshGen: 0, createdAt: past, refreshExpiresAt: past, absoluteExpiresAt: past, theftFenceTarget: 1 });
    const ttlSet = (id) => Session.countDocuments({ _id: id, theftFenceTarget: null, absoluteExpiresAt: { $lt: now } });
    ok("Gate0 partial-TTL SELECTS a normal expired session", (await ttlSet("ttlNormal")) === 1);
    ok("Gate0 partial-TTL EXCLUDES a session with a pending marker", (await ttlSet("ttlMarked")) === 0);
    const ttlIx = (await Session.collection.indexes()).find((i) => i.name === "absoluteExpiresAt_1");
    ok("Gate0 TTL index has expireAfterSeconds:0 + partialFilterExpression", !!ttlIx && ttlIx.expireAfterSeconds === 0 && !!ttlIx.partialFilterExpression && "theftFenceTarget" in ttlIx.partialFilterExpression);
    // Worker recovers the fence and clears the marker → session becomes TTL-eligible.
    await worker.sweepSessionFences({});
    ok("Gate0 worker fenced the marked user's epoch", (await User.findById(u2._id)).sessionVersion === 1);
    ok("Gate0 after recovery the marked session becomes TTL-eligible", (await ttlSet("ttlMarked")) === 1);
  }

  // Suspended user ⇒ 401 user (precedence), no rotation
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    await User.updateOne({ _id: u._id }, { $set: { role: "suspended" } });
    const r = await svc.refreshSession(s.refreshToken);
    ok("precedence: suspended user ⇒ 401 user", r.outcome === "user_401");
  }

  // CR-014 — refresh cookie maxAge is capped at the remaining ABSOLUTE lifetime
  {
    let captured = null;
    const fakeRes = { cookie: (name, val, opts) => { captured = { name, opts }; } };
    const now = Date.now();
    authCtl.setRefreshCookie(fakeRes, "sid.1.secret", new Date(now + 30 * 24 * 3600 * 1000), new Date(now + 5 * 60 * 1000));
    const capMin = 4 * 60 * 1000, capMax = 6 * 60 * 1000;
    ok("CR-014 cookie maxAge capped near the absolute deadline (~5min, not 30d)",
      captured && captured.opts.maxAge >= capMin && captured.opts.maxAge <= capMax);
  }

  // CR-011 — JWT type enforcement in resolveSessionUser
  {
    const u = await mkUser();
    const access = generateAccessToken(u._id, u.sessionVersion || 0, "somesid", 15 * 60 * 1000);
    ok("CR-011 access-typed token authenticates", !!(await resolveSessionUser(access)).user);
    const rollback = generateRollbackToken(u._id, u.sessionVersion || 0, 7 * 24 * 3600 * 1000);
    ok("CR-011 rollback-typed token authenticates", !!(await resolveSessionUser(rollback)).user);
    const legacy = jwt.sign({ id: String(u._id), sv: u.sessionVersion || 0 }, process.env.JWT_SECRET); // no type
    ok("CR-011 legacy no-type token grandfathered", !!(await resolveSessionUser(legacy)).user);
    const weird = jwt.sign({ id: String(u._id), type: "refresh" }, process.env.JWT_SECRET);
    ok("CR-011 wrong-type token rejected", !!(await resolveSessionUser(weird)).error);
  }

  // CR-011 — rollback issuance is COOKIE-ONLY (no JSON leak) and maxAge from exp
  {
    _setForTest({ flags: { SESSION_MODEL_ENABLED: true, ISSUE_NEW_MODEL: false } });
    const u = await mkUser();
    const cookies = [];
    const fakeReq = { headers: {}, ip: "1.1.1.1" };
    const fakeRes = { cookie: (n, v, o) => cookies.push({ n, v, o }), clearCookie: () => {} };
    const t0 = Date.now();
    const returned = await authCtl.issueAuthForUser(fakeReq, fakeRes, u);
    ok("CR-011 rollback mode returns NOTHING in the JSON body (cookie-only)", returned === null);
    const rc = cookies.find((c) => c.n === authCtl.ROLLBACK_COOKIE);
    ok("CR-011 rollback mode sets the rollback cookie", !!rc);
    const decoded = jwt.verify(rc.v, process.env.JWT_SECRET);
    ok("CR-011 rollback cookie is a bounded-exp rollback JWT", decoded.type === "rollback" && !!decoded.exp);
    // Max-Age <= exp: maxAge was computed at t>=t0, so it must be <= exp*1000 - t0.
    ok("CR-011 rollback cookie maxAge never exceeds the signed exp", rc.o.maxAge <= decoded.exp * 1000 - t0);
    _setForTest({ flags: { SESSION_MODEL_ENABLED: false, ISSUE_NEW_MODEL: true } });
  }

  // CR-011 — EMERGENCY_REAUTH rejects a rollback token on protected routes
  {
    const u = await mkUser();
    const rollback = generateRollbackToken(u._id, u.sessionVersion || 0, 7 * 24 * 3600 * 1000);
    ok("CR-011 rollback token accepted when NOT in emergency", !!(await resolveSessionUser(rollback)).user);
    _setForTest({ flags: { EMERGENCY_REAUTH: true } });
    const res = await resolveSessionUser(rollback);
    ok("CR-011 EMERGENCY_REAUTH rejects the rollback token on protected routes", !!res.error && res.error.kind === "auth_emergency_reauth");
    _setForTest({ flags: { EMERGENCY_REAUTH: false } });
  }

  await mongoose.disconnect();

  await mem.stop();

  const script = path.join(__dirname, "..", "..", "migrations", "2026-07-25-session-collection.js");
  const runMig = (uri, args) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, MONGO_URI: uri, DATABASE_CLOUD: uri }, encoding: "utf8",
  });

  // CR-010 (positive) — a throwaway-NAMED DB: dry-run contacts read-only, creates nothing.
  {
    const mem2 = await MongoMemoryServer.create();
    const uri2 = mem2.getUri("test_mig"); // ensure the DB NAME is in the URI path
    const run = runMig(uri2, ["--dry-run"]);
    ok("CR-010 throwaway-named dry-run prints read-only completion", /READ ONLY, nothing created/.test(run.stdout || ""));
    await mongoose.connect(uri2);
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    ok("CR-010 dry-run created NO 'sessions' collection", !names.includes("sessions"));
    ok("CR-010 dry-run created NO 'pendingsecurityactions' collection", !names.includes("pendingsecurityactions"));
    await mongoose.disconnect();
    await mem2.stop();
  }

  // CR-010 (negative) — a PRODUCTION-like name on localhost with NO --db must NOT
  // be contacted (the fix that keys safety on the NAME, not the host).
  {
    const mem3 = await MongoMemoryServer.create();
    const uri3 = mem3.getUri("examopia_prod"); // production-like NAME on localhost
    const run = runMig(uri3, ["--dry-run"]); // no --db, no --force
    ok("CR-010 prod-named localhost DB is NOT contacted", /will NOT contact/.test(run.stdout || ""));
    ok("CR-010 prod-named run does NOT print read-only completion", !/READ ONLY, nothing created/.test(run.stdout || ""));
    // And with an explicit matching --db, it IS allowed (read-only)
    const run2 = runMig(uri3, ["--dry-run", "--db=examopia_prod"]);
    ok("CR-010 explicit --db authorizes the read-only dry-run", /READ ONLY, nothing created/.test(run2.stdout || ""));
    await mongoose.connect(uri3);
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    ok("CR-010 neither run created any collection", !names.includes("sessions") && !names.includes("pendingsecurityactions"));
    await mongoose.disconnect();
    await mem3.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
