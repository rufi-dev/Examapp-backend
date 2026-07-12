/**
 * ONE-TIME OFFLINE MIGRATION for the attemptId-keyed Result invariant.
 *
 * Run ONLY behind a maintenance window (backend stopped, no live writes). It:
 *   1. Dedups duplicate ACTIVE attempts   -> retired duplicates become terminal
 *      (`{submitted:true, unscorable:retired_duplicate}`), so uniq_active_attempt can build.
 *   2. Stale-cleanup: finalizes every EXPIRED unsubmitted attempt (no age floor).
 *   3. Backfills `Result.attemptId` on UNAMBIGUOUS 1:1 pairs (never force-matches).
 *   4. Ghost-flags `submitted:true` attempts that produced no Result at all
 *      (`unscorable:ghost_no_result`); tags ambiguous legacy attempts `legacy_unlinked`.
 *   5. Idempotent repair: `submitted:false` + a linked Result -> mark submitted + link.
 *   6. Builds ALL Attempt + Result indexes offline (autoIndex is off in prod).
 *
 * DRY-RUN by default (prints counts, writes nothing). Pass --apply to write.
 * Re-running is safe — every step is idempotent.
 *
 *   node scripts/backfillAttemptId.js            # dry-run
 *   node scripts/backfillAttemptId.js --apply    # apply
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Attempt = require("../models/attemptModel");
const Result = require("../models/resultModel");
const Exam = require("../models/examModel");
const { finalizeAttempt, effectiveExpiry } = require("../controllers/quizController");

const APPLY = process.argv.includes("--apply");
const GRACE_MS = 30 * 1000;
const log = (...a) => console.log(...a);

async function run() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI);
  log(`\n=== backfillAttemptId  [${APPLY ? "APPLY" : "DRY-RUN"}] ===\n`);

  const now = Date.now();
  const stats = {
    retiredDuplicates: 0,
    staleFinalized: 0,
    staleUnscorable: 0,
    backfilled: 0,
    ambiguousSkipped: 0,
    ghosts: 0,
    legacyUnlinked: 0,
    repaired: 0,
  };

  // Cache exam endDate for effectiveExpiry (avoid re-querying per attempt).
  const examCache = new Map();
  const getExam = async (id) => {
    const k = String(id);
    if (examCache.has(k)) return examCache.get(k);
    const e = await Exam.findById(id).select("endDate").lean();
    examCache.set(k, e || null);
    return e || null;
  };
  const expiryOf = async (a) => {
    const e = await getExam(a.examId);
    return effectiveExpiry(a, e || {});
  };
  const key = (a) => `${a.userId}|${a.examId}`;

  // ── 1) DEDUP duplicate ACTIVE attempts ─────────────────────────────────────
  const activeDupes = await Attempt.aggregate([
    { $match: { submitted: false, unscorable: { $ne: true } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: { u: "$userId", e: "$examId" }, ids: { $push: "$_id" } } },
    { $match: { "ids.1": { $exists: true } } },
  ]);
  for (const d of activeDupes) {
    const [, ...older] = d.ids; // keep newest; retire the rest
    stats.retiredDuplicates += older.length;
    if (APPLY) {
      await Attempt.updateMany(
        { _id: { $in: older } },
        {
          $set: {
            submitted: true,
            unscorable: true,
            unscorableReason: "retired_duplicate",
          },
        }
      );
    }
  }
  log(`1) dedup: retired ${stats.retiredDuplicates} duplicate active attempt(s)`);

  // ── 2) STALE CLEANUP: finalize every EXPIRED unsubmitted attempt ────────────
  // (No age floor — this is the one-time offline pass. Preflight already ensured
  // no genuinely-active attempts remain.)
  const unsub = await Attempt.find({
    submitted: false,
    unscorable: { $ne: true },
  }).lean();
  for (const a of unsub) {
    const expired = (await expiryOf(a)) + GRACE_MS < now;
    if (!expired) continue;
    if (APPLY) {
      const before = a.unscorable;
      // finalizeAttempt: scores from autosave, or marks unscorable if exam/user
      // gone. suppressNotifications so we don't spam teachers with old finishes.
      const r = await finalizeAttempt(a, {
        reason: "migration_stale",
        suppressNotifications: true,
      });
      if (r == null) stats.staleUnscorable += 1;
      else stats.staleFinalized += 1;
      void before;
    } else {
      stats.staleFinalized += 1;
    }
  }
  log(
    `2) stale-cleanup: finalized ${stats.staleFinalized}, unscorable ${stats.staleUnscorable} expired unsubmitted attempt(s)`
  );

  // ── 3) BACKFILL Result.attemptId on UNAMBIGUOUS 1:1 pairs ───────────────────
  // Load submitted attempts + Results without attemptId, group by user+exam, and
  // only link when there's EXACTLY one submitted attempt and one Result, with a
  // sane timeline. NEVER force-match.
  const submittedAttempts = await Attempt.find({ submitted: true })
    .select("_id userId examId startedAt expiresAt createdAt")
    .lean();
  const orphanResults = await Result.find({ attemptId: { $exists: false } })
    .select("_id userId examId createdAt")
    .lean();

  const attemptsByKey = new Map();
  for (const a of submittedAttempts) {
    const k = key(a);
    (attemptsByKey.get(k) || attemptsByKey.set(k, []).get(k)).push(a);
  }
  const resultsByKey = new Map();
  for (const r of orphanResults) {
    const k = key(r);
    (resultsByKey.get(k) || resultsByKey.set(k, []).get(k)).push(r);
  }
  // Count TOTAL results per key (incl. already-linked) to judge ambiguity.
  const totalResultsByKey = new Map();
  const allResults = await Result.find({}).select("userId examId").lean();
  for (const r of allResults) {
    const k = key(r);
    totalResultsByKey.set(k, (totalResultsByKey.get(k) || 0) + 1);
  }

  for (const [k, rs] of resultsByKey.entries()) {
    const as = attemptsByKey.get(k) || [];
    // Unambiguous only: exactly one submitted attempt AND exactly one Result total
    // for this user+exam (so we can't attach to the wrong try).
    if (as.length !== 1 || rs.length !== 1 || (totalResultsByKey.get(k) || 0) !== 1) {
      stats.ambiguousSkipped += rs.length;
      continue;
    }
    const a = as[0];
    const r = rs[0];
    // Timeline sanity: Result created between the attempt start and effectiveExpiry+grace.
    const start = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const exp = (await expiryOf(a)) + GRACE_MS;
    const rt = new Date(r.createdAt).getTime();
    if (start && (rt < start - GRACE_MS || rt > exp)) {
      stats.ambiguousSkipped += 1;
      continue;
    }
    stats.backfilled += 1;
    if (APPLY) {
      await Result.updateOne(
        { _id: r._id },
        { $set: { attemptId: new mongoose.Types.ObjectId(a._id) } } // real ObjectId, never a string
      );
    }
  }
  log(
    `3) backfill: linked ${stats.backfilled} Result(s); skipped ${stats.ambiguousSkipped} ambiguous`
  );

  // ── 4) GHOST-FLAG + legacy_unlinked ────────────────────────────────────────
  // A submitted, non-terminal attempt with NO attemptId-linked Result. If the
  // user+exam has NO Result at all -> a true ghost (terminal unscorable). If it
  // has some Result(s) that couldn't be linked -> ambiguous legacy: tag
  // legacy_unlinked (observability only, NOT unscorable).
  for (const a of submittedAttempts) {
    // skip ones we just linked or that are already terminal
    const linked = await Result.exists({ attemptId: a._id });
    if (linked) continue;
    const cur = await Attempt.findById(a._id).select("unscorable").lean();
    if (cur && cur.unscorable) continue;
    const anyResult = (totalResultsByKey.get(key(a)) || 0) > 0;
    if (!anyResult) {
      stats.ghosts += 1;
      if (APPLY) {
        await Attempt.updateOne(
          { _id: a._id },
          { $set: { submitted: true, unscorable: true, unscorableReason: "ghost_no_result" } }
        );
      }
    } else {
      stats.legacyUnlinked += 1;
      if (APPLY) {
        await Attempt.updateOne(
          { _id: a._id },
          { $set: { unscorableReason: "legacy_unlinked" } } // NOT unscorable:true
        );
      }
    }
  }
  log(
    `4) ghost-flag: ${stats.ghosts} ghost(s) -> unscorable; ${stats.legacyUnlinked} tagged legacy_unlinked`
  );

  // ── 5) IDEMPOTENT REPAIR: submitted:false but a Result already exists ───────
  // (crash between Result.create and the submitted flip) — mark submitted + link.
  const stillActive = await Attempt.find({ submitted: false, unscorable: { $ne: true } })
    .select("_id examId userId answers violations terminated expiresAt optionOrder")
    .lean();
  for (const a of stillActive) {
    const hasResult = await Result.exists({ attemptId: a._id });
    if (!hasResult) continue;
    stats.repaired += 1;
    if (APPLY) {
      await finalizeAttempt(a, { reason: "migration_repair", suppressNotifications: true });
    }
  }
  log(`5) repair: ${stats.repaired} submitted:false-with-Result attempt(s) reconciled`);

  // ── 6) BUILD INDEXES ───────────────────────────────────────────────────────
  if (APPLY) {
    await Attempt.createIndexes();
    await Result.createIndexes();
    log("6) indexes: built Attempt + Result indexes");
    const ridx = (await Result.collection.indexes()).map((i) => i.name);
    log("   Result indexes:", ridx.join(", "));
  } else {
    log("6) indexes: (skipped in dry-run)");
  }

  log("\n=== summary ===");
  log(JSON.stringify(stats, null, 2));
  if (!APPLY) log("\nDRY-RUN — no writes. Re-run with --apply to commit.\n");
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error("[MIGRATION] failed:", e);
  process.exit(1);
});
