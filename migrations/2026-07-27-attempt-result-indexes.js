/*
 * CR-115/CR-117/CR-119 — the migration-owned OFFLINE build for the Attempt/Result index
 * contract. It builds NATIVELY from the SHARED contract (helper/attemptResultIndexes) —
 * the single source of truth also used by production startup and verifySmokeDb — never
 * Model.createIndexes(). Fail-closed and safe for real dirty data:
 *
 *   node migrations/2026-07-27-attempt-result-indexes.js --dry-run [--db=<name>]  (read-only census)
 *   node migrations/2026-07-27-attempt-result-indexes.js --apply   --db=<name>    (whole preflight, then build)
 *   node migrations/2026-07-27-attempt-result-indexes.js --verify  --db=<name>    (read-only contract check)
 *
 * CR-117: EVERY refused mode (dry-run/verify/apply) exits the documented code 3 BEFORE
 * connecting. CR-119: --apply preflights the WHOLE change (census + conflicts across BOTH
 * collections) and refuses before creating ANY index — a Results conflict/dirty dataset
 * can't leave Attempt indexes partially built, and vice versa.
 * Exit codes: 0 success, 1 verify/shape/dirty failure, 2 usage, 3 refused (unsafe target).
 */
const mongoose = require("mongoose");
const { INDEXES, collectionsOf, specsFor, buildArgs, verifyAttemptResultIndexes } = require("../helper/attemptResultIndexes");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const modeFlags = ["--dry-run", "--apply", "--verify"].filter(has);
if (modeFlags.length > 1) { console.error(`\nREFUSED: contradictory modes ${modeFlags.join(" ")}.\n`); process.exit(2); }
const APPLY = has("--apply");
const VERIFY = has("--verify");
const DRY = !APPLY && !VERIFY;
const FORCE = has("--force");
const dbArg = (argv.find((a) => a.startsWith("--db=")) || "").split("=")[1] || "";

function dbNameFromUri(uri) {
  try { const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://")); return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || ""; } catch (_) { return ""; }
}
function isThrowaway(name) { return /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(name); }

// READ-ONLY census of data that would BREAK a unique-partial build, per collection.
async function census(db) {
  const listed = async (coll) => ((await db.listCollections({ name: coll }, { nameOnly: true }).toArray()).length > 0);
  const out = { dupActiveAttempts: 0, dupResultAttemptId: 0, attemptsPresent: false, resultsPresent: false };
  if (await listed("attempts")) {
    out.attemptsPresent = true;
    const r = await db.collection("attempts").aggregate([
      { $match: { submitted: false } },
      { $group: { _id: { u: "$userId", e: "$examId" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } }, { $count: "d" },
    ]).toArray();
    out.dupActiveAttempts = r.length ? r[0].d : 0;
  }
  if (await listed("results")) {
    out.resultsPresent = true;
    const r = await db.collection("results").aggregate([
      { $match: { attemptId: { $exists: true, $type: "objectId" } } },
      { $group: { _id: "$attemptId", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } }, { $count: "d" },
    ]).toArray();
    out.dupResultAttemptId = r.length ? r[0].d : 0;
  }
  return out;
}

// Existing-index shapes that CONFLICT with the contract (wrong shape under a contract
// name, or an unexpected same-key variant). Derived from the shared verifier so it can't
// drift: a failure is a conflict UNLESS the index is simply absent / collection missing.
async function conflicts(db) {
  const v = await verifyAttemptResultIndexes(db);
  return v.failures.filter((f) => f.reason !== "absent" && f.reason !== "collection_missing")
    .map((f) => `${f.collection}.${f.name}: ${f.reason}`);
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }
  const dbName = dbNameFromUri(uri);
  if (!dbName) { console.log("Could not parse a database NAME; refusing to contact any DB."); process.exit(3); }
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;

  console.log(`\nCR-119 attempt/result-indexes migration — ${VERIFY ? "VERIFY (read-only)" : APPLY ? "APPLY" : "DRY RUN (read-only census)"}`);
  console.log(`  database: ${dbName}`);
  if (!safe) {
    console.log(`\n  Refusing: "${dbName}" is not a recognizably throwaway NAME and no matching --db=${dbName} was given.`);
    console.log("  This run did NOT contact the database. Pass --db=<exact-name> or --force to proceed.\n");
    process.exit(3);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  if (DRY) {
    const c = await census(db);
    const cf = await conflicts(db);
    console.log(`  census: dup active {userId,examId}=${c.dupActiveAttempts}; dup typed Result.attemptId=${c.dupResultAttemptId} (attempts ${c.attemptsPresent ? "present" : "absent"}, results ${c.resultsPresent ? "present" : "absent"})`);
    console.log(`  existing-index conflicts: ${cf.length ? cf.join("; ") : "(none)"}`);
    const v = await verifyAttemptResultIndexes(db);
    console.log(`  contract: ${v.ok ? "already satisfied" : "would build/repair — " + v.failures.map((f) => `${f.collection}.${f.name}:${f.reason}`).join(", ")}`);
    console.log(`  contract indexes: ${INDEXES.map((i) => `${i.collection}.${i.name}`).join(", ")}`);
    await mongoose.disconnect();
    console.log("\nDRY RUN complete — READ ONLY (no write).\n");
    process.exit(0);
  }

  if (APPLY) {
    // WHOLE-apply preflight FIRST (both collections). Nothing is created until the entire
    // change is proven safe — no partial Attempt-then-fail-on-Results build, or vice versa.
    const c = await census(db);
    const cf = await conflicts(db);
    const problems = [];
    if (c.dupActiveAttempts) problems.push(`dup active {userId,examId}=${c.dupActiveAttempts}`);
    if (c.dupResultAttemptId) problems.push(`dup typed Result.attemptId=${c.dupResultAttemptId}`);
    for (const x of cf) problems.push(x);
    if (problems.length) {
      console.error(`\nAPPLY REFUSED (whole preflight) — nothing created: ${problems.join("; ")}. Resolve dirty data with scripts/backfillAttemptId.js / drop the conflicting index, then re-run.\n`);
      await mongoose.disconnect();
      process.exit(1);
    }
    // Build NATIVELY from the contract (single source; autoIndex is off in prod).
    for (const coll of collectionsOf()) {
      for (const spec of specsFor(coll)) {
        const [key, opts] = buildArgs(spec);
        await db.collection(coll).createIndex(key, opts);
      }
    }
    console.log(`  built ${INDEXES.length} contract indexes natively: ${INDEXES.map((i) => `${i.collection}.${i.name}`).join(", ")}`);
  }

  // VERIFY (and post-APPLY): assert the exact shared contract.
  const v = await verifyAttemptResultIndexes(db);
  await mongoose.disconnect();
  if (!v.ok) {
    console.error(`\n${VERIFY ? "VERIFY" : "APPLY"} FAILED — contract not satisfied:\n  - ${v.failures.map((f) => `${f.collection}.${f.name}: ${f.reason}`).join("\n  - ")}\n`);
    process.exit(1);
  }
  console.log(`\n${VERIFY ? "VERIFY" : "APPLIED"} — exact Attempt/Result index contract satisfied.\n`);
  process.exit(0);
}

main().catch((e) => { console.error("[MIGRATION] failed:", e && e.message); process.exit(1); });
