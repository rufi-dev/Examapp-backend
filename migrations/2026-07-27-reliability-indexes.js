#!/usr/bin/env node
const mongoose = require("mongoose");
const { SPECS, verifyReliabilityIndexes } = require("../helper/reliabilityIndexes");

function arg(name) {
  const p = `--${name}=`;
  return process.argv.find((x) => x.startsWith(p))?.slice(p.length);
}
const modes = ["dry-run", "apply", "verify"].filter((m) => process.argv.includes(`--${m}`));
if (modes.length !== 1) {
  console.error("REFUSED: pass exactly one of --dry-run, --apply, --verify");
  process.exit(2);
}
const uri = process.env.MONGO_URI || "";
let dbName = arg("db");
try {
  const parsed = new URL(uri);
  dbName ||= parsed.pathname.replace(/^\//, "");
} catch {
  console.error("REFUSED: invalid MONGO_URI");
  process.exit(3);
}
const approved = /^examopia_(test|e2e|smoke|migration)[-_]/.test(dbName || "");
if (!approved && arg("db") !== dbName && !process.argv.includes("--force")) {
  console.error(`REFUSED: unapproved database "${dbName}"`);
  process.exit(3);
}

(async () => {
  await mongoose.connect(uri, { dbName });
  const db = mongoose.connection.db;
  if (modes[0] === "dry-run") {
    const current = await verifyReliabilityIndexes(db);
    console.log(JSON.stringify({ mode: "dry-run", current, required: SPECS }, null, 2));
    return;
  }
  if (modes[0] === "apply") {
    for (const spec of SPECS) {
      const exists = await db.listCollections({ name: spec.collection }, { nameOnly: true }).hasNext();
      if (!exists) await db.createCollection(spec.collection);
      const current = await db.collection(spec.collection).indexes();
      const named = current.find((i) => i.name === spec.name);
      if (named) {
        const { shapeReason } = require("../helper/reliabilityIndexes");
        const reason = shapeReason(spec, named);
        if (reason) {
          if (!process.argv.includes("--replace-index")) {
            throw new Error(
              `${spec.collection}.${spec.name}:${reason}; rerun reviewed apply with --replace-index`
            );
          }
          await db.collection(spec.collection).dropIndex(spec.name);
          await db.collection(spec.collection).createIndex(spec.key, spec.options);
        }
      } else {
        await db.collection(spec.collection).createIndex(spec.key, spec.options);
      }
    }
  }
  const verified = await verifyReliabilityIndexes(db);
  console.log(JSON.stringify({ mode: modes[0], ...verified }, null, 2));
  if (!verified.ok) process.exitCode = 1;
})()
  .catch((error) => {
    console.error("FAILED:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
