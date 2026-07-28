/*
 * AUD-002 Gate 4a — the fail-closed guard for the disposable-DB E2E launcher.
 * Pure-function test (no DB, no network): proves the launcher refuses to run E2E
 * against anything that is not provably a throwaway, loopback, ephemeral database.
 */
const { assertDisposable, looksProduction, throwawayDbName } = require("../scripts/e2eDisposable.cjs");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

// ---- throwawayDbName ----
ok("throwaway names accepted", ["exq_e2e_test", "scratch_db", "app_memory", "ci-run", "ephemeral_1", "tests"].every(throwawayDbName));
ok("production-ish names rejected", ["examopia_prod", "examopia", "app", "production", "main"].every((n) => !throwawayDbName(n)));

// ---- looksProduction ----
ok("SRV/Atlas URI looks production", looksProduction("mongodb+srv://u:p@cluster0.abcde.mongodb.net/examopia"));
ok("remote host looks production", looksProduction("mongodb://db.internal.example.com:27017/exq_e2e_test"));
ok("Atlas host looks production", looksProduction("mongodb://cluster0-shard-00-00.abcde.mongodb.net:27017/x_test"));
ok("loopback does NOT look production", !looksProduction("mongodb://127.0.0.1:38912/exq_e2e_test"));
ok("localhost does NOT look production", !looksProduction("mongodb://localhost:38912/exq_e2e_test"));
ok("unparseable looks production (fail closed)", looksProduction("not a uri"));

// ---- assertDisposable: accept ----
const good = "mongodb://127.0.0.1:38912/exq_e2e_ephemeral";
ok("accepts a loopback throwaway ephemeral URI", (() => {
  const t = assertDisposable(good, { prodUri: "mongodb+srv://u:p@cluster0.abcde.mongodb.net/examopia" });
  return t.host === "127.0.0.1" && t.db === "exq_e2e_ephemeral";
})());

// ---- assertDisposable: refuse ----
ok("refuses an empty URI", throws(() => assertDisposable("", {}), /no disposable MONGO_URI/i));
ok("refuses an SRV/Atlas target", throws(() => assertDisposable("mongodb+srv://u:p@cluster0.abcde.mongodb.net/x_test", {}), /looks like production/i));
ok("refuses a remote host", throws(() => assertDisposable("mongodb://db.prod.example.com:27017/x_test", {}), /looks like production/i));
ok("refuses a loopback but NON-throwaway db name", throws(() => assertDisposable("mongodb://127.0.0.1:27017/examopia_prod", {}), /not recognizably throwaway/i));
ok("refuses when target host+db equals the configured production DB",
  throws(() => assertDisposable("mongodb://127.0.0.1:27017/exq_test", { prodUri: "mongodb://127.0.0.1:27017/exq_test" }), /equals the configured production DB/i));
ok("accepts loopback throwaway even if prod is also loopback but a DIFFERENT db",
  !throws(() => assertDisposable("mongodb://127.0.0.1:27017/exq_e2e_test", { prodUri: "mongodb://127.0.0.1:27017/examopia_prod" })));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
