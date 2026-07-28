"use strict";

const path = require("path");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0;
let failed = 0;
const ok = (label, condition) => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
};
const script = path.join(
  __dirname,
  "..",
  "migrations",
  "2026-07-27-result-metrics.js"
);

function run(uri, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, MONGO_URI: uri },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const mem = await MongoMemoryServer.create();
  const dbName = `examopia_migration_metrics_${Date.now()}`;
  const uri = mem.getUri(dbName);
  const client = await mongoose.mongo.MongoClient.connect(uri);
  const db = client.db(dbName);
  try {
    const id = new mongoose.Types.ObjectId();
    await db.collection("results").insertOne({
      _id: id,
      attempts: 42,
      selectedAnswers: [
        { answer: "A" },
        { answer: "" },
        { answer: [1, 2] },
        { answer: null },
        { answer: { left: "right" } },
      ],
    });
    const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((row) => row.name).sort();
    ok("apply requires an explicit batch",
      (await run(uri, ["--apply"])).code === 4);
    ok("dry-run exits 0", (await run(uri, ["--dry-run"])).code === 0);
    ok("dry-run creates no journal",
      JSON.stringify(collections) === JSON.stringify(
        (await db.listCollections({}, { nameOnly: true }).toArray())
          .map((row) => row.name).sort()
      ));
    const batch = "result-metrics-test";
    ok("apply exits 0", (await run(uri, ["--apply", `--batch=${batch}`])).code === 0);
    const applied = await db.collection("results").findOne({ _id: id });
    ok("answeredCount derives from the frozen answer snapshot", applied.answeredCount === 3);
    ok("legacy attempts is not reinterpreted as an ordinal",
      !Object.prototype.hasOwnProperty.call(applied, "attemptOrdinal"));
    ok("apply retry is idempotent",
      (await run(uri, ["--apply", `--batch=${batch}`])).code === 0);
    ok("strict verify passes", (await run(uri, ["--verify"])).code === 0);
    ok("rollback exits 0",
      (await run(uri, ["--rollback", `--batch=${batch}`])).code === 0);
    const restored = await db.collection("results").findOne({ _id: id });
    ok("rollback removes only the migration-owned metric",
      !Object.prototype.hasOwnProperty.call(restored, "answeredCount") &&
      restored.attempts === 42);
  } finally {
    await client.close();
    await mem.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
