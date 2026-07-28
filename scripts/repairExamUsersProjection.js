/*
 * CR-101 — OPERATIONAL projection repair for the derived `Exam.users` reverse
 * index. `User.exams` is canonical and authoritative for access; `Exam.users` is a
 * reporting projection that a best-effort write failure can leave stale. This CLI
 * (safe to run on a schedule / from a worker) detects the drift and rebuilds
 * `Exam.users` strictly from canonical `User.exams`, emitting bounded metrics.
 *
 *   node scripts/repairExamUsersProjection.js            # detect + repair (default)
 *   node scripts/repairExamUsersProjection.js --dry-run  # detect only, no writes
 *   node scripts/repairExamUsersProjection.js --json      # machine-readable metrics line
 *
 * It NEVER touches `User.exams` (canonical), so it can never change access. Unlike a
 * one-time migration it carries no journal — the reverse projection is fully derived
 * and idempotently recomputable, so re-running only ever converges.
 *
 * FAIL-CLOSED: refuses (nonzero) to contact a database whose NAME is not a throwaway
 * and does not match --db=<name> (or --force), so a stray run cannot hit production
 * unintentionally.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has("--dry-run");
const JSON_OUT = has("--json");
const FORCE = has("--force");
const dbArg = (argv.find((a) => a.startsWith("--db=")) || "").split("=")[1] || "";

function dbNameFromUri(uri) { try { const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://")); return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || ""; } catch { return ""; } }
const isThrowaway = (n) => /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(n);

// Exported so a worker/health check can drive the same repair in-process.
async function repairExamUsersProjection(db, { dryRun = false } = {}) {
  const usersCol = db.collection("users");
  const exams = db.collection("exams");
  const metrics = { examsScanned: 0, examsDrifted: 0, examsRepaired: 0, reverseOnlyRefs: 0, canonicalOnlyRefs: 0 };

  for (const e of await exams.find({}, { projection: { _id: 1, users: 1 } }).toArray()) {
    metrics.examsScanned += 1;
    const holders = (await usersCol.find({ exams: e._id }).project({ _id: 1 }).toArray()).map((h) => String(h._id));
    const current = new Set((e.users || []).map(String));
    const canonical = new Set(holders);
    const reverseOnly = [...current].filter((u) => !canonical.has(u)); // in projection, not acquired
    const canonicalOnly = [...canonical].filter((u) => !current.has(u)); // acquired, not in projection
    metrics.reverseOnlyRefs += reverseOnly.length;
    metrics.canonicalOnlyRefs += canonicalOnly.length;
    if (reverseOnly.length || canonicalOnly.length) {
      metrics.examsDrifted += 1;
      if (!dryRun) {
        await exams.updateOne({ _id: e._id }, { $set: { users: holders.map((h) => new mongoose.Types.ObjectId(h)) } });
        metrics.examsRepaired += 1;
      }
    }
  }
  return metrics;
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }
  const dbName = dbNameFromUri(uri);
  if (!dbName) { console.error("Could not parse a database NAME; refusing to contact any DB."); process.exit(3); }
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;
  if (!safe) { console.error(`Target "${dbName}" not a throwaway NAME and no --db=${dbName}. Refusing.`); process.exit(3); }

  await mongoose.connect(uri);
  const metrics = await repairExamUsersProjection(mongoose.connection.db, { dryRun: DRY });
  await mongoose.disconnect();

  if (JSON_OUT) {
    console.log(JSON.stringify({ mode: DRY ? "dry-run" : "repair", db: dbName, ...metrics }));
  } else {
    console.log(`exam-users projection ${DRY ? "DRY-RUN" : "repair"} on ${dbName}: scanned ${metrics.examsScanned}, drifted ${metrics.examsDrifted}, repaired ${metrics.examsRepaired} (reverse-only refs ${metrics.reverseOnlyRefs}, canonical-only refs ${metrics.canonicalOnlyRefs}).`);
  }
  process.exit(0);
}

module.exports = { repairExamUsersProjection };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
