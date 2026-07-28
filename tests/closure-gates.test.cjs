"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const tests = [
  "error-contract.test.js",
  "teacher-overview-contract.test.js",
  "transaction-boundaries.test.js",
  "pagination-contract.test.js",
  "reliability-contract.test.js",
  "reliability-worker.test.js",
  "relationship-arrays-migration.test.js",
  "result-metrics-migration.test.js",
  "dead-path-scan.test.js",
];

for (const relative of tests) {
  const file = path.join(__dirname, relative);
  const result = spawnSync(process.execPath, [file], {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error(`Closure gate failed: ${relative}`);
    process.exit(result.status || 1);
  }
}

console.log(`\nClosure gates: ${tests.length} suites passed`);
