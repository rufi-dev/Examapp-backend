const Session = require("../models/sessionModel");
const User = require("../models/userModel");
const PendingSecurityAction = require("../models/pendingSecurityActionModel");
const Cryptr = require("cryptr");
const { params } = require("../config/featureFlags");
const { recordDebug } = require("../utils/debugLog");
const {
  newSid,
  newSecret,
  hashSecret,
  buildRefreshToken,
  parseRefreshToken,
  generateAccessToken,
} = require("../utils/refreshToken");

// AUD-002 session core (docs/adr/AUD-002-session-lifecycle.md §2.2). Pure of
// HTTP: controllers translate the returned { status, outcome } into responses
// and cookies. Only activates on the flagged path.

const nowDate = () => new Date();

function replayCrypt() {
  return new Cryptr(process.env.CRYPTR_KEY);
}

function sealRotationReplay(payload) {
  return replayCrypt().encrypt(JSON.stringify(payload));
}

function openRotationReplay(session, parsed, presentedHash, now) {
  const replay = session.rotationReplay;
  if (
    !replay
    || replay.consumedGen !== parsed.gen
    || replay.consumedHash !== presentedHash
    || !replay.expiresAt
    || new Date(replay.expiresAt).getTime() < now
    || typeof replay.responseCipher !== "string"
  ) return null;

  try {
    const payload = JSON.parse(replayCrypt().decrypt(replay.responseCipher));
    const replayed = parseRefreshToken(payload.refreshToken);
    if (
      !replayed
      || replayed.sid !== String(session._id)
      || replayed.gen !== session.refreshGen
      || hashSecret(replayed.secret) !== session.refreshHash
      || typeof payload.accessToken !== "string"
    ) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// A monitored security event. Written to TWO independent channels so a failure
// of one is still observable (CR-009): (1) the DebugLog DB (survives redeploy,
// queryable) and (2) stderr (does NOT depend on the DB that may have just
// failed — a log scraper / alerting pipeline can page on it). `fatal` events
// (e.g. outbox enqueue failure) are always emitted on stderr.
function emitSecurityEvent(kind, detail = {}) {
  try { recordDebug({ kind: `sec_${kind}`, message: JSON.stringify(detail), userId: detail.userId }); } catch (_) {}
  // eslint-disable-next-line no-console
  console.error(`[SECURITY] sec_${kind} ${JSON.stringify(detail)}`);
}

// Shared "is this a live, current-epoch session?" precedence (cases 2–5).
// Returns a terminal { status, outcome } or null when the session is live and
// the epoch matches. Used BOTH before the CAS and again after a CAS miss
// (CR-012), so a reset/logout-all landing mid-request cannot be misread as theft.
function classifyLive(session, user, now) {
  if (session.refreshExpiresAt <= new Date(now) || session.absoluteExpiresAt <= new Date(now)) {
    return { status: 401, outcome: "expired_401" }; // case 2
  }
  if (session.revokedAt) return { status: 401, outcome: "revoked_401" }; // case 3
  if (!user || user.role === "suspended") return { status: 401, outcome: "user_401" }; // case 5
  if (session.authVersion !== (user.sessionVersion || 0)) {
    return { status: 401, outcome: "superseded_401" }; // case 4 (epoch fence)
  }
  return null;
}

// --- creation -------------------------------------------------------------

async function createSession(user, meta = {}) {
  const now = Date.now();
  const sid = newSid();
  const secret = newSecret();
  const authVersion = user.sessionVersion || 0;
  const refreshExpiresAt = new Date(now + params.REFRESH_SLIDING_MS);
  const absoluteExpiresAt = new Date(now + params.REFRESH_ABSOLUTE_MS);
  const session = await Session.create({
    _id: sid,
    userId: user._id,
    authVersion,
    refreshHash: hashSecret(secret),
    refreshGen: 0,
    usedRefreshHashes: [],
    userAgent: meta.userAgent,
    ip: meta.ip,
    createdAt: new Date(now),
    lastUsedAt: new Date(now),
    lastRotatedAt: new Date(now),
    refreshExpiresAt,
    absoluteExpiresAt,
  });
  const accessToken = generateAccessToken(user._id, authVersion, sid, params.ACCESS_TTL_MS);
  const refreshToken = buildRefreshToken(sid, 0, secret);
  return { session, accessToken, refreshToken, sid, refreshExpiresAt, absoluteExpiresAt };
}

// --- refresh (epoch-fenced rotation + full 11-step precedence) -------------

async function refreshSession(rawRefreshToken) {
  const now = Date.now();
  try {
    const parsed = parseRefreshToken(rawRefreshToken); // case 0
    if (!parsed) return { status: 401, outcome: "malformed_401" };

    const session = await Session.findById(parsed.sid); // case 1
    if (!session) return { status: 401, outcome: "unknown_401" };

    const user = await User.findById(session.userId).select("sessionVersion role");
    const pre = classifyLive(session, user, now); // cases 2–5
    if (pre) return pre;
    const userSv = user.sessionVersion || 0;
    const presentedHash = hashSecret(parsed.secret);

    // case 6 — epoch-fenced happy-path CAS (single-document aggregation pipeline)
    const newSec = newSecret();
    const nextGen = parsed.gen + 1;
    const accessToken = generateAccessToken(user._id, userSv, parsed.sid, params.ACCESS_TTL_MS);
    const refreshToken = buildRefreshToken(parsed.sid, nextGen, newSec);
    const replayPayload = {
      accessToken,
      refreshToken,
      refreshExpiresAt: new Date(Math.min(
        now + params.REFRESH_SLIDING_MS,
        session.absoluteExpiresAt.getTime()
      )),
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
    const rotationReplay = {
      consumedGen: parsed.gen,
      consumedHash: presentedHash,
      responseCipher: sealRotationReplay(replayPayload),
      expiresAt: new Date(now + params.GRACE_WINDOW_MS),
    };
    const rotated = await Session.findOneAndUpdate(
      {
        _id: parsed.sid,
        refreshGen: parsed.gen,
        refreshHash: presentedHash,
        authVersion: userSv,
        revokedAt: null,
        refreshExpiresAt: { $gt: new Date(now) },
        absoluteExpiresAt: { $gt: new Date(now) },
      },
      [
        {
          $set: {
            refreshHash: hashSecret(newSec),
            refreshGen: { $add: ["$refreshGen", 1] },
            lastUsedAt: new Date(now),
            lastRotatedAt: new Date(now),
            rotationReplay,
            refreshExpiresAt: { $min: [new Date(now + params.REFRESH_SLIDING_MS), "$absoluteExpiresAt"] },
            usedRefreshHashes: {
              $slice: [
                { $concatArrays: ["$usedRefreshHashes", [{ gen: "$refreshGen", hash: "$refreshHash" }]] },
                -params.RING_DEPTH,
              ],
            },
          },
        },
      ],
      { new: true }
    );
    if (rotated) {
      return {
        status: 200, outcome: "rotated", accessToken, refreshToken, sid: parsed.sid,
        userId: String(user._id), refreshExpiresAt: rotated.refreshExpiresAt, absoluteExpiresAt: rotated.absoluteExpiresAt,
      };
    }

    // CR-012 — CAS missed: RE-READ session AND user and re-run the live
    // precedence first, so a concurrent reset/logout-all is classified as
    // superseded/revoked (401), never as theft.
    const cur = await Session.findById(parsed.sid);
    if (!cur) return { status: 401, outcome: "unknown_401" };
    const curUser = await User.findById(cur.userId).select("sessionVersion role");
    const post = classifyLive(cur, curUser, now);
    if (post) return post;

    const ringEntry = (cur.usedRefreshHashes || []).find(
      (e) => e.gen === parsed.gen && e.hash === presentedHash
    );
    if (ringEntry) {
      const withinGrace = now - new Date(cur.lastRotatedAt).getTime() <= params.GRACE_WINDOW_MS;
      if (parsed.gen === cur.refreshGen - 1 && withinGrace) {
        const replay = openRotationReplay(cur, parsed, presentedHash, now);
        if (replay) {
          return {
            status: 200,
            outcome: "rotation_replayed",
            accessToken: replay.accessToken,
            refreshToken: replay.refreshToken,
            sid: parsed.sid,
            userId: String(cur.userId),
            refreshExpiresAt: replay.refreshExpiresAt,
            absoluteExpiresAt: replay.absoluteExpiresAt,
          };
        }
        return { status: 409, outcome: "grace_409" }; // case 7 — strict, no mutation
      }
      // case 8 — authenticated ancestor replay = theft (concurrency-idempotent,
      // epoch-conditional). Pass the epoch we JUST classified against so a reset
      // landing mid-flight is not misread as theft (CR-012).
      return await handleTheft(cur, curUser ? (curUser.sessionVersion || 0) : 0);
    }
    return { status: 401, outcome: "unknown_401" }; // case 9 — beyond ring / unauthenticated
  } catch (err) {
    return { status: 500, outcome: "infra_5xx", error: err.message }; // case 10
  }
}

// Epoch predicate that is SAFE for legacy User docs where `sessionVersion` is
// ABSENT (the ADR treats absent as 0, but MongoDB does NOT match { sv: 0 }
// against a missing field — CR-012/CR-009). When the classified epoch is 0 we
// also match { $exists: false }; `$inc` then treats the missing field as 0.
function epochMatch(expected) {
  return expected === 0
    ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] }
    : { sessionVersion: expected };
}

// The conditional account-wide fence. Returns "bumped" (real theft, epoch was
// still the classified one), "missed" (a reset/logout-all raced in ⇒ superseded,
// not theft), or "enqueued" (infra throw ⇒ durably retried, treated as theft).
async function fenceOrEnqueue(session, expected) {
  const targetVersion = expected + 1;
  try {
    const res = await User.findOneAndUpdate(
      { _id: session.userId, ...epochMatch(expected) },
      { $inc: { sessionVersion: 1 } },
      { new: true }
    );
    return res ? "bumped" : "missed";
  } catch (err) {
    const enq = await enqueuePending("sv-bump", {
      userId: session.userId, sid: String(session._id), targetVersion, reason: "refresh-reuse",
    });
    if (!enq) emitSecurityEvent("outbox_enqueue_failed", { userId: String(session.userId), sid: String(session._id), fatal: true });
    return "enqueued";
  }
}

// Theft revoke CAS that ATOMICALLY records the account-wide fence intent
// (theftFenceTarget) in the SAME write that flips revokedAt (CR-009). Winning
// this write is what commits "this is theft, the fence is owed" — durably, in one
// document — so a crash before the inline bump cannot separate the two. Returns
// true only for the request that transitions revokedAt from null.
async function revokeForTheft(sid, fenceTarget) {
  const res = await Session.updateOne(
    { _id: sid, revokedAt: null },
    { $set: { revokedAt: nowDate(), theftFenceTarget: fenceTarget } }
  );
  const changed = res.modifiedCount != null ? res.modifiedCount : res.nModified;
  return (changed || 0) === 1;
}

// Clear the fence marker once the fence is applied (idempotent). $unset (not
// set-null) so the session re-enters the partial TTL's coverage (Gate 0).
async function clearFenceMarker(sid) {
  await Session.updateOne({ _id: sid }, { $unset: { theftFenceTarget: "" } }).catch(() => {});
}

// CR-008/CR-009/CR-012 — theft handling: concurrency-idempotent, epoch-
// conditional, absent-field-safe, resilient to a revoke-write failure, AND
// crash-safe (the fence intent is committed atomically with the revoke).
async function handleTheft(session, expected) {
  const fenceTarget = expected + 1;
  let won;
  try {
    // Atomic commit point: revoke + record the owed fence in ONE write.
    won = await revokeForTheft(session._id, fenceTarget);
  } catch (revokeErr) {
    // The atomic write itself threw — we could not durably record via the
    // Session, so fall back to the outbox for BOTH the fence and a targeted
    // revoke, and ALWAYS alert (CR-009 revoke-failure path).
    const outcome = await fenceOrEnqueue(session, expected);
    const enq = await enqueuePending("revoke-session", { userId: session.userId, sid: String(session._id), reason: "refresh-reuse" });
    if (!enq) emitSecurityEvent("outbox_enqueue_failed", { userId: String(session.userId), sid: String(session._id), fatal: true });
    emitSecurityEvent("refresh_reuse_revoke_failed", { userId: String(session.userId), sid: String(session._id), fatal: true });
    return outcome === "missed"
      ? { status: 401, outcome: "superseded_401" }
      : { status: 403, outcome: "theft_403", userId: String(session.userId) };
  }
  if (!won) {
    // Already revoked (concurrent theft OR a benign logout/reset) — no marker was
    // set by us, so no fence is owed for this path. Benign.
    return { status: 401, outcome: "revoked_401" };
  }
  // We won: the fence is now DURABLY owed (marker persisted). Apply it inline for
  // immediacy; the worker's sweep is the crash-recovery net if we die here.
  const outcome = await fenceOrEnqueue(session, expected);
  if (outcome === "missed") {
    // A reset advanced the epoch first ⇒ superseded, not theft. The marker's
    // target is now a monotonic no-op; clear it. No theft event (CR-012).
    await clearFenceMarker(session._id);
    return { status: 401, outcome: "superseded_401" };
  }
  if (outcome === "bumped") await clearFenceMarker(session._id); // applied inline
  // "enqueued" (inline fence threw): leave the marker AND the outbox record as
  // dual safety nets; both are monotonic/idempotent.
  emitSecurityEvent("refresh_reuse_theft", { userId: String(session.userId), sid: String(session._id) });
  return { status: 403, outcome: "theft_403", userId: String(session.userId) };
}

// --- revocation & epoch ---------------------------------------------------

// CR-008 — compare-and-swap revoke: returns true ONLY for the request that
// actually transitions revokedAt from null. Concurrent losers get false.
async function revokeSession(sid) {
  const res = await Session.updateOne({ _id: sid, revokedAt: null }, { $set: { revokedAt: nowDate() } });
  const changed = res.modifiedCount != null ? res.modifiedCount : res.nModified;
  return (changed || 0) === 1;
}

async function bumpUserVersion(userId) {
  const res = await User.findByIdAndUpdate(userId, { $inc: { sessionVersion: 1 } }, { new: true });
  return res ? res.sessionVersion : null;
}

// CR-015 — EPOCH-SCOPED account cleanup. Revokes ONLY sessions whose effective
// authVersion ($ifNull → 0 for legacy) is BELOW `targetVersion`. A session
// created/rebound at the new epoch (authVersion == targetVersion) is excluded,
// so this can never revoke the just-rebound caller or a new current-epoch login.
// Same predicate is used synchronously AND by the worker, so a delayed run is
// still correctly scoped. On failure it enqueues `revoke-before-epoch` (which
// carries the concrete target); if enqueue also fails, the epoch fence still
// holds and we emit the degradation alert.
async function revokeSessionsBelowEpoch(userId, targetVersion) {
  // CR-015/CR-019: a valid account-cleanup target is a POSITIVE safe integer.
  // Anything else must NEVER become a broad revoke.
  if (!Number.isSafeInteger(targetVersion) || targetVersion <= 0) {
    emitSecurityEvent("account_cleanup_invalid", { userId: String(userId), reason: "invalid_target", fatal: true });
    return false;
  }
  try {
    await Session.updateMany(
      { userId, revokedAt: null, $expr: { $lt: [{ $ifNull: ["$authVersion", 0] }, targetVersion] } },
      { $set: { revokedAt: nowDate() } }
    );
    return true;
  } catch (_) {
    const enq = await enqueuePending("revoke-before-epoch", { userId, targetVersion });
    if (!enq) emitSecurityEvent("outbox_enqueue_failed", { userId: String(userId), reason: "revoke-before-epoch", fatal: true });
    return false;
  }
}

// Reset / logout-all: bump FIRST (durable fence), then epoch-scoped cleanup.
async function revokeAllForUser(userId, reason) {
  const newVersion = await bumpUserVersion(userId);
  await revokeSessionsBelowEpoch(userId, newVersion);
  return newVersion;
}

// Revoke a single caller's own session (single-device logout).
async function revokeOne(sid) {
  return revokeSession(sid);
}

// Gate 2 / CR-015: reset-password cleanup. Reset already bumped `sessionVersion`
// itself (the durable fence); the caller passes that committed `targetVersion`
// so cleanup is epoch-scoped (no second bump, never a broad revoke).
async function revokeAllSessions(userId, targetVersion) {
  return revokeSessionsBelowEpoch(userId, targetVersion);
}


// Gate 2 / Queue 1A — change-password atomic path. The CALLER has already
// validated types/policy, verified the old password, and computed `newHash`.
// This does the security-critical part:
//   1. ONE guarded User write: set password hash + advance the epoch exactly
//      once, conditional on the classified `expectedSv` (guards concurrent
//      password/epoch changes; absent-field-safe).
//   2. rebind + rotate ONLY the caller's Session to the new epoch.
//   3. revoke sibling Sessions as retryable cleanup (no second bump).
// Returns:
//   { ok:false, conflict:true }                 — lost the guarded race (retry)
//   { ok:true, reauth:true }                    — epoch advanced but rebind failed
//                                                  (caller must re-login; NO rollback)
//   { ok:true, accessToken, refreshToken, ... } — caller stays signed in
async function changePasswordAtomic(user, newHash, expectedSv, sid) {
  const now = Date.now();
  const updated = await User.findOneAndUpdate(
    { _id: user._id, ...epochMatch(expectedSv) },
    { $set: { password: newHash }, $inc: { sessionVersion: 1 } },
    { new: true }
  );
  if (!updated) return { ok: false, conflict: true }; // concurrent change won
  const newVersion = updated.sessionVersion;

  // CR-018: the password + epoch are now COMMITTED. From here, ANY failure must
  // degrade to the re-auth fail-safe — never throw (which would surface as 500
  // and skip credential clearing), and never roll the password/epoch back.
  try {
    // 1) Rebind + rotate ONLY the caller's session to the new epoch — BEFORE any
    //    cleanup (CR-015), so the epoch-scoped cleanup naturally excludes it.
    const newSec = newSecret();
    const rebound = await Session.findOneAndUpdate(
      { _id: sid, userId: user._id, revokedAt: null },
      [
        {
          $set: {
            authVersion: newVersion,
            refreshHash: hashSecret(newSec),
            refreshGen: { $add: ["$refreshGen", 1] },
            lastUsedAt: new Date(now),
            lastRotatedAt: new Date(now),
            refreshExpiresAt: { $min: [new Date(now + params.REFRESH_SLIDING_MS), "$absoluteExpiresAt"] },
            usedRefreshHashes: {
              $slice: [{ $concatArrays: ["$usedRefreshHashes", [{ gen: "$refreshGen", hash: "$refreshHash" }]] }, -params.RING_DEPTH],
            },
          },
        },
      ],
      { new: true }
    );

    // 2) EPOCH-SCOPED sibling cleanup (revoke authVersion < newVersion). The
    //    rebound caller is at newVersion, so it is excluded; a new current-epoch
    //    login is also excluded. Same predicate used sync + by the worker (CR-015).
    await revokeSessionsBelowEpoch(user._id, newVersion);

    if (!rebound) return { ok: true, reauth: true };

    // 3) Detect a superseding epoch that raced in AFTER our bump (e.g. a
    //    concurrent reset/logout-all). If the user epoch is no longer newVersion,
    //    the tokens are already stale ⇒ prefer the defined re-auth response.
    const cur = await User.findById(user._id).select("sessionVersion");
    if ((cur ? cur.sessionVersion || 0 : 0) !== newVersion) return { ok: true, reauth: true };

    return {
      ok: true,
      accessToken: generateAccessToken(user._id, newVersion, sid, params.ACCESS_TTL_MS),
      refreshToken: buildRefreshToken(sid, rebound.refreshGen, newSec),
      refreshExpiresAt: rebound.refreshExpiresAt,
      absoluteExpiresAt: rebound.absoluteExpiresAt,
    };
  } catch (err) {
    // Committed-password fail-safe (CR-018): contain the caller + old epoch, then
    // return reauth so the controller clears cookies and requires login.
    emitSecurityEvent("change_password_post_commit_failed", { userId: String(user._id), message: err.message, fatal: true });
    if (sid) {
      try {
        await revokeSession(sid); // best-effort targeted containment of the caller
      } catch (_) {
        const enq = await enqueuePending("revoke-session", { userId: user._id, sid, reason: "change-password-failsafe" });
        if (!enq) emitSecurityEvent("outbox_enqueue_failed", { userId: String(user._id), sid, reason: "change-password-failsafe", fatal: true });
      }
    }
    await revokeSessionsBelowEpoch(user._id, newVersion); // old-epoch cleanup (self-enqueues on failure)
    return { ok: true, reauth: true };
  }
}

// --- durable outbox (ADR-018) --------------------------------------------

async function enqueuePending(action, { userId, sid = null, targetVersion = null, reason }) {
  const _id = `${action}:${sid || userId}:${targetVersion ?? 0}`;
  try {
    await PendingSecurityAction.updateOne(
      { _id },
      {
        $setOnInsert: {
          _id, action, userId, sid, targetVersion, reason,
          attempts: 0, nextAttemptAt: nowDate(), deadLetter: false, createdAt: nowDate(),
        },
      },
      { upsert: true }
    );
    return true;
  } catch (_) {
    return false; // caller emits the monitored enqueue-failed event
  }
}

module.exports = {
  createSession,
  refreshSession,
  handleTheft,
  classifyLive,
  revokeSession,
  revokeForTheft,
  revokeAllSessions,
  revokeOne,
  revokeAllForUser,
  bumpUserVersion,
  changePasswordAtomic,
  enqueuePending,
  emitSecurityEvent,
};
