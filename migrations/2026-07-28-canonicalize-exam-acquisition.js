/*
 * CR-101/CR-103 — canonicalize exam acquisition. `User.exams` is the SOLE source of
 * acquired-exam access; `Exam.users` is a DERIVED reverse projection. Before the
 * getExam reverse-index fallback was removed, this migration backfills every
 * LEGITIMATE legacy reverse-only grant into the canonical `User.exams`, then rebuilds
 * `Exam.users` strictly from the canonical side so the two agree.
 *
 *   node migrations/2026-07-28-canonicalize-exam-acquisition.js --dry-run [--db=<name>]
 *   node migrations/2026-07-28-canonicalize-exam-acquisition.js --apply    --db=<name> [--batch=<id>]
 *   node migrations/2026-07-28-canonicalize-exam-acquisition.js --verify   --db=<name> [--batch=<id>]
 *   node migrations/2026-07-28-canonicalize-exam-acquisition.js --rollback --db=<name> --batch=<id>   (--batch REQUIRED)
 *   node migrations/2026-07-28-canonicalize-exam-acquisition.js --finalize --db=<name> --batch=<id>   (--batch REQUIRED)
 *
 * FAIL-CLOSED: every refusal (contradictory modes, unparsable/unapproved db name,
 * rollback/finalize without --batch) exits NONZERO BEFORE connecting. Native driver.
 *
 * CR-103 — GRANT-LINEAGE OWNERSHIP. The journal alone cannot prove that a canonical
 * `User.exams` entry is the one THIS migration created (a user may legitimately
 * remove and re-acquire an exam after the backfill). So each backfill stamps an
 * internal ownership marker on the USER document — `_acqMig:{exam,batch,nonce}` —
 * in the SAME atomic `$addToSet` as the exam ref. The journal row (deterministic
 * `_id = "<userId>:<examId>"`) carries the identical batch+nonce.
 *
 * CR-104 — the backfill grant is a FAIL-CLOSED attempt state machine, because a user
 * may acquire the exam NORMALLY between a `planned` crash and the resume:
 *   planned   → journal the pair identity + a per-op nonce
 *   granting  → CAS-claim `planned`→`granting` so ONE worker owns the single attempt
 *   done      → the owner's grant CAS (which requires BOTH the exam ref AND any marker
 *               to be ABSENT) succeeded, so the User now carries the exam + our exact
 *               marker; resume reconciles by re-reading, never by re-granting
 *   preserved → the user ALREADY had the exam (ref present, no marker) — an ordinary/
 *               external grant; NO marker is added and rollback never removes it
 *   conflict  → foreign marker, marker-without-ref, missing user, or an ambiguous
 *               `granting` row with no ownership evidence → fail closed, never regrant
 *
 * An ordinary free acquire / teacher assignment creates NO marker, and every
 * canonical-removal path (deleteMyExam, purgeExam) pulls the marker atomically with
 * the exam ref. Therefore a remove→re-acquire carries no old marker and --rollback
 * (which matches EXACT canonical ref + EXACT marker) preserves it. --verify rejects
 * any nonterminal journal, a journal without its matching marker+ref, a marker
 * without its matching done journal, and any wrong-batch / wrong-nonce / orphan
 * marker. Two workers converge through the deterministic journal `_id`.
 *
 * CR-105 — the destructive CLIs are FAIL-CLOSED at a whole-batch boundary. Both
 * --rollback and --finalize run a read-only `preflightBatch()` FIRST and refuse
 * (nonzero, ZERO mutation) if ANY batch row is unresolved (planned/granting/conflict),
 * malformed, or inconsistent with its recorded outcome — so an unresolved `granting`
 * row can never let rollback rebuild away a legitimate reverse-only grant, nor let
 * finalize blindly delete the journal. Both return 0 ONLY after a strict postcondition
 * re-check. --finalize is a RESUMABLE, terminal-only per-row sequence (finalizing
 * INTENT → exact marker cleanup → journal deletion LAST, with failpoints between) that
 * converges on retry. Empty / already-completed batches are idempotent (exit 0).
 *
 * FINALIZATION: --rollback is possible only while the markers+journal exist. Once the
 * rollback window closes, run `--finalize --batch=<id>`. After finalize the batch can
 * no longer be rolled back, and --verify passes (no journal, no markers) because the
 * canonical/reverse invariant still holds.
 */
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const modeFlags = ["--dry-run", "--apply", "--verify", "--rollback", "--finalize"].filter(has);
if (modeFlags.length > 1) { console.error(`\nREFUSED: contradictory modes ${modeFlags.join(" ")}.\n`); process.exit(2); }
const APPLY = has("--apply"), ROLLBACK = has("--rollback"), VERIFY = has("--verify"), FINALIZE = has("--finalize");
const DRY = !APPLY && !ROLLBACK && !VERIFY && !FINALIZE;
const FORCE = has("--force");
const dbArg = (argv.find((a) => a.startsWith("--db=")) || "").split("=")[1] || "";
const batchArg = (argv.find((a) => a.startsWith("--batch=")) || "").split("=")[1] || "";
const JOURNAL = "examacquisitioncanonjournal";
const FAILPOINT = process.env.EXAM_ACQ_MIG_FAILPOINT || ""; // planned | granted | rollback

