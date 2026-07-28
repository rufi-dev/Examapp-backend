/*
 * Teacher Success Journey — AI credit engine (ADR §8; CR-121/122/123).
 * Real in-memory Mongo. Proves: HMAC compound idempotency isolation (teacher /
 * period / operation / clientReqId / kind); no overspend; explicit settlement;
 * reconcile-from-ledger crash repair; grant crash-safety + validation; expiry
 * once; stale-reservation recovery; UTC reset; mid-month ceiling raise.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-credit";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const AiCreditPeriod = require("../models/aiCreditPeriodModel");
const AiCreditLedger = require("../models/aiCreditLedgerModel");
const svc = require("../services/aiCreditService");

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, x ? JSON.stringify(x) : ""); } };
const { ObjectId } = mongoose.Types;
const JULY = new Date(Date.UTC(2026, 6, 15, 12));
const AUG = new Date(Date.UTC(2026, 7, 2));
const rid = (s) => `req.${s}.abcd`; // >= 8 chars, valid charset

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Promise.all([AiCreditPeriod.createIndexes(), AiCreditLedger.createIndexes()]);

  // ── Basic reserve/commit ──
  const t1 = new ObjectId();
  const r1 = await svc.reserve(t1, { operation: "ai.extract.questions", clientReqId: rid("one"), level: "spark", now: JULY });
  ok("reserve within allowance (5)", r1.ok && r1.reserved === 5 && r1.snapshot.remaining === 95);
  const c1 = await svc.commit(t1, { operation: "ai.extract.questions", clientReqId: rid("one"), periodMonthUtc: r1.periodMonthUtc, now: JULY });
  ok("commit charges 5", c1.committed === 5);
  ok("after commit used=5 reserved=0", (await svc.snapshot(t1, "spark", JULY)).used === 5);

  // ── CR-121: same key, same teacher, same op = exactly one charge ──
  const rA = await svc.reserve(t1, { operation: "ai.chat.message", clientReqId: rid("dup"), level: "spark", now: JULY });
  const rB = await svc.reserve(t1, { operation: "ai.chat.message", clientReqId: rid("dup"), level: "spark", now: JULY });
  ok("same key reserves once (idempotent)", rA.ok && rB.idempotent === true);
  await svc.commit(t1, { operation: "ai.chat.message", clientReqId: rid("dup"), periodMonthUtc: rA.periodMonthUtc, now: JULY });
  await svc.commit(t1, { operation: "ai.chat.message", clientReqId: rid("dup"), periodMonthUtc: rA.periodMonthUtc, now: JULY });
  ok("exactly one commit ledger row for the key", (await AiCreditLedger.countDocuments({ teacherId: t1, kind: "commit", clientReqId: rid("dup") })) === 1);

  // ── CR-121: same clientReqId across DIFFERENT operations charges each weight ──
  const t2 = new ObjectId();
  const same = rid("multi");
  const e1 = await svc.reserve(t2, { operation: "ai.extract.questions", clientReqId: same, level: "spark", now: JULY }); // 5
  const e2 = await svc.reserve(t2, { operation: "ai.chat.message", clientReqId: same, level: "spark", now: JULY });      // 1
  ok("same key + different ops both reserve their own weight (5 and 1)", e1.reserved === 5 && e2.reserved === 1);
  ok("two distinct reserve rows for same key across ops", (await AiCreditLedger.countDocuments({ teacherId: t2, kind: "reserve", clientReqId: same })) === 2);

  // ── CR-121: same key across teachers cannot collide ──
  const t3 = new ObjectId();
  const shared = rid("shared");
  await svc.reserve(t2, { operation: "ai.extract.questions", clientReqId: shared, level: "spark", now: JULY });
  const t3r = await svc.reserve(t3, { operation: "ai.extract.questions", clientReqId: shared, level: "spark", now: JULY });
  ok("same key different teachers → separate reservations", t3r.ok && t3r.idempotent === false && (await svc.snapshot(t3, "spark", JULY)).reserved === 5);

  // ── CR-121: same key across months cannot collide/bypass ──
  const t4 = new ObjectId();
  const monthKey = rid("month");
  await svc.reserve(t4, { operation: "ai.extract.questions", clientReqId: monthKey, level: "spark", now: JULY });
  const augR = await svc.reserve(t4, { operation: "ai.extract.questions", clientReqId: monthKey, level: "spark", now: AUG });
  ok("same key next month charges again (new allowance)", augR.ok && augR.idempotent === false && augR.periodMonthUtc === "2026-08" && augR.snapshot.remaining === 95);

  // ── CR-121: invalid client request id rejected (bounded) ──
  ok("too-short reqId rejected", await (async () => { try { await svc.reserve(t4, { operation: "ai.chat.message", clientReqId: "short", level: "spark", now: JULY }); return false; } catch (e) { return e.code === "invalid_client_request_id"; } })());
  ok("non-string reqId rejected", await (async () => { try { await svc.reserve(t4, { operation: "ai.chat.message", clientReqId: 12345678, level: "spark", now: JULY }); return false; } catch (e) { return e.code === "invalid_client_request_id"; } })());

  // ── No overspend under concurrency ──
  const t5 = new ObjectId();
  const attempts = await Promise.all(Array.from({ length: 30 }, (_, i) => svc.reserve(t5, { operation: "ai.extract.questions", clientReqId: rid(`c${i}`), level: "spark", now: JULY })));
  ok("exactly 20 concurrent reserves succeed (100/5)", attempts.filter((a) => a.ok && a.reserved === 5 && !a.idempotent).length === 20);
  ok("10 exhausted with typed shape", attempts.filter((a) => a.ok === false && a.code === "ai_credit_exhausted" && a.remaining === 0 && a.resetAt instanceof Date).length === 10);
  ok("reserved never exceeds allowance", (await AiCreditPeriod.findOne({ teacherId: t5 })).reserved === 100);

  // ── CR-122: reconnect/retry (reserve+commit repeated) does not double-charge ──
  const t6 = new ObjectId();
  const k6 = rid("reconnect");
  for (let i = 0; i < 3; i++) {
    const rr = await svc.reserve(t6, { operation: "ai.generate.questions", clientReqId: k6, level: "spark", now: JULY });
    await svc.commit(t6, { operation: "ai.generate.questions", clientReqId: k6, periodMonthUtc: rr.periodMonthUtc, now: JULY });
  }
  ok("reconnect/retry charges exactly once (used=5)", (await svc.snapshot(t6, "spark", JULY)).used === 5);

  // ── CR-122: release refunds; commit-after-release refused ──
  const t7 = new ObjectId();
  const k7 = rid("release");
  const rr7 = await svc.reserve(t7, { operation: "ai.extract.questions", clientReqId: k7, level: "spark", now: JULY });
  const rel = await svc.release(t7, { operation: "ai.extract.questions", clientReqId: k7, periodMonthUtc: rr7.periodMonthUtc, now: JULY });
  ok("release refunds (remaining back to 100)", rel.released === 5 && (await svc.snapshot(t7, "spark", JULY)).remaining === 100);
  const cAfterRel = await svc.commit(t7, { operation: "ai.extract.questions", clientReqId: k7, periodMonthUtc: rr7.periodMonthUtc, now: JULY });
  ok("commit after release refused", cAfterRel.ok === false && cAfterRel.code === "already_released");

  // ── CR-122: stale reservation recovery ──
  const t8 = new ObjectId();
  const k8 = rid("stale");
  await svc.reserve(t8, { operation: "ai.extract.questions", clientReqId: k8, level: "spark", now: JULY, ttlMs: 1000 });
  ok("before recovery reserved=5", (await svc.snapshot(t8, "spark", JULY)).reserved === 5);
  const reclaimed = await svc.recoverStaleReservations(new Date(JULY.getTime() + 5000));
  ok("recovery reclaims the stale reservation", reclaimed >= 1 && (await svc.snapshot(t8, "spark", JULY)).reserved === 0);

  // ── CR-123: reconcile repairs corrupted counters ──
  const t9 = new ObjectId();
  const k9 = rid("recon");
  const rr9 = await svc.reserve(t9, { operation: "ai.extract.questions", clientReqId: k9, level: "spark", now: JULY });
  await svc.commit(t9, { operation: "ai.extract.questions", clientReqId: k9, periodMonthUtc: rr9.periodMonthUtc, now: JULY });
  await AiCreditPeriod.updateOne({ teacherId: t9 }, { $set: { used: 999, reserved: 42 } }); // corrupt
  await svc.reconcilePeriod(t9, rr9.periodMonthUtc, JULY);
  const p9 = await AiCreditPeriod.findOne({ teacherId: t9 });
  ok("reconcile repairs used/reserved from the ledger (used=5,reserved=0)", p9.used === 5 && p9.reserved === 0);

  // ── CR-123: grant crash-safety (tempGranted derived) + idempotent + expiry once ──
  const t10 = new ObjectId();
  const g = await svc.grant(t10, { level: "spark", amount: 50, actor: new ObjectId(), reason: "boost", grantKey: rid("grant"), now: JULY });
  ok("grant raises ceiling to 150", g.ok && g.snapshot.remaining === 150);
  await AiCreditPeriod.updateOne({ teacherId: t10 }, { $set: { tempGranted: 0 } }); // simulate crash before counter applied
  await svc.reconcilePeriod(t10, g.snapshot.periodMonthUtc, JULY);
  ok("reconcile re-derives tempGranted (never lost)", (await AiCreditPeriod.findOne({ teacherId: t10 })).tempGranted === 50);
  const g2 = await svc.grant(t10, { level: "spark", amount: 50, actor: new ObjectId(), reason: "boost", grantKey: rid("grant"), now: JULY });
  ok("grant idempotent on grantKey (no double-grant)", g2.idempotent === true && g2.snapshot.remaining === 150);

  const t11 = new ObjectId();
  const exp = new Date(Date.UTC(2026, 6, 20));
  await svc.grant(t11, { level: "spark", amount: 30, actor: new ObjectId(), reason: "temp", expiresAt: exp, grantKey: rid("texp"), now: JULY });
  ok("before expiry ceiling includes grant (130)", (await svc.snapshot(t11, "spark", JULY)).remaining === 130);
  const afterExp = await svc.snapshot(t11, "spark", new Date(Date.UTC(2026, 6, 21)));
  ok("after expiry grant removed exactly once (100)", afterExp.remaining === 100);

  // ── CR-123: grant validation ──
  const bad = async (opts) => { try { await svc.grant(new ObjectId(), { level: "spark", actor: new ObjectId(), grantKey: rid("v"), now: JULY, ...opts }); return null; } catch (e) { return e.code; } };
  ok("grant rejects non-positive amount", (await bad({ amount: 0, reason: "x" })) === "invalid_amount");
  ok("grant rejects huge amount", (await bad({ amount: 9_000_000, reason: "x" })) === "invalid_amount");
  ok("grant rejects empty reason", (await bad({ amount: 5, reason: "  " })) === "reason_required");
  ok("grant rejects past expiry", (await bad({ amount: 5, reason: "x", expiresAt: new Date(Date.UTC(2020, 0, 1)) })) === "invalid_expiry");
  ok("grant rejects invalid grantKey", await (async () => { try { await svc.grant(new ObjectId(), { level: "spark", amount: 5, reason: "x", grantKey: "no", now: JULY }); return false; } catch (e) { return e.code === "invalid_client_request_id"; } })());

  // ── Mid-month promotion raises ceiling; UTC reset ──
  const t12 = new ObjectId();
  await svc.reserve(t12, { operation: "ai.extract.questions", clientReqId: rid("promo"), level: "spark", now: JULY });
  ok("promotion mid-month raises base to 300", (await svc.snapshot(t12, "momentum", JULY)).baseAllowance === 300);
  ok("no reduction within a month ($max keeps 300)", (await svc.snapshot(t12, "spark", JULY)).baseAllowance === 300);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
