/*
 * CR-101/CR-103 — the canonicalize-exam-acquisition migration is FAIL-CLOSED,
 * lifecycle-complete, and GRANT-LINEAGE bound. Each backfill stamps an internal
 * ownership marker on the User (`_acqMig:{exam,batch,nonce}`) atomically with the
 * exam ref; the journal (deterministic `_id="<user>:<exam>"`) carries the same
 * batch+nonce. This proves:
 *   - resume converges a crash between the grant and the journal 'done' (a planned
 *     row can NEVER linger while verify/re-apply pass);
 *   - a legitimate remove→re-acquire (no marker) is preserved by rollback;
 *   - an ordinary owned grant IS rolled back;
 *   - verify strictly reconciles journal↔marker↔canonical both ways;
 *   - two workers converge; finalize clears markers/journal after the rollback window.
 * Plus the OPERATIONAL reverse-projection repair CLI (never touches canonical).
 */
const path = require("path");
const { spawnSync, spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const MIG = path.join(__dirname, "..", "..", "migrations", "2026-07-28-canonicalize-exam-acquisition.js");
const REPAIR = path.join(__dirname, "..", "..", "scripts", "repairExamUsersProjection.js");
const JOURNAL = "examacquisitioncanonjournal";
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const { ObjectId } = mongoose.Types;
const jId = (u, e) => `${String(u)}:${String(e)}`;
const TERMINAL_PHASES = ["done", "preserved"];

function runMig(uri, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [MIG, ...args], { encoding: "utf8", env: { ...process.env, MONGO_URI: uri, ...extraEnv } });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
function runRepair(uri, args) {
  const r = spawnSync(process.execPath, [REPAIR, ...args], { encoding: "utf8", env: { ...process.env, MONGO_URI: uri } });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
function runMigAsync(uri, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [MIG, ...args], { env: { ...process.env, MONGO_URI: uri } });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}
const batchOf = (out) => (out.match(/batch (\S+?)\)/) || [])[1];

const U1 = new ObjectId(), U2 = new ObjectId(), U3 = new ObjectId(), U4 = new ObjectId(), UMISSING = new ObjectId();
const E1 = new ObjectId(), E2 = new ObjectId(), E3 = new ObjectId(), E4 = new ObjectId(), E5 = new ObjectId();

async function withDb(uri, fn) { await mongoose.connect(uri); try { return await fn(mongoose.connection.db); } finally { await mongoose.disconnect(); } }
async function seed(uri) {
  await withDb(uri, async (db) => {
    await db.collection("users").deleteMany({});
    await db.collection("exams").deleteMany({});
    await db.collection(JOURNAL).deleteMany({});
    await db.collection("users").insertMany([
      { _id: U1, exams: [] },              // reverse-only legit holder (backfill target)
      { _id: U2, exams: [] },              // reverse-only to a DELETED exam (orphan)
      { _id: U3, exams: [E4] },            // canonical-only (reverse missing → rebuild)
      { _id: U4, exams: [E5] },            // consistent pair
    ]);
    await db.collection("exams").insertMany([
      { _id: E1, users: [U1] },
      { _id: E2, users: [UMISSING] },
      { _id: E3, users: [U2], deletedAt: new Date() },
      { _id: E4, users: [] },
      { _id: E5, users: [U4] },
    ]);
  });
}
const userExams = (uri, id) => withDb(uri, async (db) => ((await db.collection("users").findOne({ _id: id })).exams || []).map(String));
const examUsers = (uri, id) => withDb(uri, async (db) => ((await db.collection("exams").findOne({ _id: id })).users || []).map(String));
const markersOf = (uri, id) => withDb(uri, async (db) => ((await db.collection("users").findOne({ _id: id }))._acqMig || []));
const journalDoc = (uri, jid) => withDb(uri, async (db) => db.collection(JOURNAL).findOne({ _id: jid }));
const journalCount = (uri, q = {}) => withDb(uri, async (db) => db.collection(JOURNAL).countDocuments(q));
// mimic the runtime canonical-removal (exam + marker) and an ordinary re-acquire (no marker)
const nativeRemove = (uri, u, e) => withDb(uri, async (db) => db.collection("users").updateOne({ _id: u }, { $pull: { exams: e, _acqMig: { exam: e } } }));
const nativeAcquire = (uri, u, e) => withDb(uri, async (db) => db.collection("users").updateOne({ _id: u }, { $addToSet: { exams: e } }));
const stampMarker = (uri, u, m) => withDb(uri, async (db) => db.collection("users").updateOne({ _id: u }, { $addToSet: { _acqMig: m } }));

