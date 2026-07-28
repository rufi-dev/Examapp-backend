"use strict";

const path = require("path");
const { spawn } = require("child_process");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const { MongoClient, ObjectId } = mongoose.mongo;

let passed = 0;
let failed = 0;
function ok(label, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const script = path.join(
  __dirname,
  "..",
  "migrations",
  "2026-07-29-relationship-arrays.js"
);

function run(uri, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, MONGO_URI: uri, ...extraEnv },
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
  const repl = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const dbName = `examopia_migration_relationship_${Date.now()}`;
  const uri = repl.getUri(dbName);
  const client = await MongoClient.connect(uri);
  const db = client.db(dbName);

  try {
    const userId = new ObjectId();
    const classId = new ObjectId();
    const tagId = new ObjectId();
    const examA = new ObjectId();
    const examB = new ObjectId();
    const resultId = new ObjectId();
    await db.collection("users").insertOne({
      _id: userId,
      results: [resultId],
      name: "legacy",
    });
    await db.collection("classes").insertOne({
      _id: classId,
      exams: [examA, examB],
      examCount: 99,
      tag: tagId,
    });
    await db.collection("tags").insertOne({
      _id: tagId,
      exams: [examA],
      classes: [classId],
    });
    await db.collection("exams").insertMany([
      { _id: examA, class: classId, results: [resultId] },
      { _id: examB, class: classId, results: [] },
    ]);

    const before = await db.collection("users").findOne({ _id: userId });
    const collectionsBefore = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((row) => row.name).sort();
    const dry = await run(uri, ["--dry-run"]);
    const collectionsAfter = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((row) => row.name).sort();
    ok("dry-run exits 0", dry.code === 0);
    ok("dry-run is byte-preserving", JSON.stringify(before) === JSON.stringify(
      await db.collection("users").findOne({ _id: userId })
    ));
    ok("dry-run creates no journal collection", JSON.stringify(collectionsBefore) === JSON.stringify(collectionsAfter));

    const missingBatch = await run(uri, ["--apply"]);
    ok("apply without reviewed batch refuses before connecting", missingBatch.code === 2);

    const batch = "relationship-test-a";
    const applied = await run(uri, [`--apply`, `--batch=${batch}`]);
    ok("apply exits 0", applied.code === 0);
    const cleanedUser = await db.collection("users").findOne({ _id: userId });
    const cleanedClass = await db.collection("classes").findOne({ _id: classId });
    const cleanedTag = await db.collection("tags").findOne({ _id: tagId });
    ok("redundant result arrays removed", !("results" in cleanedUser) &&
      !("results" in await db.collection("exams").findOne({ _id: examA })));
    ok("class/tag compatibility arrays removed", !("exams" in cleanedClass) &&
      !("exams" in cleanedTag) && !("classes" in cleanedTag));
    ok("class scalar count derives from authoritative Exam.class", cleanedClass.examCount === 2);
    ok("strict verify passes", (await run(uri, ["--verify", `--batch=${batch}`])).code === 0);
    ok("apply retry is idempotent", (await run(uri, ["--apply", `--batch=${batch}`])).code === 0);

    const rolled = await run(uri, ["--rollback", `--batch=${batch}`]);
    ok("reviewed rollback exits 0", rolled.code === 0);
    const restoredUser = await db.collection("users").findOne({ _id: userId });
    const restoredClass = await db.collection("classes").findOne({ _id: classId });
    ok("rollback restores the exact legacy arrays", restoredUser.results.length === 1 &&
      restoredClass.exams.length === 2 && restoredClass.examCount === 99);
    ok("rollback retry is idempotent", (await run(uri, ["--rollback", `--batch=${batch}`])).code === 0);

    const batch2 = "relationship-test-b";
    const lostResponse = await run(
      uri,
      ["--apply", `--batch=${batch2}`],
      { RELATIONSHIP_ARRAY_FAILPOINT: "after-apply" }
    );
    ok("post-commit response-loss failpoint exits nonzero", lostResponse.code !== 0);
    ok("re-apply converges after response loss", (await run(uri, ["--apply", `--batch=${batch2}`])).code === 0);

    await db.collection("classes").updateOne(
      { _id: classId },
      { $set: { examCount: 77 } }
    );
    const conflict = await run(uri, ["--rollback", `--batch=${batch2}`]);
    ok("foreign post-apply change makes rollback fail closed", conflict.code !== 0);
    ok("failed rollback does not overwrite foreign state",
      (await db.collection("classes").findOne({ _id: classId })).examCount === 77);
  } finally {
    await client.close();
    await repl.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
