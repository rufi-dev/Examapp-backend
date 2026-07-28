/*
 * CR-099 — the price→0 migration is FAIL-CLOSED, journaled, resumable and
 * byte-exactly reversible:
 *   A. every refusal on an unapproved DB exits NONZERO before connecting
 *      (dry/verify/apply/rollback) — the reproduced verify-exits-0 is gone
 *   B. --rollback requires an explicit --batch
 *   C. dry → verify-fail → apply → verify-ok → idempotent → EXACT rollback
 *   D. a wrong/missing batch restores nothing
 *   E. an exact observed-price CAS turns a concurrent price change into a RETAINED
 *      conflict — never a stale zero under a stale journal
 *   F. a crash mid-apply (failpoint) resumes to convergence; an unfinished journal
 *      row blocks verify even when the price is already 0
 *   G. strict verify enforces price EXACTLY 0 for EVERY exam (missing / negative /
 *      nonnumeric legacy values all block)
 */
const path = require("path");
const { spawnSync, spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const MIG = path.join(__dirname, "..", "..", "migrations", "2026-07-27-free-all-exams.js");
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function runMig(uri, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [MIG, ...args], { encoding: "utf8", env: { ...process.env, MONGO_URI: uri, ...extraEnv } });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const JOURNAL = "exampricemigrationjournal";
const base = { duration: 600, totalMarks: 100, passingMarks: 50, mode: "structured" };

async function seed(uri, docs) {
  await mongoose.connect(uri);
  await mongoose.connection.db.collection("exams").deleteMany({});
  await mongoose.connection.db.collection(JOURNAL).deleteMany({});
  if (docs.length) await mongoose.connection.db.collection("exams").insertMany(docs.map((d) => ({ ...base, ...d })));
  await mongoose.disconnect();
}
async function price(uri, name) { await mongoose.connect(uri); const e = await mongoose.connection.db.collection("exams").findOne({ name }); await mongoose.disconnect(); return e && e.price; }
async function setPrice(uri, name, p) { await mongoose.connect(uri); await mongoose.connection.db.collection("exams").updateOne({ name }, { $set: { price: p } }); await mongoose.disconnect(); }
async function journalCount(uri, q = {}) { await mongoose.connect(uri); const n = await mongoose.connection.db.collection(JOURNAL).countDocuments(q); await mongoose.disconnect(); return n; }
async function markerOf(uri, name) { await mongoose.connect(uri); const e = await mongoose.connection.db.collection("exams").findOne({ name }); await mongoose.disconnect(); return e && e._priceMig; }
async function setMarker(uri, name, marker) { await mongoose.connect(uri); await mongoose.connection.db.collection("exams").updateOne({ name }, marker === null ? { $unset: { _priceMig: "" } } : { $set: { _priceMig: marker } }); await mongoose.disconnect(); }
function runMigAsync(uri, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [MIG, ...args], { env: { ...process.env, MONGO_URI: uri, ...extraEnv } });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}
const batchOf = (out) => (out.match(/batch (\S+?)\)/) || [])[1];

