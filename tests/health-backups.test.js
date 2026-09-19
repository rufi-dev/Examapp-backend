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
const { lastNightlyBackup, lastOffsiteBackup, buildAlertsAndScore } = require("../controllers/healthController");

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

/*
 * ---- the OFF-SERVER backup ------------------------------------------------
 * The database and ~10 GB of teacher and student files live on one machine. The
 * nightly copy off it is the difference between a bad day and the end of the
 * platform — and a backup that quietly stopped running is the failure nobody
 * notices until they need it. So the Health page reads that job's own log, and
 * says so out loud when a night did not happen.
 */
const writeOffsite = (text) => fs.writeFileSync(path.join(dir, "offsite.log"), text);
const alertsFor = (offsite) => buildAlertsAndScore({ backups: { offsite } }).alerts.filter((a) => a.service === "Yedəkləmə");

console.log("\nOff-server backup status:");
fs.rmSync(path.join(dir, "offsite.log"), { force: true });
ok("no log -> null, never a fake 'copied off the server'", lastOffsiteBackup() === null);

writeOffsite(
  "2026-09-20 03:15:01 start 20260920-0315\n" +
  "2026-09-20 03:15:41 ok examopia-20260920-0315 verified, measured upload 24.1 MB, repository 9.8 GB\n"
);
const okRun = lastOffsiteBackup();
ok("reads the last OUTCOME, not the progress line", okRun && okRun.state === "ok" && okRun.at === "2026-09-20T03:15:41.000Z");
ok("and reports the MEASURED upload, not an estimate", okRun.upload === "24.1 MB" && okRun.repository === "9.8 GB");
ok("a healthy off-server backup raises no alert", alertsFor(okRun).length === 0);

writeOffsite("2026-09-20 03:15:02 FAILED: newest dump examopia-20260919-0230.archive.gz is 27h old — stale, not treating this as a backup\n");
const failedRun = lastOffsiteBackup();
ok("a failed run is reported as failed, with its reason", failedRun.state === "failed" && /stale/.test(failedRun.detail));
ok("and is CRITICAL on the page — the data is unprotected", alertsFor(failedRun).some((a) => a.severity === "critical"));

writeOffsite("2026-09-20 03:15:01 DEGRADED: continuing with FILES ONLY — the database dump did not pass its checks\n");
ok("a files-only night is not passed off as a backup", alertsFor(lastOffsiteBackup()).some((a) => a.severity === "critical"));

writeOffsite("2026-09-20 03:15:01 SKIPPED: Storage Box not configured yet (STORAGEBOX_HOST/USER empty)\n");
const notSetUp = lastOffsiteBackup();
ok("before a destination exists it is reported...", notSetUp.state === "skipped" && notSetUp.configured === false);
ok("...but does not cry wolf — a plan is not a fault", alertsFor(notSetUp).length === 0);

writeOffsite("2026-09-20 03:15:01 SKIPPED: could not reach the Storage Box\n");
ok("a skip AFTER it is set up IS an alert", alertsFor(lastOffsiteBackup()).some((a) => a.severity === "warning"));

const old = new Date(Date.now() - 50 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
const recent = new Date(Date.now() - 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
writeOffsite(`${old} ok examopia-old verified, measured upload 1.0 MB, repository 9.8 GB\n${recent} start now\n`);
const stale = lastOffsiteBackup();
ok("a run that has not SUCCEEDED in over 36h is stale", stale.ageHours >= 36 && alertsFor(stale).some((a) => a.severity === "warning"));

writeOffsite("nothing here looks like a log line\n");
ok("an unreadable log -> null", lastOffsiteBackup() === null);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} health-backups assertions failed`);
process.exit(0);