function dbNameFromUri(uri) { try { const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://")); return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || ""; } catch { return ""; } }
const isThrowaway = (n) => /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(n);
const journalId = (userId, examId) => `${String(userId)}:${String(examId)}`;
function tripwire(phase) { if (FAILPOINT && FAILPOINT === phase) { console.error(`FAILPOINT: aborting after phase "${phase}".`); process.exit(97); } }

// Compute the two mismatch sets from full snapshots (one-time migration scale).
function computeMismatches(users, examsArr) {
  const canonical = new Map(); // examKey -> Set(userKey)
  for (const u of users) for (const ex of (u.exams || [])) { const k = String(ex); if (!canonical.has(k)) canonical.set(k, new Set()); canonical.get(k).add(String(u._id)); }
  const reverse = new Map(); // examKey -> Set(userKey)
  for (const e of examsArr) reverse.set(String(e._id), new Set((e.users || []).map(String)));
  const examById = new Map(examsArr.map((e) => [String(e._id), e]));
  const userIds = new Set(users.map((u) => String(u._id)));

  const reverseOnly = [];
  for (const e of examsArr) for (const uid of (e.users || [])) {
    if (!(canonical.get(String(e._id)) || new Set()).has(String(uid))) {
      const ex = examById.get(String(e._id));
      reverseOnly.push({ exam: e._id, user: uid, legit: !!(ex && !ex.deletedAt && userIds.has(String(uid))) });
    }
  }
  const canonicalOnly = [];
  for (const u of users) for (const ex of (u.exams || [])) {
    if (!(reverse.get(String(ex)) || new Set()).has(String(u._id))) canonicalOnly.push({ exam: ex, user: u._id });
  }
  return { reverseOnly, canonicalOnly };
}

async function loadSnapshots(db) {
  const users = await db.collection("users").find({}, { projection: { _id: 1, exams: 1, _acqMig: 1 } }).toArray();
  const examsArr = await db.collection("exams").find({}, { projection: { _id: 1, users: 1, deletedAt: 1 } }).toArray();
  return { users, examsArr };
}

// Rebuild Exam.users strictly from canonical User.exams, for every exam.
async function rebuildReverse(db) {
  const usersCol = db.collection("users");
  const exams = db.collection("exams");
  let rebuilt = 0;
  for (const e of await exams.find({}, { projection: { _id: 1 } }).toArray()) {
    const holders = (await usersCol.find({ exams: e._id }).project({ _id: 1 }).toArray()).map((h) => h._id);
    await exams.updateOne({ _id: e._id }, { $set: { users: holders } });
    rebuilt += 1;
  }
  return rebuilt;
}

// Backfill ONE legit pair: journal planned (+nonce) → atomic grant+marker → done.
// Resume-safe and idempotent; converges from any crash between the phases.
// Terminal journal phases (verify treats them as resolved).
const TERMINAL = ["done", "preserved"];

// CR-104 — fail-closed grant-ATTEMPT state machine. A backfill grant is attempted
// EXACTLY ONCE, by the worker that CAS-claims the deterministic journal from
// `planned` to `granting`. That grant CAS requires BOTH the canonical exam ref AND
// any marker for it to be ABSENT, so it can NEVER stamp a marker onto a pre-existing
// ordinary acquisition. Everything else only RE-READS and classifies; an ambiguous
// `granting` row is never auto-regranted (fail closed).
async function applyOne(usersCol, journal, userId, examId, batchId) {
  const jid = journalId(userId, examId);
  let j = await journal.findOne({ _id: jid });
  if (!j) {
    const nonce = crypto.randomBytes(6).toString("hex");
    try {
      await journal.updateOne(
        { _id: jid },
        { $setOnInsert: { userId, examId, batchId, nonce, phase: "planned", at: new Date() } },
        { upsert: true }
      );
    } catch (err) { if (err.code !== 11000) throw err; } // race-safe under two workers
    j = await journal.findOne({ _id: jid });
    tripwire("planned");
  }
  if (j.phase === "done") return "already_done";
  if (j.phase === "preserved") return "already_preserved";

  // Claim the SINGLE grant attempt: CAS planned -> granting. Only the winner may
  // perform the grant; a worker that merely FINDS a granting row never grants.
  let iOwnAttempt = false;
  if (j.phase === "planned") {
    const claim = await journal.updateOne({ _id: jid, phase: "planned" }, { $set: { phase: "granting" } });
    if (claim.modifiedCount === 1) { iOwnAttempt = true; j.phase = "granting"; }
    else { j = await journal.findOne({ _id: jid }); }
  }
  if (j.phase === "done") return "already_done";
  if (j.phase === "preserved") return "already_preserved";
  if (j.phase === "conflict") return "conflict";
  // j.phase === "granting"
  tripwire("granting"); // crash AFTER claiming, BEFORE the grant CAS

  if (iOwnAttempt) {
    // THE grant: BOTH the canonical ref AND any marker for this exam must be ABSENT.
    // (The CR-104 fix — the old CAS checked marker-absence only and stamped a marker
    // onto a user's pre-existing normal grant.)
    await usersCol.updateOne(
      { _id: userId, exams: { $ne: examId }, "_acqMig.exam": { $ne: examId } },
      { $addToSet: { exams: examId, _acqMig: { exam: examId, batch: j.batchId, nonce: j.nonce } } }
    );
    tripwire("granted"); // crash AFTER the grant, BEFORE the journal reaches done
  }

  // Classify by re-reading — covers a CAS miss AND a response loss identically.
  const u = await usersCol.findOne({ _id: userId }, { projection: { exams: 1, _acqMig: 1 } });
  const setPhase = (p) => journal.updateOne({ _id: jid, phase: "granting" }, { $set: { phase: p } });
  if (!u) { if (iOwnAttempt) { await setPhase("conflict"); return "conflict"; } return "in_progress"; }
  const hasRef = (u.exams || []).some((e) => String(e) === String(examId));
  const marker = (u._acqMig || []).find((m) => String(m.exam) === String(examId));
  const ourMarker = marker && marker.batch === j.batchId && marker.nonce === j.nonce;

  if (hasRef && ourMarker) { await setPhase("done"); return "granted"; }                   // owned grant / owned response loss
  if (marker && !ourMarker) { await setPhase("conflict"); return "conflict"; }              // FOREIGN marker — unambiguous corruption
  if (hasRef && !marker) { await setPhase("preserved"); return "preserved"; }               // pre-existing ordinary grant — NO marker added
  // No ownership evidence (no ref, no/own marker). ONLY the attempt OWNER may fail it
  // closed — its own just-granted state vanished (a removal raced after the grant).
  // A NON-owner never writes conflict: it may be observing the owner mid-grant, so it
  // leaves the row `granting`. An orphaned `granting` (dead owner) therefore simply
  // stays nonterminal and BLOCKS verify — never silently regranted, never dropped.
  if (iOwnAttempt) { await setPhase("conflict"); return "conflict"; }
  return "in_progress";
}

// Roll back ONE `done` journal row: consume EXACT canonical ref + EXACT marker.
// Runs only after preflight validated the whole batch, so the common path hits the
// exact CAS. A CAS miss is re-read: an idempotent already-reverted or a legit
// re-acquire (ref, no marker) finishes the journal; a FOREIGN/partial state RETAINS
// the journal and returns "conflict" so the command exits nonzero.
async function rollbackOne(usersCol, journal, e) {
  const r = await usersCol.updateOne(
    { _id: e.userId, exams: e.examId, _acqMig: { $elemMatch: { exam: e.examId, batch: e.batchId, nonce: e.nonce } } },
    { $pull: { exams: e.examId, _acqMig: { exam: e.examId, batch: e.batchId, nonce: e.nonce } } }
  );
  tripwire("rollback"); // crash AFTER the consume CAS, BEFORE the journal delete
  if (r.modifiedCount) { await journal.deleteOne({ _id: e._id }); return "reverted"; }
  // CAS miss — re-read and classify (response loss / concurrent change since preflight).
  const u = await usersCol.findOne({ _id: e.userId }, { projection: { exams: 1, _acqMig: 1 } });
  const hasRef = !!(u && (u.exams || []).some((x) => String(x) === String(e.examId)));
  const markers = ((u && u._acqMig) || []).filter((m) => String(m.exam) === String(e.examId));
  if (!hasRef && markers.length === 0) { await journal.deleteOne({ _id: e._id }); return "already_reverted"; }
  if (hasRef && markers.length === 0) { await journal.deleteOne({ _id: e._id }); return "preserved"; } // legit re-acquire (no marker)
  return "conflict"; // foreign marker / partial state — RETAIN journal, force nonzero
}

// CR-105/CR-106 — read-only WHOLE-BATCH preflight for rollback/finalize. EXACT and
// BIDIRECTIONAL: refuses (ok=false + reasons) if ANY batch row is unresolved
// (planned/granting/conflict), malformed, or inconsistent with its recorded outcome,
// OR if any marker carrying this batch lacks its exact journal row.
//   done       → canonical ref + EXACTLY ONE marker for the exam matching this
//                batch/nonce (no foreign or duplicate marker)
//   preserved  → canonical ref + ZERO markers for the exam (a foreign marker on the
//                same exam is a refusal — the CR-106 defect)
//   finalizing → valid `finalizingFrom` (done|preserved), deterministic journal id,
//                typed nonempty batch/nonce, and ONLY the legitimate before/after
//                marker-cleanup state (never skipped)
async function preflightBatch(db, operation, batch) {
  const usersCol = db.collection("users");
  const journal = db.collection(JOURNAL);
  const rows = await journal.find({ batchId: batch }).toArray();
  const reasons = [];
  const allowed = operation === "finalize" ? ["done", "preserved", "finalizing"] : ["done", "preserved"];
  const typedId = (v) => v != null && String(v).length > 0;
  for (const e of rows) {
    // Structural: typed nonempty identity + deterministic journal id.
    if (!e.userId || !e.examId || typeof e.batchId !== "string" || !e.batchId || typeof e.nonce !== "string" || !e.nonce) { reasons.push(`malformed:${e._id}`); continue; }
    if (String(e._id) !== journalId(e.userId, e.examId)) { reasons.push(`bad-journal-id:${e._id}`); continue; }
    if (!allowed.includes(e.phase)) { reasons.push(`${e.phase}:${e._id}`); continue; }
    const u = await usersCol.findOne({ _id: e.userId }, { projection: { exams: 1, _acqMig: 1 } });
    const hasRef = !!(u && (u.exams || []).some((x) => String(x) === String(e.examId)));
    const markers = ((u && u._acqMig) || []).filter((m) => String(m.exam) === String(e.examId));
    const exactlyOneOurs = markers.length === 1 && markers[0].batch === e.batchId && markers[0].nonce === e.nonce;
    if (e.phase === "done") {
      if (!(hasRef && exactlyOneOurs)) reasons.push(`done-inconsistent:${e._id}`);
    } else if (e.phase === "preserved") {
      if (!(hasRef && markers.length === 0)) reasons.push(`preserved-inconsistent:${e._id}`);
    } else if (e.phase === "finalizing") {
      if (e.finalizingFrom !== "done" && e.finalizingFrom !== "preserved") { reasons.push(`finalizing-bad-from:${e._id}`); continue; }
      if (!typedId(e.batchId) || !typedId(e.nonce)) { reasons.push(`finalizing-untyped:${e._id}`); continue; }
      // Legitimate mid-cleanup: BEFORE cleanup (from `done` → exactly-one matching
      // marker still present) or AFTER cleanup (markers pulled → zero). Ref present.
      const beforeDone = e.finalizingFrom === "done" && exactlyOneOurs;
      const afterCleanup = markers.length === 0;
      if (!(hasRef && (beforeDone || afterCleanup))) reasons.push(`finalizing-inconsistent:${e._id}`);
    }
  }
  // Bidirectional: every marker carrying THIS batch must map to exactly one journal
  // row of this batch with the matching nonce.
  for (const u of await usersCol.find({ "_acqMig.batch": batch }, { projection: { _id: 1, _acqMig: 1 } }).toArray()) {
    for (const m of (u._acqMig || [])) {
      if (m.batch !== batch) continue;
      const j = await journal.findOne({ _id: journalId(u._id, m.exam) });
      if (!(j && j.batchId === batch && j.nonce === m.nonce && (j.phase === "done" || j.phase === "finalizing"))) reasons.push(`marker-without-journal:${String(u._id)}:${String(m.exam)}`);
    }
  }
  return { ok: reasons.length === 0, reasons, count: rows.length };
}

// Strict both-directions verification.
async function verifyState(db, batch) {
  const usersCol = db.collection("users");
  const journal = db.collection(JOURNAL);
  const { users, examsArr } = await loadSnapshots(db);
  const usersById = new Map(users.map((u) => [String(u._id), u]));
  const { reverseOnly, canonicalOnly } = computeMismatches(users, examsArr);
  // Nonterminal (unresolved) = anything not in {done, preserved}: planned, granting,
  // conflict all BLOCK verify.
  const unfinished = await journal.countDocuments({ phase: { $nin: TERMINAL } });

  // journal(done) → user still has the canonical ref AND our exact marker.
  let journalMismatch = 0;
  for (const j of await journal.find({ phase: "done" }).toArray()) {
    const u = usersById.get(String(j.userId));
    const hasRef = u && (u.exams || []).some((e) => String(e) === String(j.examId));
    const hasMarker = u && (u._acqMig || []).some((m) => String(m.exam) === String(j.examId) && m.batch === j.batchId && m.nonce === j.nonce);
    if (!(hasRef && hasMarker)) journalMismatch += 1;
  }
  // journal(preserved) → the grant EXISTS (user has the ref) but carries NONE of our
  // markers for it (we deliberately did not own it). A preserved row that lost the
  // ref, or that somehow carries our marker, is a mismatch.
  let preservedMismatch = 0;
  for (const j of await journal.find({ phase: "preserved" }).toArray()) {
    const u = usersById.get(String(j.userId));
    const hasRef = u && (u.exams || []).some((e) => String(e) === String(j.examId));
    const hasOurMarker = u && (u._acqMig || []).some((m) => String(m.exam) === String(j.examId) && m.batch === j.batchId && m.nonce === j.nonce);
    if (!(hasRef && !hasOurMarker)) preservedMismatch += 1;
  }
  // marker → a matching DONE journal row (same batch+nonce) AND the canonical ref.
  let markerMismatch = 0;
  for (const u of users) for (const m of (u._acqMig || [])) {
    const j = await journal.findOne({ _id: journalId(u._id, m.exam) });
    const hasRef = (u.exams || []).some((e) => String(e) === String(m.exam));
    if (!(j && j.phase === "done" && j.batchId === m.batch && j.nonce === m.nonce && hasRef)) markerMismatch += 1;
  }
  const batchUnfinished = batch ? await journal.countDocuments({ batchId: batch, phase: { $nin: TERMINAL } }) : 0;
  const ok = reverseOnly.length === 0 && canonicalOnly.length === 0 && unfinished === 0 && journalMismatch === 0 && preservedMismatch === 0 && markerMismatch === 0 && batchUnfinished === 0;
  return { reverseOnly: reverseOnly.length, canonicalOnly: canonicalOnly.length, unfinished, journalMismatch, preservedMismatch, markerMismatch, ok };
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }
  const dbName = dbNameFromUri(uri);
  if (!dbName) { console.log("Could not parse a database NAME; refusing to contact any DB."); process.exit(3); }
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;
  const mode = ROLLBACK ? "ROLLBACK" : FINALIZE ? "FINALIZE" : APPLY ? "APPLY" : VERIFY ? "VERIFY" : "DRY RUN (read-only)";
  console.log(`\ncanonicalize-exam-acquisition — ${mode}`);
  console.log(`  database: ${dbName}`);
  if (!safe) { console.log(`\n  Target "${dbName}" not a throwaway NAME and no --db=${dbName}. Refusing.\n`); process.exit(3); }
  if ((ROLLBACK || FINALIZE) && !batchArg) { console.log(`\n  REFUSED: --${ROLLBACK ? "rollback" : "finalize"} requires an explicit --batch=<id>.\n`); process.exit(2); }

  // Bound server selection so a concurrent worker fails instead of stalling
  // indefinitely when the target cannot be selected. Do not impose a short socket
  // timeout on the migration's data operations: large reviewed batches may
  // legitimately take longer once a server has been selected.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  const usersCol = db.collection("users");
  const journal = db.collection(JOURNAL);

  if (DRY || VERIFY) {
    if (DRY) {
      const { users, examsArr } = await loadSnapshots(db);
      const { reverseOnly, canonicalOnly } = computeMismatches(users, examsArr);
      const legit = reverseOnly.filter((p) => p.legit).length;
      const unfinished = await journal.countDocuments({ phase: { $nin: TERMINAL } });
      console.log(`  census: reverse-only pairs = ${reverseOnly.length} (legit ${legit}, orphan ${reverseOnly.length - legit}); canonical-only pairs = ${canonicalOnly.length}; nonterminal-journal = ${unfinished}`);
      reverseOnly.slice(0, 10).forEach((p) => console.log(`    reverse-only ${p.legit ? "legit " : "ORPHAN"} exam=${p.exam} user=${p.user}`));
      console.log("\nDRY RUN complete — READ ONLY.\n");
      await mongoose.disconnect(); return process.exit(0);
    }
    const v = await verifyState(db, batchArg);
    console.log(`\nVERIFY — reverse-only=${v.reverseOnly}; canonical-only=${v.canonicalOnly}; nonterminal-journal=${v.unfinished}; journal→marker/ref mismatches=${v.journalMismatch}; preserved mismatches=${v.preservedMismatch}; marker→journal mismatches=${v.markerMismatch}; ok=${v.ok}.\n`);
    await mongoose.disconnect(); return process.exit(v.ok ? 0 : 1);
  }

  if (FINALIZE) {
    // CR-105: refuse (nonzero, NO mutation) unless the WHOLE batch is terminal/consistent.
    const pf = await preflightBatch(db, "finalize", batchArg);
    if (!pf.ok) {
      console.log(`\nFINALIZE REFUSED (batch ${batchArg}): ${pf.reasons.length} unresolved/inconsistent row(s) — ${pf.reasons.slice(0, 8).join("; ")}. NO mutation performed.\n`);
      await mongoose.disconnect(); return process.exit(1);
    }
    // Resumable per-row terminal sequence: finalizing INTENT → exact marker cleanup →
    // journal deletion LAST. Failpoints between phases; a retry converges.
    const entries = await journal.find({ batchId: batchArg, phase: { $in: ["done", "preserved", "finalizing"] } }).toArray();
    let finalized = 0;
    for (const e of entries) {
      if (e.phase !== "finalizing") {
        await journal.updateOne({ _id: e._id, phase: e.phase }, { $set: { phase: "finalizing", finalizingFrom: e.phase } });
        tripwire("finalize_intent");
      }
      await usersCol.updateOne({ _id: e.userId }, { $pull: { _acqMig: { exam: e.examId, batch: e.batchId, nonce: e.nonce } } });
      tripwire("finalize_marker");
      await journal.deleteOne({ _id: e._id }); // journal deletion LAST
      tripwire("finalize_delete");
      finalized += 1;
    }
    const remJournal = await journal.countDocuments({ batchId: batchArg });
    const remMarkers = await usersCol.countDocuments({ "_acqMig.batch": batchArg });
    const v = await verifyState(db, batchArg); // CR-106: full strict verify before exit 0
    const ok = remJournal === 0 && remMarkers === 0 && v.ok;
    console.log(`\nFINALIZE batch ${batchArg}: finalized ${finalized}; remaining-journal=${remJournal}; remaining-markers=${remMarkers}; verify-ok=${v.ok}; ok=${ok}. The batch can no longer be rolled back.\n`);
    await mongoose.disconnect(); return process.exit(ok ? 0 : 1);
  }

  if (ROLLBACK) {
    // CR-105: refuse (nonzero, NO mutation, no rebuild) unless the WHOLE batch is
    // terminal/consistent — an unresolved `granting` row must never let rollback
    // rebuild away a legitimate reverse-only grant.
    const pf = await preflightBatch(db, "rollback", batchArg);
    if (!pf.ok) {
      console.log(`\nROLLBACK REFUSED (batch ${batchArg}): ${pf.reasons.length} unresolved/inconsistent row(s) — ${pf.reasons.slice(0, 8).join("; ")}. NO mutation performed.\n`);
      await mongoose.disconnect(); return process.exit(1);
    }
    const entries = await journal.find({ batchId: batchArg }).toArray();
    const tally = {};
    let inconsistent = 0;
    for (const e of entries) {
      let s;
      if (e.phase === "done") s = await rollbackOne(usersCol, journal, e); // consume exact ref+marker
      else if (e.phase === "preserved") { await journal.deleteOne({ _id: e._id }); s = "preserved"; } // NEVER touch a normal acquisition
      else s = `retained_${e.phase}`; // (should not occur post-preflight)
      if (s === "conflict" || s.startsWith("retained_")) inconsistent += 1;
      tally[s] = (tally[s] || 0) + 1;
    }
    const rebuilt = await rebuildReverse(db);
    const remaining = await journal.countDocuments({ batchId: batchArg });
    const v = await verifyState(db, batchArg); // CR-106: full strict verify before exit 0
    const ok = inconsistent === 0 && remaining === 0 && v.ok;
    console.log(`\nROLLBACK batch ${batchArg}: ${JSON.stringify(tally)} over ${entries.length} entr(ies); rebuilt ${rebuilt} exams; remaining-journal=${remaining}; verify-ok=${v.ok}; ok=${ok}.\n`);
    await mongoose.disconnect(); return process.exit(ok ? 0 : 1);
  }

  // ---- APPLY (resumable) ----
  const batchId = batchArg || `${dbName}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  let backfilled = 0, resumed = 0, preserved = 0, conflicts = 0, skippedOrphan = 0;
  const bump = (s) => { if (s === "granted") return; if (s === "preserved" || s === "already_preserved") preserved += 1; else if (s === "conflict") conflicts += 1; };
  // 1) RESUME every nonterminal journal row first (converge a prior crash) — a resume
  //    of an orphaned `granting` row fails CLOSED, never auto-regrants.
  for (const j of await journal.find({ phase: { $nin: TERMINAL } }).toArray()) {
    const s = await applyOne(usersCol, journal, j.userId, j.examId, j.batchId || batchId);
    if (s === "granted") resumed += 1; else bump(s);
  }
  // 2) Backfill fresh legit reverse-only pairs.
  const { users, examsArr } = await loadSnapshots(db);
  const { reverseOnly } = computeMismatches(users, examsArr);
  for (const p of reverseOnly) {
    if (!p.legit) { skippedOrphan += 1; continue; } // dropped by the rebuild below
    if (await journal.findOne({ _id: journalId(p.user, p.exam) })) continue; // already journaled
    const s = await applyOne(usersCol, journal, p.user, p.exam, batchId);
    if (s === "granted") backfilled += 1; else bump(s);
  }
  const rebuilt = await rebuildReverse(db);
  const v = await verifyState(db, batchId);
  console.log(`\nAPPLIED (batch ${batchId}) — backfilled ${backfilled} (resumed ${resumed}); preserved ${preserved}; conflicts ${conflicts}; dropped ${skippedOrphan} orphan reverse-only; reverse rebuilt over ${rebuilt} exams; residual reverse-only=${v.reverseOnly} canonical-only=${v.canonicalOnly}; nonterminal-journal=${v.unfinished}; ok=${v.ok}.\n`);
  await mongoose.disconnect();
  process.exit(v.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
