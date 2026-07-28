#!/usr/bin/env node
const mongoose = require("mongoose");
const { MongoClient, ObjectId } = mongoose.mongo;

const modes = ["dry-run", "apply", "verify", "rollback"].filter((m) =>
  process.argv.includes(`--${m}`)
);
const arg = (name) => process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
if (modes.length !== 1) {
  console.error("REFUSED: pass exactly one operation");
  process.exit(2);
}
const uri = process.env.MONGO_URI || "";
let parsed;
try { parsed = new URL(uri); } catch {
  console.error("REFUSED: invalid MONGO_URI");
  process.exit(3);
}
const dbName = arg("db") || parsed.pathname.replace(/^\//, "");
if (!/^examopia_(test|e2e|smoke|migration)[-_]/.test(dbName) &&
    arg("db") !== dbName &&
    !process.argv.includes("--force")) {
  console.error(`REFUSED: unapproved database "${dbName}"`);
  process.exit(3);
}
const batch = arg("batch");
if ((modes[0] === "apply" || modes[0] === "rollback") && !batch) {
  console.error(`REFUSED: --${modes[0]} requires --batch`);
  process.exit(4);
}

const answered = (selected) =>
  Array.isArray(selected)
    ? selected.filter((item) => {
        if (item == null) return false;
        if (typeof item !== "object") return String(item).trim() !== "";
        const value = item.answer ?? item.selectedAnswer ?? item.value;
        if (Array.isArray(value)) return value.length > 0;
        if (value && typeof value === "object") return Object.keys(value).length > 0;
        return value !== undefined && value !== null && String(value).trim() !== "";
      }).length
    : 0;

let client;
(async () => {
  client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const results = db.collection("results");
  const journal = db.collection("resultmetricsmigrationjournals");
  const mode = modes[0];
  if (mode === "dry-run") {
    const missing = await results.countDocuments({ answeredCount: { $exists: false } });
    console.log(JSON.stringify({ mode, missing }, null, 2));
    return;
  }
  if (mode === "apply") {
    const cursor = results.find(
      { answeredCount: { $exists: false } },
      { projection: { _id: 1, selectedAnswers: 1 } }
    );
    for await (const row of cursor) {
      const value = answered(row.selectedAnswers);
      const jid = `${row._id}`;
      await journal.updateOne(
        { _id: jid },
        { $setOnInsert: { resultId: row._id, batch, value, state: "planned", createdAt: new Date() } },
        { upsert: true }
      );
      const plan = await journal.findOne({ _id: jid });
      if (plan.batch !== batch || plan.value !== value) throw new Error(`journal conflict ${jid}`);
      const write = await results.updateOne(
        { _id: row._id, answeredCount: { $exists: false } },
        { $set: { answeredCount: value } }
      );
      if (write.modifiedCount !== 1) {
        const current = await results.findOne({ _id: row._id }, { projection: { answeredCount: 1 } });
        if (!current || current.answeredCount !== value) throw new Error(`result conflict ${jid}`);
      }
      await journal.updateOne({ _id: jid, batch }, { $set: { state: "done", completedAt: new Date() } });
    }
  }
  if (mode === "rollback") {
    const unresolved = await journal.countDocuments({ batch, state: { $ne: "done" } });
    if (unresolved) throw new Error(`rollback blocked by ${unresolved} unresolved rows`);
    for await (const plan of journal.find({ batch, state: "done" })) {
      const write = await results.updateOne(
        { _id: new ObjectId(plan.resultId), answeredCount: plan.value },
        { $unset: { answeredCount: "" } }
      );
      if (write.matchedCount !== 1) throw new Error(`rollback conflict ${plan.resultId}`);
      await journal.deleteOne({ _id: plan._id, batch, state: "done" });
    }
  }
  const unresolved = await journal.countDocuments({ state: { $ne: "done" } });
  const missing = await results.countDocuments({ answeredCount: { $exists: false } });
  const ok = mode === "rollback" ? unresolved === 0 : unresolved === 0 && missing === 0;
  console.log(JSON.stringify({ mode, ok, missing, unresolved }, null, 2));
  if (!ok) process.exitCode = 1;
})().catch((error) => {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (client) await client.close().catch(() => {});
});
