/*
 * The curriculum migration's CLI contract, on a disposable in-memory Mongo.
 *
 * Follows tests/attempt-result-indexes-migration.test.js: an async spawn (this
 * process hosts mem-Mongo, so spawnSync would freeze mongod's piped stdout), a
 * NON-ROUTABLE production URI so a refusal test that wrongly connects hangs
 * instead of silently passing, and a throwaway DB name per scenario.
 *
 * CR-MSO-010 is the point of section 6: rollback must never destroy a teacher's
 * plans or MSOs. It drops only the indexes this batch created, and refuses outright
 * once any curriculum collection holds documents.
 */
process.env.NODE_ENV = "test";
const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const MIG = path.join(__dirname, "..", "migrations", "2026-09-01-curriculum.js");
const PROD = "mongodb://10.255.255.1:27017/examopia_live"; // non-routable on purpose

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : String(extra).slice(0, 400)); }
};

function run(args, env, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [MIG, ...args], {
      env: { ...process.env, ...env },
      cwd: path.join(__dirname, ".."),
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ status: -1, out, ms: Date.now() - started, timedOut: true }); }, timeoutMs);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, out, ms: Date.now() - started, timedOut: false }); });
  });
}

const dbUri = (base, name) => base.replace(/\/[^/?]*(\?|$)/, `/${name}$1`);

async function main() {
  const mem = await MongoMemoryServer.create();
  const base = mem.getUri();

  console.log("\n1. Every mode refuses an unapproved target BEFORE connecting:");
  for (const mode of ["--dry-run", "--apply", "--verify"]) {
    const r = await run([mode], { MONGO_URI: PROD });
    ok(`${mode} → exit 3`, r.status === 3, `${r.status} ${r.out.slice(0, 200)}`);
    ok(`${mode} says it did not contact the database`, /did NOT contact the database/i.test(r.out));
    // The non-routable IP would hang for ~2 minutes if it actually connected.
    ok(`${mode} returns fast (proves no connection attempt)`, !r.timedOut && r.ms < 8000, `${r.ms}ms`);
  }
  {
    const r = await run(["--rollback"], { MONGO_URI: PROD });
    ok("--rollback without --batch is a usage error (exit 2)", r.status === 2, r.status);
    const r2 = await run(["--apply", "--verify"], { MONGO_URI: PROD });
    ok("two modes at once is a usage error (exit 2)", r2.status === 2, r2.status);
  }

  console.log("\n2. Dry-run is read-only:");
  {
    const uri = dbUri(base, "curr_dry_test");
    const r = await run(["--dry-run"], { MONGO_URI: uri });
    ok("exit 0", r.status === 0, r.out.slice(0, 300));
    ok("prints a census", /census/i.test(r.out));
    ok("reports the contract is not yet satisfied", /NOT satisfied/i.test(r.out));

    await mongoose.connect(uri);
    const cols = await mongoose.connection.db.listCollections().toArray();
    ok("dry-run created NO collection", cols.length === 0, JSON.stringify(cols.map((c) => c.name)));
    await mongoose.disconnect();
  }

  console.log("\n3. Apply then verify:");
  {
    const uri = dbUri(base, "curr_apply_test");
    const applied = await run(["--apply", "--db=curr_apply_test"], { MONGO_URI: uri });
    ok("apply exits 0", applied.status === 0, applied.out.slice(0, 400));
    ok("apply reports what it built", /built \d+ index/i.test(applied.out));
    const verified = await run(["--verify", "--db=curr_apply_test"], { MONGO_URI: uri });
    ok("verify exits 0", verified.status === 0, verified.out.slice(0, 300));
    ok("verify says the contract is satisfied", /contract satisfied/i.test(verified.out));

    const again = await run(["--apply", "--db=curr_apply_test"], { MONGO_URI: uri });
    ok("re-applying is idempotent (exit 0)", again.status === 0, again.out.slice(0, 300));
  }

  console.log("\n4. Verify on an unprepared database fails:");
  {
    const uri = dbUri(base, "curr_unprepared_test");
    const r = await run(["--verify", "--db=curr_unprepared_test"], { MONGO_URI: uri });
    ok("exit 1", r.status === 1, r.status);
    ok("names the missing pieces", /NOT satisfied/i.test(r.out));
  }

  console.log("\n5. A wrong-shape index is refused BEFORE anything is created:");
  {
    const uri = dbUri(base, "curr_conflict_test");
    await mongoose.connect(uri);
    // Same key as uniq_storage_key, same NAME, but NOT unique.
    await mongoose.connection.db.collection("curriculum_source_versions").createIndex({ storageKey: 1 }, { name: "uniq_storage_key" });
    await mongoose.disconnect();

    const r = await run(["--apply", "--db=curr_conflict_test"], { MONGO_URI: uri });
    ok("apply refuses (exit 1)", r.status === 1, r.status);
    ok("it says NOTHING was created", /nothing created/i.test(r.out), r.out.slice(0, 300));
    ok("it names the drift", /uniq_storage_key is unique/i.test(r.out), r.out.slice(0, 300));

    await mongoose.connect(uri);
    const idx = await mongoose.connection.db.collection("lesson_plans").indexes().catch(() => []);
    ok("the whole-batch preflight left other collections untouched", idx.length === 0, JSON.stringify(idx));
    await mongoose.disconnect();
  }

  console.log("\n6. CR-MSO-010 — rollback preserves user content:");
  {
    const uri = dbUri(base, "curr_rollback_test");
    const applied = await run(["--apply", "--db=curr_rollback_test", "--batch=b1"], { MONGO_URI: uri });
    ok("apply with a batch tag succeeds", applied.status === 0, applied.out.slice(0, 300));

    // A teacher's lesson plan now lives here.
    await mongoose.connect(uri);
    await mongoose.connection.db.collection("lesson_plans").insertOne({ title: "Müəllimin planı" });
    await mongoose.disconnect();

    const refused = await run(["--rollback", "--db=curr_rollback_test", "--batch=b1"], { MONGO_URI: uri });
    ok("rollback REFUSES while content exists (exit 1)", refused.status === 1, refused.status);
    ok("it says content would be lost", /content would be lost/i.test(refused.out), refused.out.slice(0, 300));
    ok("it names the populated collection", /lesson_plans\(1\)/.test(refused.out), refused.out.slice(0, 300));

    await mongoose.connect(uri);
    const stillThere = await mongoose.connection.db.collection("lesson_plans").countDocuments();
    ok("the document is still there", stillThere === 1);
    await mongoose.connection.db.collection("lesson_plans").deleteMany({});
    await mongoose.disconnect();

    const rolled = await run(["--rollback", "--db=curr_rollback_test", "--batch=b1"], { MONGO_URI: uri });
    ok("rollback succeeds once the collections are empty", rolled.status === 0, rolled.out.slice(0, 300));
    ok("it says no collection and no document was removed", /no collection and no document was removed/i.test(rolled.out));

    await mongoose.connect(uri);
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    ok("the collections themselves survive a rollback", names.includes("lesson_plans"), JSON.stringify(names));
    const after = await mongoose.connection.db.collection("lesson_plans").indexes();
    ok("only _id_ remains on a rolled-back collection", after.length === 1 && after[0].name === "_id_", JSON.stringify(after.map((i) => i.name)));
    await mongoose.disconnect();

    const noJournal = await run(["--rollback", "--db=curr_rollback_test", "--batch=nope"], { MONGO_URI: uri });
    ok("rollback of an unknown batch is refused", noJournal.status === 1, noJournal.status);
  }

  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} migration assertions failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
