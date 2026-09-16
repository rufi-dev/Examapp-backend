/*
 * The Health page's "Ehtiyat nüsxə" row reads the nightly backup's own log.
 * A static "backups run nightly" note cannot say the night it stopped; this can.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exq-backup-log-"));
process.env.BACKUP_LOG_DIR = dir;
const { lastNightlyBackup } = require("../controllers/healthController");

let passed = 0;
let failed = 0;
const ok = (name, cond) => {
  if (cond) { passed += 1; console.log("  ✓", name); } else { failed += 1; console.log("  ✗ FAIL:", name); }
};
const write = (text) => {
  fs.mkdirSync(path.join(dir, "nightly"), { recursive: true });
  fs.writeFileSync(path.join(dir, "nightly", "backup.log"), text);
};

console.log("\nNightly backup status:");
ok("no log reachable -> null, never a fake 'backed up'", lastNightlyBackup() === null);

write("2026-09-15 02:30:03 ok examopia-20260915-0230.archive.gz 19M\n2026-09-16 17:18:51 ok examopia-20260916-1718.archive.gz 20M\n");
const good = lastNightlyBackup();
ok("reads the LAST run", good && good.at === "2026-09-16T17:18:51.000Z");
ok("a successful run is ok with its file and size", good.ok === true && good.file === "examopia-20260916-1718.archive.gz" && good.size === "20M");
ok("and counts the runs on record", good.runs === 2);

write("2026-09-16 17:18:51 ok examopia-20260916-1718.archive.gz 20M\n2026-09-17 02:30:04 FAILED: empty dump\n");
const bad = lastNightlyBackup();
ok("a failed last run is reported as failed", bad && bad.ok === false && bad.at === "2026-09-17T02:30:04.000Z");
ok("with no file or size claimed", bad.file === null && bad.size === null);

write("garbage that is not a log line\n");
ok("an unreadable line -> null", lastNightlyBackup() === null);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} health-backups assertions failed`);
process.exit(0);
