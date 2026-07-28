/*
 * Teacher Success Journey — AI credit accounting (ADR §8; CR-121/122/123).
 *
 * IDEMPOTENCY (CR-121): every ledger row is keyed by a SERVER-DERIVED HMAC digest
 * of the FULL identity — teacherId | periodMonthUtc | operation | clientReqId |
 * kind. A globally reusable raw client key can never collide across teachers,
 * periods or operations, nor bypass a reservation. The client request id is
 * validated (bounded type/length) so an unbounded key can never reach the index.
 *
 * SETTLEMENT (CR-122): credits are committed only when the caller passes explicit
 * `usable` output — NEVER inferred from an HTTP status. reserve() writes an intent
 * with a TTL; commit() charges; release() refunds; a stranded reservation is
 * reclaimed by recoverStaleReservations().
 *
 * FAILURE-SAFETY (CR-123): the append-only ledger is the SOURCE OF TRUTH.
 * reconcilePeriod() recomputes used/reserved/tempGranted from the ledger, so
 * every op is resumable + idempotent across a crash: a half-applied write is
 * repaired by a later reconcile, a grant is never "recorded without reaching the
 * allowance" (tempGranted is DERIVED from grant rows), and an expired grant is
 * never subtracted twice (reconcile simply excludes it). The single enforcement-
 * critical primitive is reserve()'s atomic conditional-increment gate (no
 * overspend under concurrency); reconcile is the repair backstop.
 */
const crypto = require("crypto");
const AiCreditPeriod = require("../models/aiCreditPeriodModel");
const AiCreditLedger = require("../models/aiCreditLedgerModel");
const { weightFor } = require("../config/teacherSuccess/aiCredits");
const { allowanceFor } = require("../config/teacherSuccess/allowances");

const isDup = (e) => e && (e.code === 11000 || e.code === 11001);
const DEFAULT_RESERVE_TTL_MS = 10 * 60 * 1000; // a reservation intent lives 10 min
const GRANT_MAX = 1_000_000;

// ── identity ────────────────────────────────────────────────────────────────
function ledgerSecret() {
  const s = process.env.TSJ_LEDGER_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error("aiCreditService: no ledger secret (TSJ_LEDGER_SECRET/JWT_SECRET)");
  return s;
}
function digest(teacherId, period, operation, clientReqId, kind) {
  return crypto.createHmac("sha256", ledgerSecret())
    .update(`${String(teacherId)}|${period}|${operation}|${clientReqId}|${kind}`)
    .digest("base64url");
}
// Bounded, safe client request id (CR-121#4). Reject unbounded/odd keys.
const CLIENT_REQ_ID_RE = /^[A-Za-z0-9._:-]{8,200}$/;
function assertClientReqId(id) {
  if (typeof id !== "string" || !CLIENT_REQ_ID_RE.test(id)) {
    const e = new Error("invalid_client_request_id");
    e.code = "invalid_client_request_id";
    throw e;
  }
  return id;
}

