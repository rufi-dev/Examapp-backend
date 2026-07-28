const crypto = require("crypto");
const PendingSecurityAction = require("../models/pendingSecurityActionModel");
const Session = require("../models/sessionModel");
const User = require("../models/userModel");
const metrics = require("../utils/authMetrics");

// AUD-002 durable outbox worker (ADR-018 §12, CR-009). Drains
// `pendingSecurityActions`: applies the account-wide `sv-bump` fence and cleanup
// `revoke-session` actions that could not complete synchronously. Leased so
// multiple instances cannot double-process; idempotent + monotonic + absent-
// field-safe so a retry, duplicate, or legacy User doc is handled correctly;
// dead-letters after maxAttempts. EVERY completion write is gated on the
// claiming worker's lease, so a stale worker can never clobber another's record.

const MAX_ATTEMPTS = 8;

// eslint-disable-next-line no-console
const alert = (msg, detail) => console.error(`[SECURITY] outbox_${msg} ${JSON.stringify(detail)}`);

// Claim one due, unleased (or lease-expired) record for this worker.
async function claimOne(now, workerId, leaseMs) {
  return PendingSecurityAction.findOneAndUpdate(
    {
      deadLetter: false,
      nextAttemptAt: { $lte: now },
      $or: [{ leaseOwner: null }, { leaseUntil: { $lt: now } }],
    },
    { $set: { leaseOwner: workerId, leaseUntil: new Date(now.getTime() + leaseMs) }, $inc: { attempts: 1 } },
    { new: true, sort: { nextAttemptAt: 1 } }
  );
}

// A concrete account-cleanup target must be a positive safe integer (CR-019).
const isValidTarget = (t) => Number.isSafeInteger(t) && t > 0;

// Ownership-gated dead-letter. Returns true ONLY if THIS worker (still holding
// the lease) actually flipped the record — CR-019: a zero-match means another
// worker reclaimed it, so the caller must report "stale", not "dead".
async function markDeadLetter(rec, workerId) {
  const res = await PendingSecurityAction.updateOne(
    { _id: rec._id, leaseOwner: workerId },
    { $set: { deadLetter: true, leaseOwner: null, leaseUntil: null } }
  );
  return (res.modifiedCount || 0) === 1;
}

// Apply one claimed action. Returns "done" | "retry" | "dead" | "stale".
// "stale" = we lost the lease (another worker reclaimed) — never counted as success.
async function applyOne(rec, now, workerId) {
  try {
    if (rec.action === "sv-bump") {
      // CR-009: absent-field-safe + monotonic. `$max($ifNull(sv,0), target)`
      // sets a missing field, never lowers an existing one.
      const res = await User.updateOne(
        { _id: rec.userId },
        [{ $set: { sessionVersion: { $max: [{ $ifNull: ["$sessionVersion", 0] }, rec.targetVersion] } } }]
      );
      if ((res.matchedCount || 0) === 0) {
        // User missing (deleted) — the fence is obsolete; still complete the
        // record (ownership-gated below), but surface it.
        alert("user_missing", { _id: rec._id, userId: String(rec.userId) });
      }
    } else if (rec.action === "revoke-session") {
      // CR-015: TARGETED revoke — requires a concrete sid. A revoke-session with
      // no sid is invalid and must NEVER fall back to a broad account revoke.
      if (!rec.sid) {
        alert("invalid_revoke_session_no_sid", { _id: rec._id, userId: String(rec.userId) });
        return (await markDeadLetter(rec, workerId)) ? "dead" : "stale";
      }
      await Session.updateOne({ _id: rec.sid, revokedAt: null }, { $set: { revokedAt: now } });
    } else if (rec.action === "revoke-before-epoch") {
      // CR-015: EPOCH-SCOPED account cleanup — revoke only sessions whose
      // effective authVersion (< targetVersion). Requires a concrete POSITIVE
      // safe-integer target (CR-019); anything else is invalid.
      if (!isValidTarget(rec.targetVersion)) {
        alert("invalid_revoke_before_epoch_no_target", { _id: rec._id, userId: String(rec.userId) });
        return (await markDeadLetter(rec, workerId)) ? "dead" : "stale";
      }
      await Session.updateMany(
        { userId: rec.userId, revokedAt: null, $expr: { $lt: [{ $ifNull: ["$authVersion", 0] }, rec.targetVersion] } },
        { $set: { revokedAt: now } }
      );
    }
    // CR-009: ownership-gated completion — only the worker that still holds the
    // lease may delete. A zero-match means we are stale, NOT successful.
    const del = await PendingSecurityAction.deleteOne({ _id: rec._id, leaseOwner: workerId });
    return (del.deletedCount || 0) === 1 ? "done" : "stale";
  } catch (err) {
    if (rec.attempts >= MAX_ATTEMPTS) {
      const dl = await PendingSecurityAction.updateOne(
        { _id: rec._id, leaseOwner: workerId },
        { $set: { deadLetter: true, leaseOwner: null, leaseUntil: null } }
      );
      if ((dl.modifiedCount || 0) === 0) return "stale";
      alert("dead_letter", { _id: rec._id, action: rec.action, userId: String(rec.userId), error: err.message });
      return "dead";
    }
    const backoff = Math.min(60000, 500 * 2 ** rec.attempts);
    const rt = await PendingSecurityAction.updateOne(
      { _id: rec._id, leaseOwner: workerId },
      { $set: { nextAttemptAt: new Date(now.getTime() + backoff), leaseOwner: null, leaseUntil: null } }
    );
    return (rt.modifiedCount || 0) === 1 ? "retry" : "stale";
  }
}

