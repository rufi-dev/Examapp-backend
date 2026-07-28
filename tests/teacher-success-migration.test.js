/*
 * Teacher Success Journey migration (CR-128/CR-129): fail-closed refusal; --batch
 * required; unique-collision census for EVERY unique index; journaled + resumable
 * apply with per-index intent + per-user BEFORE-IMAGE; --verify scans the journal
 * (fails on incomplete apply / in-progress or conflicting rollback); rollback
 * reverts a user ONLY while their state still equals what the migration wrote
 * (a later promotion is PRESERVED as a retained conflict); externally-replaced
 * indexes are never dropped; failpoints at every durable phase; concurrent-worker
 * + response-loss + idempotent re-run convergence.
 */
process.env.NODE_ENV = "test";
const path = require("path");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const MIG = path.join(__dirname, "..", "migrations", "2026-07-27-teacher-success.js");
let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, extra ? "\n      " + extra : ""); } };

function run(args, env, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [MIG, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", done = false;
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => { if (!done) { done = true; try { c.kill("SIGKILL"); } catch (_) {} resolve({ status: null, out, ms: Date.now() - t0, timedOut: true }); } }, timeoutMs);
    c.on("exit", (code) => { if (!done) { done = true; clearTimeout(t); resolve({ status: code, out, ms: Date.now() - t0, timedOut: false }); } });
  });
}
const dbUri = (base, name) => base.replace(/\/?$/, "/") + name;
const PROD = "mongodb://10.255.255.1:27017/examopia_live";
const { ObjectId } = mongoose.Types;

