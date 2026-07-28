/*
 * Smoke test for scripts/backfillAttemptId.js against in-memory Mongo:
 * legacy 1:1 backfill, ghost flagging, duplicate-active cleanup, index build,
 * idempotent re-run. Spawns the migration as a child process (real offline run).
 */
const path = require("path");
const { execFile } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");

const BE = path.join(__dirname, "..");
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const oid = () => new mongoose.Types.ObjectId();

async function main() {
  const mem = await MongoMemoryServer.create();
  const uri = mem.getUri();
  await mongoose.connect(uri);
  const now = Date.now();

  // (a) Legacy 1:1 pair — one submitted attempt + one Result (no attemptId), sane timeline.
  const u1 = oid(), e1 = oid();
  const legacyAttempt = await Attempt.create({
    userId: u1, examId: e1, submitted: true,
    startedAt: new Date(now - 3600e3), expiresAt: new Date(now - 3000e3),
  });
  // Raw insert: a legacy Result predates the isNew-gated attemptId requirement.
  await Result.collection.insertOne({ userId: u1, examId: e1, earnPoints: 42, createdAt: new Date(now - 3300e3) });

  // (b) Ghost — a submitted attempt with NO Result for that user+exam.
  const u2 = oid(), e2 = oid();
  const ghost = await Attempt.create({
    userId: u2, examId: e2, submitted: true,
    startedAt: new Date(now - 3600e3), expiresAt: new Date(now - 3000e3),
  });

  // (c) Duplicate ACTIVE attempts (same user+exam, submitted:false).
  const u3 = oid(), e3 = oid();
  const older = await Attempt.create({
    userId: u3, examId: e3, submitted: false,
    startedAt: new Date(now - 500e3), expiresAt: new Date(now - 100e3), createdAt: new Date(now - 500e3),
  });
  const newer = await Attempt.create({
    userId: u3, examId: e3, submitted: false,
    startedAt: new Date(now - 400e3), expiresAt: new Date(now - 100e3), createdAt: new Date(now - 400e3),
  });

  await mongoose.disconnect();

  // This process owns the in-memory mongod. A synchronous child blocks Node's
  // event loop and can stop mongodb-memory-server's piped output from draining,
  // deadlocking the migration on Windows. Keep the owner event loop alive while
  // the real offline migration runs in its child process.
  const runMigration = () => new Promise((resolve, reject) => {
    execFile(
      "node",
      ["scripts/backfillAttemptId.js", "--apply"],
      { cwd: BE, env: { ...process.env, MONGO_URI: uri, MIGRATION_TS: new Date().toISOString() }, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
          reject(error);
        } else {
          resolve(stdout);
        }
      }
    );
  });
  const out = await runMigration();
  console.log(out.split("\n").filter((l) => /^\d\)|summary|===/.test(l)).map((l) => "    " + l).join("\n"));

  await mongoose.connect(uri);

  const legRes = await Result.findOne({ userId: u1, examId: e1 }).lean();
  ok("legacy 1:1 Result backfilled with attemptId (ObjectId)",
    legRes.attemptId && String(legRes.attemptId) === String(legacyAttempt._id));

  const g = await Attempt.findById(ghost._id).lean();
  ok("ghost attempt -> unscorable:ghost_no_result", g.unscorable === true && g.unscorableReason === "ghost_no_result");
  ok("ghost attempt -> still no Result", (await Result.countDocuments({ userId: u2, examId: e2 })) === 0);

  const oldA = await Attempt.findById(older._id).lean();
  const newA = await Attempt.findById(newer._id).lean();
  ok("duplicate: newest kept (not retired_duplicate)", newA.unscorableReason !== "retired_duplicate");
  ok("duplicate: older resolved terminal (submitted)", oldA.submitted === true);

  ok("migration built uniq_result_attempt index",
    (await Result.collection.indexes()).some((i) => i.name === "uniq_result_attempt"));

  await runMigration(); // idempotent re-run
  ok("idempotent re-run: legacy pair still single Result", (await Result.countDocuments({ userId: u1, examId: e1 })) === 1);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
