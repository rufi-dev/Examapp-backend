#!/usr/bin/env node
/*
 * The free start for teachers who joined before it existed.
 *
 * From 2026-10-27 a new teacher gets STARTER.days with one exam before the card
 * wall (config/plans.js). A teacher who signed up earlier, never paid and never
 * made an exam has not seen what Examopia does either, so they get the same: this
 * marks them `starterPending`, and their days begin on their next visit
 * (helper/teacherAccess.beginPendingStarter), not on the day this ran.
 *
 * A teacher who already made an exam (deleted ones count) has had their first
 * exam; anyone who ever paid (card, trial, an admin plan, a downgrade) is not a
 * "never paid" teacher. Neither is touched.
 *
 * Safe to re-run: it only ever sets the flag on teachers without one and without
 * a free start already.
 *
 *   node migrations/2026-10-27-teacher-starter.js --dry-run
 *   node migrations/2026-10-27-teacher-starter.js --apply
 *   node migrations/2026-10-27-teacher-starter.js --verify
 */
const mongoose = require("mongoose");

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
  dbName ||= new URL(uri).pathname.replace(/^\//, "");
} catch {
  console.error("REFUSED: invalid MONGO_URI");
  process.exit(3);
}

// Never paid, no free start yet, not already pending.
const NEVER_PAID = {
  role: "teacher",
  plan: { $nin: ["pro", "premium"] },
  planDowngradedAt: null,
  stripeTrialUsedAt: null,
  stripeSubscriptionId: null,
  starterUntil: null,
  starterPending: { $ne: true },
};

async function eligibleIds(db) {
  const made = await db.collection("exams").distinct("owner", { provisional: { $ne: true } });
  const madeSet = new Set(made.map(String));
  const teachers = await db.collection("users").find(NEVER_PAID, { projection: { _id: 1 } }).toArray();
  return teachers.map((t) => t._id).filter((id) => !madeSet.has(String(id)));
}

(async () => {
  await mongoose.connect(uri, { dbName });
  const db = mongoose.connection.db;
  const mode = modes[0];

  if (mode === "verify") {
    const pending = await db.collection("users").countDocuments({ role: "teacher", starterPending: true });
    const started = await db.collection("users").countDocuments({ role: "teacher", starterUntil: { $ne: null } });
    const left = (await eligibleIds(db)).length;
    console.log(JSON.stringify({ pending, started, stillEligibleUnmarked: left }));
    await mongoose.disconnect();
    process.exit(left === 0 ? 0 : 1);
  }

  const ids = await eligibleIds(db);
  if (mode === "dry-run") {
    console.log(JSON.stringify({ wouldMark: ids.length }));
  } else {
    const res = await db.collection("users").updateMany(
      { _id: { $in: ids }, ...NEVER_PAID },
      { $set: { starterPending: true } }
    );
    console.log(JSON.stringify({ marked: res.modifiedCount }));
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
