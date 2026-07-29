/*
 * AUD-002 session-model core regression. SERVICE/MODEL integration (NOT full
 * HTTP-stack): drives services/sessionService against in-memory Mongo for the
 * happy path + precedence — epoch-fenced rotation, the failed-CAS precedence,
 * idempotent grace replay with no leapfrog, ancestor-replay theft, the reset/logout-all/
 * change-password epoch fence, and the outbox. Failure-safety and concurrency
 * (CR-007..CR-014) live in session-hardening.test.js; HTTP flag/status/cookie
 * contracts are still an open coverage gap (documented in FIX_RESULTS).
 * Test IDs: AUD-002-T1..T13.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud002-core";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud002-core";

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Session = require("../../models/sessionModel");
const PendingSecurityAction = require("../../models/pendingSecurityActionModel");
const { _setForTest, params } = require("../../config/featureFlags");
const svc = require("../../services/sessionService");
const { parseRefreshToken } = require("../../utils/refreshToken");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

const mkUser = (over = {}) =>
  User.create({ name: "U", email: `u${Math.random().toString(36).slice(2)}@e.com`, password: "origPass12", role: "student", ...over });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  // Small ring + grace so eviction/expiry tests are fast and deterministic.
  _setForTest({ params: { RING_DEPTH: 3, GRACE_WINDOW_MS: 10 * 1000 } });

  // T1 — createSession issues a pair and captures the epoch
  {
    const u = await mkUser();
    const { session, accessToken, refreshToken } = await svc.createSession(u, {});
    ok("T1 createSession returns access+refresh", !!accessToken && !!refreshToken);
    ok("T1 session captures authVersion = user.sessionVersion", session.authVersion === (u.sessionVersion || 0));
    ok("T1 refresh token is <sid>.<gen>.<secret> at gen 0", parseRefreshToken(refreshToken)?.gen === 0);
    const claims = jwt.verify(accessToken, process.env.JWT_SECRET);
    ok("T1 access token carries exp + sid + type", !!claims.exp && claims.sid === session._id && claims.type === "access");
  }

  // T2 — rotation happy path
  {
    const u = await mkUser();
    const { refreshToken } = await svc.createSession(u, {});
    const r = await svc.refreshSession(refreshToken);
    ok("T2 rotation returns 200 rotated", r.status === 200 && r.outcome === "rotated");
    ok("T2 new refresh token is gen 1", parseRefreshToken(r.refreshToken)?.gen === 1);
    const s = await Session.findById(parseRefreshToken(refreshToken).sid);
    ok("T2 session advanced to gen 1", s.refreshGen === 1);
    ok("T2 superseded secret ringed", (s.usedRefreshHashes || []).some((e) => e.gen === 0));
    ok("T2 refreshExpiresAt ≤ absoluteExpiresAt", s.refreshExpiresAt <= s.absoluteExpiresAt);
  }

  // T3 — expiry boundaries (case 2)
  {
    const u = await mkUser();
    const { refreshToken, sid } = await svc.createSession(u, {});
    await Session.updateOne({ _id: sid }, { $set: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
    const r = await svc.refreshSession(refreshToken);
    ok("T3 absolute-expired ⇒ 401 expired", r.status === 401 && r.outcome === "expired_401");
    const u2 = await mkUser();
    const s2 = await svc.createSession(u2, {});
    await Session.updateOne({ _id: s2.sid }, { $set: { refreshExpiresAt: new Date(Date.now() - 1000) } });
    const r2 = await svc.refreshSession(s2.refreshToken);
    ok("T3 sliding-expired ⇒ 401 expired", r2.status === 401 && r2.outcome === "expired_401");
  }

  // T4 — ancestor replay within the ring = theft (403 + revoke + sv bump)
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    const r1 = await svc.refreshSession(s.refreshToken); // gen0 -> gen1
    const r2 = await svc.refreshSession(r1.refreshToken); // gen1 -> gen2
    // Replay the gen0 token now that current is gen2 (ancestor, outside grace via manual age)
    await Session.updateOne({ _id: s.sid }, { $set: { lastRotatedAt: new Date(Date.now() - 60 * 1000) } });
    const theft = await svc.refreshSession(s.refreshToken);
    ok("T4 ancestor replay ⇒ 403 theft", theft.status === 403 && theft.outcome === "theft_403");
    const sess = await Session.findById(s.sid);
    ok("T4 session revoked on theft", !!sess.revokedAt);
    const fresh = await User.findById(u._id);
    ok("T4 sessionVersion bumped on theft (logout-all)", (fresh.sessionVersion || 0) === 1);
  }

  // T5 — replay beyond the ring ⇒ 401, session NOT revoked (DoS guard)
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {}); // gen0
    let cur = s.refreshToken;
    for (let i = 0; i < 5; i++) cur = (await svc.refreshSession(cur)).refreshToken; // rotate past RING_DEPTH=3
    await Session.updateOne({ _id: s.sid }, { $set: { lastRotatedAt: new Date(Date.now() - 60 * 1000) } });
    const r = await svc.refreshSession(s.refreshToken); // gen0 evicted from ring
    ok("T5 evicted ancestor ⇒ 401 unknown (not theft)", r.status === 401 && r.outcome === "unknown_401");
    const sess = await Session.findById(s.sid);
    ok("T5 session NOT revoked (no sid-guess DoS)", !sess.revokedAt);
  }

  // T6 — immediately-previous within grace replays the exact prior response.
  // This recovers a hard reload that lost the first response without rotating
  // again or permitting the rejected leapfrog behavior.
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    const r1 = await svc.refreshSession(s.refreshToken); // gen0 -> gen1 (lastRotatedAt = now)
    const g1 = await svc.refreshSession(s.refreshToken); // present gen0, within grace
    ok("T6 grace ⇒ exact idempotent response replay", g1.status === 200
      && g1.outcome === "rotation_replayed"
      && g1.refreshToken === r1.refreshToken
      && g1.accessToken === r1.accessToken);
    const afterFirst = await Session.findById(s.sid);
    ok("T6 generation unchanged after replay", afterFirst.refreshGen === 1);
    const g2 = await svc.refreshSession(s.refreshToken); // present the SAME old token again
    const afterSecond = await Session.findById(s.sid);
    ok("T6 NO leapfrog — repeated replay cannot advance the generation",
      g2.status === 200 && g2.refreshToken === r1.refreshToken && afterSecond.refreshGen === 1);
    ok("T6 replay payload is encrypted at rest",
      !String(afterSecond.rotationReplay?.responseCipher || "").includes(r1.refreshToken));
    await Session.updateOne(
      { _id: s.sid },
      { $set: { "rotationReplay.responseCipher": "corrupt" } }
    );
    const failClosed = await svc.refreshSession(s.refreshToken);
    ok("T6 corrupt replay record fails closed to 409 without rotating",
      failClosed.status === 409 && (await Session.findById(s.sid)).refreshGen === 1);
  }

  // T7 — immediately-previous OUTSIDE grace ⇒ theft (403), not 409
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    const r1 = await svc.refreshSession(s.refreshToken); // gen0 -> gen1
    await Session.updateOne({ _id: s.sid }, { $set: { lastRotatedAt: new Date(Date.now() - 60 * 1000) } });
    const t = await svc.refreshSession(s.refreshToken); // gen0, ring, but stale
    ok("T7 previous gen outside grace ⇒ 403 theft", t.status === 403 && t.outcome === "theft_403");
  }

  // T8 — epoch fence: reset (sv bump) supersedes a live family
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {}); // authVersion 0
    await User.updateOne({ _id: u._id }, { $inc: { sessionVersion: 1 } }); // reset bumps epoch, no revoke yet
    const r = await svc.refreshSession(s.refreshToken);
    ok("T8 stale-epoch family ⇒ 401 superseded (cannot rotate)", r.status === 401 && r.outcome === "superseded_401");
    const sess = await Session.findById(s.sid);
    ok("T8 stale-epoch session still gen 0 (no rotation happened)", sess.refreshGen === 0);
  }

  // T9 — revokeAllForUser bumps FIRST then revokes; subsequent refresh fails
  {
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    const newV = await svc.revokeAllForUser(u._id, "logout-all");
    ok("T9 revokeAllForUser returns bumped version", newV === 1);
    const r = await svc.refreshSession(s.refreshToken);
    ok("T9 refresh after logout-all ⇒ 401 (revoked or superseded)", r.status === 401);
    const sess = await Session.findById(s.sid);
    ok("T9 session revoked", !!sess.revokedAt);
  }

  // T10 — change-password (changePasswordAtomic) keeps caller alive, revokes others
  {
    const u = await mkUser();
    const caller = await svc.createSession(u, {});
    const other = await svc.createSession(await User.findById(u._id), {});
    const fresh = await User.findById(u._id);
    const out = await svc.changePasswordAtomic(fresh, "hashX", 0, caller.sid);
    ok("T10 change-password returns a fresh pair for the caller", !!out && out.ok && !!out.accessToken && !!out.refreshToken);
    const callerSess = await Session.findById(caller.sid);
    ok("T10 caller session rebound to new epoch", callerSess.authVersion === 1 && !callerSess.revokedAt);
    const otherSess = await Session.findById(other.sid);
    ok("T10 other (old-epoch) session revoked by epoch-scoped cleanup", !!otherSess.revokedAt);
    const oldReuse = await svc.refreshSession(caller.refreshToken);
    ok("T10 caller's pre-change token cannot mint a new pair", oldReuse.status !== 200);
    const newUse = await svc.refreshSession(out.refreshToken);
    ok("T10 caller's new token rotates normally", newUse.status === 200);
  }

  // T11 — change-password rebind failure ⇒ reauth (caller logged out, fail-safe), epoch preserved
  {
    const u = await mkUser();
    const fresh = await User.findById(u._id);
    const out = await svc.changePasswordAtomic(fresh, "hashX", 0, "no-such-sid");
    ok("T11 rebind on a missing session ⇒ reauth (no tokens)", !!out && out.ok && out.reauth === true && !out.accessToken);
    const bumped = await User.findById(u._id);
    ok("T11 sv still bumped (fence held even though caller re-auths)", (bumped.sessionVersion || 0) === 1);
  }

  // T12 — precedence: malformed / unknown / deleted-user / concurrent-current
  {
    ok("T12 malformed token ⇒ 401 malformed", (await svc.refreshSession("garbage")).outcome === "malformed_401");
    ok("T12 well-formed unknown sid ⇒ 401 unknown", (await svc.refreshSession("aaa.0.bbb")).outcome === "unknown_401");
    const u = await mkUser();
    const s = await svc.createSession(u, {});
    await User.deleteOne({ _id: u._id });
    ok("T12 deleted user ⇒ 401 user", (await svc.refreshSession(s.refreshToken)).outcome === "user_401");
    // Two concurrent CURRENT-token requests: one rotates, the other receives
    // the exact idempotent replay. Both succeed with one live refresh secret.
    const u2 = await mkUser();
    const s2 = await svc.createSession(u2, {});
    const [a, b] = await Promise.all([svc.refreshSession(s2.refreshToken), svc.refreshSession(s2.refreshToken)]);
    ok("T12 concurrent current-token ⇒ two 200s with one identical rotation",
      a.status === 200 && b.status === 200
      && a.refreshToken === b.refreshToken
      && a.accessToken === b.accessToken);
  }

  // T13 — outbox enqueue is idempotent on the key
  {
    const u = await mkUser();
    await svc.enqueuePending("sv-bump", { userId: u._id, sid: "sidX", targetVersion: 2, reason: "refresh-reuse" });
    await svc.enqueuePending("sv-bump", { userId: u._id, sid: "sidX", targetVersion: 2, reason: "refresh-reuse" });
    const count = await PendingSecurityAction.countDocuments({ _id: "sv-bump:sidX:2" });
    ok("T13 duplicate enqueue is a single outbox record", count === 1);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
