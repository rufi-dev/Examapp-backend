/*
 * CR-113/CR-115 — deployment-FAITHFUL offline preparation for the disposable smoke
 * DB. The production boot chain refuses to serve traffic unless a real deploy has
 * ALREADY built the migration-owned indexes offline. This reproduces exactly that
 * offline path on a THROWAWAY database — running the REAL migrations with exact
 * exit-code checks, never a `Model.createIndexes()` shim — then a READ-ONLY verifier
 * asserts the exact index shapes the server asserts on boot:
 *   1. session-collection migration       --apply  (sessions + outbox indexes)
 *   2. token-indexes migration            --apply  (aud008_* token indexes)
 *   3. canonical-email migration           --apply  (exact unique email_1) *
 *   4. attempt-result-indexes migration    --apply  (Attempt/Result unique + perf) then
 *      the SAME migration                   --verify (exact shapes, read-only)
 *   5. verifySmokeDb (read-only)                    (aggregate startup postconditions)
 *
 *   * canonical-email builds email_1 only when the users collection exists (a real
 *     deploy always has users), so we first seed ONE throwaway user — deployment
 *     faithful, not an index shim.
 *
 * Refuses to touch a non-throwaway db name (fail-closed, exit 3). NEVER contacts prod.
 */
const path = require("path");
const { spawnSync } = require("child_process");
const mongoose = require("mongoose");

const isThrowaway = (n) => /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral|smoke)($|[_-])/i.test(n);
function dbName(uri) { try { const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://")); return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || ""; } catch { return ""; } }

const BE = path.join(__dirname, "..");
const SESSION_MIG = path.join(BE, "migrations", "2026-07-25-session-collection.js");
const TOKEN_MIG = path.join(BE, "migrations", "2026-07-26-token-indexes.js");
const EMAIL_MIG = path.join(BE, "migrations", "2026-07-26-canonical-email.js");
const ATTEMPT_RESULT_MIG = path.join(BE, "migrations", "2026-07-27-attempt-result-indexes.js");
const RELIABILITY_MIG = path.join(BE, "migrations", "2026-07-27-reliability-indexes.js");
const VERIFY = path.join(BE, "scripts", "verifySmokeDb.cjs");

// Run a step and REQUIRE the EXACT exit code (default 0). On any other code, print
// the captured output and abort — an ambiguous status is never treated as success.
function step(label, file, args, uri, { expect = 0, env = {} } = {}) {
  const r = spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8", timeout: 90000, env: { ...process.env, MONGO_URI: uri, EMAIL_ENABLED: "false", ...env },
  });
  if (r.status !== expect) {
    console.error(`prepareSmokeDb: ${label} expected exit ${expect} but got ${r.status}.\n${r.stdout || ""}${r.stderr || ""}`);
    process.exit(1);
  }
  console.log(`  ✓ ${label} (exit ${r.status})`);
}

(async () => {
  const uri = process.env.MONGO_URI || "";
  const name = dbName(uri);
  if (!name || !isThrowaway(name)) { console.error(`prepareSmokeDb: refusing non-throwaway db "${name}".`); process.exit(3); }

  // Seed ONE throwaway user so the canonical-email migration takes its real
  // index-building path (it skips email_1 when the users collection is absent).
  // Idempotent (upsert): a second preparation of the same throwaway db must not
  // trip the unique email_1 index built by the first run.
  await mongoose.connect(uri);
  await mongoose.connection.db.collection("users").updateOne(
    { email: "smoke.seed@example.test" },
    { $setOnInsert: { email: "smoke.seed@example.test", password: "x", role: "student", createdAt: new Date() } },
    { upsert: true }
  );
  await mongoose.disconnect();

  // Real migrations, each with an EXACT exit-code check.
  step("session-collection --apply", SESSION_MIG, ["--apply", `--db=${name}`], uri);
  step("token-indexes --apply", TOKEN_MIG, ["--apply", `--db=${name}`], uri);
  step("canonical-email --apply", EMAIL_MIG, ["--apply", `--db=${name}`], uri);
  step("attempt-result-indexes --apply", ATTEMPT_RESULT_MIG, ["--apply", `--db=${name}`], uri);
  // Migration-owned read-only VERIFY of its own exact shapes (exit 1 on any mismatch).
  step("attempt-result-indexes --verify", ATTEMPT_RESULT_MIG, ["--verify", `--db=${name}`], uri);
  step("reliability-indexes --apply", RELIABILITY_MIG, ["--apply", `--db=${name}`], uri);
  step("reliability-indexes --verify", RELIABILITY_MIG, ["--verify", `--db=${name}`], uri);

  // Aggregate read-only verifier — ALL startup postconditions present before boot.
  step("verifySmokeDb (read-only)", VERIFY, [], uri);

  console.log("prepareSmokeDb: migration-faithful preparation complete.");
  process.exit(0);
})().catch((e) => { console.error("prepareSmokeDb failed:", e && e.message); process.exit(1); });
