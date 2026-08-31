/*
 * Curriculum / lesson-plan / MSO collections + indexes.
 *
 * The application NEVER builds these: every model sets autoIndex/autoCreate false,
 * so a flag-off deployment performs zero schema writes. This migration owns them,
 * and helper/curriculumIndexes.js is the single contract it BUILDS from and
 * VERIFIES against (the same module production startup asserts with).
 *
 *   node migrations/2026-09-01-curriculum.js --dry-run [--db=<name>]   (read-only census)
 *   node migrations/2026-09-01-curriculum.js --apply   --db=<name>     (whole preflight, then build)
 *   node migrations/2026-09-01-curriculum.js --verify  --db=<name>     (read-only contract check)
 *   node migrations/2026-09-01-curriculum.js --rollback --db=<name> --batch=<tag>
 *
 * Exit codes: 0 success, 1 verify/shape/dirty failure, 2 usage, 3 refused (unsafe target).
 *
 * CR-MSO-010 — ROLLBACK PRESERVES USER CONTENT. It drops only the indexes this
 * batch created, and REFUSES outright once any curriculum collection holds
 * documents: teachers' plans and MSOs are not disposable migration state.
 */
const mongoose = require("mongoose");
require("dotenv").config();

const {
  collectionsOf,
  specsFor,
  buildArgs,
  verifyCurriculumIndexes,
  shapeReason,
} = require("../helper/curriculumIndexes");

const JOURNAL = "_curriculum_migration_journal";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const hit = argv.find((a) => a.startsWith(`${f}=`));
  return hit ? hit.slice(f.length + 1) : null;
};

const modeFlags = ["--dry-run", "--apply", "--verify", "--rollback"].filter(has);
if (modeFlags.length > 1) {
  console.error(`Usage error: pass exactly ONE of --dry-run/--apply/--verify/--rollback (got ${modeFlags.join(" ")})`);
  process.exit(2);
}
const APPLY = has("--apply");
const VERIFY = has("--verify");
const ROLLBACK = has("--rollback");
const DRY = !APPLY && !VERIFY && !ROLLBACK; // safe default
const FORCE = has("--force");
const dbArg = valueOf("--db");
const batchTag = valueOf("--batch");

if (ROLLBACK && !batchTag) {
  console.error("Usage error: --rollback requires --batch=<tag> naming the apply batch to undo.");
  process.exit(2);
}

function dbNameFromUri(uri) {
  try {
    const m = String(uri).match(/\/([^/?]+)(\?|$)/);
    return m ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
}
const isThrowaway = (name) => /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(String(name));

// Count documents WITHOUT creating a namespace.
async function census(db) {
  const rows = [];
  for (const c of collectionsOf()) {
    const exists = await db.listCollections({ name: c }, { nameOnly: true }).toArray();
    rows.push({ collection: c, exists: exists.length > 0, docs: exists.length ? await db.collection(c).countDocuments() : 0 });
  }
  return rows;
}

// Wrong-SHAPE indexes only. "absent" is what apply is for, so it is not a conflict.
async function conflicts(db) {
  const v = await verifyCurriculumIndexes(db);
  return v.failures.filter((f) => f.reason !== "absent" && f.reason !== "collection_missing");
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set.");
    process.exit(2);
  }
  const dbName = dbNameFromUri(uri);
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;
  if (!safe) {
    // Refuse BEFORE connecting: a refusal must never touch the database.
    console.error(
      `REFUSED: target database "${dbName}" was not approved. ` +
        `This run did NOT contact the database. Pass --db=<exact-name> or --force to proceed.`
    );
    process.exit(3);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  try {
    const rows = await census(db);
    const populated = rows.filter((r) => r.docs > 0);

    if (DRY) {
      console.log("[DRY-RUN] curriculum census (read-only):");
      for (const r of rows) console.log(`  ${r.collection}: ${r.exists ? `${r.docs} docs` : "collection absent"}`);
      const c = await conflicts(db);
      console.log(c.length ? `[DRY-RUN] shape conflicts: ${c.map((f) => `${f.collection}.${f.name}=${f.reason}`).join("; ")}` : "[DRY-RUN] no shape conflicts");
      const v = await verifyCurriculumIndexes(db);
      console.log(v.ok ? "[DRY-RUN] contract already satisfied" : `[DRY-RUN] contract NOT satisfied (${v.failures.length} item(s))`);
      await mongoose.disconnect();
      process.exit(0);
    }

    if (APPLY) {
      // WHOLE preflight before creating anything: a partial build leaves the DB in
      // a state neither verify nor rollback describes.
      const problems = (await conflicts(db)).map((f) => `${f.collection}.${f.name} is ${f.reason}`);
      if (problems.length) {
        console.error(
          `\nAPPLY REFUSED (whole preflight) — nothing created: ${problems.join("; ")}. ` +
            `Drop the conflicting index, then re-run.\n`
        );
        await mongoose.disconnect();
        process.exit(1);
      }

      const tag = batchTag || `curriculum-${new Date().toISOString()}`;
      const created = [];
      for (const collection of collectionsOf()) {
        for (const spec of specsFor(collection)) {
          const [key, opts] = buildArgs(spec);
          await db.collection(collection).createIndex(key, opts);
          created.push({ collection, name: spec.name });
        }
      }
      await db.collection(JOURNAL).insertOne({ batch: tag, action: "apply", created, at: new Date() });
      console.log(`[APPLY] built ${created.length} index(es) across ${collectionsOf().length} collection(s), batch "${tag}"`);
    }

    if (ROLLBACK) {
      // Content first: teachers' plans and MSOs are not disposable.
      if (populated.length) {
        console.error(
          `\nROLLBACK REFUSED — populated curriculum collections, content would be lost: ` +
            `${populated.map((r) => `${r.collection}(${r.docs})`).join(", ")}. ` +
            `Remove or export the documents first if this is really intended.\n`
        );
        await mongoose.disconnect();
        process.exit(1);
      }
      const entry = await db.collection(JOURNAL).findOne({ batch: batchTag, action: "apply" });
      if (!entry) {
        console.error(`ROLLBACK REFUSED — no apply journal entry for batch "${batchTag}".`);
        await mongoose.disconnect();
        process.exit(1);
      }
      let dropped = 0;
      for (const { collection, name } of entry.created || []) {
        // Only THIS batch's indexes, never a collection.
        await db.collection(collection).dropIndex(name).then(() => { dropped += 1; }).catch(() => {});
      }
      await db.collection(JOURNAL).insertOne({ batch: batchTag, action: "rollback", dropped, at: new Date() });
      console.log(`[ROLLBACK] dropped ${dropped} batch-owned index(es); no collection and no document was removed.`);
      await mongoose.disconnect();
      process.exit(0);
    }

    // APPLY and VERIFY both end by re-asserting the SHARED contract.
    const v = await verifyCurriculumIndexes(db);
    if (!v.ok) {
      console.error(`[VERIFY] contract NOT satisfied: ${v.failures.map((f) => `${f.collection}.${f.name}=${f.reason}`).join("; ")}`);
      await mongoose.disconnect();
      process.exit(1);
    }
    console.log("[VERIFY] curriculum index contract satisfied");
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error("[MIGRATION] failed:", e && e.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[MIGRATION] failed:", e && e.message);
  process.exit(1);
});

module.exports = { dbNameFromUri, isThrowaway, shapeReason };
