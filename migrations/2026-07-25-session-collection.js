/*
 * AUD-002 migration (Rule 10): create the `sessions` and `pendingsecurityactions`
 * collections + indexes. ADDITIVE ONLY — no backfill (sessions are created lazily
 * on login), no production-data change (Rule 7).
 *
 * Usage:
 *   node migrations/2026-07-25-session-collection.js --dry-run [--db=<name>]
 *   node migrations/2026-07-25-session-collection.js --apply --db=<name>
 *
 * SAFETY (CR-010 / Rule 7 / Rule 9):
 *   - --dry-run is GENUINELY read-only: it uses the native driver's
 *     listCollections + countDocuments and NEVER compiles a Mongoose model or
 *     creates a collection/index.
 *   - The target DATABASE NAME is parsed from the URI and validated. A run that
 *     contacts the DB requires the name to be recognizably throwaway, OR an
 *     explicit --db=<name> that matches, OR --force.
 *   - Count/permission errors are surfaced, never masked as 0.
 *
 * ROLLBACK NOTE:
 *   - Before any session exists: drop the empty collections.
 *   - After logins created sessions: do NOT drop (that logs everyone out). Use
 *     the ADR §3 feature-flag rollback and KEEP the records.
 *   - TTL index (Gate 0): this migration replaces `absoluteExpiresAt_1` with a
 *     PARTIAL TTL (partialFilterExpression { theftFenceTarget: null }). To roll
 *     the index back: db.sessions.dropIndex("absoluteExpiresAt_1") then
 *     db.sessions.createIndex({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 }).
 *     WARNING: the non-partial TTL can delete a session with a pending
 *     theftFenceTarget, so only roll back after the outbox worker backlog is 0.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run") || !argv.includes("--apply");
const FORCE = argv.includes("--force");
// CR-010: ONLY an explicit CLI --db=<name> is an authorizer. EXPECTED_DB_NAME is
// deliberately NOT merged here — an ambient env value must not silently
// authorize contacting a database (it would masquerade as an explicit run).
const dbArg = (argv.find((a) => a.startsWith("--db=")) || "").split("=")[1] || "";

const INDEXES = {
  sessions: [
    { key: { refreshHash: 1 }, options: { unique: true, name: "refreshHash_1" } },
    // Gate 0: PARTIAL TTL — `replace: true` because an earlier deploy may hold a
    // non-partial absoluteExpiresAt_1; changing options requires drop-then-create.
    { key: { absoluteExpiresAt: 1 }, replace: true, options: { expireAfterSeconds: 0, name: "absoluteExpiresAt_1", partialFilterExpression: { theftFenceTarget: null } } },
    { key: { userId: 1, revokedAt: 1 }, options: { name: "userId_1_revokedAt_1" } },
    { key: { theftFenceTarget: 1 }, options: { sparse: true, name: "theftFenceTarget_1" } },
  ],
  pendingsecurityactions: [
    { key: { deadLetter: 1, nextAttemptAt: 1 }, options: { name: "deadLetter_1_nextAttemptAt_1" } },
    { key: { leaseUntil: 1 }, options: { name: "leaseUntil_1" } },
  ],
};

function dbNameFromUri(uri) {
  try {
    const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://"));
    const name = decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0];
    return { name: name || "", host: u.hostname };
  } catch (_) {
    return { name: "", host: "" };
  }
}

// CR-010: safety is keyed on the DATABASE NAME, NOT the host. A local host is
// NOT proof a database is disposable — e.g. a developer pointing at a local
// `examopia_prod` mirror. Only a recognizably throwaway NAME auto-authorizes;
// everything else needs an explicit matching --db or --force.
function isThrowaway(name /*, host */) {
  return /(^|[_-])(test|tests|memory|scratch|throwaway|ci)($|[_-])/i.test(name);
}

function printPlan(mode) {
  console.log(`\nAUD-002 session-collection migration — ${mode}`);
  console.log("  index plan:");
  for (const [coll, ixs] of Object.entries(INDEXES)) {
    ixs.forEach((ix) => console.log(`    - ${coll}: ${ix.options.name}${ix.options.unique ? " (unique)" : ""}${ix.options.expireAfterSeconds != null ? " (TTL)" : ""}`));
  }
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }

  const { name: dbName } = dbNameFromUri(uri);
  if (!dbName) {
    printPlan("BLOCKED");
    console.log("\n  Could not parse a database NAME from the connection string; refusing to contact any DB.\n");
    process.exit(3);
  }
  const nameOk = dbArg && dbArg === dbName;
  const safe = isThrowaway(dbName) || nameOk || FORCE;

  if (!safe) {
    printPlan(DRY ? "DRY RUN (offline — DB not contacted)" : "APPLY (blocked)");
    console.log(`\n  Target database "${dbName}" is not a recognizably throwaway NAME and no matching --db=${dbName} was given.`);
    console.log("  This run will NOT contact the database. Pass --db=<exact-name> or --force to proceed.\n");
    process.exit(DRY ? 0 : 3);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  printPlan(DRY ? "DRY RUN (read-only)" : "APPLY");
  console.log(`  database: ${dbName}`);

  // Native, NON-creating inspection (never compiles a model).
  for (const coll of Object.keys(INDEXES)) {
    const exists = (await db.listCollections({ name: coll }).toArray()).length > 0;
    let count = "n/a (absent)";
    if (exists) count = await db.collection(coll).countDocuments(); // surfaces errors — no silent 0
    const existingIx = exists ? (await db.collection(coll).indexes()).map((i) => i.name) : [];
    console.log(`  ${coll}: exists=${exists} count=${count} indexes=[${existingIx.join(", ")}]`);
  }

  if (DRY) {
    console.log("\nDRY RUN complete — READ ONLY, nothing created. Re-run with --apply to build indexes.\n");
  } else {
    for (const [coll, ixs] of Object.entries(INDEXES)) {
      for (const ix of ixs) {
        if (ix.replace) {
          // Gate 0: explicitly replace (drop old options, create new). Idempotent:
          // ignore "index not found" on the drop.
          try { await db.collection(coll).dropIndex(ix.options.name); console.log(`    dropped ${coll}.${ix.options.name} (for replace)`); }
          catch (e) { if (!/index not found|ns not found/i.test(e.message)) throw e; }
        }
        await db.collection(coll).createIndex(ix.key, ix.options);
      }
    }
    console.log("\nAPPLIED — indexes created (idempotent). Verify options with db.<coll>.getIndexes().\n");
  }
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