async function main() {
  const mem = await MongoMemoryServer.create();
  const TEST = mem.getUri("canon_acq_test");
  const PROD = mem.getUri("examopia_live");

  // ── A. FAIL-CLOSED refusals (every mode nonzero; rollback/finalize need --batch). ──
  ok("A1 unapproved --dry-run refuses NONZERO", runMig(PROD, ["--dry-run"]).code !== 0);
  ok("A2 unapproved --verify refuses NONZERO", runMig(PROD, ["--verify"]).code !== 0);
  ok("A3 unapproved --apply refuses NONZERO", runMig(PROD, ["--apply"]).code !== 0);
  ok("A4 unapproved --rollback refuses NONZERO", runMig(PROD, ["--rollback", "--batch=x"]).code !== 0);
  ok("A5 unapproved --finalize refuses NONZERO", runMig(PROD, ["--finalize", "--batch=x"]).code !== 0);
  await seed(TEST);
  ok("A6 rollback WITHOUT --batch refused (exit 2)", runMig(TEST, ["--rollback"]).code === 2);
  ok("A7 finalize WITHOUT --batch refused (exit 2)", runMig(TEST, ["--finalize"]).code === 2);

  // ── B. dry-run census, read-only. ──
  const dry = runMig(TEST, ["--dry-run"]);
  ok("B1 dry-run reports reverse-only(legit/orphan) + canonical-only, exits 0", dry.code === 0 && /reverse-only pairs = 3 \(legit 1, orphan 2\)/.test(dry.out) && /canonical-only pairs = 1/.test(dry.out));
  ok("B2 dry-run mutated nothing (U1 canonical still empty, no marker)", (await userExams(TEST, U1)).length === 0 && (await markersOf(TEST, U1)).length === 0);

  // ── C. apply backfills + STAMPS MARKERS + rebuilds; verify both ways; idempotent. ──
  ok("C1 verify BEFORE apply fails (exit 1)", runMig(TEST, ["--verify"]).code === 1);
  const apply = runMig(TEST, ["--apply"]);
  const batch = batchOf(apply.out);
  ok("C2 apply exits 0, backfilled 1, dropped 2 orphans, residual 0/0", apply.code === 0 && /backfilled 1 /.test(apply.out) && /dropped 2 orphan/.test(apply.out) && /residual reverse-only=0 canonical-only=0/.test(apply.out) && !!batch);
  ok("C3 legit reverse-only BACKFILLED into canonical (U1.exams has E1)", (await userExams(TEST, U1)).includes(String(E1)));
  const m1 = await markersOf(TEST, U1);
  ok("C4 the backfill stamped an ownership MARKER on U1 (exam+batch+nonce)", m1.length === 1 && String(m1[0].exam) === String(E1) && m1[0].batch === batch && typeof m1[0].nonce === "string" && m1[0].nonce.length > 0);
  ok("C5 the journal row is deterministic-id, done, same batch+nonce", await (async () => { const j = await journalDoc(TEST, jId(U1, E1)); return j && j.phase === "done" && j.batchId === batch && j.nonce === m1[0].nonce; })());
  ok("C6 orphan reverse-only (missing user) dropped (E2.users empty)", (await examUsers(TEST, E2)).length === 0);
  ok("C7 reverse-only to DELETED exam not backfilled + dropped (U2 empty, E3.users empty)", (await userExams(TEST, U2)).length === 0 && (await examUsers(TEST, E3)).length === 0);
  ok("C8 canonical-only rebuilt into reverse (E4.users has U3) with NO marker on U3", (await examUsers(TEST, E4)).includes(String(U3)) && (await markersOf(TEST, U3)).length === 0);
  ok("C9 verify AFTER apply passes (both directions, exit 0)", runMig(TEST, ["--verify"]).code === 0);
  ok("C10 re-apply idempotent (backfilled 0), still one marker", /backfilled 0 /.test(runMig(TEST, ["--apply"]).out) && (await markersOf(TEST, U1)).length === 1);

  // ── D. CR-103 failure #1 — crash AFTER grant+marker, BEFORE journal 'done' (owned
  //      response loss). Resume reconciles the 'granting' row to done. ──
  await seed(TEST);
  const dg = runMig(TEST, ["--apply"], { EXAM_ACQ_MIG_FAILPOINT: "granted" });
  ok("D1 failpoint 'granted' aborts after the grant+marker, before 'done' (exit 97)", dg.code === 97);
  ok("D2 the crash state: U1 has E1 + a marker, journal row is GRANTING (nonterminal)", (await userExams(TEST, U1)).includes(String(E1)) && (await markersOf(TEST, U1)).length === 1 && (await journalDoc(TEST, jId(U1, E1))).phase === "granting");
  ok("D3 verify REJECTS the lingering nonterminal journal (exit 1) — not a false pass", runMig(TEST, ["--verify"]).code === 1);
  ok("D4 re-apply RECONCILES the granting row to done (verify then passes)", runMig(TEST, ["--apply"]).code === 0 && runMig(TEST, ["--verify"]).code === 0 && (await journalDoc(TEST, jId(U1, E1))).phase === "done");

  // ── CR-104. THE reproduced race: crash at 'planned' → the user acquires the exam
  //     NORMALLY (ref, no marker) → resume must NOT stamp a marker onto that grant,
  //     and rollback must PRESERVE the user's legitimate acquisition. ──
  await seed(TEST);
  const c104 = runMig(TEST, ["--apply"], { EXAM_ACQ_MIG_FAILPOINT: "planned" });
  ok("CR104-1 failpoint 'planned' aborts after journaling, before any user mutation (exit 97)", c104.code === 97);
  ok("CR104-2 pre-resume: U1 has NO ref and NO marker (nothing granted yet)", !(await userExams(TEST, U1)).includes(String(E1)) && (await markersOf(TEST, U1)).length === 0);
  const c104batch = (await journalDoc(TEST, jId(U1, E1))).batchId; // the journal row's own batch
  await nativeAcquire(TEST, U1, E1); // the user acquires the exam NORMALLY (ref, no marker)
  const c104re = runMig(TEST, ["--apply"]);
  ok("CR104-3 re-apply classifies the pre-existing normal grant as PRESERVED (adds NO marker)", c104re.code === 0 && /preserved 1/.test(c104re.out) && (await markersOf(TEST, U1)).length === 0 && (await journalDoc(TEST, jId(U1, E1))).phase === "preserved");
  ok("CR104-4 verify PASSES with the preserved terminal outcome (exit 0)", runMig(TEST, ["--verify"]).code === 0);
  const c104rb = runMig(TEST, ["--rollback", `--batch=${c104batch}`]);
  ok("CR104-5 rollback PRESERVES the user's legitimate acquisition (U1 STILL holds E1, marker-free)", c104rb.code === 0 && /preserved/.test(c104rb.out) && (await userExams(TEST, U1)).includes(String(E1)) && (await markersOf(TEST, U1)).length === 0);

  // ── CR-104b. A 'granting' row with NO ownership evidence must FAIL CLOSED (never
  //     auto-regrant) — protects a removal that raced after an owned grant. ──
  await seed(TEST);
  const gjid = jId(U1, E1);
  await withDb(TEST, (db) => db.collection(JOURNAL).insertOne({ _id: gjid, userId: U1, examId: E1, batchId: "b-orphan", nonce: "n-orphan", phase: "granting" }));
  await withDb(TEST, (db) => db.collection("exams").updateOne({ _id: E1 }, { $set: { users: [] } })); // no reverse-only left to grant
  runMig(TEST, ["--apply"]);
  ok("CR104b-1 an orphaned 'granting' row (no ref/marker) is NOT regranted — U1 stays empty", !(await userExams(TEST, U1)).includes(String(E1)) && (await markersOf(TEST, U1)).length === 0);
  ok("CR104b-2 fail closed: the row stays NONTERMINAL (granting/conflict) and verify BLOCKS", !TERMINAL_PHASES.includes((await journalDoc(TEST, gjid)).phase) && runMig(TEST, ["--verify"]).code === 1);

  // ── E. remove→re-acquire DRIFTS the recorded state (done row, but the marker is
  //     gone). CR-105 strict preflight REFUSES the batch rollback (nonzero, no
  //     mutation) — the user's re-acquired grant is left fully intact. ──
  await seed(TEST);
  const eb = batchOf(runMig(TEST, ["--apply"]).out);
  await nativeRemove(TEST, U1, E1);   // legitimate removal (pulls exam + marker)
  await nativeAcquire(TEST, U1, E1);  // legitimate re-acquire (NO marker)
  ok("E1 after remove→re-acquire U1 holds E1 again but carries NO marker", (await userExams(TEST, U1)).includes(String(E1)) && (await markersOf(TEST, U1)).length === 0);
  const erb = runMig(TEST, ["--rollback", `--batch=${eb}`]);
  ok("E2 rollback of the DRIFTED batch is REFUSED (nonzero) and leaves the grant intact", erb.code === 1 && /REFUSED/.test(erb.out) && (await userExams(TEST, U1)).includes(String(E1)));

  // ── F. Ordinary owned rollback DOES remove the migration grant. ──
  await seed(TEST);
  const fb = batchOf(runMig(TEST, ["--apply"]).out);
  const frb = runMig(TEST, ["--rollback", `--batch=${fb}`]);
  ok("F1 owned rollback reverts the backfilled grant (U1 no longer holds E1, marker gone)", frb.code === 0 && /reverted/.test(frb.out) && !(await userExams(TEST, U1)).includes(String(E1)) && (await markersOf(TEST, U1)).length === 0);
  ok("F2 rollback rebuilt the reverse index (E1.users empty)", (await examUsers(TEST, E1)).length === 0);

  // ── G. wrong batch + foreign marker. ──
  await seed(TEST);
  const gb = batchOf(runMig(TEST, ["--apply"]).out);
  ok("G1 rollback with the WRONG batch reverts nothing (U1 keeps E1)", runMig(TEST, ["--rollback", "--batch=not-the-batch"]).code === 0 && (await userExams(TEST, U1)).includes(String(E1)));
  await stampMarker(TEST, U4, { exam: E5, batch: "foreign-batch", nonce: "deadbeef" }); // foreign marker, no journal
  ok("G2 verify REJECTS a foreign marker with no matching journal (exit 1)", runMig(TEST, ["--verify"]).code === 1);
  await withDb(TEST, (db) => db.collection("users").updateOne({ _id: U4 }, { $pull: { _acqMig: { batch: "foreign-batch" } } }));
  ok("G3 clearing the foreign marker restores verify (exit 0) for batch " + gb, runMig(TEST, ["--verify"]).code === 0);

  // ── H. journal-only + marker-only orphans both fail verify. ──
  await seed(TEST); runMig(TEST, ["--apply"]);
  await withDb(TEST, (db) => db.collection(JOURNAL).insertOne({ _id: jId(U4, E4), userId: U4, examId: E4, batchId: "ghost", nonce: "n", phase: "done" }));
  ok("H1 verify REJECTS a journal(done) with no matching marker/ref (exit 1)", runMig(TEST, ["--verify"]).code === 1);
  await withDb(TEST, (db) => db.collection(JOURNAL).deleteOne({ _id: jId(U4, E4) }));
  await stampMarker(TEST, U3, { exam: E4, batch: "ghost2", nonce: "n2" }); // marker with no journal
  ok("H2 verify REJECTS a marker with no matching journal (exit 1)", runMig(TEST, ["--verify"]).code === 1);

  // ── I. two concurrent workers converge (deterministic journal id). ──
  await seed(TEST);
  const [ia, ib] = await Promise.all([runMigAsync(TEST, ["--apply"]), runMigAsync(TEST, ["--apply"])]);
  ok("I1 both concurrent workers exit 0", ia.code === 0 && ib.code === 0);
  ok("I2 exactly one journal row and one marker for the backfilled pair", (await journalCount(TEST, { _id: jId(U1, E1) })) === 1 && (await markersOf(TEST, U1)).length === 1);
  ok("I3 verify passes after the two-worker race", runMig(TEST, ["--verify"]).code === 0);

  // ── J. finalize clears markers+journal after the rollback window. ──
  await seed(TEST);
  const jb = batchOf(runMig(TEST, ["--apply"]).out);
  const fin = runMig(TEST, ["--finalize", `--batch=${jb}`]);
  ok("J1 finalize clears the batch markers + journal (exit 0)", fin.code === 0 && (await markersOf(TEST, U1)).length === 0 && (await journalCount(TEST)) === 0);
  ok("J2 verify still passes after finalize (canonical/reverse invariant holds)", runMig(TEST, ["--verify"]).code === 0 && (await userExams(TEST, U1)).includes(String(E1)));
  ok("J3 rollback after finalize is a no-op (nothing to revert; grant kept)", runMig(TEST, ["--rollback", `--batch=${jb}`]).code === 0 && (await userExams(TEST, U1)).includes(String(E1)));

  // ── K. OPERATIONAL reverse-projection repair CLI (fail-closed; canonical untouched). ──
  ok("K0 repair CLI refuses an unapproved db NONZERO", runRepair(PROD, ["--json"]).code !== 0);
  await seed(TEST);
  const dryR = JSON.parse(runRepair(TEST, ["--dry-run", "--json"]).out.trim().split(/\r?\n/).pop());
  ok("K1 repair --dry-run detects drift, repairs nothing", dryR.examsDrifted >= 2 && dryR.examsRepaired === 0 && (await examUsers(TEST, E4)).length === 0);
  const repM = JSON.parse(runRepair(TEST, ["--json"]).out.trim().split(/\r?\n/).pop());
  ok("K2 repair rebuilds reverse from canonical (E4.users has U3; stale E1 ref dropped)", repM.examsRepaired >= 2 && (await examUsers(TEST, E4)).includes(String(U3)) && (await examUsers(TEST, E1)).length === 0);
  ok("K3 repair NEVER mutates canonical User.exams (U3 keeps E4; U1 still empty)", (await userExams(TEST, U3)).includes(String(E4)) && (await userExams(TEST, U1)).length === 0);
  ok("K4 a second repair run is idempotent (no drift)", JSON.parse(runRepair(TEST, ["--json"]).out.trim().split(/\r?\n/).pop()).examsDrifted === 0);

  // ══ CR-105 — fail-closed rollback/finalize CLI boundary ══
  // L. THE reproduced sequence: crash at 'granting' → rollback & finalize must REFUSE
  //    (nonzero, ZERO mutation), leaving the legacy reverse grant + journal intact.
  await seed(TEST);
  const lcrash = runMig(TEST, ["--apply"], { EXAM_ACQ_MIG_FAILPOINT: "granting" });
  ok("L1 crash at 'granting' before the user CAS (exit 97)", lcrash.code === 97);
  const lbatch = (await journalDoc(TEST, jId(U1, E1))).batchId;
  const before = JSON.stringify({ u: await userExams(TEST, U1), e: await examUsers(TEST, E1), j: await journalDoc(TEST, jId(U1, E1)) });
  const lrb = runMig(TEST, ["--rollback", `--batch=${lbatch}`]);
  ok("L2 rollback of the unresolved batch is REFUSED nonzero (no rebuild, no removal)", lrb.code === 1 && /REFUSED/.test(lrb.out));
  const lfin = runMig(TEST, ["--finalize", `--batch=${lbatch}`]);
  ok("L3 finalize of the unresolved batch is REFUSED nonzero (journal not deleted)", lfin.code === 1 && /REFUSED/.test(lfin.out));
  const after = JSON.stringify({ u: await userExams(TEST, U1), e: await examUsers(TEST, E1), j: await journalDoc(TEST, jId(U1, E1)) });
  ok("L4 the refused commands left User, Exam and journal BYTE-FOR-BYTE unchanged", before === after);
  ok("L5 the legacy reverse grant survives (E1.users has U1) and verify BLOCKS", (await examUsers(TEST, E1)).includes(String(U1)) && runMig(TEST, ["--verify"]).code === 1);

  // M. finalize is RESUMABLE — a crash after marker cleanup, before journal delete,
  //    converges on retry (response loss).
  await seed(TEST);
  const mb = batchOf(runMig(TEST, ["--apply"]).out);
  const mf1 = runMig(TEST, ["--finalize", `--batch=${mb}`], { EXAM_ACQ_MIG_FAILPOINT: "finalize_marker" });
  ok("M1 finalize failpoint 'finalize_marker' aborts mid-sequence (exit 97)", mf1.code === 97);
  ok("M2 crash window: the marker is gone but the journal row is 'finalizing' (not deleted)", (await markersOf(TEST, U1)).length === 0 && (await journalDoc(TEST, jId(U1, E1))).phase === "finalizing");
  ok("M3 verify BLOCKS on the in-flight 'finalizing' row (exit 1)", runMig(TEST, ["--verify"]).code === 1);
  const mf2 = runMig(TEST, ["--finalize", `--batch=${mb}`]);
  ok("M4 a re-run RESUMES finalize to completion (journal + markers gone, exit 0)", mf2.code === 0 && (await journalCount(TEST)) === 0 && (await markersOf(TEST, U1)).length === 0);
  ok("M5 verify passes after the finalize resume (grant intact)", runMig(TEST, ["--verify"]).code === 0 && (await userExams(TEST, U1)).includes(String(E1)));

  // N. two concurrent finalize workers CONVERGE. Finalize is resumable/idempotent, so
  //    a worker that observes the other mid-cleanup may conservatively exit nonzero
  //    (its postcondition not yet met) — that is fail-closed, not a defect. The
  //    invariant is that the END STATE converges and an idempotent re-run confirms 0.
  await seed(TEST);
  const nb = batchOf(runMig(TEST, ["--apply"]).out);
  const [na, nc] = await Promise.all([runMigAsync(TEST, ["--finalize", `--batch=${nb}`]), runMigAsync(TEST, ["--finalize", `--batch=${nb}`])]);
  ok("N1 neither concurrent finalize worker crashed (exit 0 or a benign nonzero on an intermediate view)", [0, 1].includes(na.code) && [0, 1].includes(nc.code));
  ok("N2 finalize CONVERGED (journal + markers gone; grant intact) and a re-run is idempotent (exit 0)", (await journalCount(TEST)) === 0 && (await markersOf(TEST, U1)).length === 0 && (await userExams(TEST, U1)).includes(String(E1)) && runMig(TEST, ["--finalize", `--batch=${nb}`]).code === 0);

  // O. a FOREIGN/inconsistent marker on a done row makes BOTH commands refuse.
  await seed(TEST);
  const ob = batchOf(runMig(TEST, ["--apply"]).out);
  await withDb(TEST, (db) => db.collection("users").updateOne({ _id: U1 }, { $set: { _acqMig: [{ exam: E1, batch: "foreign", nonce: "x" }] } }));
  ok("O1 rollback REFUSES a done row whose marker is foreign (exit 1, grant untouched)", runMig(TEST, ["--rollback", `--batch=${ob}`]).code === 1 && (await userExams(TEST, U1)).includes(String(E1)));
  ok("O2 finalize REFUSES the same inconsistent batch (exit 1, journal intact)", runMig(TEST, ["--finalize", `--batch=${ob}`]).code === 1 && (await journalCount(TEST, { batchId: ob })) === 1);

  // P. empty / unknown batch is idempotent for both commands.
  await seed(TEST);
  ok("P1 rollback of an empty/unknown batch is idempotent (exit 0)", runMig(TEST, ["--rollback", "--batch=nonexistent-xyz"]).code === 0);
  ok("P2 finalize of an empty/unknown batch is idempotent (exit 0)", runMig(TEST, ["--finalize", "--batch=nonexistent-xyz"]).code === 0);

  // Q. a PRESERVED batch finalizes cleanly (journal cleared, grant kept, no marker).
  await seed(TEST);
  runMig(TEST, ["--apply"], { EXAM_ACQ_MIG_FAILPOINT: "planned" });
  const qbatch = (await journalDoc(TEST, jId(U1, E1))).batchId;
  await nativeAcquire(TEST, U1, E1); // normal acquire → re-apply classifies preserved
  runMig(TEST, ["--apply"]);
  ok("Q3 the pair is classified preserved", (await journalDoc(TEST, jId(U1, E1))).phase === "preserved");
  const qfin = runMig(TEST, ["--finalize", `--batch=${qbatch}`]);
  ok("Q4 finalize of a PRESERVED batch clears the journal, keeps the grant, no marker", qfin.code === 0 && (await journalCount(TEST)) === 0 && (await userExams(TEST, U1)).includes(String(E1)) && (await markersOf(TEST, U1)).length === 0);

  // ══ CR-106 — EXACT + BIDIRECTIONAL preflight ══
  // R. THE reproduced defect: a valid PRESERVED grant + a FOREIGN marker for the SAME
  //    exam. Rollback must REFUSE (byte-for-byte unchanged), NOT delete the journal
  //    while leaving the marker (which then trips strict verify).
  await seed(TEST);
  runMig(TEST, ["--apply"], { EXAM_ACQ_MIG_FAILPOINT: "planned" });
  const r6batch = (await journalDoc(TEST, jId(U1, E1))).batchId;
  await nativeAcquire(TEST, U1, E1); // normal acquire → re-apply classifies preserved
  runMig(TEST, ["--apply"]);
  await stampMarker(TEST, U1, { exam: E1, batch: "foreign", nonce: "zz" }); // FOREIGN marker, same exam
  const r6before = JSON.stringify({ u: await userExams(TEST, U1), m: await markersOf(TEST, U1), j: await journalDoc(TEST, jId(U1, E1)) });
  const r6rb = runMig(TEST, ["--rollback", `--batch=${r6batch}`]);
  ok("R1 preserved + foreign-marker: rollback is REFUSED nonzero (was: exit 0 + orphaned marker)", r6rb.code === 1 && /REFUSED/.test(r6rb.out));
  ok("R2 the refused rollback left User + marker + journal BYTE-FOR-BYTE unchanged", r6before === JSON.stringify({ u: await userExams(TEST, U1), m: await markersOf(TEST, U1), j: await journalDoc(TEST, jId(U1, E1)) }));
  ok("R3 finalize of the same batch is also REFUSED (preserved requires ZERO markers)", runMig(TEST, ["--finalize", `--batch=${r6batch}`]).code === 1 && (await journalCount(TEST, { batchId: r6batch })) === 1);

  // S. `done` + an EXTRA/foreign marker for the exam → not exactly-one → both refuse.
  await seed(TEST);
  const sbatch = batchOf(runMig(TEST, ["--apply"]).out); // U1/E1 done + 1 matching marker
  await stampMarker(TEST, U1, { exam: E1, batch: "foreign", nonce: "yy" });
  ok("S1 done + extra marker: rollback REFUSES (grant untouched)", runMig(TEST, ["--rollback", `--batch=${sbatch}`]).code === 1 && (await userExams(TEST, U1)).includes(String(E1)));
  ok("S2 done + extra marker: finalize REFUSES (journal intact)", runMig(TEST, ["--finalize", `--batch=${sbatch}`]).code === 1 && (await journalCount(TEST, { batchId: sbatch })) === 1);

  // T. a marker carrying THIS batch but with NO matching journal row → bidirectional refuse.
  await seed(TEST);
  const tbatch = batchOf(runMig(TEST, ["--apply"]).out);
  await stampMarker(TEST, U3, { exam: E4, batch: tbatch, nonce: "orphan-marker" }); // no journal for (U3,E4)
  ok("T1 marker-without-journal (same batch) makes rollback REFUSE (bidirectional)", runMig(TEST, ["--rollback", `--batch=${tbatch}`]).code === 1);
  ok("T2 marker-without-journal makes finalize REFUSE too", runMig(TEST, ["--finalize", `--batch=${tbatch}`]).code === 1);

  // U. a malformed `finalizing` row (invalid finalizingFrom) is never skipped → refuse.
  await seed(TEST);
  const ubatch = batchOf(runMig(TEST, ["--apply"]).out);
  await withDb(TEST, (db) => db.collection(JOURNAL).updateOne({ _id: jId(U1, E1) }, { $set: { phase: "finalizing", finalizingFrom: "bogus" } }));
  ok("U1 finalize REFUSES a finalizing row with an invalid finalizingFrom (assertions never skipped)", runMig(TEST, ["--finalize", `--batch=${ubatch}`]).code === 1);

  // V. clean owned batch still rolls back to a strict-verified success (exit 0).
  await seed(TEST);
  const vbatch = batchOf(runMig(TEST, ["--apply"]).out);
  const vrb = runMig(TEST, ["--rollback", `--batch=${vbatch}`]);
  ok("V1 a clean batch rollback passes strict verify and exits 0", vrb.code === 0 && /verify-ok=true/.test(vrb.out) && !(await userExams(TEST, U1)).includes(String(E1)));

  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
