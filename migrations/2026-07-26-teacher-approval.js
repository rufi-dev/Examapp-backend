/*
 * AUD-005 migration — introduce explicit, REVIEWED teacher-approval state.
 *
 *   node migrations/2026-07-26-teacher-approval.js --dry-run [--db=<name>]
 *   node migrations/2026-07-26-teacher-approval.js --apply --db=<name> \
 *        ( --allow-none | --allow=<id,id,...> | --allow-file=<path> ) \
 *        [--reviewer=<adminUserId>]   (REQUIRED when granting) [--batch=<tag>]
 *   node migrations/2026-07-26-teacher-approval.js --rollback --db=<name> --batch=<tag>
 *
 * WHY (CR-041): a pre-fix teacher is INDISTINGUISHABLE from an account an attacker
 * self-provisioned via the very bug AUD-005 closes, so legacy trust is an
 * EXPLICIT, operator-reviewed decision — not an automatic grant:
 *   - Teachers on the reviewed ALLOWLIST → `approved_legacy` (capable), stamped
 *     with WHO reviewed (reviewer User id), when, method, and batch.
 *   - Every OTHER legacy teacher → `pending` (NON-capable; in the admin queue).
 *
 * SAFE CLI CONTRACT (CR-045):
 *   - EXACTLY ONE operation mode: --dry-run | --apply | --rollback. Contradictory
 *     modes are REJECTED (never resolved by precedence). No mode → dry-run.
 *   - For --apply: EXACTLY ONE review-decision source (--allow-none | --allow |
 *     --allow-file). Any combination is REJECTED (so a stale --allow can never
 *     override --allow-none).
 *   - Granting (--allow / --allow-file) REQUIRES --reviewer=<adminUserId>, a valid
 *     ObjectId of an existing admin; it is persisted to teacherApprovalMeta.by.
 *   - Valid reviewed IDs that do NOT match a current legacy teacher are reported
 *     prominently (stale/typo guard).
 *   - --rollback REQUIRES an explicit --batch=<tag> (no default) and reverts ONLY
 *     that batch's migration-owned grants/holds.
 *
 * SAFETY (CR-043): --dry-run uses the native driver only (no Mongoose model), so it
 * never auto-creates a collection; a fresh DB is left byte-identical. Contacting
 * the DB requires a throwaway db NAME, a matching --db=<name>, or --force.
 */
require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (k) => { const a = argv.find((x) => x.startsWith(k + "=")); return a ? a.split("=").slice(1).join("=") : undefined; };

// ── exactly-one operation mode (CR-045.1) ──
const modeFlags = ["--dry-run", "--apply", "--rollback"].filter(has);
if (modeFlags.length > 1) {
  console.error(`\nREFUSED: contradictory operation modes ${modeFlags.join(" ")}. Pass exactly one of --dry-run | --apply | --rollback.\n`);
  process.exit(2);
}
const APPLY = has("--apply");
const ROLLBACK = has("--rollback");
const DRY = !APPLY && !ROLLBACK; // no mode → safe read-only default

const FORCE = has("--force");
const dbArg = val("--db") || "";
const reviewerArg = val("--reviewer") || "";
const batchArg = val("--batch");

// ── exactly-one review-decision source for apply (CR-045.2) ──
const ALLOW_NONE = has("--allow-none");
const allowInline = val("--allow");
const allowFile = val("--allow-file");
const decisionCount = [ALLOW_NONE, allowInline !== undefined, allowFile !== undefined].filter(Boolean).length;

function dbNameFromUri(uri) {
  try {
    const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://"));
    return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || "";
  } catch (_) { return ""; }
}
function isThrowaway(name) {
  return /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(name);
}
function loadAllowlist() {
  const raw = [];
  if (allowInline) raw.push(...allowInline.split(","));
  if (allowFile) {
    const text = fs.readFileSync(allowFile, "utf8");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* not JSON */ }
    if (Array.isArray(parsed)) raw.push(...parsed.map(String));
    else raw.push(...text.split(/[\s,]+/).filter((t) => t && !t.startsWith("#")));
  }
  const valid = new Set();
  const invalid = [];
  for (const s of raw.map((x) => x.trim()).filter(Boolean)) {
    if (mongoose.Types.ObjectId.isValid(s)) valid.add(s);
    else invalid.push(s);
  }
  return { valid, invalid };
}

