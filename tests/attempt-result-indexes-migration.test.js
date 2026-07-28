/*
 * CR-117 — the Attempt/Result index migration is fail-closed, refuses an unapproved
 * target in EVERY mode (exit 3, fast, no network timeout), is SAFE against dirty data
 * and wrong-shape conflicts, and verifies the SHARED index contract exactly.
 */
process.env.NODE_ENV = "test";
const path = require("path");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const MIG = path.join(__dirname, "..", "migrations", "2026-07-27-attempt-result-indexes.js");
let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, extra ? "\n      " + extra : ""); } };

// Async spawn (this process hosts mem-Mongo; spawnSync would freeze mongod's piped stdout).
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

async function main() {
  const mem = await MongoMemoryServer.create();
  const base = mem.getUri().replace(/\/[^/]*$/, "");

  // ── 1) EVERY mode refuses an unapproved target with EXACT exit 3, fast, no hang. ──
  for (const mode of ["--dry-run", "--verify", "--apply"]) {
    const r = await run([mode], { MONGO_URI: PROD }, 12000);
    ok(`refusal ${mode}: exit 3 + 'refusing' + fast (<8s) BEFORE connecting`,
      r.status === 3 && /refusing/i.test(r.out) && r.timedOut === false && r.ms < 8000, `exit=${r.status} ms=${r.ms}`);
  }

  // ── 2) dry-run census on an empty throwaway db: read-only, exit 0. ──
  {
    const uri = dbUri(base, "aidx_dry_test");
    const r = await run(["--dry-run", "--db=aidx_dry_test"], { MONGO_URI: uri });
    ok("dry-run on empty throwaway: exit 0 + census printed", r.status === 0 && /census:/.test(r.out), r.out.slice(-200));
  }

  // ── 3) apply then verify on a clean throwaway db: both exit 0; contract satisfied. ──
  {
    const uri = dbUri(base, "aidx_apply_test");
    const a = await run(["--apply", "--db=aidx_apply_test"], { MONGO_URI: uri });
    ok("apply on clean throwaway: exit 0 + contract satisfied", a.status === 0 && /contract satisfied/.test(a.out), a.out.slice(-200));
    const v = await run(["--verify", "--db=aidx_apply_test"], { MONGO_URI: uri });
    ok("verify after apply: exit 0", v.status === 0, v.out.slice(-200));
  }

  // ── 4) verify on an UNPREPARED throwaway db: exit 1 (contract not satisfied). ──
  {
    const uri = dbUri(base, "aidx_unprep_test");
    await mongoose.connect(uri);
    await mongoose.connection.db.collection("attempts").insertOne({ x: 1 }); // collection exists, no index
    await mongoose.disconnect();
    const v = await run(["--verify", "--db=aidx_unprep_test"], { MONGO_URI: uri });
    ok("verify on unprepared db: exit 1 (missing indexes)", v.status === 1 && /not satisfied/.test(v.out), v.out.slice(-200));
  }

  // ── 5) apply REFUSES dirty data (duplicate active attempts) BEFORE creating. ──
  {
    const uri = dbUri(base, "aidx_dirty_test");
    await mongoose.connect(uri);
    const u = new mongoose.Types.ObjectId(), e = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection("attempts").insertMany([
      { userId: u, examId: e, submitted: false },
      { userId: u, examId: e, submitted: false }, // duplicate active → breaks uniq_active_attempt
    ]);
    await mongoose.disconnect();
    const a = await run(["--apply", "--db=aidx_dirty_test"], { MONGO_URI: uri });
    ok("apply refuses duplicate active attempts (exit 1, no index built)", a.status === 1 && /dirty data/i.test(a.out), a.out.slice(-200));
  }

  // ── 6) apply REFUSES a wrong-shape existing index BEFORE creating. ──
  {
    const uri = dbUri(base, "aidx_conflict_test");
    await mongoose.connect(uri);
    // A same-NAME index with the wrong shape (unique but NO partial filter).
    await mongoose.connection.db.collection("attempts").createIndex({ userId: 1, examId: 1 }, { name: "uniq_active_attempt", unique: true });
    await mongoose.disconnect();
    const a = await run(["--apply", "--db=aidx_conflict_test"], { MONGO_URI: uri });
    ok("apply refuses a wrong-shape conflicting index (exit 1)", a.status === 1 && /conflict/i.test(a.out), a.out.slice(-200));
    // And VERIFY reports the drift (wrong shape) as a failure.
    const v = await run(["--verify", "--db=aidx_conflict_test"], { MONGO_URI: uri });
    ok("verify detects the wrong-shape drift (exit 1, 'partial')", v.status === 1 && /partial/.test(v.out), v.out.slice(-200));
  }

  // ── 7) CR-119: dropping the NON-UNIQUE Attempt perf index must FAIL verify (the
  //    exact defect Codex found — the old contract omitted it and returned ok:true). ──
  {
    const uri = dbUri(base, "aidx_dropperf_test");
    await run(["--apply", "--db=aidx_dropperf_test"], { MONGO_URI: uri });
    await mongoose.connect(uri);
    await mongoose.connection.db.collection("attempts").dropIndex("userId_1_examId_1");
    await mongoose.disconnect();
    const v = await run(["--verify", "--db=aidx_dropperf_test"], { MONGO_URI: uri });
    ok("drop non-unique Attempt perf index → verify FAILS (exit 1, absent)", v.status === 1 && /userId_1_examId_1: absent/.test(v.out), v.out.slice(-200));
  }

  // ── 8) an UNEXPECTED same-key variant (extra index on a contract key, wrong name). ──
  {
    const uri = dbUri(base, "aidx_variant_test");
    await run(["--apply", "--db=aidx_variant_test"], { MONGO_URI: uri });
    await mongoose.connect(uri);
    // A DISTINGUISHABLE same-key index (differing partial filter) under a non-contract
    // name — MongoDB allows it (options differ), but the contract must reject it.
    await mongoose.connection.db.collection("attempts").createIndex({ userId: 1, examId: 1 }, { name: "sneaky_variant", partialFilterExpression: { terminated: true } });
    await mongoose.disconnect();
    const v = await run(["--verify", "--db=aidx_variant_test"], { MONGO_URI: uri });
    ok("unexpected same-key variant → verify FAILS (exit 1, unexpected_same_key_variant)", v.status === 1 && /unexpected_same_key_variant/.test(v.out), v.out.slice(-200));
  }

  // ── 9) duplicate TYPED Result.attemptId → apply refuses in the whole preflight. ──
  {
    const uri = dbUri(base, "aidx_dupres_test");
    await mongoose.connect(uri);
    const aid = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection("results").insertMany([{ attemptId: aid }, { attemptId: aid }]);
    await mongoose.disconnect();
    const a = await run(["--apply", "--db=aidx_dupres_test"], { MONGO_URI: uri });
    ok("apply refuses duplicate typed Result.attemptId (exit 1, whole preflight)", a.status === 1 && /dup typed Result\.attemptId/.test(a.out), a.out.slice(-200));
  }

  // ── 10) a required index hidden from the planner is semantic drift. ──
  {
    const uri = dbUri(base, "aidx_hidden_test");
    await run(["--apply", "--db=aidx_hidden_test"], { MONGO_URI: uri });
    await mongoose.connect(uri);
    await mongoose.connection.db.command({
      collMod: "attempts",
      index: { name: "userId_1_examId_1", hidden: true },
    });
    await mongoose.disconnect();
    const v = await run(["--verify", "--db=aidx_hidden_test"], { MONGO_URI: uri });
    ok("hidden required index → verify FAILS (exit 1, hidden_drift)",
      v.status === 1 && /hidden_drift/.test(v.out), v.out.slice(-200));
  }

  // ── 11) dry-run is byte-for-byte read-only; clean apply is exact + idempotent. ──
  {
    const uri = dbUri(base, "aidx_idem_test");
    const census = async () => {
      await mongoose.connect(uri);
      const a = (await mongoose.connection.db.collection("attempts").indexes()).map((i) => i.name).sort();
      const r = (await mongoose.connection.db.collection("results").indexes()).map((i) => i.name).sort();
      await mongoose.disconnect();
      return JSON.stringify({ a, r });
    };
    await run(["--apply", "--db=aidx_idem_test"], { MONGO_URI: uri });
    const before = await census();
    await run(["--dry-run", "--db=aidx_idem_test"], { MONGO_URI: uri });
    ok("dry-run leaves the index census byte-for-byte unchanged", (await census()) === before);
    const a2 = await run(["--apply", "--db=aidx_idem_test"], { MONGO_URI: uri });
    ok("clean apply is idempotent (2nd apply exit 0, indexes unchanged)", a2.status === 0 && (await census()) === before);
  }

  // ── 12) the intended non-unique + partial-unique SAME-KEY pair both pass. ──
  {
    const uri = dbUri(base, "aidx_pair_test");
    await run(["--apply", "--db=aidx_pair_test"], { MONGO_URI: uri });
    await mongoose.connect(uri);
    const ai = (await mongoose.connection.db.collection("attempts").indexes());
    const nonUniq = ai.find((i) => i.name === "userId_1_examId_1");
    const uniq = ai.find((i) => i.name === "uniq_active_attempt");
    await mongoose.disconnect();
    ok("intended same-key pair coexists (non-unique + partial-unique)", !!nonUniq && !nonUniq.unique && !!uniq && uniq.unique === true);
  }

  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
