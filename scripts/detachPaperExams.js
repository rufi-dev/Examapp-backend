/**
 * ONE-TIME MIGRATION: detach paper exams from their classes.
 *
 * Paper exams used to be created inside a class, but they are never listed in one
 * (they live only on the "Kağız imtahanları" page) and access now follows their
 * OWNER — the teacher — not a class. Older paper exams still carry `class`, so
 * they still show a class name and are still referenced by `Class.exams`.
 *
 * This sets `class: null` on every exam with `mode: "paper"` (archived ones too,
 * otherwise a restore brings the class back) and removes those ids from every
 * class's `exams` array.
 *
 * SAFE: it never touches any other mode, and it refuses to detach an exam that
 * has no `owner`, because that exam would afterwards be visible to no student.
 * Idempotent — re-running finds nothing left to do.
 *
 *   node scripts/detachPaperExams.js            # dry-run (writes nothing)
 *   node scripts/detachPaperExams.js --apply    # apply
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Exam = require("../models/examModel");
const Class = require("../models/classModel");

const APPLY = process.argv.includes("--apply");
const log = (...a) => console.log(...a);

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  log(`\n=== detachPaperExams  [${APPLY ? "APPLY" : "DRY-RUN"}] ===\n`);

  const attached = await Exam.find({ mode: "paper", class: { $ne: null } })
    .select("_id name class owner deletedAt")
    .lean();
  log(`paper exams still attached to a class: ${attached.length}`);
  if (!attached.length) {
    log("nothing to do.\n");
    return;
  }

  // An exam with no owner has no teacher, so nobody would be able to see it once
  // the class link is gone. Leave those alone and report them.
  const ownerless = attached.filter((e) => !e.owner);
  const detachable = attached.filter((e) => e.owner);
  ownerless.forEach((e) => log(`  ! SKIP ${e._id} "${e.name}" — no owner, would become invisible`));
  detachable.forEach((e) =>
    log(`  - ${e._id} "${e.name}"${e.deletedAt ? " (archived)" : ""} — class ${e.class}`)
  );

  if (!APPLY) {
    log(`\nwould detach ${detachable.length}, skip ${ownerless.length}. Re-run with --apply.\n`);
    return;
  }

  const ids = detachable.map((e) => e._id);
  const classIds = [...new Set(detachable.map((e) => String(e.class)))];
  const examRes = await Exam.updateMany({ _id: { $in: ids } }, { $set: { class: null } });
  const classRes = await Class.updateMany({ _id: { $in: classIds } }, { $pull: { exams: { $in: ids } } });

  log(`\ndetached ${examRes.modifiedCount} exam(s); cleaned ${classRes.modifiedCount} class list(s).`);
  const left = await Exam.countDocuments({ mode: "paper", class: { $ne: null } });
  log(`paper exams still attached: ${left}${left === ownerless.length ? " (ownerless only)" : ""}\n`);
}

main()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("MIGRATION FAILED:", e.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