const LEGACY_MATCH = { role: "teacher", $or: [{ teacherApproval: "none" }, { teacherApproval: null }, { teacherApproval: { $exists: false } }] };

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }
  const dbName = dbNameFromUri(uri);
  if (!dbName) { console.log("Could not parse a database NAME; refusing to contact any DB."); process.exit(3); }
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;

  const mode = ROLLBACK ? "ROLLBACK" : APPLY ? "APPLY" : "DRY RUN (read-only)";
  console.log(`\nAUD-005 teacher-approval migration — ${mode}`);
  console.log(`  database: ${dbName}`);
  if (!safe) {
    console.log(`\n  Target database "${dbName}" is not a recognizably throwaway NAME and no matching --db=${dbName} was given.`);
    console.log("  This run will NOT contact the database. Pass --db=<exact-name> or --force to proceed.\n");
    process.exit(DRY ? 0 : 3);
  }

  // ── pre-connect CLI validation for the mutating modes (no DB side effects) ──
  if (APPLY) {
    if (decisionCount !== 1) {
      console.log("\n  REFUSED: --apply needs EXACTLY ONE review-decision source: --allow-none | --allow=<ids> | --allow-file=<path>.");
      console.log("  A combination (e.g. --allow-none with --allow) is rejected so a stale flag can never override the decision.\n");
      process.exit(4);
    }
  }
  if (ROLLBACK && !batchArg) {
    console.log("\n  REFUSED: --rollback requires an explicit --batch=<tag> (the exact batch used at --apply).\n");
    process.exit(4);
  }

  await mongoose.connect(uri);
  const users = mongoose.connection.db.collection("users");
  const { ObjectId } = mongoose.Types;

  const [teachers, legacy, tPending, tApproved, tLegacy] = await Promise.all([
    users.countDocuments({ role: "teacher" }),
    users.countDocuments(LEGACY_MATCH),
    users.countDocuments({ role: "teacher", teacherApproval: "pending" }),
    users.countDocuments({ role: "teacher", teacherApproval: "approved" }),
    users.countDocuments({ role: "teacher", teacherApproval: "approved_legacy" }),
  ]);
  console.log("  census:");
  console.log(`    teachers=${teachers} (unset/none=${legacy}, pending=${tPending}, approved=${tApproved}, approved_legacy=${tLegacy})`);

  if (DRY) {
    const sample = await users.find(LEGACY_MATCH, { projection: { _id: 1, email: 1, createdAt: 1 } }).sort({ createdAt: 1 }).toArray();
    if (sample.length) {
      console.log("\n  legacy teachers requiring an explicit review decision (build the --allow-file from these):");
      for (const u of sample) console.log(`    ${String(u._id)}  ${u.email}`);
    }
    console.log(`\n  → on --apply: allowlisted IDs become approved_legacy; all ${legacy} others become pending (non-capable).`);
    console.log("\nDRY RUN complete — READ ONLY (no collection created, no document written).\n");
    await mongoose.disconnect();
    return process.exit(0);
  }

  if (ROLLBACK) {
    const filter = { "teacherApprovalMeta.method": "migration", "teacherApprovalMeta.batch": batchArg };
    const { modifiedCount } = await users.updateMany(filter, { $set: { teacherApproval: "none" }, $unset: { teacherApprovalMeta: "" } });
    console.log(`\nROLLBACK (batch ${batchArg}): reverted ${modifiedCount} migration-owned grant/hold(s) → none.\n`);
    await mongoose.disconnect();
    return process.exit(0);
  }

  // ── APPLY ──
  const BATCH = batchArg || "2026-07-26-teacher-approval";
  const { valid: allow, invalid } = loadAllowlist();
  if (invalid.length) {
    console.log(`\n  REFUSED: allowlist contains ${invalid.length} invalid ObjectId(s): ${invalid.slice(0, 5).join(", ")}${invalid.length > 5 ? " …" : ""}\n`);
    await mongoose.disconnect();
    return process.exit(4);
  }
  const granting = allow.size > 0;

  // Granting REQUIRES a valid, EXISTING admin reviewer id (CR-045.3). Persisted to
  // teacherApprovalMeta.by (typed ObjectId) — never an unused free-form actor.
  let reviewerId = null;
  if (granting) {
    if (!reviewerArg || !ObjectId.isValid(reviewerArg)) {
      console.log("\n  REFUSED: granting legacy teachers requires --reviewer=<adminUserId> (a valid User ObjectId).\n");
      await mongoose.disconnect();
      return process.exit(4);
    }
    const reviewer = await users.findOne({ _id: new ObjectId(reviewerArg) }, { projection: { role: 1 } });
    if (!reviewer || reviewer.role !== "admin") {
      console.log(`\n  REFUSED: --reviewer=${reviewerArg} is not an existing admin user.\n`);
      await mongoose.disconnect();
      return process.exit(4);
    }
    reviewerId = reviewer._id;
  }

  const now = new Date();
  const allowIds = [...allow].map((id) => new ObjectId(id));

  // CR-045.5: report reviewed IDs that do NOT match a current legacy teacher
  // (already approved, not a teacher, or nonexistent) — a stale/typo guard.
  if (allowIds.length) {
    const matched = await users.find({ ...LEGACY_MATCH, _id: { $in: allowIds } }, { projection: { _id: 1 } }).toArray();
    const matchedSet = new Set(matched.map((d) => String(d._id)));
    const unmatched = [...allow].filter((id) => !matchedSet.has(id));
    if (unmatched.length) {
      console.log(`\n  WARNING: ${unmatched.length} reviewed ID(s) did NOT match any current legacy teacher (ignored):`);
      for (const id of unmatched) console.log(`    ${id}`);
    }
  }

  // 1) Grandfather the reviewed allowlist → approved_legacy (+ reviewer provenance).
  const grant = allowIds.length
    ? await users.updateMany(
        { ...LEGACY_MATCH, _id: { $in: allowIds } },
        { $set: { teacherApproval: "approved_legacy", teacherApprovalMeta: { by: reviewerId, at: now, method: "migration", batch: BATCH } } }
      )
    : { modifiedCount: 0 };
  // 2) Every remaining legacy teacher → pending (explicit, non-capable hold).
  const hold = await users.updateMany(
    LEGACY_MATCH,
    { $set: { teacherApproval: "pending", teacherApprovalMeta: { by: null, at: now, method: "migration", batch: BATCH } } }
  );

  const stillLegacy = await users.countDocuments(LEGACY_MATCH);
  console.log(`\nAPPLIED (batch ${BATCH}${reviewerId ? `, reviewer ${String(reviewerId)}` : ""}) — grandfathered ${grant.modifiedCount} reviewed teacher(s) → approved_legacy;`);
  console.log(`  held ${hold.modifiedCount} unreviewed teacher(s) → pending (non-capable).`);
  console.log(`  verification: legacy (unset/none) teachers remaining=${stillLegacy} (expected 0).\n`);
  await mongoose.disconnect();
  process.exit(stillLegacy === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