async function main() {
  const mem = await MongoMemoryServer.create();
  const base = mem.getUri().replace(/\/[^/]*$/, "");
  const seedColl = async (name, coll, docs) => { const uri = dbUri(base, name); await mongoose.connect(uri); await mongoose.connection.db.collection(coll).insertMany(docs); await mongoose.disconnect(); return uri; };
  const withDb = async (uri, fn) => { await mongoose.connect(uri); try { return await fn(mongoose.connection.db); } finally { await mongoose.disconnect(); } };
  const legacyTeacher = () => ({ name: "Legacy", email: `l${Math.random()}@x.com`, role: "teacher" });

  // ── 1) refusals + usage ──
  for (const mode of ["--dry-run", "--verify", "--apply", "--rollback"]) {
    const r = await run([mode], { MONGO_URI: PROD }, 12000);
    ok(`refusal ${mode}: exit 3 fast BEFORE connecting`, r.status === 3 && /refusing/i.test(r.out) && !r.timedOut && r.ms < 8000, `exit=${r.status}`);
  }
  ok("contradictory modes → exit 2", (await run(["--apply", "--verify"], { MONGO_URI: PROD }, 8000)).status === 2);
  {
    const uri = dbUri(base, "tsj_nobatch_test");
    ok("apply without --batch → exit 2", (await run(["--apply", "--db=tsj_nobatch_test"], { MONGO_URI: uri })).status === 2);
    ok("rollback without --batch → exit 2", (await run(["--rollback", "--db=tsj_nobatch_test"], { MONGO_URI: uri })).status === 2);
  }

  // ── 2) apply + verify + idempotent ──
  {
    const uri = dbUri(base, "tsj_apply_test");
    ok("apply w/o --batch refused (exit 2)", (await run(["--apply", "--db=tsj_apply_test"], { MONGO_URI: uri })).status === 2);
    const a = await run(["--apply", "--db=tsj_apply_test", "--batch=b1"], { MONGO_URI: uri });
    ok("apply: exit 0 + journal complete", a.status === 0 && /journal complete/.test(a.out), a.out.slice(-200));
    ok("verify after apply: exit 0 (contract + journal clean)", (await run(["--verify", "--db=tsj_apply_test"], { MONGO_URI: uri })).status === 0);
    ok("re-apply same batch idempotent: exit 0", (await run(["--apply", "--db=tsj_apply_test", "--batch=b1"], { MONGO_URI: uri })).status === 0);
  }

  // ── 3) verify on unprepared → exit 1 ──
  {
    const uri = await seedColl("tsj_unprep_test", "ai_credit_ledger", [{ x: 1 }]);
    ok("verify unprepared: exit 1", (await run(["--verify", "--db=tsj_unprep_test"], { MONGO_URI: uri })).status === 1);
  }

  // ── 4) dirty data refused for EVERY unique index ──
  const tid = new ObjectId();
  const dirty = [
    ["users", [{ email: "a@x.com", referralCode: "DUP" }, { email: "b@x.com", referralCode: "DUP" }], "uniq_referral_code"],
    ["teacher_activity_daily", [{ teacherId: tid, date: "2026-07-10" }, { teacherId: tid, date: "2026-07-10" }], "uniq_teacher_day"],
    ["teacher_referral", [{ refereeId: tid }, { refereeId: tid }], "uniq_referee"],
    ["teacher_referral", [{ refereeId: new ObjectId(), rewardKey: "RK" }, { refereeId: new ObjectId(), rewardKey: "RK" }], "uniq_reward_key"],
    ["teacher_upgrade_request", [{ teacherId: tid, targetLevel: "momentum", status: "open" }, { teacherId: tid, targetLevel: "momentum", status: "open" }], "uniq_open_request"],
    ["ai_credit_period", [{ teacherId: tid, periodMonthUtc: "2026-07" }, { teacherId: tid, periodMonthUtc: "2026-07" }], "uniq_teacher_period"],
    ["ai_credit_ledger", [{ idempotencyKey: "K" }, { idempotencyKey: "K" }], "uniq_idem"],
    ["teacher_level_history", [{ teacherId: tid, levelVersionAfter: 1 }, { teacherId: tid, levelVersionAfter: 1 }], "uniq_teacher_version"],
  ];
  let di = 0;
  for (const [coll, docs, idxName] of dirty) {
    const name = `tsj_dirty_${di++}_test`;
    const uri = await seedColl(name, coll, docs);
    const a = await run(["--apply", `--db=${name}`, "--batch=b1"], { MONGO_URI: uri });
    ok(`dirty ${idxName}: apply REFUSES (exit 1, names index)`, a.status === 1 && /REFUSED/.test(a.out) && a.out.includes(idxName), a.out.slice(-160));
    const built = await withDb(uri, (db) => db.collection(coll).indexes());
    ok(`dirty ${idxName}: no index built`, !built.some((i) => i.name === idxName));
  }

  // ── 5) CR-129#2: failpoint after-indexes → verify FAILS (journal incomplete) → resume → verify 0 ──
  {
    const name = "tsj_fp_indexes_test"; const uri = dbUri(base, name);
    await withDb(uri, (db) => db.collection("users").insertOne(legacyTeacher()));
    const crash = await run(["--apply", `--db=${name}`, "--batch=bF"], { MONGO_URI: uri, TSJ_MIG_FAILPOINT: "after-indexes" });
    ok("apply aborts at after-indexes (exit 97)", crash.status === 97);
    ok("verify AFTER incomplete apply: exit 1 (journal incomplete)", (await run(["--verify", `--db=${name}`], { MONGO_URI: uri })).status === 1);
    const resume = await run(["--apply", `--db=${name}`, "--batch=bF"], { MONGO_URI: uri });
    ok("resume same batch converges: exit 0", resume.status === 0 && /journal complete/.test(resume.out));
    ok("verify after resume: exit 0", (await run(["--verify", `--db=${name}`], { MONGO_URI: uri })).status === 0);
  }

  // ── 6) CR-129#5: rollback MUST PRESERVE a promoted teacher (never unset Momentum/1) ──
  {
    const name = "tsj_promote_rollback_test"; const uri = dbUri(base, name);
    const id = (await withDb(uri, (db) => db.collection("users").insertOne(legacyTeacher()))).insertedId;
    await run(["--apply", `--db=${name}`, "--batch=bP"], { MONGO_URI: uri });
    ok("apply gave Spark/0", await withDb(uri, async (db) => { const u = await db.collection("users").findOne({ _id: id }); return u.teacherLevel === "spark" && u.levelVersion === 0; }));
    // legitimate promotion after the migration
    await withDb(uri, (db) => db.collection("users").updateOne({ _id: id }, { $set: { teacherLevel: "momentum", levelVersion: 1, levelSince: new Date(), levelSource: "admin" } }));
    const rb = await run(["--rollback", `--db=${name}`, "--batch=bP"], { MONGO_URI: uri });
    ok("rollback of a promoted teacher: exit 1 + RETAINED conflict", rb.status === 1 && /RETAINED/.test(rb.out) && /promoted\/changed/.test(rb.out), rb.out.slice(-200));
    ok("Momentum/1 PRESERVED (never unset)", await withDb(uri, async (db) => { const u = await db.collection("users").findOne({ _id: id }); return u.teacherLevel === "momentum" && u.levelVersion === 1 && u.levelSource === "admin"; }));
    ok("verify now exit 1 (retained rollback conflict)", (await run(["--verify", `--db=${name}`], { MONGO_URI: uri })).status === 1);
  }

  // ── 7) clean rollback: revert to exact before-image (absent) + drop batch indexes + journal cleared ──
  {
    const name = "tsj_clean_rollback_test"; const uri = dbUri(base, name);
    const id = (await withDb(uri, (db) => db.collection("users").insertOne(legacyTeacher()))).insertedId;
    await run(["--apply", `--db=${name}`, "--batch=bC"], { MONGO_URI: uri });
    const rb = await run(["--rollback", `--db=${name}`, "--batch=bC"], { MONGO_URI: uri });
    ok("clean rollback: exit 0 + journal cleared", rb.status === 0 && /Journal cleared/.test(rb.out), rb.out.slice(-160));
    ok("teacher restored to BEFORE-image (level/version absent)", await withDb(uri, async (db) => { const u = await db.collection("users").findOne({ _id: id }); return u.teacherLevel === undefined && u.levelVersion === undefined; }));
    ok("batch indexes dropped", await withDb(uri, async (db) => !(await db.collection("ai_credit_ledger").indexes()).some((i) => i.name === "uniq_idem")));
    ok("verify after rollback: exit 1 (indexes gone)", (await run(["--verify", `--db=${name}`], { MONGO_URI: uri })).status === 1);
    ok("rollback of an unknown batch is a no-op (exit 0)", (await run(["--rollback", `--db=${name}`, "--batch=nope"], { MONGO_URI: uri })).status === 0);
  }

  // ── 8) external index replacement → rollback RETAINS conflict, never drops it ──
  {
    const name = "tsj_extidx_test"; const uri = dbUri(base, name);
    await run(["--apply", `--db=${name}`, "--batch=bX"], { MONGO_URI: uri });
    await withDb(uri, async (db) => { await db.collection("ai_credit_ledger").dropIndex("uniq_idem"); await db.collection("ai_credit_ledger").createIndex({ idempotencyKey: 1 }, { name: "uniq_idem" }); }); // now NON-unique
    const rb = await run(["--rollback", `--db=${name}`, "--batch=bX"], { MONGO_URI: uri });
    ok("rollback with an externally-replaced index: exit 1 + retained conflict", rb.status === 1 && /externally-replaced index/.test(rb.out), rb.out.slice(-200));
    ok("the externally-replaced index is NOT dropped", await withDb(uri, async (db) => (await db.collection("ai_credit_ledger").indexes()).some((i) => i.name === "uniq_idem")));
  }

  // ── 9) response-loss failpoints (before/after index create, before/after backfill) all converge ──
  for (const fp of ["before-index-create", "after-index-create", "after-ownership-record", "before-backfill-apply", "after-backfill-apply", "rollback-user-restore"]) {
    const name = `tsj_fp_${fp.replace(/[^a-z]/g, "")}_test`; const uri = dbUri(base, name);
    const id = (await withDb(uri, (db) => db.collection("users").insertOne(legacyTeacher()))).insertedId;
    if (fp === "rollback-user-restore") {
      await run(["--apply", `--db=${name}`, "--batch=bR"], { MONGO_URI: uri });
      const crash = await run(["--rollback", `--db=${name}`, "--batch=bR"], { MONGO_URI: uri, TSJ_MIG_FAILPOINT: fp });
      const resume = await run(["--rollback", `--db=${name}`, "--batch=bR"], { MONGO_URI: uri });
      ok(`failpoint ${fp}: crash(97) → resume rollback converges (exit 0)`, crash.status === 97 && resume.status === 0, `crash=${crash.status} resume=${resume.status}`);
      ok(`failpoint ${fp}: teacher restored to before-image`, await withDb(uri, async (db) => { const u = await db.collection("users").findOne({ _id: id }); return u.teacherLevel === undefined; }));
    } else {
      const crash = await run(["--apply", `--db=${name}`, "--batch=bR"], { MONGO_URI: uri, TSJ_MIG_FAILPOINT: fp });
      ok(`failpoint ${fp}: apply aborts (exit 97) + verify fails`, crash.status === 97 && (await run(["--verify", `--db=${name}`], { MONGO_URI: uri })).status === 1);
      const resume = await run(["--apply", `--db=${name}`, "--batch=bR"], { MONGO_URI: uri });
      ok(`failpoint ${fp}: resume converges (exit 0) + verify 0`, resume.status === 0 && (await run(["--verify", `--db=${name}`], { MONGO_URI: uri })).status === 0);
    }
  }

  // ── 10) concurrent apply workers converge (one journal row per user, contract satisfied) ──
  {
    const name = "tsj_concurrent_test"; const uri = dbUri(base, name);
    await withDb(uri, (db) => db.collection("users").insertMany([legacyTeacher(), legacyTeacher(), legacyTeacher()]));
    const [w1, w2] = await Promise.all([run(["--apply", `--db=${name}`, "--batch=bK"], { MONGO_URI: uri }), run(["--apply", `--db=${name}`, "--batch=bK"], { MONGO_URI: uri })]);
    ok("both concurrent apply workers converge (exit 0)", w1.status === 0 && w2.status === 0, `w1=${w1.status} w2=${w2.status}`);
    ok("exactly one backfill journal row per user (no duplicate)", await withDb(uri, async (db) => (await db.collection("_tsj_backfill_journal").countDocuments({ batch: "bK" })) === 3));
    ok("verify after concurrent apply: exit 0", (await run(["--verify", `--db=${name}`], { MONGO_URI: uri })).status === 0);
  }

  // ── 11) CR-132: a promotion landing EXACTLY before the rollback write is PRESERVED ──
  {
    const name = "tsj_cr132_racewrite_test"; const uri = dbUri(base, name);
    const id = (await withDb(uri, (db) => db.collection("users").insertOne(legacyTeacher()))).insertedId;
    await run(["--apply", `--db=${name}`, "--batch=bW"], { MONGO_URI: uri });
    // rollback crashes at the failpoint immediately BEFORE the atomic conditional write
    const crash = await run(["--rollback", `--db=${name}`, "--batch=bW"], { MONGO_URI: uri, TSJ_MIG_FAILPOINT: "before-rollback-write" });
    ok("CR-132: rollback crashed (97) before the conditional write", crash.status === 97, `status=${crash.status}`);
    // an admin promotes in that exact gap
    await withDb(uri, (db) => db.collection("users").updateOne({ _id: id }, { $set: { teacherLevel: "momentum", levelVersion: 1, levelSince: new Date(), levelSource: "admin" } }));
    // resume: the atomic conditional MISSES the promoted state → PRESERVE, never erase
    const rb = await run(["--rollback", `--db=${name}`, "--batch=bW"], { MONGO_URI: uri });
    ok("CR-132: resumed rollback PRESERVES the promotion (exit 1 + RETAINED)", rb.status === 1 && /RETAINED/.test(rb.out) && /promoted\/changed/.test(rb.out), rb.out.slice(-200));
    ok("CR-132: Momentum/1 intact after the race (never unset)", await withDb(uri, async (db) => { const u = await db.collection("users").findOne({ _id: id }); return u.teacherLevel === "momentum" && u.levelVersion === 1 && u.levelSource === "admin"; }));
  }

  // ── 12) CR-132: a metadata-only change (levelSince/levelSource) is PRESERVED ──
  {
    const name = "tsj_cr132_meta_test"; const uri = dbUri(base, name);
    const id = (await withDb(uri, (db) => db.collection("users").insertOne(legacyTeacher()))).insertedId;
    await run(["--apply", `--db=${name}`, "--batch=bM"], { MONGO_URI: uri });
    // level/version stay spark/0, but an admin action stamps the metadata fields
    await withDb(uri, (db) => db.collection("users").updateOne({ _id: id }, { $set: { levelSince: new Date(), levelSource: "admin_note" } }));
    const rb = await run(["--rollback", `--db=${name}`, "--batch=bM"], { MONGO_URI: uri });
    ok("CR-132: metadata change → rollback PRESERVES (exit 1 + RETAINED)", rb.status === 1 && /RETAINED/.test(rb.out), rb.out.slice(-200));
    ok("CR-132: metadata retained; level NOT unset", await withDb(uri, async (db) => { const u = await db.collection("users").findOne({ _id: id }); return u.teacherLevel === "spark" && u.levelSource === "admin_note"; }));
  }

  // ── 13) CR-132: concurrent rollback workers converge; restore happens exactly once ──
  {
    const name = "tsj_cr132_concurrent_rb_test"; const uri = dbUri(base, name);
    const id = (await withDb(uri, (db) => db.collection("users").insertOne(legacyTeacher()))).insertedId;
    await run(["--apply", `--db=${name}`, "--batch=bCR"], { MONGO_URI: uri });
    const [r1, r2] = await Promise.all([
      run(["--rollback", `--db=${name}`, "--batch=bCR"], { MONGO_URI: uri }),
      run(["--rollback", `--db=${name}`, "--batch=bCR"], { MONGO_URI: uri }),
    ]);
    ok("CR-132: both concurrent rollback workers converge (exit 0)", r1.status === 0 && r2.status === 0, `r1=${r1.status} r2=${r2.status}`);
    ok("CR-132: restored to before-image (absent) — no double-restore, no erase", await withDb(uri, async (db) => { const u = await db.collection("users").findOne({ _id: id }); return u.teacherLevel === undefined && u.levelVersion === undefined; }));
  }

  // ── 14) CR-132: crash before the write with NO concurrent change → clean resume ──
  {
    const name = "tsj_cr132_resploss_test"; const uri = dbUri(base, name);
    const id = (await withDb(uri, (db) => db.collection("users").insertOne(legacyTeacher()))).insertedId;
    await run(["--apply", `--db=${name}`, "--batch=bL"], { MONGO_URI: uri });
    const crash = await run(["--rollback", `--db=${name}`, "--batch=bL"], { MONGO_URI: uri, TSJ_MIG_FAILPOINT: "before-rollback-write" });
    const resume = await run(["--rollback", `--db=${name}`, "--batch=bL"], { MONGO_URI: uri });
    ok("CR-132: crash-before-write then clean resume converges (97 → 0)", crash.status === 97 && resume.status === 0, `crash=${crash.status} resume=${resume.status}`);
    ok("CR-132: teacher restored to before-image on resume", await withDb(uri, async (db) => { const u = await db.collection("users").findOne({ _id: id }); return u.teacherLevel === undefined; }));
  }

  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
