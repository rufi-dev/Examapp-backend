/*
 * AUD-008 migration — add TTL + partial-unique lookup indexes to the `tokens`
 * collection (password-reset / email-verify / login-code tokens).
 *
 *   node migrations/2026-07-26-token-indexes.js --dry-run [--db=<name>]
 *   node migrations/2026-07-26-token-indexes.js --apply --db=<name>
 *   node migrations/2026-07-26-token-indexes.js --rollback --db=<name>
 *
 * WHAT --apply BUILDS (idempotent):
 *   - TTL on `expiresAt` (expireAfterSeconds:0) — Mongo reaps expired token rows.
 *   - partial-UNIQUE indexes on rToken / vToken / lToken (only over non-empty
 *     values) — indexed lookups + a token hash cannot collide.
 *   - a plain index on userId.
 *
 * SAFETY (Rule 7/9; CR-043): --dry-run is read-only via the native driver (no
 * Mongoose model, so no collection is auto-created). A throwaway db NAME, a
 * matching --db, or --force is required to contact the DB. --apply REFUSES to
 * build a unique index if the collection already contains duplicate non-empty
 * token hashes (it reports them first) — never silently drops data.
 *
 * ROLLBACK drops exactly the five indexes this migration creates (by name).
 */
require("dotenv").config();
const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const modeFlags = ["--dry-run", "--apply", "--rollback"].filter(has);
if (modeFlags.length > 1) { console.error(`\nREFUSED: contradictory modes ${modeFlags.join(" ")}.\n`); process.exit(2); }
const APPLY = has("--apply");
const ROLLBACK = has("--rollback");
const DRY = !APPLY && !ROLLBACK;
const FORCE = has("--force");
const dbArg = (argv.find((a) => a.startsWith("--db=")) || "").split("=")[1] || "";

function dbNameFromUri(uri) {
  try {
    const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://"));
    return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || "";
  } catch (_) { return ""; }
}
function isThrowaway(name) {
  return /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(name);
}

// The canonical index spec is SHARED with the startup verifier (helper/tokenIndexes).
const { INDEXES, collectionExists } = require("../helper/tokenIndexes");

async function dupCount(coll, field) {
  const r = await coll.aggregate([
    { $match: { [field]: { $gt: "" } } },
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: "dups" },
  ]).toArray();
  return r.length ? r[0].dups : 0;
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }
  const dbName = dbNameFromUri(uri);
  if (!dbName) { console.log("Could not parse a database NAME; refusing to contact any DB."); process.exit(3); }
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;

  const mode = ROLLBACK ? "ROLLBACK" : APPLY ? "APPLY" : "DRY RUN (read-only)";
  console.log(`\nAUD-008 token-indexes migration — ${mode}`);
  console.log(`  database: ${dbName}`);
  if (!safe) {
    console.log(`\n  Target database "${dbName}" is not a recognizably throwaway NAME and no matching --db=${dbName} was given.`);
    console.log("  This run will NOT contact the database. Pass --db=<exact-name> or --force to proceed.\n");
    process.exit(DRY ? 0 : 3);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const coll = db.collection("tokens");

  // CR-052: a fresh DB has no `tokens` collection. `coll.indexes()` would throw
  // NamespaceNotFound — so census only inspects indexes/dups when it EXISTS, and
  // never creates it (dry-run/rollback must leave a fresh DB unchanged).
  const exists = await collectionExists(db, "tokens");
  const total = exists ? await coll.countDocuments({}) : 0;
  const expired = exists ? await coll.countDocuments({ expiresAt: { $lte: new Date() } }) : 0;
  const dR = exists ? await dupCount(coll, "rToken") : 0;
  const dV = exists ? await dupCount(coll, "vToken") : 0;
  const dL = exists ? await dupCount(coll, "lToken") : 0;
  const existing = exists ? (await coll.indexes()).map((i) => i.name) : [];
  console.log(`  census: collection ${exists ? "present" : "ABSENT"}; tokens=${total} (expired=${expired}); dup non-empty hashes: rToken=${dR}, vToken=${dV}, lToken=${dL}`);
  console.log(`  existing indexes: ${existing.join(", ") || "(none)"}`);

  if (DRY) {
    const missing = INDEXES.filter((ix) => !existing.includes(ix.options.name)).map((ix) => ix.options.name);
    console.log(`  → would create: ${missing.join(", ") || "(all present)"}`);
    if (dR || dV || dL) console.log("  WARNING: duplicate non-empty token hashes exist — --apply will REFUSE the unique index until resolved.");
    console.log("\nDRY RUN complete — READ ONLY (no index created, no document written).\n");
    await mongoose.disconnect();
    return process.exit(0);
  }

  if (ROLLBACK) {
    let dropped = 0;
    for (const ix of INDEXES) {
      if (existing.includes(ix.options.name)) { await coll.dropIndex(ix.options.name); dropped += 1; }
    }
    console.log(`\nROLLBACK: dropped ${dropped} AUD-008 index(es).\n`);
    await mongoose.disconnect();
    return process.exit(0);
  }

  // ---- APPLY ----
  if (dR || dV || dL) {
    console.log("\n  REFUSED: duplicate non-empty token hashes present — a unique index would fail.");
    console.log("  Resolve duplicates (they indicate a bug or a replay) before re-running --apply.\n");
    await mongoose.disconnect();
    return process.exit(4);
  }
  let created = 0;
  for (const ix of INDEXES) {
    await coll.createIndex(ix.key, ix.options); // idempotent by name+spec
    created += 1;
  }
  const after = (await coll.indexes()).map((i) => i.name);
  const ok = INDEXES.every((ix) => after.includes(ix.options.name));
  console.log(`\nAPPLIED — ensured ${created} index(es). Present now: ${after.join(", ")}.`);
  console.log(`  verification: all AUD-008 indexes present = ${ok}.\n`);
  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
