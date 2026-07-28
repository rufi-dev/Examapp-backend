/*
 * AUD-003 migration — introduce immutable exam versions.
 *
 *   node migrations/2026-07-25-exam-versioning.js --dry-run [--db=<name>]
 *   node migrations/2026-07-25-exam-versioning.js --apply --db=<name>
 *   node migrations/2026-07-25-exam-versioning.js --rollback --db=<name>
 *
 * WHAT --apply DOES (additive, idempotent, batched):
 *   1. For every active exam that HAS a question doc, pre-create its initial
 *      immutable version (v1 snapshot) via ensurePublishedVersion — idempotent by
 *      content hash, so a re-run creates no duplicates. Attempts started AFTER
 *      deploy bind lazily at start; this just gives every exam a baseline version.
 *   2. Tag every existing Result WITHOUT a version as legacyUnversioned:true — it
 *      was graded against the then-live exam and is explicitly NOT a reproducible
 *      snapshot. We NEVER fabricate a trustworthy examVersionId for legacy data.
 *   Existing in-flight attempts stay unbound (legacy-unversioned) and grade against
 *   the live exam, exactly as before.
 *
 * SAFETY (Rule 7/9, mirrors the session migration):
 *   - --dry-run is GENUINELY read-only (counts only; never writes).
 *   - contacting the DB requires a recognizably throwaway db NAME, OR an explicit
 *     --db=<name> that matches the URI's db, OR --force.
 *
 * ROLLBACK (--rollback): unset legacyUnversioned on all results, and delete only
 * ExamVersion docs NOT referenced by any Attempt/Result (a referenced version is
 * never dropped — that would corrupt history). Safe before any versioned attempt
 * exists; after activation, referenced versions are preserved.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ROLLBACK = argv.includes("--rollback");
const DRY = !APPLY && !ROLLBACK;
const FORCE = argv.includes("--force");
const dbArg = (argv.find((a) => a.startsWith("--db=")) || "").split("=")[1] || "";
const BATCH = 200;

function dbNameFromUri(uri) {
  try {
    const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://"));
    return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || "";
  } catch (_) { return ""; }
}
// Safety is keyed on the db NAME, not the host (a local host is not proof a DB is
// disposable). Only a recognizably throwaway name auto-authorizes.
function isThrowaway(name) {
  return /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(name);
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }
  const dbName = dbNameFromUri(uri);
  if (!dbName) { console.log("Could not parse a database NAME; refusing to contact any DB."); process.exit(3); }
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;

  const mode = ROLLBACK ? "ROLLBACK" : APPLY ? "APPLY" : "DRY RUN (read-only)";
  console.log(`\nAUD-003 exam-versioning migration — ${mode}`);
  console.log(`  database: ${dbName}`);
  if (!safe) {
    console.log(`\n  Target database "${dbName}" is not a recognizably throwaway NAME and no matching --db=${dbName} was given.`);
    console.log("  This run will NOT contact the database. Pass --db=<exact-name> or --force to proceed.\n");
    process.exit(DRY ? 0 : 3);
  }

  await mongoose.connect(uri);
  const Exam = require("../models/examModel");
  const Question = require("../models/questionModel");
  const Attempt = require("../models/attemptModel");
  const Result = require("../models/resultModel");
  const ExamVersion = require("../models/examVersionModel");
  const { publishExam } = require("../helper/examVersion");

  // ---- census (all modes) ----
  const [exams, examsWithQ, attempts, attemptsUnbound, results, resultsUnbound, versions] = await Promise.all([
    Exam.countDocuments({}),
    Exam.countDocuments({ questions: { $exists: true, $ne: null } }),
    Attempt.countDocuments({}),
    Attempt.countDocuments({ examVersionId: null }),
    Result.countDocuments({}),
    Result.countDocuments({ examVersionId: null }),
    ExamVersion.countDocuments({}),
  ]);
  const ambiguous = exams - examsWithQ; // no question doc ⇒ no key to snapshot
  console.log("  census:");
  console.log(`    exams=${exams} (with-questions=${examsWithQ}, ambiguous-no-key=${ambiguous})`);
  console.log(`    attempts=${attempts} (unbound=${attemptsUnbound})  results=${results} (unbound=${resultsUnbound})`);
  console.log(`    existing versions=${versions}`);

  if (DRY) {
    console.log("\nDRY RUN complete — READ ONLY. Re-run with --apply to create baseline versions + tag legacy.\n");
    await mongoose.disconnect();
    return process.exit(0);
  }

  if (ROLLBACK) {
    await ExamVersion.createIndexes().catch(() => {});
    // Preserve any version referenced by an attempt/result; delete the rest.
    const referenced = new Set();
    for (const id of await Attempt.distinct("examVersionId", { examVersionId: { $ne: null } })) referenced.add(String(id));
    for (const id of await Result.distinct("examVersionId", { examVersionId: { $ne: null } })) referenced.add(String(id));
    const all = await ExamVersion.find({}).select("_id").lean();
    const drop = all.map((v) => v._id).filter((id) => !referenced.has(String(id)));
    const dropSet = new Set(drop.map(String));
    // CR-035: deleting published versions requires the AUTHORIZED, AUDITED
    // maintenance service (writes a durable audit event first).
    const { performMaintenance } = require("../services/versionMaintenance");
    const del = drop.length
      ? (await performMaintenance(
          { actor: "migration:2026-07-25-exam-versioning", reason: "rollback: delete unreferenced versions", action: "exam_version_delete", target: drop.map(String), authorized: true },
          () => ExamVersion.deleteMany({ _id: { $in: drop } })
        )).deletedCount
      : 0;
    const untag = (await Result.updateMany({ legacyUnversioned: true }, { $set: { legacyUnversioned: false } })).modifiedCount;

    // CR-034: RECONCILE the active pointer on every exam whose active version was
    // just deleted (or dangles). Repoint to the highest RETAINED version, or clear
    // to null/0 when none remain — so a non-null pointer ALWAYS exists after
    // rollback and re-apply's advance-only CAS is not blocked by a stale number.
    let repointed = 0;
    let cleared = 0;
    const exams = await Exam.find({ activeVersionId: { $ne: null } }).select("_id activeVersionId").lean();
    for (const ex of exams) {
      const stillExists = ex.activeVersionId && !dropSet.has(String(ex.activeVersionId));
      if (stillExists) continue; // pointer still valid
      const top = await ExamVersion.findOne({ examId: ex._id }).sort({ versionNumber: -1 }).lean();
      if (top) {
        await Exam.updateOne({ _id: ex._id }, { $set: { activeVersionId: top._id, activeVersionNumber: top.versionNumber } });
        repointed += 1;
      } else {
        await Exam.updateOne({ _id: ex._id }, { $set: { activeVersionId: null, activeVersionNumber: 0 } });
        cleared += 1;
      }
    }
    console.log(`\nROLLBACK: deleted ${del} unreferenced version(s) (kept ${referenced.size} referenced); untagged ${untag} result(s); pointer repointed=${repointed}, cleared=${cleared}.\n`);
    await mongoose.disconnect();
    return process.exit(0);
  }

  // ---- APPLY ----
  await ExamVersion.createIndexes();
  let created = 0, skipped = 0, processed = 0;
  const cursor = Exam.find({ questions: { $exists: true, $ne: null } }).populate("questions").cursor({ batchSize: BATCH });
  for (let exam = await cursor.next(); exam != null; exam = await cursor.next()) {
    processed += 1;
    if (!exam.questions || !Array.isArray(exam.questions.correctAnswers) || !exam.questions.correctAnswers.length) {
      skipped += 1; // no key content ⇒ nothing trustworthy to snapshot
      continue;
    }
    const before = await ExamVersion.countDocuments({ examId: exam._id });
    await publishExam(exam, exam.questions, ExamVersion, Exam);
    const after = await ExamVersion.countDocuments({ examId: exam._id });
    if (after > before) created += 1;
    if (processed % BATCH === 0) console.log(`    …processed ${processed} exams (created ${created})`);
  }
  // Tag every version-less Result as explicitly legacy (idempotent).
  const tagged = (await Result.updateMany(
    { examVersionId: null, legacyUnversioned: { $ne: true } },
    { $set: { legacyUnversioned: true } }
  )).modifiedCount;

  // ---- verification ----
  const versionsAfter = await ExamVersion.countDocuments({});
  const stillUntagged = await Result.countDocuments({ examVersionId: null, legacyUnversioned: { $ne: true } });
  console.log(`\nAPPLIED — baseline versions created=${created}, skipped(no key)=${skipped}, exams processed=${processed}.`);
  console.log(`  results tagged legacyUnversioned=${tagged}; total versions now=${versionsAfter}.`);
  console.log(`  verification: version-less results still untagged=${stillUntagged} (expected 0).\n`);
  await mongoose.disconnect();
  process.exit(stillUntagged === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