async function main() {
  const mem = await MongoMemoryServer.create();
  const TEST = mem.getUri("free_exams_test");     // throwaway NAME → approved
  const PROD = mem.getUri("examopia_live");        // production-like NAME → refused

  // ── A. FAIL-CLOSED: an unapproved DB refuses in EVERY mode, NONZERO, no mutation.
  ok("A1 unapproved --dry-run refuses NONZERO", runMig(PROD, ["--dry-run"]).code !== 0);
  const av = runMig(PROD, ["--verify"]);
  ok("A2 unapproved --verify refuses NONZERO (the reproduced exit-0 is gone)", av.code !== 0 && /Refusing/.test(av.out));
  ok("A3 unapproved --apply refuses NONZERO", runMig(PROD, ["--apply"]).code !== 0);
  ok("A4 unapproved --rollback refuses NONZERO", runMig(PROD, ["--rollback", "--batch=x"]).code !== 0);
  ok("A5 an approved --db=<name> lets an unapproved-NAMED db proceed", runMig(PROD, ["--dry-run", "--db=examopia_live"]).code === 0);

  // ── B. --rollback REQUIRES --batch.
  await seed(TEST, [{ name: "paidA", price: 5 }, { name: "paidB", price: 10 }, { name: "freeC", price: 0 }]);
  ok("B1 rollback WITHOUT --batch is refused (exit 2)", runMig(TEST, ["--rollback"]).code === 2);

  // ── C. Happy path: dry → verify-fail → apply → verify-ok → idempotent → EXACT rollback.
  const dry = runMig(TEST, ["--dry-run"]);
  ok("C1 dry-run exits 0, counts 2 paid, read-only", dry.code === 0 && /price>0 = 2/.test(dry.out));
  ok("C2 dry-run left prices untouched", (await price(TEST, "paidA")) === 5 && (await price(TEST, "paidB")) === 10);
  ok("C3 verify BEFORE apply fails (exit 1)", runMig(TEST, ["--verify"]).code === 1);
  const apply = runMig(TEST, ["--apply"]);
  const batch = batchOf(apply.out);
  ok("C4 apply exits 0, zeroed 2", apply.code === 0 && /zeroed 2/.test(apply.out) && !!batch);
  ok("C5 both paid exams are now exactly 0", (await price(TEST, "paidA")) === 0 && (await price(TEST, "paidB")) === 0);
  ok("C6 verify AFTER apply passes (exit 0)", runMig(TEST, ["--verify"]).code === 0);
  ok("C7 re-apply is idempotent (zeroed 0)", /zeroed 0/.test(runMig(TEST, ["--apply"]).out));
  const rb = runMig(TEST, ["--rollback", `--batch=${batch}`]);
  ok("C8 rollback restores the EXACT old prices (5 and 10)", rb.code === 0 && (await price(TEST, "paidA")) === 5 && (await price(TEST, "paidB")) === 10);
  ok("C9 journal is emptied after a clean rollback", (await journalCount(TEST)) === 0);

  // ── D. A wrong/nonexistent batch restores nothing; the real batch still works.
  const apply2 = runMig(TEST, ["--apply"]);
  const batch2 = batchOf(apply2.out);
  const rbWrong = runMig(TEST, ["--rollback", "--batch=does-not-exist"]);
  ok("D1 wrong-batch rollback restores 0 (prices stay 0)", /restored 0\/0/.test(rbWrong.out) && (await price(TEST, "paidA")) === 0);
  ok("D2 the correct batch still restores exactly", runMig(TEST, ["--rollback", `--batch=${batch2}`]).code === 0 && (await price(TEST, "paidA")) === 5);

  // ── E. EXACT observed-price CAS: a price changed after journaling becomes a
  //      RETAINED conflict — never a stale zero written under a stale journal.
  await seed(TEST, [{ name: "casA", price: 5 }, { name: "casB", price: 10 }]);
  const f1 = runMig(TEST, ["--apply"], { EXAM_PRICE_MIG_FAILPOINT: "planned" });
  ok("E1 failpoint 'planned' aborts after journaling, before zeroing (exit 97)", f1.code === 97);
  const casAStill = await price(TEST, "casA");
  const casBStill = await price(TEST, "casB");
  ok("E2 nothing was zeroed by the aborted apply (both still paid)", casAStill === 5 && casBStill === 10);
  // A concurrent actor changes whichever exam was journaled first, off its journaled price.
  await mongoose.connect(TEST); const je = await mongoose.connection.db.collection(JOURNAL).findOne({}); await mongoose.disconnect();
  const changedName = je ? (await (async () => { await mongoose.connect(TEST); const d = await mongoose.connection.db.collection("exams").findOne({ _id: je._id }); await mongoose.disconnect(); return d.name; })()) : "casA";
  await setPrice(TEST, changedName, 999);
  const resume = runMig(TEST, ["--apply"]);
  ok("E3 the concurrently-changed exam is NOT zeroed under the stale journal (stays 999)", (await price(TEST, changedName)) === 999);
  ok("E4 the CAS conflict is reported and verify STILL blocks", /conflicts=1/.test(resume.out) && runMig(TEST, ["--verify"]).code === 1);
  ok("E5 the OTHER exam was zeroed normally", (await price(TEST, changedName === "casA" ? "casB" : "casA")) === 0);

  // ── F. Crash mid-apply resumes to convergence; an unfinished journal row blocks
  //      verify even when the price is already 0.
  await seed(TEST, [{ name: "solo", price: 8 }]);
  const fz = runMig(TEST, ["--apply"], { EXAM_PRICE_MIG_FAILPOINT: "zeroed" });
  ok("F1 failpoint 'zeroed' aborts after the CAS zero, before marking done (exit 97)", fz.code === 97);
  ok("F2 the exam IS zeroed but its journal row is unfinished", (await price(TEST, "solo")) === 0 && (await journalCount(TEST, { phase: { $ne: "done" } })) === 1);
  ok("F3 verify BLOCKS on the unfinished journal even though price is already 0", runMig(TEST, ["--verify"]).code === 1);
  const fresume = runMig(TEST, ["--apply"]);
  ok("F4 a plain re-apply RESUMES to convergence (verify then passes)", fresume.code === 0 && runMig(TEST, ["--verify"]).code === 0);
  const fbatch = batchOf(fresume.out) || batchOf(fz.out);
  await mongoose.connect(TEST); const soloJ = await mongoose.connection.db.collection(JOURNAL).findOne({}); await mongoose.disconnect();
  ok("F5 rollback of the resumed batch restores the exact old price (8)", runMig(TEST, ["--rollback", `--batch=${soloJ.batchId}`]).code === 0 && (await price(TEST, "solo")) === 8);

  // ── G. STRICT verify: EVERY exam must be exactly 0. Missing / negative / nonnumeric
  //      legacy prices all block; apply (which targets price>0) does not paper over them.
  await seed(TEST, [{ name: "neg", price: -5 }, { name: "str", price: "9" }, { name: "missing" }, { name: "okzero", price: 0 }]);
  ok("G1 verify BLOCKS while any exam is not EXACTLY 0 (neg/nonnumeric/missing)", runMig(TEST, ["--verify"]).code === 1);
  runMig(TEST, ["--apply"]);
  ok("G2 apply only touches price>0 — verify STILL blocks on the malformed values", runMig(TEST, ["--verify"]).code === 1);
  await setPrice(TEST, "neg", 0); await setPrice(TEST, "str", 0); await setPrice(TEST, "missing", 0);
  ok("G3 once EVERY exam is exactly 0, verify passes", runMig(TEST, ["--verify"]).code === 0);

  // ── H. CR-102 — the EXACT reproduced ambiguity: journal 5 → crash at planned →
  //      an EXTERNAL actor writes price 0 (no marker) → resume must NOT call it
  //      migration-owned, and rollback must NOT restore the stale 5. ──
  await seed(TEST, [{ name: "ext", price: 5 }]);
  const hp = runMig(TEST, ["--apply"], { EXAM_PRICE_MIG_FAILPOINT: "planned" });
  ok("H1 failpoint 'planned' aborts after journaling old-price 5 (exit 97)", hp.code === 97);
  await setPrice(TEST, "ext", 0); // external zero — no ownership marker
  const hres = runMig(TEST, ["--apply"]);
  ok("H2 resume treats the UNMARKED external zero as a CONFLICT, never 'done'", /conflicts=1/.test(hres.out) && (await journalCount(TEST, { phase: "done" })) === 0);
  ok("H3 the exam carries NO migration marker (it was not our write)", !(await markerOf(TEST, "ext")));
  ok("H4 verify BLOCKS (external zero is unfinished, not migration-owned)", runMig(TEST, ["--verify"]).code === 1);
  await mongoose.connect(TEST); const extJ = await mongoose.connection.db.collection(JOURNAL).findOne({}); await mongoose.disconnect();
  const hrb = runMig(TEST, ["--rollback", `--batch=${extJ.batchId}`]);
  ok("H5 rollback does NOT restore the stale 5 over an external zero (price stays 0)", (await price(TEST, "ext")) === 0);
  ok("H6 the external zero is a RETAINED conflict on rollback (nonzero exit, journal kept)", hrb.code === 1 && /RETAINED/.test(hrb.out) && (await journalCount(TEST)) === 1);

  // ── I. CR-102 — a crash DURING rollback (after the restore CAS, before the journal
  //      delete) converges on re-rollback. ──
  await seed(TEST, [{ name: "rbf", price: 7 }]);
  const rbatch = batchOf(runMig(TEST, ["--apply"]).out);
  const rf = runMig(TEST, ["--rollback", `--batch=${rbatch}`], { EXAM_PRICE_MIG_FAILPOINT: "rollback" });
  ok("I1 rollback failpoint aborts after the restore CAS, before the journal delete (exit 97)", rf.code === 97);
  ok("I2 price IS restored but the journal row survives (the crash window)", (await price(TEST, "rbf")) === 7 && (await journalCount(TEST, { batchId: rbatch })) === 1);
  const rf2 = runMig(TEST, ["--rollback", `--batch=${rbatch}`]);
  ok("I3 re-rollback CONVERGES (already-restored, journal cleaned, exit 0)", rf2.code === 0 && (await price(TEST, "rbf")) === 7 && (await journalCount(TEST, { batchId: rbatch })) === 0);

  // ── J. CR-102 — strict verify rejects an ORPHAN on-document marker (no matching
  //      journal), even when the price is already 0. ──
  await seed(TEST, [{ name: "orphanMark", price: 0 }]);
  await setMarker(TEST, "orphanMark", { batch: "no-such-batch", op: "zero" });
  ok("J1 verify REJECTS an orphan marker with no matching journal (exit 1)", runMig(TEST, ["--verify"]).code === 1);
  await setMarker(TEST, "orphanMark", null);
  ok("J2 clearing the orphan marker clears verify (exit 0)", runMig(TEST, ["--verify"]).code === 0);

  // ── K. CR-102 — two concurrent apply workers converge: one journal row + one marker
  //      per exam, every price 0, verify passes. ──
  await seed(TEST, [{ name: "w1", price: 3 }, { name: "w2", price: 4 }, { name: "w3", price: 6 }]);
  const [ka, kb] = await Promise.all([runMigAsync(TEST, ["--apply"]), runMigAsync(TEST, ["--apply"])]);
  ok("K1 both concurrent apply workers exit 0", ka.code === 0 && kb.code === 0);
  ok("K2 every price converged to exactly 0", (await price(TEST, "w1")) === 0 && (await price(TEST, "w2")) === 0 && (await price(TEST, "w3")) === 0);
  ok("K3 exactly one journal row per exam (no duplicate/split)", (await journalCount(TEST)) === 3);
  ok("K4 verify passes (markers reconcile both directions after the race)", runMig(TEST, ["--verify"]).code === 0);

  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
