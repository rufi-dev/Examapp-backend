/*
 * AUD-002 Gate 4b — session-collection migration lifecycle against in-memory Mongo:
 *   dry-run (genuinely read-only) -> apply -> verify (partial TTL) -> rollback
 *   (documented procedure) -> re-apply (idempotent, replaces non-partial TTL).
 * Also proves the CR-010 fail-closed guard: an --apply against a NON-throwaway db
 * name with no --db/--force contacts NOTHING and exits non-zero.
 *
 * The migration is spawned as a real child process (offline run), same pattern as
 * migration.test.js. No production data, no external services (Rule 7 / Rule 9).
 */
const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const BE = path.join(__dirname, "..");
const MIG = "migrations/2026-07-25-session-collection.js";
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

// Run the migration as a child process. Returns { code, out }. Never throws on a
// non-zero exit — we assert on the code.
function runMig(uri, args) {
  try {
    const out = execFileSync("node", [MIG, ...args], {
      cwd: BE, env: { ...process.env, MONGO_URI: uri }, encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

async function collExists(db, name) {
  return (await db.listCollections({ name }).toArray()).length > 0;
}
async function indexesOf(db, name) {
  if (!(await collExists(db, name))) return [];
  return db.collection(name).indexes();
}

async function main() {
  const mem = await MongoMemoryServer.create();
  const host = mem.getUri().replace(/\/?$/, "/"); // mongodb://127.0.0.1:PORT/
  const TEST_DB = "exq_e2e_test";                  // recognizably throwaway NAME
  const PROD_DB = "examopia_prod";                 // NOT throwaway — must be refused
  const testUri = host + TEST_DB;
  const prodUri = host + PROD_DB;

  await mongoose.connect(testUri);
  const db = mongoose.connection.db;

  // ---- 1) DRY RUN is genuinely read-only ----
  const dry = runMig(testUri, ["--dry-run", "--db=" + TEST_DB]);
  ok("dry-run exits 0", dry.code === 0);
  ok("dry-run reports READ ONLY", /DRY RUN/i.test(dry.out) && /READ ONLY|read-only/i.test(dry.out));
  ok("dry-run created NOTHING (sessions absent)", !(await collExists(db, "sessions")));
  ok("dry-run created NOTHING (pendingsecurityactions absent)", !(await collExists(db, "pendingsecurityactions")));

  // ---- 2) FAIL-CLOSED: --apply against a non-throwaway db, no --db/--force ----
  const blocked = runMig(prodUri, ["--apply"]);
  ok("apply on non-throwaway NAME is refused (exit 3)", blocked.code === 3);
  ok("refusal message names the DB and the escape hatch", /not (a )?recognizably throwaway/i.test(blocked.out));
  const prodDb = mongoose.connection.getClient().db(PROD_DB);
  ok("refused run created NOTHING in prod-named db", !(await collExists(prodDb, "sessions")));

  // ---- 3) APPLY (throwaway db) builds the indexes ----
  const apply = runMig(testUri, ["--apply", "--db=" + TEST_DB]);
  ok("apply exits 0", apply.code === 0);
  ok("apply reports APPLIED", /APPLIED/i.test(apply.out));

  const sIx = await indexesOf(db, "sessions");
  const byName = (arr, n) => arr.find((i) => i.name === n);
  ok("sessions collection created", await collExists(db, "sessions"));
  ok("refreshHash_1 unique", !!byName(sIx, "refreshHash_1") && byName(sIx, "refreshHash_1").unique === true);
  ok("userId_1_revokedAt_1 present", !!byName(sIx, "userId_1_revokedAt_1"));
  ok("theftFenceTarget_1 sparse", !!byName(sIx, "theftFenceTarget_1") && byName(sIx, "theftFenceTarget_1").sparse === true);

  // ---- 4) VERIFY the Gate 0 PARTIAL TTL (the safety-critical property) ----
  const ttl = byName(sIx, "absoluteExpiresAt_1");
  ok("absoluteExpiresAt_1 is a TTL index (expireAfterSeconds:0)", !!ttl && ttl.expireAfterSeconds === 0);
  ok("absoluteExpiresAt_1 is PARTIAL on { theftFenceTarget: null }",
    !!ttl && ttl.partialFilterExpression && ttl.partialFilterExpression.theftFenceTarget === null);

  const pIx = await indexesOf(db, "pendingsecurityactions");
  ok("pendingsecurityactions.deadLetter_1_nextAttemptAt_1 present", !!byName(pIx, "deadLetter_1_nextAttemptAt_1"));
  ok("pendingsecurityactions.leaseUntil_1 present", !!byName(pIx, "leaseUntil_1"));

  // ---- 5) ROLLBACK (documented procedure, pre-session state) ----
  // (a) roll the partial TTL back to a NON-partial TTL, per the ROLLBACK NOTE.
  await db.collection("sessions").dropIndex("absoluteExpiresAt_1");
  await db.collection("sessions").createIndex({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0, name: "absoluteExpiresAt_1" });
  const rolledTtl = (await db.collection("sessions").indexes()).find((i) => i.name === "absoluteExpiresAt_1");
  ok("rollback: TTL is now NON-partial", !!rolledTtl && !rolledTtl.partialFilterExpression);
  // (b) before any session exists, dropping the empty collections is safe.
  await db.collection("sessions").drop();
  await db.collection("pendingsecurityactions").drop().catch(() => {});
  ok("rollback: empty sessions collection dropped", !(await collExists(db, "sessions")));

  // ---- 6) RE-APPLY is idempotent AND restores the partial TTL (replace path) ----
  // Simulate the real-world case where a non-partial TTL is present and must be
  // replaced: recreate sessions with the OLD non-partial TTL, then re-apply.
  await db.collection("sessions").createIndex({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0, name: "absoluteExpiresAt_1" });
  const reapply = runMig(testUri, ["--apply", "--db=" + TEST_DB]);
  ok("re-apply exits 0", reapply.code === 0);
  const ttl2 = (await db.collection("sessions").indexes()).find((i) => i.name === "absoluteExpiresAt_1");
  ok("re-apply REPLACED the non-partial TTL with the partial one",
    !!ttl2 && ttl2.partialFilterExpression && ttl2.partialFilterExpression.theftFenceTarget === null);
  // idempotent second re-apply must not throw or duplicate indexes.
  const reapply2 = runMig(testUri, ["--apply", "--db=" + TEST_DB]);
  ok("second re-apply is idempotent (exit 0)", reapply2.code === 0);
  const names = (await db.collection("sessions").indexes()).map((i) => i.name).sort();
  const uniq = [...new Set(names)];
  ok("no duplicate indexes after repeated apply", names.length === uniq.length);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
