/*
 * AUD-008 CR-050 — canonicalize user email (trim + lower-case) so identity is
 * case-insensitive and the unique index is effective.
 *
 *   node migrations/2026-07-26-canonical-email.js --dry-run [--db=<name>]
 *   node migrations/2026-07-26-canonical-email.js --apply --db=<name>
 *   node migrations/2026-07-26-canonical-email.js --rollback --db=<name>
 *
 * --dry-run  groups users by canonical email and REPORTS collisions (two rows that
 *            would become identical, e.g. Teacher@x + teacher@x) + how many rows
 *            need lowercasing. Read-only.
 * --apply    REFUSES while any collision remains unresolved (an operator must merge
 *            /rename first); otherwise lower-cases every email in place (idempotent)
 *            and verifies the unique index on `email`.
 *            After canonicalization it OWNS the exact unique {email:1} index:
 *            creates it when absent; refuses a conflicting NON-unique/wrong-shape
 *            index (offline drop required, or pass --replace-index for a reviewed
 *            drop+recreate — this needs a write-drain since dropping a unique index
 *            momentarily allows duplicates). Exits NONZERO unless BOTH canonical
 *            data AND the exact uniqueness invariant are verified.
 * --rollback documented no-op: lower-casing is LOSSY, so rollback deliberately does
 *            NOT restore original case (that would recreate the ambiguous identities
 *            this migration removed). It also does NOT drop the unique index (that
 *            would reopen the duplicate-identity hole). Canonical emails are kept.
 *
 * SAFETY (CR-043): native driver; a throwaway db NAME / matching --db / --force is
 * required to contact the DB. Dry-run never writes.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const modeFlags = ["--dry-run", "--apply", "--rollback"].filter(has);
if (modeFlags.length > 1) { console.error(`\nREFUSED: contradictory modes ${modeFlags.join(" ")}.\n`); process.exit(2); }
const APPLY = has("--apply"), ROLLBACK = has("--rollback"), DRY = !APPLY && !ROLLBACK, FORCE = has("--force");
const REPLACE_INDEX = has("--replace-index");
const dbArg = (argv.find((a) => a.startsWith("--db=")) || "").split("=")[1] || "";
const { inspectEmailIndex } = require("../helper/emailIndex");

function dbNameFromUri(uri) {
  try { const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://")); return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || ""; } catch { return ""; }
}
const isThrowaway = (n) => /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(n);
const canonExpr = { $toLower: { $trim: { input: "$email" } } };

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }
  const dbName = dbNameFromUri(uri);
  if (!dbName) { console.log("Could not parse a database NAME; refusing to contact any DB."); process.exit(3); }
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;

  console.log(`\nAUD-008 canonical-email migration — ${ROLLBACK ? "ROLLBACK" : APPLY ? "APPLY" : "DRY RUN (read-only)"}`);
  console.log(`  database: ${dbName}`);
  if (!safe) {
    console.log(`\n  Target "${dbName}" is not a recognizably throwaway NAME and no matching --db=${dbName} was given.`);
    console.log("  This run will NOT contact the database. Pass --db=<exact-name> or --force.\n");
    process.exit(DRY ? 0 : 3);
  }

  await mongoose.connect(uri);
  const users = mongoose.connection.db.collection("users");

  // Collision groups: >1 user sharing one canonical email.
  const collisions = await users.aggregate([
    { $group: { _id: canonExpr, ids: { $push: "$_id" }, emails: { $push: "$email" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();
  const needLower = await users.countDocuments({ $expr: { $ne: ["$email", canonExpr] } });
  console.log(`  census: users=${await users.countDocuments({})}; need-lowercasing=${needLower}; collision groups=${collisions.length}`);

  if (collisions.length) {
    console.log("  COLLISIONS (must be resolved before --apply):");
    for (const c of collisions.slice(0, 20)) console.log(`    ${c._id} <- ${c.emails.join(", ")}`);
  }

  if (DRY) {
    console.log("\nDRY RUN complete — READ ONLY.\n");
    await mongoose.disconnect();
    return process.exit(0);
  }

  if (ROLLBACK) {
    console.log("\nROLLBACK: no-op by design — lower-casing is lossy; original case is NOT restored (that would recreate ambiguous identities). Canonical emails kept.\n");
    await mongoose.disconnect();
    return process.exit(0);
  }

  // ---- APPLY ----
  const db = mongoose.connection.db;
  // 1) Refuse on existing collisions BEFORE any mutation.
  if (collisions.length) {
    console.log(`\n  REFUSED: ${collisions.length} canonical-email collision group(s) exist. Merge/rename the duplicate accounts, then re-run --apply.\n`);
    await mongoose.disconnect();
    return process.exit(4);
  }
  // 2) CR-062: inspect the email index BEFORE canonicalizing. A wrong-shape index
  //    (non-unique / partial / sparse / collation) is refused WITHOUT mutating any
  //    email, unless --replace-index authorizes a reviewed drop+recreate.
  let ix = await inspectEmailIndex(db);
  if (ix.state === "wrong_shape" && !REPLACE_INDEX) {
    console.log(`\n  REFUSED (no mutation performed): a wrong-shape email index "${ix.name}" exists [${(ix.reasons || []).join(",")}]. Drop it offline (write-drain) or re-run with --replace-index.\n`);
    await mongoose.disconnect();
    return process.exit(4);
  }

  // 3) Canonicalize the email data.
  const res = await users.updateMany({ $expr: { $ne: ["$email", canonExpr] } }, [{ $set: { email: canonExpr } }]);

  // 4) CR-062 #5: re-run the collision census (post-canonicalization / pre-index).
  //    A race that introduced a canonical collision must abort BEFORE we try the
  //    unique index (which would otherwise fail mid-build). Requires a write drain.
  const raceCollisions = await users.aggregate([
    { $group: { _id: canonExpr, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();
  if (raceCollisions.length) {
    console.log(`\n  ABORTED: ${raceCollisions.length} canonical collision(s) appeared during the run (concurrent writes?). Ensure writes are drained and re-run.\n`);
    await mongoose.disconnect();
    return process.exit(1);
  }

  // 5) Ensure the EXACT unique index (replace any wrong shape when authorized).
  ix = await inspectEmailIndex(db);
  if (ix.state === "wrong_shape") { // only reachable with --replace-index
    console.log(`  --replace-index: dropping wrong-shape email index "${ix.name}" [${(ix.reasons || []).join(",")}] and recreating it EXACT-unique (writes must be drained).`);
    await users.dropIndex(ix.name);
    ix = { state: "absent" };
  }
  if (ix.state === "absent") {
    await users.createIndex({ email: 1 }, { unique: true, name: "email_1" });
  }
  // 6) Reconcile the app's lastActiveAt perf index (autoIndex is disabled on the
  //    model, so nothing else builds it) — explicit, never silently lost.
  await users.createIndex({ lastActiveAt: 1 }, { name: "lastActiveAt_1" });

  // 7) Verify BOTH postconditions; exit nonzero on any failure.
  const finalIx = await inspectEmailIndex(db);
  const remaining = await users.countDocuments({ $expr: { $ne: ["$email", canonExpr] } });
  const ok = remaining === 0 && finalIx.state === "exact";
  console.log(`\nAPPLIED — lower-cased ${res.modifiedCount} email(s); unique email index=${finalIx.state}; remaining non-canonical=${remaining}.`);
  console.log(`  verification: canonical data + exact uniqueness invariant = ${ok}.\n`);
  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
