/*
 * Payments removed (CR-099) — migrate every exam to FREE (price = 0), FAIL-CLOSED,
 * journaled, resumable and byte-exactly reversible.
 *
 *   node migrations/2026-07-27-free-all-exams.js --dry-run [--db=<name>]
 *   node migrations/2026-07-27-free-all-exams.js --apply --db=<name> [--batch=<id>]
 *   node migrations/2026-07-27-free-all-exams.js --verify --db=<name>
 *   node migrations/2026-07-27-free-all-exams.js --rollback --db=<name> --batch=<id>  (--batch REQUIRED)
 *
 * SAFETY: EVERY refusal (contradictory modes, unparsable/unapproved db name, a
 * rollback without --batch) exits NONZERO BEFORE any DB connection. Contacting a DB
 * requires a throwaway NAME, a matching --db=<name>, or --force. Native driver only.
 *
 * Per-exam journaled state machine (`exampricemigrationjournal`), so no crash or
 * concurrent price change can zero one value while rollback restores another:
 *   planned  → the OBSERVED old price is journaled
 *   done     → the exam is CAS-updated to 0 ONLY while it still equals the exact
 *              journaled price (a concurrent change is a retained `conflict`)
 * --rollback restores the exact committed old price ONLY while the exam is still the
 * migration's 0, retains+reports conflicts, and deletes each journal entry LAST.
 * --verify enforces the terminal invariant: EVERY exam has price EXACTLY 0 (a
 * missing/null/negative/nonnumeric/>0 price all fail) and no journal row is unfinished.
 *
 * A test-only failpoint (EXAM_PRICE_MIG_FAILPOINT = planned|zeroed) aborts right
 * after that phase to prove resume/verify/rollback converge.
 */
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const modeFlags = ["--dry-run", "--apply", "--verify", "--rollback"].filter(has);
if (modeFlags.length > 1) { console.error(`\nREFUSED: contradictory modes ${modeFlags.join(" ")}.\n`); process.exit(2); }
const APPLY = has("--apply"), ROLLBACK = has("--rollback"), VERIFY = has("--verify"), DRY = !APPLY && !ROLLBACK && !VERIFY;
const FORCE = has("--force");
const dbArg = (argv.find((a) => a.startsWith("--db=")) || "").split("=")[1] || "";
const batchArg = (argv.find((a) => a.startsWith("--batch=")) || "").split("=")[1] || "";
const JOURNAL = "exampricemigrationjournal";
const FAILPOINT = process.env.EXAM_PRICE_MIG_FAILPOINT || "";
// CR-102: an on-document OWNERSHIP MARKER written to the SAME exam in the exact CAS
// that zeroes its price. It proves WHO wrote price:0 (this migration, this batch),
// so a price:0 written by an EXTERNAL actor can never be mistaken for migration-owned
// (never marked `done`, never rolled back to a stale old price).
const MARKER = "_priceMig";

