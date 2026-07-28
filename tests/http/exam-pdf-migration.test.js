/*
 * AUD-013 CR-068/CR-073/CR-074 — the RESUMABLE, byte-safe exam-PDF migration.
 * apply (copy+fsync+checksum+CAS persisting size/hash+source-delete-last) →
 * STRICT verify (size/hash/journal/duplicates/keyed-missing/leftover-source/
 * orphans; corrupt file fails; unapproved-DB refusal exits nonzero) →
 * byte-safe, batch-required, resumable rollback (existing wrong destination is
 * refused with the private copy + journal RETAINED). Failpoints at every apply
 * AND rollback phase prove convergence with no byte loss.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const MIG = path.join(__dirname, "..", "..", "migrations", "2026-07-26-exam-pdf-private.js");
const PRIV = fs.mkdtempSync(path.join(os.tmpdir(), "mig-priv-"));
const UPD = fs.mkdtempSync(path.join(os.tmpdir(), "mig-upl-"));
const KEY = "a".repeat(64);
const PDF_BYTES = Buffer.from("%PDF-1.7\n" + "content" + "\n%%EOF\n", "latin1");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

let URI;
function runMig(args = [], extraEnv = {}, uri = URI) {
  const r = spawnSync(process.execPath, [MIG, ...args], {
    encoding: "utf8",
    env: { ...process.env, MONGO_URI: uri, EXAM_PDF_DIR: PRIV, UPLOADS_DIR: UPD, LEGACY_UPLOADS_ORIGIN: "https://api.x", ...extraEnv },
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
function runMigAsync(args = [], extraEnv = {}, uri = URI) {
  return new Promise((resolve) => {
    const cp = require("child_process").spawn(process.execPath, [MIG, ...args], {
      env: { ...process.env, MONGO_URI: uri, EXAM_PDF_DIR: PRIV, UPLOADS_DIR: UPD, LEGACY_UPLOADS_ORIGIN: "https://api.x", ...extraEnv },
    });
    let out = "";
    cp.stdout.on("data", (d) => (out += d));
    cp.stderr.on("data", (d) => (out += d));
    cp.on("close", (code) => resolve({ code, out }));
  });
}
const batchOf = (out) => (out.match(/batch (\S+?)[)\s]/) || [])[1];
async function db() { await mongoose.connect(URI); return mongoose.connection.db; }
async function disc() { await mongoose.disconnect(); }

async function seedLocal(d, tag, file) {
  fs.writeFileSync(path.join(UPD, file), PDF_BYTES);
  await d.collection("pdfs").insertOne({ tag, path: `https://api.x/uploads/${file}` });
}
async function keyOf(tag) { const d = await db(); const r = await d.collection("pdfs").findOne({ tag }); await disc(); return r && r.key; }

async function main() {
  const mem = await MongoMemoryServer.create();
  URI = mem.getUri("exampdf_priv_test");
  const d = await db();

  await seedLocal(d, "local1", "local1.pdf");
  await seedLocal(d, "local2", "local2.pdf");
  fs.writeFileSync(path.join(UPD, "dup.pdf"), PDF_BYTES);
  fs.writeFileSync(path.join(PRIV, `${KEY}.pdf`), PDF_BYTES);
  await d.collection("pdfs").insertMany([
    { tag: "remote", path: "https://cdn.x/external/y.pdf" },
    { tag: "missing", path: "https://api.x/uploads/gone.pdf" },
    // a valid keyed row carries its authoritative size + hash.
    { tag: "private", key: KEY, size: PDF_BYTES.length, hash: sha(PDF_BYTES) },
    { tag: "unsafe", path: "https://api.x/uploads/../secret.pdf" },
    { tag: "dupA", path: "https://api.x/uploads/dup.pdf" },
    { tag: "dupB", path: "https://api.x/uploads/dup.pdf" },
  ]);
  await disc();

  // 1. DRY RUN — census, read-only.
  const dry = runMig(["--dry-run"]);
  ok("dry-run exits 0 + census correct", dry.code === 0 && /alreadyPrivate=1 local=2 remote=1 missing=1 unsafe=1 duplicate=2/.test(dry.out));
  ok("dry-run READ-ONLY", fs.existsSync(path.join(UPD, "local1.pdf")));

  // 2. CR-074 — a refusal against an UNAPPROVED db name exits NONZERO (not 0).
  const unapproved = runMig(["--verify"], {}, mem.getUri("proddata_live"));
  ok("verify against unapproved DB REFUSES with nonzero exit", unapproved.code === 3 && /Refusing/.test(unapproved.out));

  // 3. VERIFY before apply → blockers → exit 1.
  ok("verify BEFORE apply fails (exit 1)", runMig(["--verify"]).code === 1);

  // 4. APPLY --skip-ambiguous → migrate the two clean locals.
  const apply = runMig(["--apply", "--skip-ambiguous"]);
  const BATCH = batchOf(apply.out);
  ok("apply exits 0 + migrated 2 new", apply.code === 0 && /migrated 2 new/.test(apply.out));
  ok("clean sources removed (source-delete-last)", !fs.existsSync(path.join(UPD, "local1.pdf")) && !fs.existsSync(path.join(UPD, "local2.pdf")));
  const k1 = await keyOf("local1");
  ok("BYTES PRESERVED + authoritative size/hash persisted on the row", await (async () => {
    const dd = await db(); const r = await dd.collection("pdfs").findOne({ tag: "local1" }); await disc();
    return r.key && r.size === PDF_BYTES.length && r.hash === sha(PDF_BYTES) && sha(fs.readFileSync(path.join(PRIV, `${r.key}.pdf`))) === sha(PDF_BYTES);
  })());

  // 5. CR-074 — a CORRUPT keyed file fails STRICT verify (still remote/dup remain too).
  fs.writeFileSync(path.join(PRIV, `${k1}.pdf`), Buffer.from("%PDF-1.7\nDIFFERENT\n%%EOF\n"));
  const corruptV = runMig(["--verify"]);
  ok("verify detects the corrupt keyed file (exit 1 + checksum-mismatch>0)", corruptV.code === 1 && /checksum-mismatch=[1-9]/.test(corruptV.out));
  fs.writeFileSync(path.join(PRIV, `${k1}.pdf`), PDF_BYTES); // restore

  // ── FAILPOINT convergence (apply phases) ──
  async function reset() { const dd = await db(); await dd.collection("exampdfmigrationjournal").deleteMany({}); await disc(); }
  async function seedOne(tag, file) { const dd = await db(); await seedLocal(dd, tag, file); await disc(); }
  async function phaseOf(tag) { const dd = await db(); const j = await dd.collection("exampdfmigrationjournal").findOne({}); const r = await dd.collection("pdfs").findOne({ tag }); await disc(); return { phase: j && j.phase, key: r && r.key }; }

  for (const fp of ["planned", "copied", "committed"]) {
    await reset();
    await seedOne(`fp_${fp}`, `fp_${fp}.pdf`);
    const crash = runMig(["--apply", "--skip-ambiguous"], { EXAM_PDF_MIG_FAILPOINT: fp });
    ok(`apply failpoint ${fp}: aborts (97) + source preserved pre-commit`, crash.code === 97 && (fp === "committed" || fs.existsSync(path.join(UPD, `fp_${fp}.pdf`))));
    const resume = runMig(["--apply", "--skip-ambiguous"]);
    const st = await phaseOf(`fp_${fp}`);
    ok(`apply failpoint ${fp}: resume converges + bytes preserved`, resume.code === 0 && st.phase === "done" && sha(fs.readFileSync(path.join(PRIV, `${st.key}.pdf`))) === sha(PDF_BYTES));
  }

  // ── CR-073 — ROLLBACK safety ──
  await reset();
  await seedOne("rb", "rb.pdf");
  const rbApply = runMig(["--apply", "--skip-ambiguous"]);
  const rbBatch = batchOf(rbApply.out);
  const rbKey = await keyOf("rb");

  // (a) rollback REQUIRES a batch.
  ok("rollback without --batch is REFUSED (exit 2)", runMig(["--rollback"]).code === 2);

  // (b) an EXISTING destination with WRONG bytes → refuse, RETAIN private + journal + key.
  fs.writeFileSync(path.join(UPD, "rb.pdf"), Buffer.from("%PDF-1.7\nATTACKER\n%%EOF\n")); // wrong legacy bytes present
  const badDest = runMig(["--rollback", `--batch=${rbBatch}`]);
  ok("rollback refuses a wrong-bytes destination (exit 1 + dest_mismatch)", badDest.code === 1 && /refused_dest_mismatch/.test(badDest.out));
  ok("… private good copy RETAINED", fs.existsSync(path.join(PRIV, `${rbKey}.pdf`)) && sha(fs.readFileSync(path.join(PRIV, `${rbKey}.pdf`))) === sha(PDF_BYTES));
  ok("… DB key RETAINED (not cleared)", (await keyOf("rb")) === rbKey);
  ok("… journal RETAINED", await (async () => { const dd = await db(); const n = await dd.collection("exampdfmigrationjournal").countDocuments({ batchId: rbBatch }); await disc(); return n === 1; })());

  // (c) clear the bad destination → a clean rollback restores bytes + deletes private LAST.
  fs.unlinkSync(path.join(UPD, "rb.pdf"));
  const goodRb = runMig(["--rollback", `--batch=${rbBatch}`]);
  ok("clean rollback exits 0 + reverted 1", goodRb.code === 0 && /reverted 1\/1/.test(goodRb.out));
  ok("rollback restored the exact bytes to uploads/", fs.existsSync(path.join(UPD, "rb.pdf")) && sha(fs.readFileSync(path.join(UPD, "rb.pdf"))) === sha(PDF_BYTES));
  ok("rollback deleted the private copy LAST", !fs.existsSync(path.join(PRIV, `${rbKey}.pdf`)));
  ok("rollback cleared the row key", (await keyOf("rb")) == null);

  // Remove any leftover local (e.g. a just-reverted) rows + their files so each
  // failpoint iteration migrates EXACTLY one record.
  async function clearLocals() {
    const dd = await db();
    const rows = await dd.collection("pdfs").find({ path: { $regex: "/uploads/" }, $or: [{ key: { $exists: false } }, { key: null }] }).toArray();
    for (const r of rows) { const f = (r.path.split("/uploads/")[1] || "").split(/[?#]/)[0]; try { fs.unlinkSync(path.join(UPD, f)); } catch {} await dd.collection("pdfs").deleteOne({ _id: r._id }); }
    await disc();
  }

  // ── CR-073 — ROLLBACK failpoint convergence (retain on crash, resume) ──
  for (const fp of ["rb_dest", "rb_cas", "rb_priv"]) {
    await reset();
    await clearLocals();
    await seedOne(`rbfp_${fp}`, `rbfp_${fp}.pdf`);
    const ap = runMig(["--apply", "--skip-ambiguous"]);
    const b = batchOf(ap.out);
    const key = await keyOf(`rbfp_${fp}`);
    const crash = runMig(["--rollback", `--batch=${b}`], { EXAM_PDF_MIG_FAILPOINT: fp });
    ok(`rollback failpoint ${fp}: aborts (97) + journal RETAINED`, crash.code === 97 && await (async () => { const dd = await db(); const n = await dd.collection("exampdfmigrationjournal").countDocuments({ batchId: b }); await disc(); return n === 1; })());
    const resume = runMig(["--rollback", `--batch=${b}`]);
    ok(`rollback failpoint ${fp}: resume converges (exit 0, bytes restored, key cleared)`, resume.code === 0 && fs.existsSync(path.join(UPD, `rbfp_${fp}.pdf`)) && sha(fs.readFileSync(path.join(UPD, `rbfp_${fp}.pdf`))) === sha(PDF_BYTES) && (await keyOf(`rbfp_${fp}`)) == null && !fs.existsSync(path.join(PRIV, `${key}.pdf`)));
  }

  const journalCount = async (b) => { const dd = await db(); const c = await dd.collection("exampdfmigrationjournal").countDocuments({ batchId: b }); await disc(); return c; };
  const pathOf = async (tag) => { const dd = await db(); const r = await dd.collection("pdfs").findOne({ tag }); await disc(); return r && r.path; };

  // ── CR-084 — the EXACT Codex rb_dest→cas conflict: evil key/path mutation ──
  {
    await reset(); await clearLocals();
    await seedOne("cc", "cc.pdf");
    const ap = runMig(["--apply", "--skip-ambiguous"]);
    const b = batchOf(ap.out);
    const key = await keyOf("cc");
    const crash = runMig(["--rollback", `--batch=${b}`], { EXAM_PDF_MIG_FAILPOINT: "rb_dest" });
    ok("CR-084: rollback crashes at rb_dest (97)", crash.code === 97);
    // Concurrently REBIND the row to an evil public URL, removing the key.
    { const dd = await db(); await dd.collection("pdfs").updateOne({ tag: "cc" }, { $unset: { key: "", size: "", hash: "" }, $set: { path: "https://evil.example/rebound.pdf" } }); await disc(); }
    const resume = runMig(["--rollback", `--batch=${b}`]);
    ok("CR-084: resume DETECTS the conflict → nonzero + cas_conflict (NOT reverted)", resume.code === 1 && /cas_conflict/.test(resume.out) && !/reverted 1\/1/.test(resume.out));
    ok("CR-084: private copy + journal RETAINED after the conflict", fs.existsSync(path.join(PRIV, `${key}.pdf`)) && (await journalCount(b)) === 1);
    ok("CR-084: the evil row state is left untouched (not silently 'reverted')", (await pathOf("cc")) === "https://evil.example/rebound.pdf");
  }

  // ── CR-084 — a MISSING row at rb_dest→cas is a conflict, not silent success ──
  {
    await reset(); await clearLocals();
    await seedOne("mr", "mr.pdf");
    const b = batchOf(runMig(["--apply", "--skip-ambiguous"]).out);
    const key = await keyOf("mr");
    runMig(["--rollback", `--batch=${b}`], { EXAM_PDF_MIG_FAILPOINT: "rb_dest" });
    { const dd = await db(); await dd.collection("pdfs").deleteOne({ tag: "mr" }); await disc(); }
    const resume = runMig(["--rollback", `--batch=${b}`]);
    ok("CR-084: missing row at cas → conflict (nonzero) + private/journal retained", resume.code === 1 && /cas_conflict/.test(resume.out) && fs.existsSync(path.join(PRIV, `${key}.pdf`)) && (await journalCount(b)) === 1);
  }

  // ── CR-089 — a FOREIGN worker's partial temp is LEFT UNTOUCHED; rollback still
  //    converges via its own run-owned temp + atomic hard-link install ──
  {
    await reset(); await clearLocals();
    await seedOne("pt", "pt.pdf");
    const b = batchOf(runMig(["--apply", "--skip-ambiguous"]).out);
    const foreign = path.join(UPD, `pt.pdf.deadbeefdeadbeef.rbtmp`); // another worker's partial (unpredictable name)
    fs.writeFileSync(foreign, Buffer.from("ANOTHER-WORKER-PARTIAL"));
    const rb = runMig(["--rollback", `--batch=${b}`]);
    ok("CR-089: rollback restores EXACT bytes and NEVER removes another worker's partial", rb.code === 0 && /reverted 1\/1/.test(rb.out) && sha(fs.readFileSync(path.join(UPD, "pt.pdf"))) === sha(PDF_BYTES) && fs.existsSync(foreign));
    fs.rmSync(foreign, { force: true });
  }

  // ── CR-089 — a destination CREATED at the final install boundary with the SAME
  //    journaled bytes is accepted (no overwrite); with DIFFERENT bytes it is
  //    refused. This is the exact Linux-rename TOCTOU the hard-link install closes. ──
  {
    await reset(); await clearLocals();
    await seedOne("pm", "pm.pdf");
    const b = batchOf(runMig(["--apply", "--skip-ambiguous"]).out);
    const rb = runMig(["--rollback", `--batch=${b}`], { EXAM_PDF_RB_PREEMPT_DEST: "match" });
    ok("CR-089: a concurrently-created dest with the SAME bytes is accepted (no overwrite; reverted)", rb.code === 0 && /reverted 1\/1/.test(rb.out) && sha(fs.readFileSync(path.join(UPD, "pm.pdf"))) === sha(PDF_BYTES));
  }
  {
    await reset(); await clearLocals();
    await seedOne("px", "px.pdf");
    const b = batchOf(runMig(["--apply", "--skip-ambiguous"]).out);
    const key = await keyOf("px");
    const rb = runMig(["--rollback", `--batch=${b}`], { EXAM_PDF_RB_PREEMPT_DEST: "mismatch" });
    ok("CR-089: a concurrently-created dest with DIFFERENT bytes is REFUSED (never overwritten); private+journal retained", rb.code === 1 && /refused_dest_mismatch/.test(rb.out) && fs.existsSync(path.join(PRIV, `${key}.pdf`)) && (await journalCount(b)) === 1);
    // The foreign destination was left exactly as the concurrent writer wrote it.
    ok("CR-089: the mismatched destination was NOT overwritten by rollback", fs.readFileSync(path.join(UPD, "px.pdf")).toString() === "DIFFERENT-BYTES");
  }

  // ── CR-089 — an injected install-time EBUSY RETAINS the record (private + journal)
  //    and a retry converges. One worker never advances on an fs install failure. ──
  {
    await reset(); await clearLocals();
    await seedOne("eb", "eb.pdf");
    const b = batchOf(runMig(["--apply", "--skip-ambiguous"]).out);
    const key = await keyOf("eb");
    const busy = runMig(["--rollback", `--batch=${b}`], { EXAM_PDF_RB_LINK_FAIL: "EBUSY" });
    ok("CR-089: an install-time EBUSY RETAINS the private copy + journal (exit 1, dest not created)", busy.code === 1 && /refused_install_failed/.test(busy.out) && fs.existsSync(path.join(PRIV, `${key}.pdf`)) && !fs.existsSync(path.join(UPD, "eb.pdf")) && (await journalCount(b)) === 1);
    const retry = runMig(["--rollback", `--batch=${b}`]);
    ok("CR-089: the retry (no injected error) converges — exact bytes restored, key cleared", retry.code === 0 && /reverted 1\/1/.test(retry.out) && sha(fs.readFileSync(path.join(UPD, "eb.pdf"))) === sha(PDF_BYTES) && (await keyOf("eb")) == null);
  }

  // ── CR-089 — TWO independent, CONCURRENT rollback workers converge with no
  //    corruption or overwrite (unpredictable owned temps + atomic hard-link). ──
  {
    await reset(); await clearLocals();
    await seedOne("tw", "tw.pdf");
    const b = batchOf(runMig(["--apply", "--skip-ambiguous"]).out);
    const [w1, w2] = await Promise.all([
      runMigAsync(["--rollback", `--batch=${b}`]),
      runMigAsync(["--rollback", `--batch=${b}`]),
    ]);
    const restored = fs.existsSync(path.join(UPD, "tw.pdf")) && sha(fs.readFileSync(path.join(UPD, "tw.pdf"))) === sha(PDF_BYTES);
    const cleared = (await keyOf("tw")) == null;
    const noStrayTmp = fs.readdirSync(UPD).every((f) => !f.endsWith(".rbtmp"));
    ok("CR-089: two concurrent rollback workers converge (exact bytes, key cleared, no stray temp, no corruption)", restored && cleared && noStrayTmp && (w1.code === 0 || w2.code === 0));
  }

  // ── CR-089 — a journal oldPath whose /uploads filename MISMATCHES the validated
  //    basename is REFUSED before any DB write-back (no blind path restore). ──
  {
    const dd = await db();
    await dd.collection("exampdfmigrationjournal").deleteMany({});
    await dd.collection("exampdfmigrationjournal").insertOne({ _id: new (require("mongoose").Types.ObjectId)(), batchId: "op", filename: "rb.pdf", key: "a".repeat(64), oldPath: "https://api.x/uploads/DIFFERENT.pdf", checksum: "b".repeat(64), size: 10, phase: "done" });
    await disc();
    const rb = runMig(["--rollback", "--batch=op"]);
    ok("CR-089: a journal oldPath filename≠validated basename is REFUSED (no blind DB write-back)", rb.code === 1 && /refused_corrupt_journal/.test(rb.out));
  }

  // ── CR-084 — a corrupt/traversal journal entry is REFUSED (no fs access) ──
  {
    await reset(); await clearLocals();
    const dd = await db();
    await dd.collection("exampdfmigrationjournal").insertOne({ _id: new (require("mongoose").Types.ObjectId)(), batchId: "evil", filename: "../../etc/passwd", key: "a".repeat(64), oldPath: "https://api.x/uploads/x.pdf", checksum: "b".repeat(64), size: 10, phase: "done" });
    await disc();
    const rb = runMig(["--rollback", "--batch=evil"]);
    ok("CR-084: a traversal-filename journal entry is REFUSED (nonzero, no fs escape)", rb.code === 1 && /refused_corrupt_journal/.test(rb.out));
  }

  // ── CR-080 — strict verify blocks a keyed row that RETAINS a public path ──
  {
    const dd = await db();
    await dd.collection("pdfs").deleteMany({});
    await dd.collection("exampdfmigrationjournal").deleteMany({});
    const key = "c".repeat(64);
    fs.writeFileSync(path.join(PRIV, `${key}.pdf`), PDF_BYTES);
    await dd.collection("pdfs").insertOne({ tag: "kp", key, size: PDF_BYTES.length, hash: sha(PDF_BYTES), path: "https://public-cdn.example/exam.pdf" });
    await disc();
    const v = runMig(["--verify"]);
    ok("verify BLOCKS a keyed row retaining a public path (exit 1 + keyed-with-path>=1)", v.code === 1 && /keyed-with-path=[1-9]/.test(v.out));
  }

  // ── CR-080 — strict verify blocks an INCONSISTENT completed (done) journal ──
  {
    const dd = await db();
    await dd.collection("pdfs").deleteMany({});
    await dd.collection("exampdfmigrationjournal").deleteMany({});
    const key = "d".repeat(64);
    fs.writeFileSync(path.join(PRIV, `${key}.pdf`), PDF_BYTES);
    const { insertedId } = await dd.collection("pdfs").insertOne({ tag: "ij", key, size: PDF_BYTES.length, hash: sha(PDF_BYTES) });
    // a `done` journal whose key/size/checksum deliberately DISAGREE with the row/bytes.
    await dd.collection("exampdfmigrationjournal").insertOne({ _id: insertedId, batchId: "b", filename: "x.pdf", key, size: 999, checksum: "deadbeef".repeat(8), phase: "done" });
    await disc();
    const v = runMig(["--verify"]);
    ok("verify BLOCKS an inconsistent done-journal (exit 1 + done-journal-bad>=1)", v.code === 1 && /done-journal-bad=[1-9]/.test(v.out));
  }

  // ── CR-083 — apply BINDS a migrated row to its referencing Exam ──
  {
    const dd = await db();
    await dd.collection("pdfs").deleteMany({});
    await dd.collection("exampdfmigrationjournal").deleteMany({});
    await dd.collection("exams").deleteMany({});
    for (const f of fs.readdirSync(PRIV)) { try { fs.unlinkSync(path.join(PRIV, f)); } catch {} } // clear leftover private files (orphan check)
    fs.writeFileSync(path.join(UPD, "bound.pdf"), PDF_BYTES);
    const owner = new (require("mongoose").Types.ObjectId)();
    const { insertedId: pdfId } = await dd.collection("pdfs").insertOne({ tag: "bound", path: "https://api.x/uploads/bound.pdf" });
    const { insertedId: examId } = await dd.collection("exams").insertOne({ name: "E", owner, pdf: pdfId, duration: 600, price: 0, totalMarks: 100, passingMarks: 50 });
    await disc();
    const ap = runMig(["--apply"]);
    ok("apply migrates + BINDS the row (state attached, owner+examId from the exam)", await (async () => {
      const c = await db(); const r = await c.collection("pdfs").findOne({ tag: "bound" }); await disc();
      return ap.code === 0 && r.state === "attached" && String(r.owner) === String(owner) && String(r.examId) === String(examId);
    })());
    ok("verify PASSES for the bound migrated row (exit 0)", runMig(["--verify"]).code === 0);
  }

  // ── CR-083 — verify BLOCKS a keyed row with zero referencing exams (orphan) ──
  {
    const dd = await db();
    await dd.collection("pdfs").deleteMany({});
    await dd.collection("exampdfmigrationjournal").deleteMany({});
    await dd.collection("exams").deleteMany({});
    const key = "e".repeat(64);
    fs.writeFileSync(path.join(PRIV, `${key}.pdf`), PDF_BYTES);
    await dd.collection("pdfs").insertOne({ tag: "orphan", key, state: "attached", size: PDF_BYTES.length, hash: sha(PDF_BYTES), owner: new (require("mongoose").Types.ObjectId)() });
    await disc();
    const v = runMig(["--verify"]);
    ok("verify BLOCKS a zero-reference keyed row (exit 1 + unbound-keyed>=1)", v.code === 1 && /unbound-keyed=[1-9]/.test(v.out));
  }

  // ── CR-088 — STRICT terminal-binding verify (native raw documents). Each seeds a
  //    checksum-correct private file so only the BINDING field varies; verify must
  //    BLOCK every missing/mismatched/non-live/ambiguous binding. ──
  const oid = () => new mongoose.Types.ObjectId();
  async function freshWorld() {
    const dd = await db();
    await dd.collection("pdfs").deleteMany({});
    await dd.collection("exampdfmigrationjournal").deleteMany({});
    await dd.collection("exams").deleteMany({});
    for (const f of fs.readdirSync(PRIV)) { try { fs.unlinkSync(path.join(PRIV, f)); } catch {} }
    return dd;
  }
  const privRow = (over) => { const key = sha(String(Math.random()) + Object.keys(over).join()).slice(0, 64); fs.writeFileSync(path.join(PRIV, `${key}.pdf`), PDF_BYTES); return { key, size: PDF_BYTES.length, hash: sha(PDF_BYTES), ...over }; };
  const mkExam = (over) => ({ name: "E", duration: 600, price: 0, totalMarks: 100, passingMarks: 50, ...over });

  // (1) The EXACT Codex reproduction: a `staged`, owner/examId-less keyed row that
  //     ONE exam references. Previously passed; must now BLOCK.
  {
    const dd = await freshWorld();
    const owner = oid();
    const { insertedId: pid } = await dd.collection("pdfs").insertOne(privRow({ tag: "cr088_staged", state: "staged" }));
    await dd.collection("exams").insertOne(mkExam({ owner, pdf: pid }));
    await disc();
    const v = runMig(["--verify"]);
    ok("CR-088: exam→(staged, owner/examId-less) keyed row BLOCKS (exit 1 + exam-ref-unbound>=1)", v.code === 1 && /exam-ref-unbound=[1-9]/.test(v.out));
  }
  // (2) attached row referenced by an exam but MISSING owner → block.
  {
    const dd = await freshWorld();
    const owner = oid();
    const { insertedId: pid } = await dd.collection("pdfs").insertOne(privRow({ tag: "cr088_noowner", state: "attached", examId: oid() /* set below to match */ }));
    const { insertedId: eid } = await dd.collection("exams").insertOne(mkExam({ owner, pdf: pid }));
    await dd.collection("pdfs").updateOne({ _id: pid }, { $set: { examId: eid }, $unset: { owner: "" } });
    await disc();
    const v = runMig(["--verify"]);
    ok("CR-088: attached exam-referenced row MISSING owner BLOCKS (exit 1)", v.code === 1 && /exam-ref-unbound=[1-9]/.test(v.out));
  }
  // (3) attached row referenced by an exam but MISSING examId → block.
  {
    const dd = await freshWorld();
    const owner = oid();
    const { insertedId: pid } = await dd.collection("pdfs").insertOne(privRow({ tag: "cr088_noexam", state: "attached", owner }));
    await dd.collection("exams").insertOne(mkExam({ owner, pdf: pid }));
    await disc();
    const v = runMig(["--verify"]);
    ok("CR-088: attached exam-referenced row MISSING examId BLOCKS (exit 1)", v.code === 1 && /exam-ref-unbound=[1-9]/.test(v.out));
  }
  // (4) attached row whose examId POINTS ELSEWHERE (mismatch) → block.
  {
    const dd = await freshWorld();
    const owner = oid();
    const { insertedId: pid } = await dd.collection("pdfs").insertOne(privRow({ tag: "cr088_mismatch", state: "attached", owner, examId: oid() }));
    await dd.collection("exams").insertOne(mkExam({ owner, pdf: pid }));
    await disc();
    const v = runMig(["--verify"]);
    ok("CR-088: attached row with a MISMATCHED examId BLOCKS (exit 1)", v.code === 1 && /exam-ref-unbound=[1-9]/.test(v.out));
  }
  // (5) attached row referenced by TWO exams → block (duplicate reference).
  {
    const dd = await freshWorld();
    const owner = oid();
    const { insertedId: pid } = await dd.collection("pdfs").insertOne(privRow({ tag: "cr088_dup", state: "attached", owner, examId: oid() }));
    await dd.collection("exams").insertMany([mkExam({ owner, pdf: pid }), mkExam({ owner, pdf: pid })]);
    await disc();
    const v = runMig(["--verify"]);
    ok("CR-088: an attached row referenced by TWO exams BLOCKS (exit 1)", v.code === 1 && /(exam-ref-unbound|unbound-keyed)=[1-9]/.test(v.out));
  }
  // (6) a NON-LIVE (deleting) row an exam references → block.
  {
    const dd = await freshWorld();
    const owner = oid();
    const { insertedId: pid } = await dd.collection("pdfs").insertOne(privRow({ tag: "cr088_deleting", state: "deleting", owner, examId: oid() }));
    await dd.collection("exams").insertOne(mkExam({ owner, pdf: pid }));
    await disc();
    const v = runMig(["--verify"]);
    ok("CR-088: exam→a non-live (deleting) keyed row BLOCKS (exit 1)", v.code === 1 && /exam-ref-unbound=[1-9]/.test(v.out));
  }
  // (7) APPLY BACKFILLS an already-private, single-exam-referenced but UNBOUND row
  //     (state:staged, no owner/examId) via exact CAS → then verify PASSES.
  {
    const dd = await freshWorld();
    const owner = oid();
    const { insertedId: pid } = await dd.collection("pdfs").insertOne(privRow({ tag: "cr088_backfill", state: "staged" }));
    const { insertedId: eid } = await dd.collection("exams").insertOne(mkExam({ owner, pdf: pid }));
    await disc();
    const ap = runMig(["--apply"]);
    const bound = await (async () => { const c = await db(); const r = await c.collection("pdfs").findOne({ tag: "cr088_backfill" }); await disc(); return r; })();
    ok("CR-088: apply BACKFILLS an already-private unbound row (state attached, owner+examId from the exam)", ap.code === 0 && /backfilled 1/.test(ap.out) && bound.state === "attached" && String(bound.owner) === String(owner) && String(bound.examId) === String(eid));
    ok("CR-088: verify PASSES after the backfill (exit 0)", runMig(["--verify"]).code === 0);
  }
  // (8) apply must NOT overwrite a DIFFERENT existing binding (cross-owner) — leave it to verify.
  {
    const dd = await freshWorld();
    const ownerA = oid(), ownerB = oid();
    const { insertedId: pid } = await dd.collection("pdfs").insertOne(privRow({ tag: "cr088_cross", state: "attached", owner: ownerA, examId: oid() }));
    await dd.collection("exams").insertOne(mkExam({ owner: ownerB, pdf: pid }));
    await disc();
    const ap = runMig(["--apply"]);
    const row = await (async () => { const c = await db(); const r = await c.collection("pdfs").findOne({ tag: "cr088_cross" }); await disc(); return r; })();
    ok("CR-088: apply does NOT rewrite a cross-owner binding; verify BLOCKS it (exit 1)", ap.code === 0 && /backfilled 0/.test(ap.out) && String(row.owner) === String(ownerA) && runMig(["--verify"]).code === 1);
  }

  // ── CR-092 — a concurrent DIFFERENT binding BETWEEN the backfill read and its CAS
  //    is NEVER overwritten and NEVER counted; apply surfaces a conflict and BLOCKS. ──
  {
    const dd = await freshWorld();
    const owner = oid();
    const { insertedId: pid } = await dd.collection("pdfs").insertOne(privRow({ tag: "cr092", state: "staged" })); // eligible, unbound
    const { insertedId: eid } = await dd.collection("exams").insertOne(mkExam({ owner, pdf: pid }));
    await disc();
    // The seam rebinds the row to a DIFFERENT owner/examId after the read, before the CAS.
    const ap = runMig(["--apply"], { EXAM_PDF_MIG_BACKFILL_MUTATE: "1" });
    const row = await (async () => { const c = await db(); const r = await c.collection("pdfs").findOne({ tag: "cr092" }); await disc(); return r; })();
    ok("CR-092: a concurrent rebind between read+CAS is NOT overwritten, NOT counted, and apply BLOCKS (nonzero)",
      ap.code !== 0 && /backfilled 0/.test(ap.out) && /backfill-conflicts=1/.test(ap.out) && String(row.owner) !== String(owner) && String(row.examId) !== String(eid));
  }

  // ── CR-093 — a journal with an ATTACKER-ORIGIN oldPath (filename matches) is
  //    REFUSED; the DB key, private bytes and journal are all RETAINED. ──
  {
    const dd = await db();
    await dd.collection("pdfs").deleteMany({});
    await dd.collection("exampdfmigrationjournal").deleteMany({});
    for (const f of fs.readdirSync(PRIV)) { try { fs.unlinkSync(path.join(PRIV, f)); } catch {} }
    const key = "9".repeat(64);
    fs.writeFileSync(path.join(PRIV, `${key}.pdf`), PDF_BYTES);
    const { insertedId } = await dd.collection("pdfs").insertOne({ tag: "cr093", key, size: PDF_BYTES.length, hash: sha(PDF_BYTES) });
    await dd.collection("exampdfmigrationjournal").insertOne({ _id: insertedId, batchId: "atk", filename: "rollback.pdf", key, oldPath: "https://attacker.example/uploads/rollback.pdf", checksum: sha(PDF_BYTES), size: PDF_BYTES.length, phase: "done" });
    await disc();
    const rb = runMig(["--rollback", "--batch=atk"]);
    ok("CR-093: an attacker-origin oldPath is REFUSED (nonzero); key + private bytes + journal retained",
      rb.code === 1 && /refused_corrupt_journal/.test(rb.out) && (await keyOf("cr093")) === key && fs.existsSync(path.join(PRIV, `${key}.pdf`)) && (await journalCount("atk")) === 1);
  }

  await mem.stop();
  for (const dir of [PRIV, UPD]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
