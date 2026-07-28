/*
 * Teacher Success Journey — manual promotion + correction (ADR §9).
 * Real in-memory Mongo. Proves: one-step advance-only promotion; concurrent/
 * retried clicks promote exactly once; immutable history; reason required;
 * top-level + stale-version handling; correction/reversal writes a correction row.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-level";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/userModel");
const TeacherLevelHistory = require("../models/teacherLevelHistoryModel");
const svc = require("../services/teacherLevelService");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const { ObjectId } = mongoose.Types;

let seq = 0;
const mkTeacher = (over = {}) => User.create({ name: "T", email: `lvl${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true, teacherLevel: "spark", levelVersion: 0, ...over });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await User.createIndexes();
  await TeacherLevelHistory.createIndexes();

  const admin = new ObjectId();

  // ── 1) One-step promotion writes immutable history ──
  const t1 = await mkTeacher();
  const p1 = await svc.promote({ teacherId: t1._id, actorId: admin, reason: "Consistent activity", fromLevel: "spark", fromVersion: 0 });
  ok("promote spark→momentum ok", p1.ok && p1.level === "momentum" && p1.levelVersion === 1);
  const t1r = await User.findById(t1._id).lean();
  ok("user level advanced + version incremented", t1r.teacherLevel === "momentum" && t1r.levelVersion === 1 && t1r.levelSource === "admin");
  const h1 = await svc.history(t1._id);
  ok("exactly one history row written", h1.length === 1 && h1[0].fromLevel === "spark" && h1[0].toLevel === "momentum" && h1[0].kind === "promotion" && String(h1[0].actor) === String(admin));

  // ── 2) Reason required ──
  const t2 = await mkTeacher();
  const p2 = await svc.promote({ teacherId: t2._id, actorId: admin, reason: "  ", fromLevel: "spark", fromVersion: 0 });
  ok("promote without reason refused", p2.ok === false && p2.code === "reason_required");
  ok("no history written on refusal", (await TeacherLevelHistory.countDocuments({ teacherId: t2._id })) === 0);

  // ── 3) Concurrent/retried clicks promote exactly once ──
  const t3 = await mkTeacher();
  const results = await Promise.all(Array.from({ length: 8 }, () => svc.promote({ teacherId: t3._id, actorId: admin, reason: "burst", fromLevel: "spark", fromVersion: 0 })));
  const successNonIdem = results.filter((r) => r.ok && !r.idempotent).length;
  const idem = results.filter((r) => r.ok && r.idempotent).length;
  ok("exactly one non-idempotent success under concurrency", successNonIdem === 1);
  ok("the rest are idempotent successes (retried click)", idem === 7);
  ok("only ONE history row for the burst", (await TeacherLevelHistory.countDocuments({ teacherId: t3._id })) === 1);
  const t3r = await User.findById(t3._id).lean();
  ok("burst advanced exactly one level", t3r.teacherLevel === "momentum" && t3r.levelVersion === 1);

  // ── 4) One step only (cannot skip) + top-of-ladder ──
  const p3b = await svc.promote({ teacherId: t3._id, actorId: admin, reason: "again", fromLevel: "momentum", fromVersion: 1 });
  ok("second promotion momentum→impact (one more step)", p3b.ok && p3b.level === "impact");
  const p3c = await svc.promote({ teacherId: t3._id, actorId: admin, reason: "top", fromLevel: "impact", fromVersion: 2 });
  ok("cannot promote past impact", p3c.ok === false && p3c.code === "already_at_top");

  // ── 5a) A LATE retry of the same click (spark@0) is idempotent, not a double-step ──
  const t4 = await mkTeacher();
  await svc.promote({ teacherId: t4._id, actorId: admin, reason: "first", fromLevel: "spark", fromVersion: 0 });
  const retry = await svc.promote({ teacherId: t4._id, actorId: admin, reason: "first (retry)", fromLevel: "spark", fromVersion: 0 });
  ok("late retry of the same promotion is idempotent (no double-step)", retry.ok && retry.idempotent === true && retry.level === "momentum");
  ok("no extra history row for the retry", (await TeacherLevelHistory.countDocuments({ teacherId: t4._id })) === 1);

  // ── 5b) A genuinely stale action (teacher already moved further) is rejected ──
  const t4b = await mkTeacher();
  await svc.promote({ teacherId: t4b._id, actorId: admin, reason: "s1", fromLevel: "spark", fromVersion: 0 }); // → momentum@1
  await svc.promote({ teacherId: t4b._id, actorId: admin, reason: "s2", fromLevel: "momentum", fromVersion: 1 }); // → impact@2
  const stale = await svc.promote({ teacherId: t4b._id, actorId: admin, reason: "stale", fromLevel: "spark", fromVersion: 0 });
  ok("promotion off a stale view (teacher moved further) is stale_version", stale.ok === false && stale.code === "stale_version" && stale.currentLevel === "impact");

  // ── 6) Correction/reversal writes a correction row ──
  const t5 = await mkTeacher({ teacherLevel: "momentum", levelVersion: 1 });
  const corr = await svc.correct({ teacherId: t5._id, actorId: admin, toLevel: "spark", reason: "granted in error", fromLevel: "momentum", fromVersion: 1 });
  ok("correction momentum→spark ok", corr.ok && corr.level === "spark");
  const h5 = await TeacherLevelHistory.findOne({ teacherId: t5._id, kind: "correction" }).lean();
  ok("correction history row written (kind=correction)", !!h5 && h5.fromLevel === "momentum" && h5.toLevel === "spark");
  const t5r = await User.findById(t5._id).lean();
  ok("correction does not touch role/approval (core access intact)", t5r.role === "teacher" && t5r.teacherApproval === "approved");

  // ── CR-126: a crash AFTER the level CAS (history missing) is repaired on retry ──
  const t6 = await mkTeacher();
  await svc.promote({ teacherId: t6._id, actorId: admin, reason: "first", fromLevel: "spark", fromVersion: 0 });
  ok("promotion wrote its history row", (await TeacherLevelHistory.countDocuments({ teacherId: t6._id })) === 1);
  await TeacherLevelHistory.deleteMany({ teacherId: t6._id }); // simulate crash before the history write
  const repair = await svc.promote({ teacherId: t6._id, actorId: admin, reason: "first (retry)", fromLevel: "spark", fromVersion: 0 });
  ok("retry after crash detects already-advanced + repairs history", repair.ok && repair.idempotent === true && repair.repairedHistory === true);
  ok("history row restored exactly once", (await TeacherLevelHistory.countDocuments({ teacherId: t6._id })) === 1);
  // a further retry does NOT duplicate the history
  const repair2 = await svc.promote({ teacherId: t6._id, actorId: admin, reason: "again", fromLevel: "spark", fromVersion: 0 });
  ok("second retry does not duplicate history", repair2.ok && repair2.repairedHistory === false && (await TeacherLevelHistory.countDocuments({ teacherId: t6._id })) === 1);
  // uniqueness enforced at the DB: two history rows for the same reached version is impossible
  let dupBlocked = false;
  try { await TeacherLevelHistory.create({ teacherId: t6._id, fromLevel: "spark", toLevel: "momentum", source: "admin", kind: "promotion", reason: "x", actor: admin, levelVersionBefore: 0, levelVersionAfter: 1 }); }
  catch (e) { dupBlocked = e && (e.code === 11000 || e.code === 11001); }
  ok("uniq_teacher_version blocks a duplicate history row for the same version", dupBlocked === true);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
