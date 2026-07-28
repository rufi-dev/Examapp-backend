#!/usr/bin/env node
"use strict";

/*
 * AUD-011 relationship-array reconciliation.
 *
 * Authoritative edges:
 *   Result.userId / Result.examId  (not User.results / Exam.results)
 *   Exam.class                     (not Class.exams)
 *   Class.tag                      (not Tag.classes / Tag.exams)
 *
 * Usage:
 *   --dry-run
 *   --apply --batch=<reviewed-id>
 *   --verify [--batch=<id>]
 *   --rollback --batch=<reviewed-id>
 *
 * Dry-run and every refusal are read-only. Apply/rollback are per-row
 * transactions with an exact before/after CAS and a durable journal, so a
 * response loss or a second worker is idempotent while a foreign concurrent
 * edit fails closed.
 */

const mongoose = require("mongoose");

const JOURNAL = "relationshiparrayjournals";
const MODES = ["dry-run", "apply", "verify", "rollback"].filter((mode) =>
  process.argv.includes(`--${mode}`)
);
const valueArg = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};
const batch = valueArg("batch");
const failpoint = process.env.RELATIONSHIP_ARRAY_FAILPOINT || "";

function refuse(message, code = 2) {
  console.error(`REFUSED: ${message}`);
  process.exit(code);
}

if (MODES.length !== 1) refuse("pass exactly one operation mode");
if (["apply", "rollback"].includes(MODES[0]) && !batch) {
  refuse(`${MODES[0]} requires --batch=<reviewed-id>`);
}
if (batch && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(batch)) {
  refuse("batch must be a bounded safe identifier");
}

