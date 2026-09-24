#!/usr/bin/env node
/*
 * Scope the open-request uniqueness to PLAN requests only.
 *
 * The index was { teacher, targetPlan } unique among open rows. Credit top-ups
 * and (now) storage rentals carry no targetPlan, so both indexed as null — which
 * meant a teacher with one open credit request could not open a second for a
 * different pack, and could not ask for storage at all. The duplicate-key error
 * surfaced as a generic 500 with nothing to say why.
 *
 * The constraint was only ever meant for plans, which is what the old index's own
 * comment said. This adds `kind: "plan"` to the partial filter under a new name
 * and drops the old one.
 *
 * Safe to re-run. Dropping the old index can never lose data — a unique index is
 * a constraint, not content — and the new one is created before the old is
 * removed, so the plan constraint is never briefly absent.
 *
 *   node migrations/2026-09-24-plan-request-kind-index.js --dry-run
 *   node migrations/2026-09-24-plan-request-kind-index.js --apply
 *   node migrations/2026-09-24-plan-request-kind-index.js --verify
 */
const mongoose = require("mongoose");

const COLL = "plan_upgrade_request";
const OLD = "uniq_open_plan_request";
const NEW = {
  name: "uniq_open_plan_request_v2",
  key: { teacher: 1, targetPlan: 1 },
  unique: true,
  partialFilterExpression: { status: "open", kind: "plan" },
};

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

const names = async (db) => (await db.collection(COLL).indexes()).map((i) => i.name);

(async () => {
  await mongoose.connect(uri, { dbName });
  const db = mongoose.connection.db;
  const before = await names(db);
  const state = { collection: COLL, hasOld: before.includes(OLD), hasNew: before.includes(NEW.name) };

  if (modes[0] === "dry-run") {
    console.log(JSON.stringify({ mode: "dry-run", ...state, willCreate: !state.hasNew, willDrop: state.hasOld }, null, 2));
  } else if (modes[0] === "apply") {
    if (!state.hasNew) {
      await db.collection(COLL).createIndex(NEW.key, {
        name: NEW.name,
        unique: NEW.unique,
        partialFilterExpression: NEW.partialFilterExpression,
      });
      console.log(`created ${COLL}.${NEW.name}`);
    }
    // Only after the replacement exists, so the plan constraint never lapses.
    if (state.hasOld) {
      await db.collection(COLL).dropIndex(OLD);
      console.log(`dropped ${COLL}.${OLD}`);
    }
    const after = await names(db);
    console.log(JSON.stringify({ mode: "apply", indexes: after }, null, 2));
  } else {
    const ok = state.hasNew && !state.hasOld;
    console.log(JSON.stringify({ mode: "verify", ...state, ok }, null, 2));
    if (!ok) process.exitCode = 1;
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
