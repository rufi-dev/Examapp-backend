/*
 * AUD-013 CR-069/CR-075/CR-079/CR-081 — the DURABLE, mutually-exclusive PDF
 * upload lifecycle. Claim binds owner+exam+opToken; a request must win
 * claimed→attaching BEFORE referencing the Exam; the janitor must win
 * claimed→deleting; the two CONTEND on the same state so only one wins. The exact
 * attach-vs-janitor interleaving Codex reproduced can no longer delete an
 * attached PDF. Cleanup retains the locator on an fs failure. A global invariant
 * asserts no Exam ever references a missing PDF row/file.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-cr079";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-cr079";
process.env.EXAM_PDF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cr079-priv-"));
process.env.PDF_STAGING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cr079-stg-"));

const http = require("http");
const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Exam = require("../../models/examModel");
const PDF = require("../../models/pdfModel");
const { generateToken } = require("../../utils");
const { protect, teacherOnly } = require("../../middleware/authMiddleware");
const {
  uploadPdf, getPdfByExam, claimStagedPdf, beginAttach, attachPdf,
  purgeStagedUploads, deletePdfDurably, deletePdfFile, validatePdfTiming,
} = require("../../controllers/quizController");
const { pathForKey, PDF_STAGING_DIR } = require("../../helper/examPdfStorage");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const { ObjectId } = mongoose.Types;
const PDF_BYTES = Buffer.from("%PDF-1.7\n" + "A".repeat(60) + "\n%%EOF\n", "latin1");
let keyN = 0;
const uniqKey = () => (keyN++).toString(16).padStart(64, "0");

// Assert the GLOBAL invariant: every Exam.pdf points to an existing row whose
// file exists; no attached row is missing its bytes.
async function invariantHolds() {
  for (const e of await Exam.find({ pdf: { $ne: null } }).select("pdf")) {
    const row = await PDF.findById(e.pdf);
    if (!row) return false;
    if (row.key && !fs.existsSync(pathForKey(row.key))) return false;
  }
  return true;
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const owner = await User.create({ name: "O", email: "o@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const other = await User.create({ name: "T", email: "t@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const tok = (u) => generateToken(u._id, u.sessionVersion);

  const app = express();
  const upload = multer({ storage: multer.diskStorage({ destination: (rq, f, cb) => { fs.mkdirSync(PDF_STAGING_DIR, { recursive: true }); cb(null, PDF_STAGING_DIR); }, filename: (rq, f, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}.pdf`) }) });
  app.post("/uploadPdf", protect, teacherOnly, upload.single("file"), uploadPdf);
  app.get("/getPdfByExam/:examId", protect, getPdfByExam);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const staged = (o, over = {}) => PDF.create({ key: uniqKey(), owner: o._id, state: "staged", expiresAt: new Date(Date.now() + 1e6), ...over });
  const exId = () => new ObjectId();

  // ── CR-081: timing config is boot-validated ──
  ok("validatePdfTiming accepts a bounded integer", validatePdfTiming("X", "60000", 1) === 60000);
  ok("validatePdfTiming rejects 0/negative/NaN/fractional/huge", ["0", "-5", "not-a-number", "1.5", String(Number.MAX_SAFE_INTEGER)].every((v) => throws(() => validatePdfTiming("X", v, 1))));
  ok("validatePdfTiming falls back to default when unset", validatePdfTiming("X", undefined, 1234) === 1234);

  // ── claim + attach state machine ──
  const s1 = await staged(owner);
  const ex1 = exId();
  const c1 = await claimStagedPdf(String(s1._id), owner._id, ex1);
  ok("claim → state 'claimed' with an opToken bound to the exam", c1 && c1.state === "claimed" && !!c1.opToken && String(c1.examId) === String(ex1));
  ok("REUSE claim → null", (await claimStagedPdf(String(s1._id), owner._id, exId())) === null);
  ok("THEFT claim (other owner) → null", (await claimStagedPdf(String((await staged(owner))._id), other._id, exId())) === null);
  ok("EXPIRED claim → null", (await claimStagedPdf(String((await staged(owner, { expiresAt: new Date(Date.now() - 1) }))._id), owner._id, exId())) === null);

  ok("beginAttach with the WRONG opToken → false", (await beginAttach(c1._id, owner._id, ex1, "wrong")) === false);
  ok("beginAttach with the correct token → true (claimed→attaching)", (await beginAttach(c1._id, owner._id, ex1, c1.opToken)) === true);
  ok("CR-091: attachPdf with a wrong exam id → 'conflict' (matchedCount 0, not idempotent)", (await attachPdf(c1._id, owner._id, exId(), c1.opToken)) === "conflict");
  ok("CR-091: attachPdf with the exact owner/exam/token → 'attached' (attaching→attached)", (await attachPdf(c1._id, owner._id, ex1, c1.opToken)) === "attached");
  ok("CR-091: re-running attachPdf on the SAME attached row → 'already_attached' (idempotent)", (await attachPdf(c1._id, owner._id, ex1, c1.opToken)) === "already_attached");
  ok("an attached row has cleared its opToken", !(await PDF.findById(c1._id)).opToken);

  // ── CR-079 THE EXACT RACE: janitor classifies a claim, then the attach commits ──
  const rc = await staged(owner);
  const rcExam = exId();
  const rcClaim = await claimStagedPdf(String(rc._id), owner._id, rcExam);
  await PDF.updateOne({ _id: rc._id }, { $set: { claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }); // old ⇒ janitor candidate
  fs.writeFileSync(pathForKey(rc.key), PDF_BYTES);
  const raceJan = await purgeStagedUploads(Date.now(), {
    // Runs AFTER the janitor classified rc as a deletable claim, BEFORE it deletes.
    __afterClassify: async () => {
      await beginAttach(rc._id, owner._id, rcExam, rcClaim.opToken);
      await Exam.create({ _id: rcExam, name: "R", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: exId(), pdf: rc._id });
      await attachPdf(rc._id, owner._id, rcExam, rcClaim.opToken);
    },
  });
  ok("RACE: the now-attached row + file SURVIVE the janitor", (await PDF.findById(rc._id))?.state === "attached" && fs.existsSync(pathForKey(rc.key)));
  ok("RACE: the Exam still references a LIVE PDF (no dangling ref)", String((await Exam.findById(rcExam)).pdf) === String(rc._id));
  ok("RACE: invariant holds (no Exam → missing PDF)", await invariantHolds());

  // ── reverse ordering: janitor wins deleting first → the attach must ABORT ──
  const rv = await staged(owner);
  const rvExam = exId();
  const rvClaim = await claimStagedPdf(String(rv._id), owner._id, rvExam);
  fs.writeFileSync(pathForKey(rv.key), PDF_BYTES);
  const del = await deletePdfDurably(rv._id, ["claimed"], "janitor"); // janitor wins first
  ok("janitor won claimed→deleting and removed the row+bytes", del === "deleted" && !(await PDF.findById(rv._id)) && !fs.existsSync(pathForKey(rv.key)));
  ok("a subsequent beginAttach on the deleted/deleting row ABORTS (false)", (await beginAttach(rv._id, owner._id, rvExam, rvClaim.opToken)) === false);

  // ── two janitors / stuck deleting resume ──
  const st = await staged(owner, { expiresAt: new Date(Date.now() - 1) });
  fs.writeFileSync(pathForKey(st.key), PDF_BYTES);
  // Simulate a crash after acquiring `deleting` (row stuck deleting, file present).
  await PDF.updateOne({ _id: st._id }, { $set: { state: "deleting", deleteToken: "stale", deletingAt: new Date() } });
  const resume = await purgeStagedUploads();
  ok("a stuck 'deleting' row is resumed to completion (row+bytes gone)", !(await PDF.findById(st._id)) && !fs.existsSync(pathForKey(st.key)));
  ok("resume reported a removal", resume.removed >= 1);

  // ── janitor classification: staged-expired / crashed-claim / attaching-orphan / committed-claim / fresh / orphan-file ──
  const long = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const expiredStaged = await staged(owner, { expiresAt: new Date(Date.now() - 1) }); fs.writeFileSync(pathForKey(expiredStaged.key), PDF_BYTES);
  const crashedClaim = await PDF.create({ key: uniqKey(), owner: owner._id, state: "claimed", examId: exId(), opToken: "t", claimedAt: long }); fs.writeFileSync(pathForKey(crashedClaim.key), PDF_BYTES);
  const attachingOrphan = await PDF.create({ key: uniqKey(), owner: owner._id, state: "attaching", examId: exId(), opToken: "t", claimedAt: long }); fs.writeFileSync(pathForKey(attachingOrphan.key), PDF_BYTES);
  const committedClaim = await PDF.create({ key: uniqKey(), owner: owner._id, state: "claimed", examId: exId(), opToken: "t", claimedAt: long });
  await Exam.create({ _id: committedClaim.examId, name: "E", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: exId(), pdf: committedClaim._id });
  fs.writeFileSync(pathForKey(committedClaim.key), PDF_BYTES);
  const freshStaged = await staged(owner); fs.writeFileSync(pathForKey(freshStaged.key), PDF_BYTES);
  const attachedLive = await PDF.create({ key: uniqKey(), owner: owner._id, state: "attached", examId: exId() }); fs.writeFileSync(pathForKey(attachedLive.key), PDF_BYTES);
  const orphanKey = uniqKey(); fs.writeFileSync(pathForKey(orphanKey), PDF_BYTES);

  const jan = await purgeStagedUploads();
  ok("janitor removed expired-staged + crashed-claim bytes+rows", !(await PDF.findById(expiredStaged._id)) && !(await PDF.findById(crashedClaim._id)) && !fs.existsSync(pathForKey(crashedClaim.key)));
  ok("janitor RETAINED + alerted an uncertain 'attaching' orphan (never deleted)", (await PDF.findById(attachingOrphan._id))?.state === "attaching" && fs.existsSync(pathForKey(attachingOrphan.key)) && jan.attachingRetained >= 1);
  ok("janitor RECONCILED a committed claim to 'attached' (kept)", (await PDF.findById(committedClaim._id))?.state === "attached" && fs.existsSync(pathForKey(committedClaim.key)));
  ok("janitor KEPT a fresh staged + a live attached row", (await PDF.findById(freshStaged._id))?.state === "staged" && (await PDF.findById(attachedLive._id))?.state === "attached");
  ok("janitor swept an orphan private file", !fs.existsSync(pathForKey(orphanKey)));
  ok("invariant holds after the full janitor sweep", await invariantHolds());

  // ── CR-081: an fs failure RETAINS the locator (no row loss) ──
  const busy = await PDF.create({ key: uniqKey(), owner: owner._id, state: "attached", examId: exId() });
  fs.writeFileSync(pathForKey(busy.key), PDF_BYTES);
  const origUnlink = fs.promises.unlink;
  fs.promises.unlink = async () => { const e = new Error("busy"); e.code = "EBUSY"; throw e; };
  const retStatus = await deletePdfDurably(busy._id, ["attached"], "test");
  fs.promises.unlink = origUnlink;
  ok("a non-ENOENT unlink failure RETAINS the row (state 'deleting') + reports 'retained'", retStatus === "retained" && (await PDF.findById(busy._id))?.state === "deleting" && fs.existsSync(pathForKey(busy.key)));
  const retry = await deletePdfDurably(busy._id, ["deleting"], "retry");
  ok("a later retry converges (row+bytes removed)", retry === "deleted" && !(await PDF.findById(busy._id)) && !fs.existsSync(pathForKey(busy.key)));

  // ── uploadPdf still returns an owner-bound staged locator ──
  const upRes = await new Promise((resolve) => {
    const b = "----b" + Math.random().toString(36).slice(2);
    const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="q.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), PDF_BYTES, Buffer.from(`\r\n--${b}--\r\n`)]);
    const rq = http.request({ host: "127.0.0.1", port, method: "POST", path: "/uploadPdf", headers: { "Content-Type": `multipart/form-data; boundary=${b}`, "Content-Length": body.length, Authorization: `Bearer ${tok(owner)}` } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString() || "{}") })); });
    rq.write(body); rq.end();
  });
  const up = await PDF.findById(upRes.body.uploadId);
  ok("uploadPdf → owner-bound state 'staged' with size/hash + file", upRes.status === 200 && up.state === "staged" && String(up.owner) === String(owner._id) && up.size === PDF_BYTES.length && fs.existsSync(pathForKey(up.key)));

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  for (const d of [process.env.EXAM_PDF_DIR, process.env.PDF_STAGING_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