function dbNameFromUri(uri) { try { const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://")); return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || ""; } catch { return ""; } }
const isThrowaway = (n) => /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(n);
const isPositiveNumber = (p) => typeof p === "number" && Number.isFinite(p) && p > 0;
function tripwire(phase) { if (FAILPOINT && FAILPOINT === phase) { console.error(`FAILPOINT: aborting after phase "${phase}".`); process.exit(97); } }

// A transient DB error under CONCURRENCY (WriteConflict / interrupted / network /
// pool) is safe to retry because applyOne is an idempotent journaled state machine.
// This makes two concurrent apply workers DETERMINISTICALLY converge to exit 0
// instead of one losing to a transient race.
function isTransient(e) {
  if (!e) return false;
  if ([112, 251, 189, 91, 6, 7, 10107, 11602, 13435, 13436, 133, 64].includes(e.code)) return true;
  if (typeof e.hasErrorLabel === "function" && e.hasErrorLabel("TransientTransactionError")) return true;
  return /WriteConflict|write conflict|interrupted|not master|connection|ECONN|pool|topology|network|socket/i.test(e.message || "");
}
async function withRetry(fn, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { if (!isTransient(e)) throw e; last = e; await new Promise((r) => setTimeout(r, 15 * (i + 1))); }
  }
  throw last;
}

// Zero one exam under the EXACT observed-price CAS, with a durable journal.
async function applyOne(exams, journal, id, batchId, observedPrice) {
  let j = await journal.findOne({ _id: id });
  if (!j) {
    if (!isPositiveNumber(observedPrice)) return "skipped_nonpaid";
    // Race-safe journal claim: an upsert so two concurrent workers converge on ONE
    // journal row (and thus ONE batchId/marker) instead of a duplicate-key crash.
    try {
      await journal.updateOne(
        { _id: id },
        { $setOnInsert: { batchId, oldPrice: observedPrice, phase: "planned", at: new Date() } },
        { upsert: true }
      );
    } catch (error) {
      // Two upserts on the same deterministic _id may both observe "missing"
      // before either insert commits. The loser gets E11000; that is an
      // expected claim race, not a migration failure. Re-read the winner's
      // durable journal below and converge on its batch/old-price lineage.
      if (error?.code !== 11000) throw error;
    }
    j = await journal.findOne({ _id: id });
    tripwire("planned");
  }
  if (j.phase === "planned") {
    // EXACT observed-price CAS: zero a row STILL at the journaled old price AND stamp
    // our ownership marker in the SAME write, so the price:0 is provably ours.
    const r = await exams.updateOne(
      { _id: id, price: j.oldPrice },
      { $set: { price: 0, [MARKER]: { batch: j.batchId, op: "zero" } } }
    );
    tripwire("zeroed");
    if (r.matchedCount === 0) {
      // Not at the journaled price. Resume accepts price:0 as ours ONLY if it carries
      // our EXACT marker (a crash between the CAS and marking done). A price:0 with no
      // marker, or a foreign batch/op, is an EXTERNAL zero → retained conflict, never done.
      const cur = await exams.findOne({ _id: id }, { projection: { price: 1, [MARKER]: 1 } });
      const mine = cur && cur.price === 0 && cur[MARKER] && cur[MARKER].batch === j.batchId && cur[MARKER].op === "zero";
      if (!mine) {
        await journal.updateOne({ _id: id }, { $set: { phase: "conflict" } });
        return "conflict";
      }
      // our own zero (idempotent resume) — fall through to done.
    }
    await journal.updateOne({ _id: id }, { $set: { phase: "done" } });
    return "zeroed";
  }
  if (j.phase === "conflict") return "conflict";
  return "already_done";
}

// Restore one exam's exact committed old price under a marker-scoped CAS.
async function rollbackOne(exams, journal, e) {
  if (!isPositiveNumber(e.oldPrice)) { await journal.deleteOne({ _id: e._id }); return "dropped_nonpaid"; }
  // CR-102: restore ONLY a zero carrying OUR EXACT marker (this batch, op "zero"),
  // and remove the marker in the SAME write. An external zero (no/foreign marker) is
  // NOT ours — it is a retained conflict, never restored to a stale old price.
  const r = await exams.updateOne(
    { _id: e._id, price: 0, [`${MARKER}.batch`]: e.batchId, [`${MARKER}.op`]: "zero" },
    { $set: { price: e.oldPrice }, $unset: { [MARKER]: "" } }
  );
  tripwire("rollback"); // crash AFTER the restore CAS, BEFORE the journal delete
  if (r.matchedCount === 0) {
    // Either already restored by us (price back, marker gone) or a foreign/external zero.
    const cur = await exams.findOne({ _id: e._id }, { projection: { price: 1, [MARKER]: 1 } });
    if (cur && cur.price === e.oldPrice && !cur[MARKER]) { await journal.deleteOne({ _id: e._id }); return "already_restored"; }
    return "conflict"; // retain the journal entry + report
  }
  // Postcondition proven (price === oldPrice, marker cleared) — drop the journal LAST.
  await journal.deleteOne({ _id: e._id });
  return "restored";
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }
  const dbName = dbNameFromUri(uri);
  if (!dbName) { console.log("Could not parse a database NAME; refusing to contact any DB."); process.exit(3); }
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;
  console.log(`\nfree-all-exams migration — ${ROLLBACK ? "ROLLBACK" : APPLY ? "APPLY" : VERIFY ? "VERIFY" : "DRY RUN (read-only)"}`);
  console.log(`  database: ${dbName}`);
  // CR-099: EVERY safety refusal exits NONZERO, BEFORE any connection.
  if (!safe) { console.log(`\n  Target "${dbName}" not a throwaway NAME and no --db=${dbName}. Refusing.\n`); process.exit(3); }
  if (ROLLBACK && !batchArg) { console.log(`\n  REFUSED: --rollback requires an explicit --batch=<id>.\n`); process.exit(2); }

  await mongoose.connect(uri);
  const exams = mongoose.connection.db.collection("exams");
  const journal = mongoose.connection.db.collection(JOURNAL);

  const paidCount = await exams.countDocuments({ price: { $gt: 0 } });
  const nonZero = await exams.countDocuments({ price: { $ne: 0 } });
  const unfinished = await journal.countDocuments({ phase: { $ne: "done" } });
  console.log(`  census: price>0 = ${paidCount}; price!=0 (incl. missing/negative/nonnumeric) = ${nonZero}; unfinished-journal = ${unfinished}`);

  if (DRY) {
    if (nonZero > paidCount) console.log("  NOTE: some exams have a missing/negative/nonnumeric price — --verify will BLOCK until every exam is exactly 0.");
    console.log("\nDRY RUN complete — READ ONLY.\n");
    await mongoose.disconnect(); return process.exit(0);
  }

  if (VERIFY) {
    // STRICT terminal invariant: EVERY exam price is EXACTLY 0, no journal row is
    // unfinished, AND the journal and the on-document markers reconcile BOTH ways.
    const violating = await exams.countDocuments({ price: { $ne: 0 } });
    const batchUnfinished = batchArg ? await journal.countDocuments({ batchId: batchArg, phase: { $ne: "done" } }) : 0;

    // journal(done) → exam must be 0 and carry OUR matching marker.
    let journalToExam = 0;
    for (const j of await journal.find({ phase: "done" }).toArray()) {
      const ex = await exams.findOne({ _id: j._id }, { projection: { price: 1, [MARKER]: 1 } });
      const good = ex && ex.price === 0 && ex[MARKER] && ex[MARKER].op === "zero" && ex[MARKER].batch === j.batchId;
      if (!good) journalToExam += 1;
    }
    // exam(marker) → a done journal row with the matching batch (rejects orphan /
    // mismatch / unfinished / stale markers left by any non-migration writer).
    let markerToJournal = 0;
    for (const ex of await exams.find({ [MARKER]: { $exists: true } }).project({ _id: 1, price: 1, [MARKER]: 1 }).toArray()) {
      const j = await journal.findOne({ _id: ex._id });
      const good = ex.price === 0 && ex[MARKER] && ex[MARKER].op === "zero" && j && j.phase === "done" && j.batchId === ex[MARKER].batch;
      if (!good) markerToJournal += 1;
    }
    const ok = violating === 0 && unfinished === 0 && batchUnfinished === 0 && journalToExam === 0 && markerToJournal === 0;
    console.log(`\nVERIFY — price!=0=${violating}; unfinished=${unfinished}${batchArg ? `; batch-unfinished=${batchUnfinished}` : ""}; journal→exam mismatches=${journalToExam}; marker→journal mismatches=${markerToJournal}; ok=${ok}.\n`);
    await mongoose.disconnect(); return process.exit(ok ? 0 : 1);
  }

  if (ROLLBACK) {
    const entries = await journal.find({ batchId: batchArg }).toArray();
    const tally = {};
    let restored = 0, conflicts = 0;
    for (const e of entries) {
      const status = await rollbackOne(exams, journal, e);
      tally[status] = (tally[status] || 0) + 1;
      if (status === "restored") restored += 1;
      if (status === "conflict") conflicts += 1;
    }
    console.log(`\nROLLBACK batch ${batchArg}: restored ${restored}/${entries.length}; ${JSON.stringify(tally)}.`);
    if (conflicts) console.log(`  ${conflicts} conflict(s) RETAINED for review (price changed after zeroing).`);
    console.log("");
    await mongoose.disconnect(); return process.exit(conflicts ? 1 : 0);
  }

  // ---- APPLY (resumable) ----
  const batchId = batchArg || `${dbName}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  let zeroed = 0, conflicts = 0, resumed = 0;
  // 1) RESUME every unfinished journal row first (converge a prior crash).
  for (const e of await journal.find({ phase: { $ne: "done" } }).toArray()) {
    const s = await withRetry(() => applyOne(exams, journal, e._id, e.batchId || batchId, e.oldPrice));
    if (s === "zeroed") { zeroed += 1; resumed += 1; }
    if (s === "conflict") conflicts += 1;
  }
  // 2) Zero fresh paid exams.
  for (const e of await exams.find({ price: { $gt: 0 } }).project({ _id: 1, price: 1 }).toArray()) {
    if (await journal.findOne({ _id: e._id })) continue;
    const s = await withRetry(() => applyOne(exams, journal, e._id, batchId, e.price));
    if (s === "zeroed") zeroed += 1;
    if (s === "conflict") conflicts += 1;
  }
  // CONCURRENCY: a worker that finishes first may read the GLOBAL counts while a
  // PEER worker is still mid-write (a journal row momentarily "planned"). Its exit
  // code must not depend on the peer's in-flight state — so re-check convergence a
  // bounded number of times. applyOne is idempotent + the data provably converges,
  // so the counts settle to zero once the peer finishes; a REAL conflict (local
  // counter) never clears. This makes two concurrent workers deterministically
  // both exit 0.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let violating = await exams.countDocuments({ price: { $ne: 0 } });
  let stillUnfinished = await journal.countDocuments({ phase: { $ne: "done" } });
  for (let i = 0; i < 20 && conflicts === 0 && (violating > 0 || stillUnfinished > 0); i += 1) {
    await sleep(40);
    violating = await exams.countDocuments({ price: { $ne: 0 } });
    stillUnfinished = await journal.countDocuments({ phase: { $ne: "done" } });
  }
  const ok = violating === 0 && conflicts === 0 && stillUnfinished === 0;
  console.log(`\nAPPLIED (batch ${batchId}) — zeroed ${zeroed} (resumed ${resumed}); conflicts=${conflicts}; remaining price!=0=${violating}; unfinished=${stillUnfinished}; ok=${ok}.\n`);
  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