const uri = process.env.MONGO_URI || "";
let parsed;
try {
  parsed = new URL(uri);
} catch {
  refuse("invalid MONGO_URI", 3);
}
const dbName = valueArg("db") || parsed.pathname.replace(/^\//, "");
const approved = /^examopia_(test|e2e|smoke|migration)[-_]/.test(dbName);
if (!approved && valueArg("db") !== dbName && !process.argv.includes("--force")) {
  refuse(`unapproved database "${dbName}"`, 3);
}

const FIELD_SPECS = {
  users: ["results"],
  exams: ["results"],
  classes: ["exams"],
  tags: ["exams", "classes"],
};

const same = (left, right) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function presentArray(doc, field) {
  return Array.isArray(doc?.[field]) ? doc[field] : [];
}

function beforeFor(collection, doc) {
  const before = {};
  for (const field of FIELD_SPECS[collection]) {
    if (Object.prototype.hasOwnProperty.call(doc, field)) before[field] = doc[field];
  }
  if (collection === "classes" && Object.prototype.hasOwnProperty.call(doc, "examCount")) {
    before.examCount = doc.examCount;
  }
  return before;
}

function exactFieldFilter(before, field) {
  return Object.prototype.hasOwnProperty.call(before, field)
    ? before[field]
    : { $exists: false };
}

function exactBeforeFilter(journal) {
  const filter = { _id: journal.entityId };
  for (const field of FIELD_SPECS[journal.collection]) {
    filter[field] = exactFieldFilter(journal.before, field);
  }
  if (journal.collection === "classes") {
    filter.examCount = exactFieldFilter(journal.before, "examCount");
  }
  return filter;
}

function exactAfterFilter(journal) {
  const filter = { _id: journal.entityId };
  for (const field of FIELD_SPECS[journal.collection]) {
    filter[field] = { $exists: false };
  }
  if (journal.collection === "classes") filter.examCount = journal.after.examCount;
  return filter;
}

function afterMatches(journal, doc) {
  if (!doc) return false;
  if (
    FIELD_SPECS[journal.collection].some((field) =>
      Object.prototype.hasOwnProperty.call(doc, field)
    )
  ) return false;
  return journal.collection !== "classes" ||
    Number(doc.examCount || 0) === Number(journal.after.examCount || 0);
}

async function classCount(db, classId, session = null) {
  return db.collection("exams").countDocuments(
    { class: classId, purgedAt: { $exists: false } },
    session ? { session } : {}
  );
}

async function census(db) {
  const rows = [];
  for (const [collection, fields] of Object.entries(FIELD_SPECS)) {
    const exists = await db.listCollections({ name: collection }, { nameOnly: true }).hasNext();
    if (!exists) continue;
    const clauses = fields.map((field) => ({ [`${field}.0`]: { $exists: true } }));
    if (collection === "classes") {
      const docs = await db.collection(collection).find({}).toArray();
      for (const doc of docs) {
        const count = await classCount(db, doc._id);
        if (clauses.some((clause) => presentArray(doc, Object.keys(clause)[0].slice(0, -2)).length) ||
            Number(doc.examCount || 0) !== count) {
          rows.push({ collection, doc, classExamCount: count });
        }
      }
      continue;
    }
    for await (const doc of db.collection(collection).find({ $or: clauses })) {
      rows.push({ collection, doc });
    }
  }
  return rows;
}

async function verifyState(db, verifyBatch = null) {
  const failures = [];
  for (const [collection, fields] of Object.entries(FIELD_SPECS)) {
    const exists = await db.listCollections({ name: collection }, { nameOnly: true }).hasNext();
    if (!exists) continue;
    for (const field of fields) {
      const count = await db.collection(collection).countDocuments({ [`${field}.0`]: { $exists: true } });
      if (count) failures.push(`${collection}.${field}:nonempty=${count}`);
    }
  }
  if (await db.listCollections({ name: "classes" }, { nameOnly: true }).hasNext()) {
    for await (const klass of db.collection("classes").find({}, { projection: { examCount: 1 } })) {
      const count = await classCount(db, klass._id);
      if (Number(klass.examCount || 0) !== count) {
        failures.push(`classes.${klass._id}:examCount=${klass.examCount || 0},actual=${count}`);
      }
    }
  }
  const journalExists = await db.listCollections({ name: JOURNAL }, { nameOnly: true }).hasNext();
  if (journalExists) {
    const filter = verifyBatch ? { batch: verifyBatch } : { state: { $nin: ["applied", "rolled_back"] } };
    for await (const row of db.collection(JOURNAL).find(filter)) {
      if (!["applied", "rolled_back"].includes(row.state)) {
        failures.push(`journal.${row._id}:state=${row.state}`);
        continue;
      }
      const doc = await db.collection(row.collection).findOne({ _id: row.entityId });
      if (row.state === "applied" && !afterMatches(row, doc)) {
        failures.push(`journal.${row._id}:applied_postcondition`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

async function ensureJournal(db, row) {
  const _id = `${batch}:${row.collection}:${row.doc._id}`;
  const after = row.collection === "classes" ? { examCount: row.classExamCount } : {};
  try {
    await db.collection(JOURNAL).updateOne(
      { _id },
      {
        $setOnInsert: {
          _id,
          batch,
          collection: row.collection,
          entityId: row.doc._id,
          before: beforeFor(row.collection, row.doc),
          after,
          state: "planned",
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  return db.collection(JOURNAL).findOne({ _id });
}

async function applyRow(db, row) {
  const journal = await ensureJournal(db, row);
  if (journal.batch !== batch) throw new Error(`foreign journal ${journal._id}`);
  if (journal.state === "applied") return;
  if (failpoint === "after-journal") throw new Error("FAILPOINT after-journal");
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const currentJournal = await db.collection(JOURNAL).findOne(
        { _id: journal._id },
        { session }
      );
      if (currentJournal.state === "applied") return;
      const update = {
        $unset: Object.fromEntries(
          FIELD_SPECS[row.collection].map((field) => [field, ""])
        ),
      };
      if (row.collection === "classes") {
        update.$set = { examCount: journal.after.examCount };
      }
      const changed = await db.collection(row.collection).updateOne(
        exactBeforeFilter(journal),
        update,
        { session }
      );
      if (changed.matchedCount !== 1) {
        const current = await db.collection(row.collection).findOne(
          { _id: journal.entityId },
          { session }
        );
        if (!afterMatches(journal, current)) {
          throw new Error(`concurrent relationship change ${journal._id}`);
        }
      }
      await db.collection(JOURNAL).updateOne(
        { _id: journal._id, state: "planned" },
        { $set: { state: "applied", appliedAt: new Date() } },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }
  if (failpoint === "after-apply") throw new Error("FAILPOINT after-apply");
}

async function rollbackBatch(db) {
  const exists = await db.listCollections({ name: JOURNAL }, { nameOnly: true }).hasNext();
  if (!exists) return;
  const rows = await db.collection(JOURNAL).find({ batch }).toArray();
  for (const row of rows) {
    if (row.state === "rolled_back") continue;
    if (row.state !== "applied") throw new Error(`unresolved journal ${row._id}`);
    const current = await db.collection(row.collection).findOne({ _id: row.entityId });
    if (!afterMatches(row, current)) throw new Error(`rollback conflict ${row._id}`);
  }
  for (const row of rows) {
    if (row.state === "rolled_back") continue;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const set = {};
        const unset = {};
        for (const field of [...FIELD_SPECS[row.collection], "examCount"]) {
          if (Object.prototype.hasOwnProperty.call(row.before, field)) set[field] = row.before[field];
          else unset[field] = "";
        }
        const update = {};
        if (Object.keys(set).length) update.$set = set;
        if (Object.keys(unset).length) update.$unset = unset;
        const restored = await db.collection(row.collection).updateOne(
          exactAfterFilter(row),
          update,
          { session }
        );
        if (restored.matchedCount !== 1) throw new Error(`rollback CAS lost ${row._id}`);
        if (failpoint === "rollback-after-restore") {
          throw new Error("FAILPOINT rollback-after-restore");
        }
        await db.collection(JOURNAL).updateOne(
          { _id: row._id, state: "applied" },
          { $set: { state: "rolled_back", rolledBackAt: new Date() } },
          { session }
        );
      });
    } finally {
      await session.endSession();
    }
  }
}

(async () => {
  await mongoose.connect(uri, { dbName });
  const db = mongoose.connection.db;
  const mode = MODES[0];
  if (mode === "dry-run") {
    const rows = await census(db);
    console.log(JSON.stringify({
      mode,
      rows: rows.length,
      byCollection: rows.reduce((out, row) => {
        out[row.collection] = (out[row.collection] || 0) + 1;
        return out;
      }, {}),
    }));
    return;
  }
  if (mode === "apply") {
    const rows = await census(db);
    for (const row of rows) await applyRow(db, row);
    // Resume rows that committed before a lost response.
    const journals = await db.collection(JOURNAL).find({ batch, state: "planned" }).toArray();
    for (const journal of journals) {
      const doc = await db.collection(journal.collection).findOne({ _id: journal.entityId });
      await applyRow(db, {
        collection: journal.collection,
        doc,
        classExamCount: journal.after.examCount,
      });
    }
  } else if (mode === "rollback") {
    await rollbackBatch(db);
  }
  let verified;
  if (mode === "rollback") {
    const failures = [];
    const rows = await db.collection(JOURNAL).find({ batch }).toArray();
    for (const row of rows) {
      const current = await db.collection(row.collection).findOne({ _id: row.entityId });
      if (row.state !== "rolled_back") failures.push(`journal.${row._id}:not_rolled_back`);
      for (const field of [...FIELD_SPECS[row.collection], "examCount"]) {
        const expectedPresent = Object.prototype.hasOwnProperty.call(row.before, field);
        if (expectedPresent ? !same(current?.[field], row.before[field])
          : Object.prototype.hasOwnProperty.call(current || {}, field)) {
          failures.push(`journal.${row._id}:${field}_restore_mismatch`);
        }
      }
    }
    verified = { ok: failures.length === 0, failures };
  } else {
    verified = await verifyState(db, batch || null);
  }
  console.log(JSON.stringify({ mode, batch: batch || null, ...verified }));
  if (!verified.ok) process.exitCode = 1;
})()
  .catch((error) => {
    console.error(`FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });

module.exports = { FIELD_SPECS, verifyState, beforeFor, afterMatches };