// CR-009 crash recovery: apply account-wide fences that were committed ATOMICALLY
// onto a Session (theftFenceTarget) but whose inline bump never ran because the
// process crashed after the theft revoke. Both operations are monotonic/
// idempotent ($max fence, then clear the marker), so this is safe to run
// concurrently with the inline path and across multiple workers without a lease.
async function sweepSessionFences({ max = 100 } = {}) {
  const summary = { fenced: 0 };
  for (let i = 0; i < max; i++) {
    const s = await Session.findOne({ theftFenceTarget: { $ne: null } }).select("_id userId theftFenceTarget");
    if (!s) break;
    await User.updateOne(
      { _id: s.userId },
      [{ $set: { sessionVersion: { $max: [{ $ifNull: ["$sessionVersion", 0] }, s.theftFenceTarget] } } }]
    );
    // $unset (Gate 0) so the recovered session re-enters partial-TTL coverage.
    await Session.updateOne({ _id: s._id }, { $unset: { theftFenceTarget: "" } });
    summary.fenced += 1;
  }
  return summary;
}

// Drain up to `max` records once (outbox actions + Session fence recovery).
// `workerId` defaults to a UNIQUE per-call id (CR-009 — never a shared literal),
// so lease ownership is meaningful.
async function drainOnce({ workerId = `w-${crypto.randomUUID()}`, leaseMs = 30000, max = 100 } = {}) {
  const summary = { done: 0, retry: 0, dead: 0, stale: 0 };
  for (let i = 0; i < max; i++) {
    const now = new Date();
    const rec = await claimOne(now, workerId, leaseMs);
    if (!rec) break;
    summary[await applyOne(rec, now, workerId)] += 1;
  }
  const fences = await sweepSessionFences({ max });
  summary.fenced = fences.fenced;
  return summary;
}

// Long-running loop (call from server startup ONLY when the feature is enabled).
// Each loop uses one stable unique worker id.
function startWorker({ intervalMs = 5000, workerId = `w-${crypto.randomUUID()}`, ...opts } = {}) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await drainOnce({ workerId, ...opts }); metrics.workerHeartbeat(); } catch (e) { alert("drain_error", { error: e.message }); }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  setTimeout(tick, intervalMs);
  return () => { stopped = true; };
}

module.exports = { drainOnce, sweepSessionFences, startWorker, claimOne, applyOne, MAX_ATTEMPTS };
