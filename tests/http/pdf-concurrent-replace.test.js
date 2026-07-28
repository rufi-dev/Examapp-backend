/*
 * AUD-013 CR-083 — concurrent PDF replacement is safe and the BIDIRECTIONAL
 * invariant holds. Two concurrent replacements race an EXACT expected-old-ref CAS
 * on Exam.pdf: exactly one wins, and the loser DURABLY reclaims its own new
 * upload — never leaving an `attached` orphan. `attached` rows keep an immutable
 * owner+examId binding. Edit-vs-purge is coordinated. The invariant checks BOTH
 * directions: every live Exam.pdf resolves to a file-backed live PDF with matching
 * owner/exam, and every attached PDF is referenced by exactly one live Exam with
 * the same owner/exam (no orphan / cross-owner / duplicate / deleting reference).
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-cr083";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-cr083";
process.env.EXAM_PDF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cr083-priv-"));
process.env.PDF_STAGING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cr083-stg-"));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Exam = require("../../models/examModel");
const PDF = require("../../models/pdfModel");
const { replaceExamPdf, deletePdfDurably, attachPdf, beginAttach, claimStagedPdf, purgeExam } = require("../../controllers/quizController");
const { pathForKey } = require("../../helper/examPdfStorage");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const { ObjectId } = mongoose.Types;
const BYTES = Buffer.from("%PDF-1.7\n%%EOF\n");
let n = 0;
const uniqKey = () => (n++).toString(16).padStart(64, "0");

// A ready-to-use staged upload owned by `owner`.
async function stagedUpload(owner) {
  const key = uniqKey();
  fs.writeFileSync(pathForKey(key), BYTES);
  const d = await PDF.create({ key, owner: owner._id, state: "staged", size: BYTES.length, expiresAt: new Date(Date.now() + 1e6) });
  return d;
}
// A live exam whose attached PDF is fully bound (owner+examId).
async function examWithPdf(owner) {
  const examId = new ObjectId();
  const key = uniqKey();
  fs.writeFileSync(pathForKey(key), BYTES);
  const pdf = await PDF.create({ key, owner: owner._id, state: "attached", examId, size: BYTES.length });
  await Exam.create({ _id: examId, name: "E", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: new ObjectId(), pdf: pdf._id });
  return { examId, pdf };
}

// The BIDIRECTIONAL invariant. Returns "ok" or the first violation.
// CR-087: owner AND examId must be PRESENT and equal (never compared only when
// truthy); an `attaching` row must carry a complete, recoverable operation intent.
async function bidirectional() {
  for (const e of await Exam.find({ pdf: { $ne: null } }).select("pdf owner")) {
    const row = await PDF.findById(e.pdf);
    if (!row) return "exam→missing_row";
    if (!["attached", "attaching"].includes(row.state)) return `exam→non_live_state(${row.state})`;
    if (row.key && !fs.existsSync(pathForKey(row.key))) return "exam→missing_bytes";
    if (!row.owner || String(row.owner) !== String(e.owner)) return "exam→owner_missing_or_mismatch";
    if (!row.examId || String(row.examId) !== String(e._id)) return "exam→examId_missing_or_mismatch";
    if (row.state === "attaching" && !row.opToken) return "exam→attaching_without_intent";
  }
  for (const row of await PDF.find({ state: "attached" })) {
    const refs = await Exam.find({ pdf: row._id }).select("owner _id");
    if (refs.length !== 1) return `attached_ref_count=${refs.length}`; // 0 orphan, >1 duplicate
    if (!row.owner || String(refs[0].owner) !== String(row.owner)) return "attached_owner_missing_or_mismatch";
    if (!row.examId || String(row.examId) !== String(refs[0]._id)) return "attached_examId_missing_or_mismatch";
  }
  return "ok";
}

async function isPurgedTombstone(examId) {
  const row = await Exam.findById(examId).select("purgedAt hidden pdf questions");
  return Boolean(
    row &&
      row.purgedAt &&
      row.hidden === true &&
      !row.pdf &&
      !row.questions
  );
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const owner = await User.create({ name: "O", email: "o@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });

  ok("baseline: bidirectional invariant holds on an empty world", (await bidirectional()) === "ok");

  // ── attached rows carry immutable owner + examId ──
  const { examId, pdf } = await examWithPdf(owner);
  ok("an attached row keeps owner + examId binding", String(pdf.owner) === String(owner._id) && String(pdf.examId) === String(examId));
  ok("bidirectional invariant holds for a bound exam+pdf", (await bidirectional()) === "ok");

  // ── CR-083: TWO concurrent replacements → exactly one wins, loser reclaims ──
  const upA = await stagedUpload(owner);
  const upB = await stagedUpload(owner);
  const [rA, rB] = await Promise.all([
    replaceExamPdf(examId, String(upA._id), owner._id),
    replaceExamPdf(examId, String(upB._id), owner._id),
  ]);
  const winners = [rA, rB].filter((r) => r.ok);
  const losers = [rA, rB].filter((r) => !r.ok);
  const loserKey = losers.length ? ([upA, upB].find((u) => String(u._id) === String(losers[0].pdfId)) || {}).key : null;
  ok("exactly one concurrent replacement WON", winners.length === 1 && losers.length === 1 && losers[0].status === "cas_lost");
  const examAfter = await Exam.findById(examId);
  ok("Exam.pdf references the WINNER", String(examAfter.pdf) === String(winners[0].pdfId));
  ok("the LOSER's upload was durably reclaimed (row + bytes gone, no orphan)", !(await PDF.findById(losers[0].pdfId)) && !fs.existsSync(pathForKey(loserKey)));
  ok("the OLD pdf is deleted (bytes + row)", !(await PDF.findById(pdf._id)) && !fs.existsSync(pathForKey(pdf.key)));
  ok("winner is attached + bound to the exam", (await PDF.findById(winners[0].pdfId))?.state === "attached");
  ok("BIDIRECTIONAL invariant holds after the concurrent replacement", (await bidirectional()) === "ok");

  // ── replacement CAS loser leaves nothing attached-but-unreferenced ──
  const attachedRows = await PDF.find({ state: "attached" });
  ok("no attached row is unreferenced by any exam", await (async () => { for (const r of attachedRows) { if ((await Exam.countDocuments({ pdf: r._id })) !== 1) return false; } return true; })());

  // ── crash BETWEEN the Exam CAS and attachPdf → reconciled, never orphaned ──
  // (a bare exam with no prior PDF, so the CAS is {pdf:null} → claimed).
  const ex2 = new ObjectId();
  await Exam.create({ _id: ex2, name: "E2", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: new ObjectId() });
  const up2 = await stagedUpload(owner);
  const claimed = await claimStagedPdf(String(up2._id), owner._id, ex2);
  await beginAttach(claimed._id, owner._id, ex2, claimed.opToken);
  await Exam.findOneAndUpdate({ _id: ex2 }, { $set: { pdf: claimed._id } }); // committed…
  // …CRASH before attachPdf: row is left `attaching` bound to ex2, exam refs it.
  ok("post-CAS crash leaves an ATTACHING row the exam references (recoverable)", (await PDF.findById(claimed._id))?.state === "attaching" && String((await Exam.findById(ex2)).pdf) === String(claimed._id));
  // Recovery: attachPdf (as the janitor's attaching-reconcile would) → attached.
  await attachPdf(claimed._id, owner._id, ex2, claimed.opToken);
  ok("recovery attaches it; invariant holds (no orphan)", (await PDF.findById(claimed._id))?.state === "attached" && (await bidirectional()) === "ok");

  // ── CR-087: REAL purge-vs-replacement fence via the shipping purgeExam +
  //    replaceExamPdf chain — NO stale-read orphan in EITHER order. ──

  // Ordering A — REPLACE wins first, THEN purge: purge must delete the EXACT
  // winner (the new pdf), never a stale old reference.
  const A = await examWithPdf(owner);
  const upA1 = await stagedUpload(owner);
  const repA = await replaceExamPdf(A.examId, String(upA1._id), owner._id);
  ok("A: replacement committed the new winner", repA.ok && String((await Exam.findById(A.examId)).pdf) === String(repA.pdfId));
  await purgeExam(A.examId);
  ok("A: purge deleted the EXACT winner (row + bytes); no orphan; invariant holds", !(await PDF.findById(repA.pdfId)) && !fs.existsSync(pathForKey(upA1.key)) && (await bidirectional()) === "ok");
  ok("A: no attached PDF row survives for the purged exam", (await PDF.countDocuments({ examId: A.examId, state: "attached" })) === 0);

  // Ordering B — PURGE claims first, THEN a real replacement races (via the
  // __afterClaim seam, i.e. the exact interleave Codex reproduced). The fence must
  // REFUSE the replacement; its upload is reclaimed; no orphan bytes survive.
  const B = await examWithPdf(owner);
  const upB1 = await stagedUpload(owner);
  let repB;
  await purgeExam(B.examId, { __afterClaim: async () => { repB = await replaceExamPdf(B.examId, String(upB1._id), owner._id); } });
  ok("B: the fenced replacement was REFUSED (cas_lost)", repB && repB.ok === false && repB.status === "cas_lost");
  ok("B: the refused replacement's upload was durably reclaimed (no orphan bytes)", !(await PDF.findById(repB.pdfId)) && !fs.existsSync(pathForKey(upB1.key)));
  ok("B: exam tombstone retained, old pdf gone; NO attached orphan; invariant holds", (await isPurgedTombstone(B.examId)) && !(await PDF.findById(B.pdf._id)) && (await PDF.countDocuments({ examId: B.examId, state: "attached" })) === 0 && (await bidirectional()) === "ok");

  // ── CR-087: crash-resumable purge. A crash right after the purge claim leaves
  //    the exam FENCED; nothing can attach; a retry finishes it idempotently. ──
  const C = await examWithPdf(owner);
  try { await purgeExam(C.examId, { __afterClaim: async () => { throw new Error("simulated crash after claim"); } }); } catch { /* crashed */ }
  ok("C: after a crash the exam is still present but fenced", (await Exam.findById(C.examId)) !== null);
  const upC = await stagedUpload(owner);
  const repC = await replaceExamPdf(C.examId, String(upC._id), owner._id);
  ok("C: NO replacement can attach to a fenced (crashed-purge) exam", repC.ok === false && repC.status === "cas_lost" && !(await PDF.findById(repC.pdfId)) && !fs.existsSync(pathForKey(upC.key)));
  await purgeExam(C.examId);
  ok("C: resumed purge completes; tombstone retained + pdf gone; invariant holds", (await isPurgedTombstone(C.examId)) && !(await PDF.findById(C.pdf._id)) && (await bidirectional()) === "ok");

  // ── CR-087: a FAILED attach CAS after the Exam CAS must be reported as failure,
  //    roll the reference back to the old pdf, and reclaim the upload. ──
  const D = await examWithPdf(owner);
  const upD = await stagedUpload(owner);
  const repD = await replaceExamPdf(D.examId, String(upD._id), owner._id, {
    // Steal the attaching row (as a concurrent janitor delete would) so attachPdf loses.
    __afterExamCas: async (pdfId) => { await deletePdfDurably(pdfId, ["attaching"], "steal"); },
  });
  ok("D: a lost attach CAS is reported as FAILURE, not success", repD.ok === false && repD.status === "attach_failed");
  ok("D: the exam reference rolled back to the OLD attached pdf (never a non-live ref)", String((await Exam.findById(D.examId)).pdf) === String(D.pdf._id));
  ok("D: the failed upload is reclaimed; invariant holds", !(await PDF.findById(repD.pdfId)) && (await bidirectional()) === "ok");

  // ── CR-091: a concurrent RECONCILER completing the SAME attach is an IDEMPOTENT
  //    success — never misreported as attach_failed, never leaving an orphan. ──
  {
    const R = await examWithPdf(owner);
    const upR = await stagedUpload(owner);
    const repR = await replaceExamPdf(R.examId, String(upR._id), owner._id, {
      // A legitimate reconciler finishes the exact attaching→attached transition
      // BEFORE the request's own attachPdf runs (Codex's exact interleave).
      __afterExamCas: async (pdfId) => { await attachPdf(pdfId, owner._id, R.examId, (await PDF.findById(pdfId)).opToken); },
    });
    ok("CR-091: a concurrent-reconciler completion is IDEMPOTENT SUCCESS (not attach_failed)", repR.ok === true && repR.status === "replaced");
    ok("CR-091: new pdf attached+referenced, old gone, NO orphan, invariant holds", (await PDF.findById(repR.pdfId))?.state === "attached" && String((await Exam.findById(R.examId)).pdf) === String(repR.pdfId) && !(await PDF.findById(R.pdf._id)) && (await bidirectional()) === "ok");
  }

  // ── CR-091: if PURGE owns the exam, an idempotently-attached row is NOT reported
  //    as replacement success and is NEVER rolled back — purge contains it. ──
  {
    const S = await examWithPdf(owner);
    const upS = await stagedUpload(owner);
    const repS = await replaceExamPdf(S.examId, String(upS._id), owner._id, {
      __afterExamCas: async (pdfId) => {
        await attachPdf(pdfId, owner._id, S.examId, (await PDF.findById(pdfId)).opToken); // reconciler completes it
        await Exam.updateOne({ _id: S.examId }, { $set: { purging: true } });             // purge claims the exam
      },
    });
    ok("CR-091: purge-owned exam → idempotent attach is 'superseded' (not success), not rolled back", repS.ok === false && repS.status === "superseded" && (await PDF.findById(repS.pdfId))?.state === "attached");
    await purgeExam(S.examId);
    ok("CR-091: purge contains the superseded winner (pdf+bytes gone, tombstone retained, no orphan)", !(await PDF.findById(repS.pdfId)) && (await isPurgedTombstone(S.examId)) && (await bidirectional()) === "ok");
  }

  // ── CR-091: the terminal binding is IMMUTABLE — owner/examId cannot be cleared,
  //    unset OR rewritten to a different non-null value via ANY write path. ──
  {
    const blocked = async (fn) => { try { await fn(); return false; } catch { return true; } };
    const M = await examWithPdf(owner);
    const other = new ObjectId();
    ok("CR-091: updateOne cannot $unset owner", await blocked(() => PDF.updateOne({ _id: M.pdf._id }, { $unset: { owner: "" } })));
    ok("CR-091: updateOne cannot $set examId to null", await blocked(() => PDF.updateOne({ _id: M.pdf._id }, { $set: { examId: null } })));
    ok("CR-091: updateOne cannot REWRITE owner to a different non-null id", await blocked(() => PDF.updateOne({ _id: M.pdf._id }, { $set: { owner: other } })));
    ok("CR-091: findOneAndUpdate cannot REWRITE examId to a different non-null id", await blocked(() => PDF.findOneAndUpdate({ _id: M.pdf._id }, { $set: { examId: other } })));
    ok("CR-091: updateMany cannot rewrite owner", await blocked(() => PDF.updateMany({ _id: M.pdf._id }, { $set: { owner: other } })));
    ok("CR-091: a replacement (replaceOne) cannot rewrite the binding", await blocked(() => PDF.replaceOne({ _id: M.pdf._id }, { key: M.pdf.key, state: "attached", owner: other, examId: other })));
    ok("CR-091: doc.save() cannot reassign owner on an existing row", await blocked(async () => { const d = await PDF.findById(M.pdf._id); d.owner = other; await d.save(); }));
    ok("CR-091: doc.save() cannot reassign examId on an existing row", await blocked(async () => { const d = await PDF.findById(M.pdf._id); d.examId = other; await d.save(); }));
    const unchanged = await PDF.findById(M.pdf._id);
    ok("CR-091: the terminal binding is UNCHANGED after every rewrite attempt", String(unchanged.owner) === String(owner._id) && String(unchanged.examId) === String(M.examId));
    // The ONLY permitted assignment — the initial staged→claimed examId — still works.
    const upClaim = await stagedUpload(owner);
    const exNew = new ObjectId();
    const claimedOk = await claimStagedPdf(String(upClaim._id), owner._id, exNew);
    ok("CR-091: the initial staged→claimed examId assignment is still permitted", !!claimedOk && String((await PDF.findById(upClaim._id)).examId) === String(exNew));
  }

  // ── CR-094: replacement / pipeline / bulkWrite write shapes cannot bypass binding
  //    immutability, and the ONE permitted examId assignment is EXACTLY the claim. ──
  {
    const blocked = async (fn) => { try { await fn(); return false; } catch { return true; } };
    const W = await examWithPdf(owner); // attached + bound
    const other = new ObjectId();

    // Replacement writes — omit (would CLEAR both) or rewrite — rejected outright.
    ok("CR-094: replaceOne OMITTING owner/examId is rejected (would clear both)", await blocked(() => PDF.replaceOne({ _id: W.pdf._id }, { key: W.pdf.key, state: "attached" })));
    ok("CR-094: findOneAndReplace OMITTING owner/examId is rejected", await blocked(() => PDF.findOneAndReplace({ _id: W.pdf._id }, { key: W.pdf.key, state: "attached" })));
    ok("CR-094: findOneAndReplace REWRITING owner/examId is rejected", await blocked(() => PDF.findOneAndReplace({ _id: W.pdf._id }, { key: W.pdf.key, state: "attached", owner: other, examId: other })));

    // Aggregation-pipeline updates — rewrite/unset — rejected.
    ok("CR-094: an update PIPELINE rewriting owner is rejected", await blocked(() => PDF.updateOne({ _id: W.pdf._id }, [{ $set: { owner: other } }])));
    ok("CR-094: an update PIPELINE unsetting examId is rejected", await blocked(() => PDF.updateOne({ _id: W.pdf._id }, [{ $unset: "examId" }])));
    ok("CR-094: a findOneAndUpdate PIPELINE rewriting examId is rejected", await blocked(() => PDF.findOneAndUpdate({ _id: W.pdf._id }, [{ $set: { examId: other } }])));

    // bulkWrite update + replacement + pipeline — all rejected.
    ok("CR-094: bulkWrite updateOne rewriting owner is rejected", await blocked(() => PDF.bulkWrite([{ updateOne: { filter: { _id: W.pdf._id }, update: { $set: { owner: other } } } }])));
    ok("CR-094: bulkWrite updateOne unsetting examId is rejected", await blocked(() => PDF.bulkWrite([{ updateOne: { filter: { _id: W.pdf._id }, update: { $unset: { examId: "" } } } }])));
    ok("CR-094: bulkWrite replaceOne is rejected", await blocked(() => PDF.bulkWrite([{ replaceOne: { filter: { _id: W.pdf._id }, replacement: { key: W.pdf.key, state: "attached" } } }])));
    ok("CR-094: bulkWrite pipeline update is rejected", await blocked(() => PDF.bulkWrite([{ updateOne: { filter: { _id: W.pdf._id }, update: [{ $set: { owner: other } }] } }])));

    const stillW = await PDF.findById(W.pdf._id);
    ok("CR-094: the binding is UNCHANGED after every replacement/pipeline/bulkWrite attempt", String(stillW.owner) === String(owner._id) && String(stillW.examId) === String(W.examId) && stillW.state === "attached");

    // The examId assignment is narrowed to the EXACT single-row claim.
    ok("CR-094: a broad staged updateMany examId assignment is rejected", await blocked(() => PDF.updateMany({ state: "staged" }, { $set: { examId: other } })));
    const upBroad = await stagedUpload(owner);
    ok("CR-094: a PARTIAL single-row staged examId assignment (not the exact claim) is rejected", await blocked(() => PDF.updateOne({ _id: upBroad._id, state: "staged" }, { $set: { examId: other } })));

    // The real claim transition still succeeds.
    const upOk = await stagedUpload(owner);
    const exOk = new ObjectId();
    const claimedOk = await claimStagedPdf(String(upOk._id), owner._id, exOk);
    ok("CR-094: the REAL claimStagedPdf staged→claimed transition still SUCCEEDS", !!claimedOk && claimedOk.state === "claimed" && String((await PDF.findById(upOk._id)).examId) === String(exOk));
  }

  // ── CR-095: fail-closed operator/path coverage + a STRICT exact-claim predicate.
  //    $rename / $setOnInsert / dotted paths / bulkWrite cannot touch the binding, an
  //    operator-owner or examId-present claim shape is refused, and only the exact
  //    findOneAndUpdate claim (examId absent) may set examId. ──
  {
    const blocked = async (fn) => { try { await fn(); return false; } catch { return true; } };
    const W = await examWithPdf(owner); // attached + bound (has owner + examId)
    const other = new ObjectId();

    // $rename moving owner/examId (source OR destination) → rejected.
    ok("CR-095: updateOne $rename OFF owner is rejected", await blocked(() => PDF.updateOne({ _id: W.pdf._id }, { $rename: { owner: "ownerX" } })));
    ok("CR-095: findOneAndUpdate $rename ONTO examId is rejected", await blocked(() => PDF.findOneAndUpdate({ _id: W.pdf._id }, { $rename: { key: "examId" } })));
    // $setOnInsert touching the binding → rejected.
    ok("CR-095: $setOnInsert owner (upsert) is rejected", await blocked(() => PDF.updateOne({ _id: W.pdf._id }, { $setOnInsert: { owner: other } }, { upsert: true })));
    // dotted path into owner/examId → rejected.
    ok("CR-095: a dotted-path $set (owner.evil) is rejected", await blocked(() => PDF.updateOne({ _id: W.pdf._id }, { $set: { "owner.evil": other } })));
    // bulkWrite is rejected OUTRIGHT (even a benign op, and $rename).
    ok("CR-095: PDF.bulkWrite is rejected outright (benign op)", await blocked(() => PDF.bulkWrite([{ updateOne: { filter: { _id: W.pdf._id }, update: { $set: { size: 1 } } } }])));
    ok("CR-095: PDF.bulkWrite $rename is rejected outright", await blocked(() => PDF.bulkWrite([{ updateOne: { filter: { _id: W.pdf._id }, update: { $rename: { owner: "x" } } } }])));

    const stillW = await PDF.findById(W.pdf._id);
    ok("CR-095: binding UNCHANGED after $rename/$setOnInsert/dotted/bulk attempts", String(stillW.owner) === String(owner._id) && String(stillW.examId) === String(W.examId));

    const upOp = await stagedUpload(owner);
    // A claim-SHAPED update whose filter uses an OPERATOR owner is NOT the exact claim.
    ok("CR-095: a claim-shaped update with owner:{$exists:true} filter is rejected", await blocked(() => PDF.findOneAndUpdate(
      { _id: upOp._id, owner: { $exists: true }, state: "staged", examId: { $exists: false }, expiresAt: { $gt: new Date() } },
      { $set: { state: "claimed", examId: other, opToken: "t", claimedAt: new Date() }, $unset: { expiresAt: "" } }
    )));
    // A claim-shaped update WITHOUT the examId-absent predicate could rewrite a pre-existing examId → rejected.
    ok("CR-095: a claim-shaped update WITHOUT examId-absent predicate is rejected", await blocked(() => PDF.findOneAndUpdate(
      { _id: upOp._id, owner: owner._id, state: "staged", expiresAt: { $gt: new Date() } },
      { $set: { state: "claimed", examId: other, opToken: "t", claimedAt: new Date() }, $unset: { expiresAt: "" } }
    )));
    // The claim shape via updateOne (not findOneAndUpdate) → rejected (op restriction).
    ok("CR-095: a claim shape via updateOne (not findOneAndUpdate) is rejected", await blocked(() => PDF.updateOne(
      { _id: upOp._id, owner: owner._id, state: "staged", examId: { $exists: false }, expiresAt: { $gt: new Date() } },
      { $set: { state: "claimed", examId: other, opToken: "t", claimedAt: new Date() }, $unset: { expiresAt: "" } }
    )));
    // An EXTRA $set key beyond the claim allowlist → rejected.
    ok("CR-095: a claim shape with an EXTRA $set key is rejected", await blocked(() => PDF.findOneAndUpdate(
      { _id: upOp._id, owner: owner._id, state: "staged", examId: { $exists: false }, expiresAt: { $gt: new Date() } },
      { $set: { state: "claimed", examId: other, opToken: "t", claimedAt: new Date(), owner: other }, $unset: { expiresAt: "" } }
    )));
    ok("CR-095: none of the rejected claim shapes assigned examId (row still staged, unbound)", (await PDF.findById(upOp._id)).state === "staged" && (await PDF.findById(upOp._id)).examId == null);

    // The REAL claimStagedPdf (findOneAndUpdate with the exact predicate) still SUCCEEDS.
    const exOk = new ObjectId();
    const claimedOk = await claimStagedPdf(String(upOp._id), owner._id, exOk);
    ok("CR-095: the REAL claimStagedPdf still SUCCEEDS", !!claimedOk && claimedOk.state === "claimed" && String((await PDF.findById(upOp._id)).examId) === String(exOk));
  }

  await mongoose.disconnect();
  await mem.stop();
  for (const d of [process.env.EXAM_PDF_DIR, process.env.PDF_STAGING_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
