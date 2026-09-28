/*
 * Run EVERY test file, then report.
 *
 * The suite used to be one `&&` chain of 129 commands, which stops at the first
 * failure. On this machine it stopped at file 79 - container-smoke, which needs
 * indexes a Windows dev box does not have - so the last FIFTY files had not run
 * in who knows how long, among them most of the ones guarding exams, plans and
 * storage. The exam-creation path broke in production while its own tests sat
 * downstream of a failure that had nothing to do with it.
 *
 * A suite that hides its own tail cannot tell you anything. This runs all of
 * them, reports each one, and fails at the end if any failed - so a broken file
 * costs you that file, not the rest of the suite.
 *
 *   node tests/run-all.cjs            run everything, summarise
 *   node tests/run-all.cjs --bail     stop at the first failure (the old way)
 *   node tests/run-all.cjs <substr>   run only files matching a substring
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "_manifest.json"), "utf8"));
const args = process.argv.slice(2);
const bail = args.includes("--bail");
const filter = args.find((a) => !a.startsWith("--"));
const files = filter ? manifest.filter((f) => f.includes(filter)) : manifest;

if (!files.length) {
  console.error(`no test files match "${filter}"`);
  process.exit(1);
}

/*
 * A test file that is not in the manifest never runs.
 *
 * That is how fourteen of them - including the one guarding the CLI runner -
 * came to sit on disk for weeks without being executed once: the manifest was
 * transcribed from the old `&&` chain, and anything the chain had already missed
 * stayed missed. A suite that silently ignores its own files is the same failure
 * this runner was written to fix, one level up.
 */
/*
 * Files deliberately not in the suite, and why. A file is either run or listed
 * here with a reason - never simply absent, which is indistinguishable from
 * having been forgotten.
 */
const EXCLUDED = {
  "tests/parentAccounts.rules.test.js":
    "written for vitest, which the backend does not install - so it runs under no runner here at all",
};

function drift() {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.test\.(js|cjs|mjs)$/.test(e.name)) {
        found.push(path.relative(path.join(__dirname, ".."), full).split(path.sep).join("/"));
      }
    }
  };
  walk(__dirname);
  return {
    unlisted: found.filter((f) => !manifest.includes(f) && !EXCLUDED[f]).sort(),
    missing: manifest.filter((f) => !found.includes(f)).sort(),
  };
}

const failures = [];
const started = Date.now();

files.forEach((file, i) => {
  const label = `[${String(i + 1).padStart(3)}/${files.length}] ${file}`;
  const run = spawnSync(process.execPath, [file], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    cwd: path.join(__dirname, ".."),
    env: process.env,
  });
  const out = `${run.stdout || ""}${run.stderr || ""}`;
  if (run.status === 0) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures.push({ file, out });
    if (bail) {
      process.stdout.write(out);
      console.log(`\nstopped at the first failure (--bail)`);
      process.exit(1);
    }
  }
});

const secs = Math.round((Date.now() - started) / 1000);
console.log(`\n${files.length - failures.length}/${files.length} files passed in ${secs}s`);

/* Only on a full run: a filtered run is deliberately partial. */
let drifted = false;
if (!filter) {
  const { unlisted, missing } = drift();
  if (unlisted.length) {
    drifted = true;
    console.log(`\n${unlisted.length} test file(s) exist but are NOT in tests/_manifest.json, so they never run:`);
    for (const f of unlisted) console.log(`    ${f}`);
    console.log("  Add them to the manifest (or delete them if they are dead).");
  }
  if (missing.length) {
    drifted = true;
    console.log(`\n${missing.length} manifest entr(ies) point at a file that is gone:`);
    for (const f of missing) console.log(`    ${f}`);
  }
}

if (failures.length || drifted) {
  if (!failures.length) {
    console.log("\nthe files that ran all passed, but the suite is not running every file.");
    process.exit(1);
  }
}
if (failures.length) {
  console.log(`\n${failures.length} file(s) failed:\n`);
  for (const f of failures) {
    console.log(`──────── ${f.file} ────────`);
    // The tail is where these suites print their own summary and failures.
    const lines = f.out.trimEnd().split("\n");
    console.log(lines.slice(-25).join("\n"));
    console.log("");
  }
  process.exit(1);
}
console.log("every test file passed.");
