/*
 * Teacher Success Journey — migration-owned OFFLINE build of the Journey index
 * contract + a conservative existing-teacher Spark backfill (ADR §11.4; CR-128/CR-129).
 * Builds NATIVELY from the SHARED contract (helper/teacherSuccessIndexes) — the
 * single source also used by production startup — never Model.createIndexes().
 *
 *   node migrations/2026-07-27-teacher-success.js --dry-run [--db=<name>]                 (read-only census)
 *   node migrations/2026-07-27-teacher-success.js --apply    --db=<name> --batch=<tag>    (journaled, resumable)
 *   node migrations/2026-07-27-teacher-success.js --verify   --db=<name>                  (contract + JOURNAL check)
 *   node migrations/2026-07-27-teacher-success.js --rollback --db=<name> --batch=<tag>    (before-image, conflict-safe)
 *
 * CR-129 guarantees:
 *  - EVERY refused mode exits 3 (unsafe target) BEFORE connecting, or 2 (usage).
 *  - --apply/--rollback REQUIRE --batch. Apply preflights EVERY unique index for
 *    duplicate-key collisions + wrong-shape conflicts and refuses before writing.
 *  - Per-INDEX intent is journaled BEFORE create (with the exact pre-state), so a
 *    crash in the create→ownership window is reconciled on resume and rollback
 *    drops ONLY indexes this batch actually created AND whose live shape is still
 *    exactly the contract (an external replacement is a retained conflict).
 *  - Per-USER BEFORE-IMAGE is journaled: rollback reverts a backfilled teacher
 *    ONLY while their current state still equals what THIS migration wrote; a
 *    later promotion/correction is PRESERVED and reported as a retained conflict.
 *    Pre-existing levelVersion/levelSince/levelSource are restored exactly.
 *  - --verify scans the journal and exits nonzero for any planned/in-progress/
 *    incomplete apply or in-progress/conflicting rollback row.
 *  - The journal is deleted ONLY after every owned index/user reaches its verified
 *    rollback postcondition.
 *  - Failpoints (TSJ_MIG_FAILPOINT) abort after each durable phase for recovery tests.
 * Exit codes: 0 success, 1 verify/dirty/conflict, 2 usage, 3 refused, 97 failpoint.
 */
const mongoose = require("mongoose");
const { INDEXES, collectionsOf, specsFor, buildArgs, verifyTeacherSuccessIndexes, shapeReason } = require("../helper/teacherSuccessIndexes");

const JOURNAL = "_tsj_migration_journal";        // _id: batch — overall + per-index intents
const BACKFILL = "_tsj_backfill_journal";        // unique {batch,userId} — per-user before-image
const BACKFILL_FIELDS = ["teacherLevel", "levelVersion", "levelSince", "levelSource"]; // the ONLY user fields the backfill may write
const FP = process.env.TSJ_MIG_FAILPOINT || "";
function failpoint(name) { if (FP === name) { console.error(`[FAILPOINT] aborting at "${name}".`); process.exit(97); } }

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const modeFlags = ["--dry-run", "--apply", "--verify", "--rollback"].filter(has);
if (modeFlags.length > 1) { console.error(`\nREFUSED: contradictory modes ${modeFlags.join(" ")}.\n`); process.exit(2); }
const APPLY = has("--apply"), VERIFY = has("--verify"), ROLLBACK = has("--rollback");
const DRY = !APPLY && !VERIFY && !ROLLBACK;
const FORCE = has("--force");
const dbArg = (argv.find((a) => a.startsWith("--db=")) || "").split("=")[1] || "";
const batch = (argv.find((a) => a.startsWith("--batch=")) || "").split("=")[1] || "";

