/*
 * CR-115 — READ-ONLY verifier for the disposable smoke DB. It creates/repairs
 * NOTHING; it only asserts that the exact index shapes the production boot chain
 * requires (server.js verifyStartupInvariants + preflight-adjacent token/email
 * invariants) are ALREADY present, exactly as a real migrated deploy would have
 * them. Used AFTER the migrations run and BEFORE the server boots, so the smoke
 * proves the migration-owned deployment path — never a Model.createIndexes() shim.
 *
 *   node scripts/verifySmokeDb.cjs      (MONGO_URI = throwaway)  -> exit 0 all present
 * Refuses a non-throwaway db name (fail-closed, exit 3).
 */
const mongoose = require("mongoose");
const { verifyTokenIndexes } = require("../helper/tokenIndexes");
const { verifyEmailUniqueIndex } = require("../helper/emailIndex");
const { verifyAttemptResultIndexes } = require("../helper/attemptResultIndexes");
const { verifyReliabilityIndexes } = require("../helper/reliabilityIndexes");

const isThrowaway = (n) => /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral|smoke)($|[_-])/i.test(n);
function dbName(uri) { try { const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://")); return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || ""; } catch { return ""; } }

// Returns an array of failure strings (empty = all invariants hold).
async function verify(db) {
  const fails = [];

  // 1) tokens — exact aud008_* shapes (migration-owned).
  const t = await verifyTokenIndexes(db);
  if (!t.ok) fails.push(`tokens: missing=[${t.missing.join(",")}] mismatched=[${(t.mismatched || []).map((m) => `${m.name}:${m.reason}`).join(",")}]${t.collectionMissing ? " (collection missing)" : ""}`);

  // 2) users — exact unique {email:1} (migration-owned).
  const e = await verifyEmailUniqueIndex(db);
  if (!e.ok) fails.push(`users email_1: state=${e.state}${e.reasons ? ` [${e.reasons.join(",")}]` : ""}`);

  // 3+4) attempts/results — the SHARED Attempt/Result index contract (no drift with
  // the migration or production startup).
  const ar = await verifyAttemptResultIndexes(db);
  for (const f of ar.failures) fails.push(`${f.collection}.${f.name}: ${f.reason}`);
  const ri = await verifyReliabilityIndexes(db);
  for (const f of ri.failures) fails.push(`${f.collection}.${f.name}: ${f.reason}`);

  return fails;
}

async function main() {
  const uri = process.env.MONGO_URI || "";
  const name = dbName(uri);
  if (!name || !isThrowaway(name)) { console.error(`verifySmokeDb: refusing non-throwaway db "${name}".`); process.exit(3); }
  await mongoose.connect(uri);
  const fails = await verify(mongoose.connection.db);
  await mongoose.disconnect();
  if (fails.length) {
    console.error("verifySmokeDb: startup-invariant shapes NOT satisfied:\n  - " + fails.join("\n  - "));
    process.exit(1);
  }
  console.log("verifySmokeDb: token + email + Attempt/Result index shapes verified (read-only).");
  process.exit(0);
}

module.exports = { verify, isThrowaway, dbName };
if (require.main === module) main().catch((e) => { console.error("verifySmokeDb failed:", e && e.message); process.exit(1); });