// ── period keys ───────────────────────────────────────────────────────────────
function utcMonthKey(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
function nextMonthResetAt(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}
const effectiveCeiling = (p) => (p.baseAllowance || 0) + (p.tempGranted || 0);
const computeRemaining = (p) => Math.max(0, effectiveCeiling(p) - (p.used || 0) - (p.reserved || 0));

async function ensurePeriod(teacherId, level, now = new Date()) {
  const periodMonthUtc = utcMonthKey(now);
  const base = allowanceFor(level);
  await AiCreditPeriod.updateOne(
    { teacherId, periodMonthUtc },
    { $setOnInsert: { teacherId, periodMonthUtc, used: 0, reserved: 0, tempGranted: 0, levelAtOpen: level }, $max: { baseAllowance: base } },
    { upsert: true }
  );
  return AiCreditPeriod.findOne({ teacherId, periodMonthUtc });
}

/*
 * FULL crash-repair: recompute used/reserved/tempGranted for a period FROM THE
 * LEDGER (the truth). Idempotent. This OVERWRITES the counters, so it must NOT
 * run in the concurrent hot path (a reserve that has inc'd the counter but not
 * yet inserted its ledger row would be transiently under-counted). It is invoked
 * by the recovery worker and by failpoint tests — the hot path stays incremental
 * (atomic single-doc ops), which is the enforcement-safe primitive.
 */
async function reconcilePeriod(teacherId, periodMonthUtc, now = new Date()) {
  const rows = await AiCreditLedger.find({ teacherId, periodMonthUtc }).select("kind operation clientReqId amount expiresAt").lean();
  const committed = new Set();
  const released = new Set();
  for (const r of rows) {
    const k = `${r.operation}|${r.clientReqId}`;
    if (r.kind === "commit") committed.add(k);
    else if (r.kind === "release") released.add(k);
  }
  let used = 0, reserved = 0, tempGranted = 0;
  for (const r of rows) {
    const k = `${r.operation}|${r.clientReqId}`;
    if (r.kind === "commit") used += r.amount;
    else if (r.kind === "reserve") { if (!committed.has(k) && !released.has(k)) reserved += r.amount; }
    else if (r.kind === "grant") { if (!r.expiresAt || new Date(r.expiresAt) > now) tempGranted += r.amount; }
  }
  await AiCreditPeriod.updateOne({ teacherId, periodMonthUtc }, { $set: { used, reserved, tempGranted } });
  return { used, reserved, tempGranted };
}

/*
 * tempGranted-only reconcile: recompute the granted ceiling from the grant rows
 * (excluding expired). Safe in the hot path — it never touches reserved/used, so
 * it cannot clobber an in-flight reservation. This is how a grant becomes
 * crash-safe (tempGranted is DERIVED, never "recorded without reaching the
 * allowance") and how an expired grant drops off exactly once.
 */
async function reconcileTempGranted(teacherId, periodMonthUtc, now = new Date()) {
  const grants = await AiCreditLedger.find({ teacherId, periodMonthUtc, kind: "grant" }).select("amount expiresAt").lean();
  let tempGranted = 0;
  for (const g of grants) if (!g.expiresAt || new Date(g.expiresAt) > now) tempGranted += g.amount;
  await AiCreditPeriod.updateOne({ teacherId, periodMonthUtc }, { $set: { tempGranted } });
  return tempGranted;
}

async function snapshot(teacherId, level, now = new Date()) {
  const period = await ensurePeriod(teacherId, level, now);
  await reconcileTempGranted(teacherId, period.periodMonthUtc, now); // expiry-safe, no counter clobber
  const p = await AiCreditPeriod.findOne({ teacherId, periodMonthUtc: period.periodMonthUtc });
  return {
    level, periodMonthUtc: p.periodMonthUtc,
    baseAllowance: p.baseAllowance, tempGranted: p.tempGranted, used: p.used, reserved: p.reserved,
    remaining: computeRemaining(p), resetAt: nextMonthResetAt(now),
  };
}

/*
 * Reserve weightFor(operation) credits for one logical action (clientReqId).
 * Returns { ok, reserved, idempotent, periodMonthUtc, snapshot } or
 * { ok:false, code:"ai_credit_exhausted", remaining, resetAt }.
 */
async function reserve(teacherId, { operation, clientReqId, level, now = new Date(), ttlMs = DEFAULT_RESERVE_TTL_MS }) {
  const weight = weightFor(operation); // throws on unknown/forged operation
  assertClientReqId(clientReqId);
  const period = await ensurePeriod(teacherId, level, now);
  const periodMonthUtc = period.periodMonthUtc;
  await reconcileTempGranted(teacherId, periodMonthUtc, now); // expiry-safe (no counter clobber)
  if (weight === 0) return { ok: true, reserved: 0, idempotent: false, periodMonthUtc, snapshot: await snapshot(teacherId, level, now) };

  const reserveKey = digest(teacherId, periodMonthUtc, operation, clientReqId, "reserve");
  const existing = await AiCreditLedger.findOne({ idempotencyKey: reserveKey });
  if (existing) return { ok: true, reserved: existing.amount, idempotent: true, periodMonthUtc, snapshot: await snapshot(teacherId, level, now) };

  // Atomic no-overspend gate (the one enforcement-critical primitive).
  const updated = await AiCreditPeriod.findOneAndUpdate(
    { teacherId, periodMonthUtc, $expr: { $gte: [{ $add: ["$baseAllowance", "$tempGranted"] }, { $add: ["$used", "$reserved", weight] }] } },
    { $inc: { reserved: weight } },
    { new: true }
  );
  if (!updated) {
    const p = await AiCreditPeriod.findOne({ teacherId, periodMonthUtc });
    return { ok: false, code: "ai_credit_exhausted", remaining: computeRemaining(p), resetAt: nextMonthResetAt(now) };
  }
  try {
    await AiCreditLedger.create({ teacherId, periodMonthUtc, idempotencyKey: reserveKey, clientReqId, operation, kind: "reserve", amount: weight, expiresAt: new Date(now.getTime() + ttlMs) });
  } catch (e) {
    // Concurrent duplicate or failure: undo the inc (fail-closed) and dedupe.
    await AiCreditPeriod.updateOne({ teacherId, periodMonthUtc }, { $inc: { reserved: -weight } });
    if (isDup(e)) { const prior = await AiCreditLedger.findOne({ idempotencyKey: reserveKey }); return { ok: true, reserved: prior ? prior.amount : weight, idempotent: true, periodMonthUtc, snapshot: await snapshot(teacherId, level, now) }; }
    throw e;
  }
  return { ok: true, reserved: weight, idempotent: false, periodMonthUtc, snapshot: await snapshot(teacherId, level, now) };
}

// Commit a reservation after USABLE output. Idempotent; refuses after release.
async function commit(teacherId, { operation, clientReqId, periodMonthUtc, now = new Date() }) {
  assertClientReqId(clientReqId);
  const reserveKey = digest(teacherId, periodMonthUtc, operation, clientReqId, "reserve");
  const reserveRow = await AiCreditLedger.findOne({ idempotencyKey: reserveKey });
  if (!reserveRow) return { ok: true, committed: 0, idempotent: false };
  const amount = reserveRow.amount;
  const commitKey = digest(teacherId, periodMonthUtc, operation, clientReqId, "commit");
  const releaseKey = digest(teacherId, periodMonthUtc, operation, clientReqId, "release");
  if (await AiCreditLedger.exists({ idempotencyKey: commitKey })) return { ok: true, committed: amount, idempotent: true };
  if (await AiCreditLedger.exists({ idempotencyKey: releaseKey })) return { ok: false, code: "already_released", committed: 0 };
  // Ledger-FIRST (fail-closed: a crash before the counter move is repaired to
  // "charged" by the recovery reconcile, never lost), then an atomic move.
  try { await AiCreditLedger.create({ teacherId, periodMonthUtc, idempotencyKey: commitKey, clientReqId, operation, kind: "commit", amount }); }
  catch (e) { if (!isDup(e)) throw e; }
  await AiCreditPeriod.findOneAndUpdate({ teacherId, periodMonthUtc, reserved: { $gte: amount } }, { $inc: { reserved: -amount, used: amount } });
  return { ok: true, committed: amount, idempotent: false };
}

// Release a reservation (no usable output). Idempotent; no-op after commit.
async function release(teacherId, { operation, clientReqId, periodMonthUtc, now = new Date() }) {
  assertClientReqId(clientReqId);
  const reserveKey = digest(teacherId, periodMonthUtc, operation, clientReqId, "reserve");
  const reserveRow = await AiCreditLedger.findOne({ idempotencyKey: reserveKey });
  if (!reserveRow) return { ok: true, released: 0, idempotent: false };
  const amount = reserveRow.amount;
  const commitKey = digest(teacherId, periodMonthUtc, operation, clientReqId, "commit");
  const releaseKey = digest(teacherId, periodMonthUtc, operation, clientReqId, "release");
  if (await AiCreditLedger.exists({ idempotencyKey: releaseKey })) return { ok: true, released: amount, idempotent: true };
  if (await AiCreditLedger.exists({ idempotencyKey: commitKey })) return { ok: true, released: 0, committed: true };
  try { await AiCreditLedger.create({ teacherId, periodMonthUtc, idempotencyKey: releaseKey, clientReqId, operation, kind: "release", amount }); }
  catch (e) { if (!isDup(e)) throw e; }
  await AiCreditPeriod.findOneAndUpdate({ teacherId, periodMonthUtc, reserved: { $gte: amount } }, { $inc: { reserved: -amount } });
  return { ok: true, released: amount, idempotent: false };
}

/*
 * Admin temporary grant (CR-123#5). Validates target-is-teacher (caller),
 * bounded amount, non-empty reason, valid FUTURE expiry, and an explicit
 * idempotency key. Crash-safe: the grant row is inserted first, then reconcile
 * DERIVES tempGranted — a grant can never be "recorded without reaching the
 * allowance", and a retry repairs rather than double-granting.
 */
async function grant(teacherId, { level, amount, actor, reason, expiresAt = null, grantKey, now = new Date() }) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > GRANT_MAX) { const e = new Error("invalid_amount"); e.code = "invalid_amount"; throw e; }
  if (!reason || !String(reason).trim()) { const e = new Error("reason_required"); e.code = "reason_required"; throw e; }
  if (expiresAt != null) { const d = new Date(expiresAt); if (Number.isNaN(d.getTime()) || d <= now) { const e = new Error("invalid_expiry"); e.code = "invalid_expiry"; throw e; } }
  assertClientReqId(grantKey);
  const period = await ensurePeriod(teacherId, level, now);
  const key = digest(teacherId, period.periodMonthUtc, "admin.grant", grantKey, "grant");
  if (await AiCreditLedger.exists({ idempotencyKey: key })) { await reconcileTempGranted(teacherId, period.periodMonthUtc, now); return { ok: true, granted: 0, idempotent: true, snapshot: await snapshot(teacherId, level, now) }; }
  try { await AiCreditLedger.create({ teacherId, periodMonthUtc: period.periodMonthUtc, idempotencyKey: key, clientReqId: grantKey, operation: "admin.grant", kind: "grant", amount, actor, reason: String(reason).trim(), expiresAt: expiresAt ? new Date(expiresAt) : null }); }
  catch (e) { if (!isDup(e)) throw e; }
  // tempGranted is DERIVED from grant rows (crash-safe): a retry repairs it.
  await reconcileTempGranted(teacherId, period.periodMonthUtc, now);
  return { ok: true, granted: amount, idempotent: false, snapshot: await snapshot(teacherId, level, now) };
}