function dbNameFromUri(uri) { try { const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://")); return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || ""; } catch (_) { return ""; } }
const isThrowaway = (n) => /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral|smoke|preview)($|[_-])/i.test(n);
const listed = async (db, coll) => ((await db.listCollections({ name: coll }, { nameOnly: true }).toArray()).length > 0);
const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function teachersMissingLevel(db) { return (await listed(db, "users")) ? db.collection("users").countDocuments({ role: "teacher", teacherLevel: { $exists: false } }) : 0; }

async function conflicts(db) {
  const v = await verifyTeacherSuccessIndexes(db);
  return v.failures.filter((f) => f.reason !== "absent" && f.reason !== "collection_missing").map((f) => `${f.collection}.${f.name}: ${f.reason}`);
}
async function uniqueCollisions(db) {
  const out = [];
  for (const spec of INDEXES.filter((i) => i.unique)) {
    if (!(await listed(db, spec.collection))) continue;
    const groupId = {}; for (const k of Object.keys(spec.key)) groupId[k.replace(/\./g, "_")] = `$${k}`;
    const pipeline = []; if (spec.partialFilterExpression) pipeline.push({ $match: spec.partialFilterExpression });
    pipeline.push({ $group: { _id: groupId, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: "d" });
    const r = await db.collection(spec.collection).aggregate(pipeline).toArray();
    if (r.length && r[0].d) out.push(`${spec.collection}.${spec.name}: ${r[0].d} duplicate-key collision(s)`);
  }
  return out;
}

// Exact live shape of a contract index, classified against the contract spec.
async function classifyIndex(db, spec) {
  if (!(await listed(db, spec.collection))) return "absent";
  const got = (await db.collection(spec.collection).indexes()).find((i) => i.name === spec.name);
  if (!got) return "absent";
  return shapeReason(spec, got) === null ? "present-exact" : "present-wrong";
}

// The user fields this migration would/did write, snapshotted (before-image). Only
// PRESENT fields are stored — an absent field must stay absent in the snapshot (the
// driver would serialize `undefined` as null, which rollback would wrongly re-set).
function snapshotUser(u) {
  const snap = {};
  for (const f of BACKFILL_FIELDS) if (Object.prototype.hasOwnProperty.call(u, f)) snap[f] = u[f];
  return snap;
}
const isDup = (e) => e && (e.code === 11000 || e.code === 11001);
// Does the user's CURRENT state exactly match `after` on every field the backfill wrote?
function stateEquals(u, after) {
  for (const f of Object.keys(after)) { if (!jeq(u[f], after[f])) return false; }
  return true;
}
// Has the user already been restored to the exact BEFORE-image (idempotent rollback resume)?
function matchesBefore(u, before) {
  for (const f of BACKFILL_FIELDS) { if (!jeq(Object.prototype.hasOwnProperty.call(u, f) ? u[f] : undefined, before[f])) return false; }
  return true;
}

// ── journal scan for --verify (CR-129#1) ──
async function journalIssues(db) {
  const issues = [];
  if (await listed(db, JOURNAL)) {
    for (const j of await db.collection(JOURNAL).find({}).toArray()) {
      if (j.rollbackStartedAt && !j.rollbackCompletedAt) issues.push(`rollback batch "${j.batch}" in progress`);
      else if (!j.completedAt) issues.push(`apply batch "${j.batch}" incomplete/planned`);
      for (const idx of j.indexes || []) if (!idx.done) issues.push(`index intent ${idx.collection}.${idx.name} (batch ${j.batch}) not done`);
    }
  }
  if (await listed(db, BACKFILL)) {
    const undone = await db.collection(BACKFILL).countDocuments({ done: { $ne: true } });
    if (undone) issues.push(`${undone} backfill row(s) not done`);
    const conf = await db.collection(BACKFILL).countDocuments({ conflict: true });
    if (conf) issues.push(`${conf} retained rollback conflict(s)`);
  }
  return issues;
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }
  const dbName = dbNameFromUri(uri);
  if (!dbName) { console.log("Could not parse a database NAME; refusing to contact any DB."); process.exit(3); }
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;

  console.log(`\nTeacher Success migration — ${VERIFY ? "VERIFY (read-only)" : APPLY ? "APPLY" : ROLLBACK ? "ROLLBACK" : "DRY RUN"}`);
  console.log(`  database: ${dbName}${batch ? ` · batch=${batch}` : ""}`);
  if (!safe) {
    console.log(`\n  Refusing: "${dbName}" is not a recognizably throwaway NAME and no matching --db=${dbName} was given.`);
    console.log("  This run did NOT contact the database. Pass --db=<exact-name> or --force to proceed.\n");
    process.exit(3);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const jcoll = db.collection(JOURNAL);
  const bcoll = db.collection(BACKFILL);

  if (DRY) {
    const miss = await teachersMissingLevel(db);
    const uc = await uniqueCollisions(db); const cf = await conflicts(db);
    console.log(`  census: teachers missing level=${miss}`);
    console.log(`  unique-index collisions: ${uc.length ? uc.join("; ") : "(none)"}`);
    console.log(`  existing-index conflicts: ${cf.length ? cf.join("; ") : "(none)"}`);
    const v = await verifyTeacherSuccessIndexes(db);
    console.log(`  contract: ${v.ok ? "already satisfied" : "would build/repair"}`);
    await mongoose.disconnect();
    console.log("\nDRY RUN complete — READ ONLY (no write).\n");
    process.exit(0);
  }

  if (VERIFY) {
    const v = await verifyTeacherSuccessIndexes(db);
    const issues = await journalIssues(db);
    await mongoose.disconnect();
    if (!v.ok || issues.length) {
      console.error(`\nVERIFY FAILED:${v.ok ? "" : "\n  index contract: " + v.failures.map((f) => `${f.collection}.${f.name}:${f.reason}`).join(", ")}${issues.length ? "\n  journal: " + issues.join("; ") : ""}\n`);
      process.exit(1);
    }
    console.log("\nVERIFY — exact index contract satisfied + journal clean.\n");
    process.exit(0);
  }

  if (ROLLBACK) {
    if (!batch) { console.error("\nROLLBACK REFUSED — --batch=<tag> required.\n"); await mongoose.disconnect(); process.exit(2); }
    const j = (await listed(db, JOURNAL)) ? await jcoll.findOne({ _id: batch }) : null;
    if (!j) { await mongoose.disconnect(); console.log(`\nROLLBACK: no journal for batch "${batch}"; nothing owned (no change).\n`); process.exit(0); }
    await jcoll.updateOne({ _id: batch }, { $set: { rollbackStartedAt: j.rollbackStartedAt || new Date() } });

    let reverted = 0, preserved = 0;
    // 1) Users: restore the before-image as ONE ATOMIC CONDITIONAL update (CR-132).
    //    The filter pins the COMPLETE expected post-migration state — a present/absent
    //    predicate on ALL FOUR level fields (the value THIS migration wrote where it
    //    wrote, else the untouched before value) — so a promotion/correction/metadata
    //    change that lands BETWEEN our decision and this write makes the filter miss.
    //    We never read-then-blind-write; on a miss we re-read and retain a conflict.
    for (const row of await bcoll.find({ batch, rolledBack: { $ne: true } }).toArray()) {
      const before = row.before || {}, after = row.after || {};
      const matchAfter = { _id: row.userId };
      for (const f of BACKFILL_FIELDS) {
        const exp = Object.prototype.hasOwnProperty.call(after, f) ? after[f] : before[f];
        matchAfter[f] = exp === undefined ? { $exists: false } : exp;
      }
      const set = {}, unset = {};
      for (const f of BACKFILL_FIELDS) { if (before[f] === undefined) unset[f] = ""; else set[f] = before[f]; }
      const op = {}; if (Object.keys(set).length) op.$set = set; if (Object.keys(unset).length) op.$unset = unset;

      failpoint("before-rollback-write"); // CR-132: crash BEFORE the conditional write (test a race landing here)
      const res = Object.keys(op).length
        ? await db.collection("users").updateOne(matchAfter, op)
        : { matchedCount: 1 }; // nothing to restore (before === after shape)
      failpoint("rollback-user-restore"); // crash AFTER the write, before journaling it
      if (res.matchedCount === 1) {
        await bcoll.updateOne({ _id: row._id }, { $set: { rolledBack: true, conflict: false } });
        reverted++;
        continue;
      }
      // The conditional MISSED: the user is not in the exact post-migration state.
      const u = await db.collection("users").findOne({ _id: row.userId });
      if (!u) { await bcoll.updateOne({ _id: row._id }, { $set: { rolledBack: true, conflict: false, note: "user_gone" } }); continue; }
      if (matchesBefore(u, before)) {
        // Already restored (crash-resume / lost-response retry / a concurrent rollback
        // worker won the write) → idempotent success, never a second restore.
        await bcoll.updateOne({ _id: row._id }, { $set: { rolledBack: true, conflict: false } });
        reverted++;
        continue;
      }
      // A later promotion / correction / metadata change → PRESERVE, retain conflict.
      await bcoll.updateOne({ _id: row._id }, { $set: { conflict: true, note: "user_changed_preserved" } });
      preserved++;
    }
    // 2) Indexes: drop ONLY batch-created indexes whose live shape is STILL exact.
    let dropped = 0, idxConflicts = 0;
    for (const idx of (j.indexes || []).filter((i) => i.createdByBatch && i.done)) {
      const spec = INDEXES.find((s) => s.collection === idx.collection && s.name === idx.name);
      if (!spec || !(await listed(db, idx.collection))) continue;
      const state = await classifyIndex(db, spec);
      if (state === "present-exact") {
        // Idempotent under CONCURRENT rollback workers: a peer that classified the same
        // index and dropped it between our classify and this call raises IndexNotFound —
        // that is convergence, not an error.
        try { await db.collection(idx.collection).dropIndex(idx.name); }
        catch (e) { if (!(e && (e.code === 27 || e.codeName === "IndexNotFound" || /index not found/i.test(e.message || "")))) throw e; }
        failpoint("index-drop"); dropped++;
      }
      else if (state === "present-wrong") { idxConflicts++; } // externally replaced → retained conflict, never drop
    }
    // 3) Delete the journal ONLY when every owned user/index reached its postcondition.
    const remainingConflicts = preserved + idxConflicts;
    if (remainingConflicts === 0) {
      failpoint("journal-deletion");
      await bcoll.deleteMany({ batch });
      await jcoll.deleteOne({ _id: batch });
      await mongoose.disconnect();
      console.log(`\nROLLBACK complete (batch=${batch}) — reverted ${reverted} teacher(s), dropped ${dropped} index(es). Journal cleared.\n`);
      process.exit(0);
    }
    await jcoll.updateOne({ _id: batch }, { $set: { rollbackCompletedAt: null } });
    await mongoose.disconnect();
    console.error(`\nROLLBACK PARTIAL (batch=${batch}) — reverted ${reverted}, dropped ${dropped}; RETAINED ${remainingConflicts} conflict(s) (${preserved} promoted/changed teacher(s), ${idxConflicts} externally-replaced index(es)). Journal KEPT for review.\n`);
    process.exit(1);
  }

  // ── APPLY (journaled + resumable + crash-safe) ──
  if (!batch) { console.error("\nAPPLY REFUSED — --batch=<tag> required.\n"); await mongoose.disconnect(); process.exit(2); }
  const uc = await uniqueCollisions(db); const cf = await conflicts(db);
  const problems = [...uc, ...cf];
  if (problems.length) { console.error(`\nAPPLY REFUSED (whole preflight) — nothing created: ${problems.join("; ")}.\n`); await mongoose.disconnect(); process.exit(1); }
  failpoint("after-census");

  // Concurrency-safe journal: unique {batch,userId} so two workers converge on one
  // before-image row (idempotent $setOnInsert) instead of duplicating.
  await bcoll.createIndex({ batch: 1, userId: 1 }, { unique: true, name: "uniq_batch_user" });
  try { await jcoll.updateOne({ _id: batch }, { $setOnInsert: { _id: batch, batch, startedAt: new Date(), completedAt: null, indexes: [] } }, { upsert: true }); }
  catch (e) { if (!isDup(e)) throw e; } // concurrent worker inserted first

  let built = 0;
  for (const coll of collectionsOf()) {
    for (const spec of specsFor(coll)) {
      const cur = await jcoll.findOne({ _id: batch });
      let intent = (cur.indexes || []).find((i) => i.collection === coll && i.name === spec.name);
      if (!intent) {
        // CR-129#8: persist the intent + EXACT pre-state BEFORE creating. Conditional
        // push (name not already present) → concurrent workers can't duplicate it.
        const preState = await classifyIndex(db, spec);
        intent = { collection: coll, name: spec.name, preState, createdByBatch: preState === "absent", done: false };
        await jcoll.updateOne({ _id: batch, "indexes.name": { $ne: spec.name } }, { $push: { indexes: intent } });
        intent = (await jcoll.findOne({ _id: batch })).indexes.find((i) => i.name === spec.name); // re-read (winner's intent)
      }
      failpoint("before-index-create");
      if (!intent.done) {
        const [key, opts] = buildArgs(spec);
        await db.collection(coll).createIndex(key, opts); // idempotent
        failpoint("after-index-create");
        await jcoll.updateOne({ _id: batch, "indexes.name": spec.name }, { $set: { "indexes.$.done": true } });
        failpoint("after-ownership-record");
      }
      built += 1;
    }
  }
  console.log(`  built/verified ${built} contract indexes natively.`);
  failpoint("after-indexes");

  // Conservative Spark backfill — per-user BEFORE-IMAGE journaled for exact rollback.
  let backfilled = 0;
  const cursor = db.collection("users").find({ role: "teacher", teacherLevel: { $exists: false } });
  for await (const u of cursor) {
    const after = { teacherLevel: "spark", levelVersion: 0 };
    // Journal the before-image first (idempotent on {batch,userId}; a concurrent
    // worker that inserted it first gets E11000 → we simply proceed).
    try {
      await bcoll.updateOne({ batch, userId: u._id }, { $setOnInsert: { batch, userId: u._id, before: snapshotUser(u), after, done: false } }, { upsert: true });
    } catch (e) { if (!isDup(e)) throw e; }
    failpoint("before-backfill-apply");
    // Apply conditionally (still missing level) so a resume is idempotent.
    await db.collection("users").updateOne({ _id: u._id, teacherLevel: { $exists: false } }, { $set: after });
    failpoint("after-backfill-apply");
    await bcoll.updateOne({ batch, userId: u._id }, { $set: { done: true } });
    backfilled += 1;
  }
  // Reconcile any journaled-but-undone rows from a prior crash (idempotent resume).
  for (const row of await bcoll.find({ batch, done: { $ne: true } }).toArray()) {
    await db.collection("users").updateOne({ _id: row.userId, teacherLevel: { $exists: false } }, { $set: row.after });
    await bcoll.updateOne({ _id: row._id }, { $set: { done: true } });
  }
  console.log(`  backfilled ${backfilled} existing teacher(s) to Spark (batch=${batch}).`);
  failpoint("after-backfill");

  await jcoll.updateOne({ _id: batch }, { $set: { completedAt: new Date() } });

  const v = await verifyTeacherSuccessIndexes(db);
  const issues = await journalIssues(db);
  await mongoose.disconnect();
  if (!v.ok || issues.length) { console.error(`\nAPPLY FAILED — ${!v.ok ? "contract not satisfied" : "journal: " + issues.join("; ")}\n`); process.exit(1); }
  console.log(`\nAPPLIED — exact index contract satisfied + journal complete.\n`);
  process.exit(0);
}

main().catch((e) => { console.error("[MIGRATION] failed:", e && e.message); process.exit(1); });
