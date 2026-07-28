/*
 * AUD-008 token-indexes migration lifecycle (in-memory Mongo, real child-process
 * runs): dry-run read-only → fail-closed on a prod name → apply builds the 5
 * indexes → idempotent re-apply → rollback drops them → apply REFUSES when
 * duplicate non-empty token hashes exist.
 */
const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

mongoose.set("autoIndex", false); // don't let a model build indexes behind the migration

const BE = path.join(__dirname, "..");
const MIG = "migrations/2026-07-26-token-indexes.js";
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function run(uri, args) {
  try {
    return { code: 0, out: execFileSync("node", [MIG, ...args], { cwd: BE, env: { ...process.env, MONGO_URI: uri }, encoding: "utf8" }) };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}
const AUD_NAMES = ["aud008_ttl_expiresAt", "aud008_uniq_rToken", "aud008_uniq_vToken", "aud008_uniq_lToken", "aud008_userId"];

async function main() {
  const mem = await MongoMemoryServer.create();
  const host = mem.getUri().replace(/\/?$/, "/");
  const TEST_DB = "exq_e2e_test";
  const PROD_DB = "examopia_prod";
  const DUP_DB = "exq_dup_test";
  const testUri = host + TEST_DB;
  const prodUri = host + PROD_DB;
  const dupUri = host + DUP_DB;

  await mongoose.connect(testUri);
  const db = mongoose.connection.useDb(TEST_DB).db;
  const tokens = db.collection("tokens");
  const oid = () => new mongoose.Types.ObjectId();
  await tokens.insertMany([
    { userId: oid(), rToken: "r1", vToken: "", lToken: "", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) },
    { userId: oid(), rToken: "", vToken: "v1", lToken: "", createdAt: new Date(), expiresAt: new Date(Date.now() - 3600e3) }, // expired
  ]);
  const names = async (coll) => (await coll.indexes()).map((i) => i.name);

  // ── 0) CR-052: dry-run on a FRESH DB with NO tokens collection does not crash ──
  const FRESH_NO_COLL = "exq_fresh_notoken_test";
  const freshUri = host + FRESH_NO_COLL;
  const freshDb = mongoose.connection.useDb(FRESH_NO_COLL).db;
  const beforeCols = (await freshDb.listCollections().toArray()).map((c) => c.name).sort();
  const dryFresh = run(freshUri, ["--dry-run", "--db=" + FRESH_NO_COLL]);
  const afterCols = (await freshDb.listCollections().toArray()).map((c) => c.name).sort();
  ok("fresh-DB (no tokens collection) dry-run exits 0 (no NamespaceNotFound)", dryFresh.code === 0);
  ok("fresh-DB dry-run reports collection ABSENT", /collection ABSENT/.test(dryFresh.out));
  ok("fresh-DB dry-run created NO collection", JSON.stringify(beforeCols) === JSON.stringify(afterCols) && !afterCols.includes("tokens"));

  // ── 1) DRY RUN is read-only ──
  const dry = run(testUri, ["--dry-run", "--db=" + TEST_DB]);
  ok("dry-run exits 0", dry.code === 0);
  ok("dry-run reports READ ONLY", /READ ONLY/i.test(dry.out));
  ok("dry-run created NO AUD-008 index", !(await names(tokens)).some((n) => AUD_NAMES.includes(n)));

  // ── 2) FAIL-CLOSED on a non-throwaway name ──
  const blocked = run(prodUri, ["--apply"]);
  ok("apply on non-throwaway NAME refused (exit 3)", blocked.code === 3);

  // ── 3) APPLY builds all 5 ──
  const apply = run(testUri, ["--apply", "--db=" + TEST_DB]);
  ok("apply exits 0", apply.code === 0);
  const after = await names(tokens);
  ok("all 5 AUD-008 indexes present", AUD_NAMES.every((n) => after.includes(n)));

  // ── 4) IDEMPOTENT re-apply ──
  ok("re-apply exits 0 (idempotent)", run(testUri, ["--apply", "--db=" + TEST_DB]).code === 0);

  // ── 5) ROLLBACK drops them ──
  const rb = run(testUri, ["--rollback", "--db=" + TEST_DB]);
  ok("rollback exits 0", rb.code === 0);
  const afterRb = await names(tokens);
  ok("all 5 AUD-008 indexes dropped", !AUD_NAMES.some((n) => afterRb.includes(n)));

  // ── 6) APPLY refuses when duplicate non-empty token hashes exist ──
  const dupDb = mongoose.connection.useDb(DUP_DB).db;
  const dupTokens = dupDb.collection("tokens");
  await dupTokens.insertMany([
    { userId: oid(), rToken: "dup", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) },
    { userId: oid(), rToken: "dup", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) },
  ]);
  const dupApply = run(dupUri, ["--apply", "--db=" + DUP_DB]);
  ok("apply REFUSES on duplicate non-empty hashes (exit 4)", dupApply.code === 4);
  ok("refused apply built NO unique index", !(await names(dupTokens)).includes("aud008_uniq_rToken"));

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