/*
 * Recovery worker (CR-122#4 / CR-123): reclaim reservations whose intent TTL has
 * passed with neither commit nor release — a crash between reserve and settle can
 * never permanently strand credits. Idempotent (release is idempotent). Returns
 * the count reclaimed. Callers gate this on the feature flag.
 */
async function recoverStaleReservations(now = new Date(), limit = 500) {
  const stale = await AiCreditLedger.find({ kind: "reserve", expiresAt: { $ne: null, $lte: now } }).limit(limit).lean();
  let reclaimed = 0;
  for (const r of stale) {
    const commitKey = digest(r.teacherId, r.periodMonthUtc, r.operation, r.clientReqId, "commit");
    const releaseKey = digest(r.teacherId, r.periodMonthUtc, r.operation, r.clientReqId, "release");
    if (await AiCreditLedger.exists({ idempotencyKey: { $in: [commitKey, releaseKey] } })) continue; // settled
    const res = await release(r.teacherId, { operation: r.operation, clientReqId: r.clientReqId, periodMonthUtc: r.periodMonthUtc, now });
    if (res.ok && res.released > 0) reclaimed++;
  }
  return reclaimed;
}

module.exports = {
  utcMonthKey, nextMonthResetAt, computeRemaining, ensurePeriod, reconcilePeriod,
  snapshot, reserve, commit, release, grant, recoverStaleReservations,
  digest, assertClientReqId, DEFAULT_RESERVE_TTL_MS,
};
