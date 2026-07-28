/*
 * Teacher Journey — server-authoritative XP (points) engine.
 *
 * The client can NEVER submit or choose points. Every award is derived from one real
 * COMMITTED domain event and is:
 *   - Idempotent   — a UNIQUE HMAC key (teacher | type | sourceId); a retried /
 *                    duplicated / concurrent award for the same source is a no-op.
 *   - Traceable    — one immutable ledger row referencing the source event.
 *   - Capped       — per-exam / monthly ceilings enforced before insert.
 *   - Reversible   — only via an audited admin correction (a signed ledger row).
 *   - Reconcilable — lifetime XP is ALWAYS rebuildable as SUM(amount) over the ledger.
 *
 * No multi-doc transactions are required (mirrors aiCreditService): idempotency is the
 * unique index (E11000 ⇒ no-op), the projected state is an atomic single-doc $inc that
 * reconcile() can always rebuild from the ledger, and a durable outbox absorbs a
 * transient award failure so a committed business action is NEVER rolled back.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const TeacherXpEvent = require("../models/teacherXpEventModel");
const TeacherXpState = require("../models/teacherXpStateModel");
const TeacherXpOutbox = require("../models/teacherXpOutboxModel");
const { xpFor, CAPS, isAward, CORRECTION_TYPE } = require("../config/teacherSuccess/xp");

const secret = () => process.env.TSJ_LEDGER_SECRET || process.env.JWT_SECRET || "tsj-dev-ledger-secret";
const pad = (n) => String(n).padStart(2, "0");
const utcMonthKey = (d = new Date()) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
const utcDayKey = (d = new Date()) => `${utcMonthKey(d)}-${pad(d.getUTCDate())}`;
const isDup = (e) => e && (e.code === 11000 || e.code === 11001);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const typeKey = (t) => t.replace(/[.\-]/g, "_"); // Mongo field-safe key for byType
function oid(id) { try { return new mongoose.Types.ObjectId(id); } catch { return id; } }

// Stable idempotency identity for one award — a globally-reusable raw source id can
// never collide across teachers or award types.
function digest(teacherId, type, sourceId) {
  return crypto.createHmac("sha256", secret()).update(`${String(teacherId)}|${type}|${String(sourceId)}`).digest("hex");
}

// ── caps ─────────────────────────────────────────────────────────────────────
async function capReached(teacherId, type, sourceId, periodMonthUtc) {
  if (type === "question.published") {
    const examId = String(sourceId).split(":")[0];
    const perExam = await TeacherXpEvent.countDocuments({ teacherId, type, sourceId: new RegExp(`^${escapeRegex(examId)}:`) });
    if (perExam >= CAPS.questionPerExam) return "questionPerExam";
    const perMonth = await TeacherXpEvent.countDocuments({ teacherId, type, periodMonthUtc });
    if (perMonth >= CAPS.questionPerMonth) return "questionPerMonth";
  } else if (type === "attempt.completed") {
    const perMonth = await TeacherXpEvent.countDocuments({ teacherId, type, periodMonthUtc });
    if (perMonth >= CAPS.attemptPerMonth) return "attemptPerMonth";
  }
  return null;
}

// Atomic single-doc projection; reconcile() can always rebuild it from the ledger.
async function projectAdd(teacherId, type, amount, at) {
  await TeacherXpState.updateOne(
    { teacherId },
    { $inc: { lifetimeXp: amount, [`byType.${typeKey(type)}`]: 1, version: 1 }, $set: { lastEventAt: at } },
    { upsert: true }
  );
}

// ── award ────────────────────────────────────────────────────────────────────
// Returns { awarded, amount, duplicate?, capped?, event? }. Throws only on an
// unexpected error (callers should use awardOrEnqueue for committed-event hooks).
async function award({ teacherId, type, sourceId, meta, at = new Date() }) {
  if (!isAward(type)) throw new Error(`teacherXpService.award: not an XP award type: ${type}`);
  if (sourceId === undefined || sourceId === null || sourceId === "") throw new Error("teacherXpService.award: sourceId required");
  const amount = xpFor(type);
  if (amount <= 0) return { awarded: false, amount: 0, reason: "zero_award" };
  const key = digest(teacherId, type, sourceId);
  const periodMonthUtc = utcMonthKey(at);

  if (await TeacherXpEvent.exists({ idempotencyKey: key })) return { awarded: false, duplicate: true, amount: 0 };
  const cap = await capReached(teacherId, type, sourceId, periodMonthUtc);
  if (cap) return { awarded: false, capped: cap, amount: 0 };

  try {
    const [event] = await TeacherXpEvent.create([{
      teacherId, type, amount, sourceId: String(sourceId), idempotencyKey: key,
      periodMonthUtc, dayKey: utcDayKey(at), meta,
    }]);
    await projectAdd(teacherId, type, amount, at);
    return { awarded: true, amount, event };
  } catch (e) {
    if (isDup(e)) return { awarded: false, duplicate: true, amount: 0 }; // concurrent same-source ⇒ awarded once
    throw e;
  }
}

// ── audited admin correction (the ONLY way to reverse/adjust XP) ───────────────
async function adminCorrect({ teacherId, amount, reason, actor, correctionId, at = new Date() }) {
  const n = Math.trunc(Number(amount));
  if (!Number.isSafeInteger(n) || n === 0) throw new Error("teacherXpService.adminCorrect: amount must be a non-zero integer");
  if (!reason || String(reason).trim().length === 0) throw new Error("teacherXpService.adminCorrect: reason required");
  const sourceId = correctionId ? `correction:${correctionId}` : `correction:${at.getTime()}:${crypto.randomBytes(6).toString("hex")}`;
  const key = digest(teacherId, CORRECTION_TYPE, sourceId);
  if (await TeacherXpEvent.exists({ idempotencyKey: key })) return { corrected: false, duplicate: true, amount: 0 };
  try {
    const [event] = await TeacherXpEvent.create([{
      teacherId, type: CORRECTION_TYPE, amount: n, sourceId, idempotencyKey: key,
      periodMonthUtc: utcMonthKey(at), actor: actor || null, reason: String(reason).slice(0, 500),
    }]);
    await projectAdd(teacherId, CORRECTION_TYPE, n, at);
    return { corrected: true, amount: n, event };
  } catch (e) {
    if (isDup(e)) return { corrected: false, duplicate: true, amount: 0 };
    throw e;
  }
}

// ── reconcile (rebuild the projection from the immutable ledger) ───────────────
async function reconcile(teacherId) {
  const tid = oid(teacherId);
  const [totalRow] = await TeacherXpEvent.aggregate([
    { $match: { teacherId: tid } },
    { $group: { _id: null, lifetimeXp: { $sum: "$amount" }, lastEventAt: { $max: "$createdAt" } } },
  ]);
  const byTypeRows = await TeacherXpEvent.aggregate([
    { $match: { teacherId: tid } },
    { $group: { _id: "$type", n: { $sum: 1 } } },
  ]);
  const byType = {};
  for (const r of byTypeRows) byType[typeKey(r._id)] = r.n;
  const lifetimeXp = totalRow ? totalRow.lifetimeXp : 0;
  const lastEventAt = totalRow ? totalRow.lastEventAt : null;
  await TeacherXpState.updateOne({ teacherId }, { $set: { lifetimeXp, byType, lastEventAt }, $inc: { version: 1 } }, { upsert: true });
  return { lifetimeXp, byType };
}

async function total(teacherId) {
  const s = await TeacherXpState.findOne({ teacherId }).lean();
  return s ? s.lifetimeXp : 0;
}

async function state(teacherId) {
  const s = await TeacherXpState.findOne({ teacherId }).lean();
  return s || { teacherId, lifetimeXp: 0, byType: {}, lastEventAt: null };
}

// ── activity feed (cursor pagination; no internal/security details leaked) ─────
async function feed({ teacherId, cursor, limit = 20 }) {
  const lim = Math.max(1, Math.min(Number(limit) || 20, 50));
  const q = { teacherId };
  if (cursor) { const d = new Date(cursor); if (!isNaN(d)) q.createdAt = { $lt: d }; }
  const rows = await TeacherXpEvent.find(q).sort({ createdAt: -1 }).limit(lim + 1).lean();
  const hasMore = rows.length > lim;
  const items = rows.slice(0, lim).map((r) => ({ type: r.type, amount: r.amount, at: r.createdAt }));
  const nextCursor = hasMore ? rows[lim - 1].createdAt.toISOString() : null;
  return { items, nextCursor };
}

// ── durable outbox (award without ever rolling back the business action) ───────
async function enqueue({ teacherId, type, sourceId, meta }) {
  const key = digest(teacherId, type, sourceId);
  try { await TeacherXpOutbox.create([{ idempotencyKey: key, teacherId, type, sourceId: String(sourceId), payload: { meta } }]); }
  catch (e) { if (!isDup(e)) throw e; } // already queued (idempotent)
}

// Best-effort award for a committed-event hook: never throws, enqueues on failure so a
// transient XP error can't roll back the exam/student/material action.
async function awardOrEnqueue(args) {
  try { return await award(args); }
  catch (_) { try { await enqueue(args); } catch (__) { /* swallow; worker/reconcile recover */ } return { awarded: false, enqueued: true, amount: 0 }; }
}

async function drainOutbox({ limit = 50, now = new Date(), maxAttempts = 8 } = {}) {
  const due = await TeacherXpOutbox.find({ deadLetter: false, nextAttemptAt: { $lte: now } }).limit(limit);
  let drained = 0;
  for (const row of due) {
    try {
      await award({ teacherId: row.teacherId, type: row.type, sourceId: row.sourceId, meta: row.payload && row.payload.meta });
      await TeacherXpOutbox.deleteOne({ _id: row._id });
      drained += 1;
    } catch (e) {
      const attempts = (row.attempts || 0) + 1;
      const dead = attempts >= maxAttempts;
      await TeacherXpOutbox.updateOne({ _id: row._id }, {
        $set: { attempts, deadLetter: dead, lastError: String((e && e.message) || e).slice(0, 500), nextAttemptAt: new Date(now.getTime() + Math.min(3_600_000, 1000 * 2 ** attempts)) },
      });
    }
  }
  return { drained, considered: due.length };
}

module.exports = {
  digest, utcMonthKey, utcDayKey,
  award, adminCorrect, reconcile, total, state, feed,
  enqueue, awardOrEnqueue, drainOutbox, capReached,
};
