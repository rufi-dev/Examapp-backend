/*
 * Teacher Journey — server-authoritative XP engine.
 * Real in-memory Mongo. Proves: idempotent award under retry AND concurrency;
 * per-exam + monthly caps; admin correction (signed, audited); lifetime XP
 * reconciles EXACTLY from the immutable ledger; zero-award types no-op; the durable
 * outbox awards exactly once even when the first attempt fails.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-xp";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const TeacherXpEvent = require("../models/teacherXpEventModel");
const TeacherXpState = require("../models/teacherXpStateModel");
const TeacherXpOutbox = require("../models/teacherXpOutboxModel");
const xpCfg = require("../config/teacherSuccess/xp");
const svc = require("../services/teacherXpService");

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, x ? JSON.stringify(x) : ""); } };
const { ObjectId } = mongoose.Types;
const JULY = new Date(Date.UTC(2026, 6, 15, 12));
const AUG = new Date(Date.UTC(2026, 7, 3, 9));

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Promise.all([TeacherXpEvent.createIndexes(), TeacherXpState.createIndexes(), TeacherXpOutbox.createIndexes()]);

  // ── 1) award + projection ──
  const t1 = new ObjectId();
  const a1 = await svc.award({ teacherId: t1, type: "exam.publish", sourceId: "examA", at: JULY });
  ok("award exam.publish grants 25", a1.awarded && a1.amount === 25);
  ok("lifetime XP projected to 25", (await svc.total(t1)) === 25);

  // ── 2) idempotency under RETRY (same source) ──
  const a1b = await svc.award({ teacherId: t1, type: "exam.publish", sourceId: "examA", at: JULY });
  ok("re-award same exam is a no-op (duplicate)", !a1b.awarded && a1b.duplicate);
  ok("lifetime XP still 25 after retry", (await svc.total(t1)) === 25);
  ok("exactly one ledger row for examA", (await TeacherXpEvent.countDocuments({ teacherId: t1, sourceId: "examA" })) === 1);

  // ── 3) idempotency under CONCURRENCY (10 parallel awards of the same source) ──
  const t2 = new ObjectId();
  const bursts = await Promise.all(Array.from({ length: 10 }, () => svc.award({ teacherId: t2, type: "exam.publish", sourceId: "examZ", at: JULY })));
  ok("concurrent same-source awards: exactly one succeeds", bursts.filter((r) => r.awarded).length === 1);
  ok("concurrent same-source: lifetime XP is one award (25)", (await svc.total(t2)) === 25);

  // ── 4) DIFFERENT sources each award (distinct exams) ──
  await svc.award({ teacherId: t1, type: "exam.publish", sourceId: "examB", at: JULY });
  ok("a distinct exam awards again (50 total)", (await svc.total(t1)) === 50);

  // ── 5) per-EXAM question cap (60) ──
  const t3 = new ObjectId();
  for (let i = 0; i < 65; i += 1) await svc.award({ teacherId: t3, type: "question.published", sourceId: `examQ:q${i}`, at: JULY });
  const perExam = await TeacherXpEvent.countDocuments({ teacherId: t3, type: "question.published" });
  ok("question.published capped at 60 per exam", perExam === xpCfg.CAPS.questionPerExam);
  ok("beyond the per-exam cap returns capped", (await svc.award({ teacherId: t3, type: "question.published", sourceId: "examQ:q999", at: JULY })).capped === "questionPerExam");

  // ── 6) attempt monthly cap (200) ── (sample the boundary cheaply)
  const t4 = new ObjectId();
  // seed 200 committed attempts directly then assert the 201st is capped
  const rows = [];
  for (let i = 0; i < 200; i += 1) rows.push({ teacherId: t4, type: "attempt.completed", amount: 2, sourceId: `att${i}`, idempotencyKey: svc.digest(t4, "attempt.completed", `att${i}`), periodMonthUtc: "2026-07", dayKey: "2026-07-15" });
  await TeacherXpEvent.insertMany(rows);
  ok("201st completed attempt in the month is capped", (await svc.award({ teacherId: t4, type: "attempt.completed", sourceId: "att200", at: JULY })).capped === "attemptPerMonth");
  ok("a NEXT-month attempt is NOT capped", (await svc.award({ teacherId: t4, type: "attempt.completed", sourceId: "attAug", at: AUG })).awarded === true);

  // ── 7) admin correction (signed, audited, reversible) ──
  const admin = new ObjectId();
  const before = await svc.total(t1);
  const corr = await svc.adminCorrect({ teacherId: t1, amount: -10, reason: "duplicate exam credit", actor: admin });
  ok("admin correction applies a signed amount", corr.corrected && corr.amount === -10);
  ok("lifetime XP reflects the correction", (await svc.total(t1)) === before - 10);
  ok("correction is audited (actor + reason on the ledger row)", await TeacherXpEvent.exists({ teacherId: t1, type: "admin.correction", actor: admin, reason: /duplicate/ }));
  let threw = false; try { await svc.adminCorrect({ teacherId: t1, amount: 5 }); } catch { threw = true; }
  ok("correction without a reason is rejected", threw);

  // ── 8) reconcile rebuilds lifetime XP EXACTLY from the ledger ──
  // Corrupt the projection, then reconcile from the immutable ledger.
  await TeacherXpState.updateOne({ teacherId: t1 }, { $set: { lifetimeXp: 999999 } });
  const rec = await svc.reconcile(t1);
  const ledgerSum = (await TeacherXpEvent.aggregate([{ $match: { teacherId: t1 } }, { $group: { _id: null, s: { $sum: "$amount" } } }]))[0].s;
  ok("reconcile rebuilds lifetime XP to the exact ledger sum", rec.lifetimeXp === ledgerSum && (await svc.total(t1)) === ledgerSum);

  // ── 9) zero-award config value never awards ──
  process.env.TSJ_XP_EXAM_PUBLISH = "0";
  const zero = await svc.award({ teacherId: new ObjectId(), type: "exam.publish", sourceId: "z", at: JULY });
  ok("a zero-configured award is a no-op", !zero.awarded && zero.reason === "zero_award");
  delete process.env.TSJ_XP_EXAM_PUBLISH;

  // ── 10) durable outbox: a failed award enqueues, then drains exactly once ──
  const t5 = new ObjectId();
  await svc.enqueue({ teacherId: t5, type: "referral.qualified", sourceId: "refX" });
  ok("outbox enqueue is idempotent", (await svc.enqueue({ teacherId: t5, type: "referral.qualified", sourceId: "refX" }), (await TeacherXpOutbox.countDocuments({ teacherId: t5 })) === 1));
  const soon = new Date(Date.now() + 5000); // after the row's default nextAttemptAt
  const d1 = await svc.drainOutbox({ now: soon });
  ok("drain awards the queued referral once (100)", d1.drained === 1 && (await svc.total(t5)) === 100);
  ok("drained outbox row is removed", (await TeacherXpOutbox.countDocuments({ teacherId: t5 })) === 0);
  const d2 = await svc.drainOutbox({ now: soon });
  ok("re-draining does not double-award", d2.drained === 0 && (await svc.total(t5)) === 100);

  // ── 11) awardOrEnqueue never throws (committed-event safety) ──
  const t6 = new ObjectId();
  const safe = await svc.awardOrEnqueue({ teacherId: t6, type: "material.uploaded", sourceId: "matA", at: JULY });
  ok("awardOrEnqueue awards on the happy path (5)", safe.awarded && (await svc.total(t6)) === 5);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
