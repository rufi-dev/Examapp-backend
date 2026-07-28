/*
 * AUD-004-T2 — monotonic autosave revisions + deadline race (in-memory Mongo).
 * Proves the server accepts only strictly-newer revisions, treats an equal
 * revision as an idempotent duplicate, rejects an older one as stale (never as
 * stored), and that the finalizer freezes a DEFINED acknowledged revision even
 * when a late autosave races the deadline. One terminal result per attempt.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const User = require("../models/userModel");
const { autosaveAttempt, finalizeExpiredAttempts } = require("../controllers/quizController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function mkRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function save(examId, userId, body) {
  const res = mkRes();
  let err = null;
  await autosaveAttempt({ params: { examId: String(examId) }, body, user: { _id: userId } }, res, (e) => (err = e));
  if (err) throw err;
  return res.body;
}

let seq = 0;
async function setup({ expiresInMs = 60 * 60 * 1000 } = {}) {
  const owner = await User.create({ name: "T", email: `t${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const student = await User.create({ name: "S", email: `s${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true });
  const exam = await Exam.create({ name: "E", owner: owner._id, duration: 3600, price: 0, totalMarks: 100, passingMarks: 50, mode: "structured", class: new mongoose.Types.ObjectId() });
  const q = await Question.create({ exam: exam._id, correctAnswers: [{ type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] }] });
  exam.questions = q._id; await exam.save();
  const attempt = await Attempt.create({ userId: student._id, examId: exam._id, startedAt: new Date(), expiresAt: new Date(Date.now() + expiresInMs) });
  return { exam, student, attempt };
}
const ans = (v) => [{ type: "Cm", answer: v }];

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();

  // ── monotonic acceptance ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    const r1 = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 1, requestId: "a" });
    ok("rev 1 stored", r1.ok === true && r1.outcome === "stored" && r1.storedRevision === 1);

    const r2 = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1), clientRevision: 2, requestId: "b" });
    ok("rev 2 (newer) stored", r2.ok === true && r2.outcome === "stored" && r2.storedRevision === 2);

    const rStale = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 1, requestId: "c" });
    ok("rev 1 (older) rejected as STALE, not stored", rStale.ok === false && rStale.outcome === "stale" && rStale.storedRevision === 2);

    const rDup = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1), clientRevision: 2, requestId: "b" });
    ok("rev 2 (duplicate) is idempotent success", rDup.ok === true && rDup.outcome === "duplicate" && rDup.storedRevision === 2);

    const fresh = await Attempt.findById(id).lean();
    ok("stored answers are rev 2's (the stale write did NOT overwrite)", fresh.answers[0].answer === 1 && fresh.autosaveRev === 2);
  }

  // ── out-of-order delivery ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    const hi = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1), clientRevision: 5, requestId: "x" });
    ok("rev 5 stored", hi.outcome === "stored" && hi.storedRevision === 5);
    const lo = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 3, requestId: "y" });
    ok("rev 3 arriving after rev 5 is stale", lo.ok === false && lo.outcome === "stale" && lo.storedRevision === 5);
  }

  // ── CR-037: an unversioned write must NOT overwrite a versioned snapshot ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 5, requestId: "r5" });
    const legacy = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1) }); // no clientRevision
    ok("unversioned write after a versioned save is rejected (protocol_conflict)", legacy.ok === false && legacy.outcome === "protocol_conflict");
    const fresh = await Attempt.findById(id).lean();
    ok("unversioned write did NOT overwrite the rev-5 answers", fresh.answers[0].answer === 0 && fresh.autosaveRev === 5);
  }

  // ── CR-037: a pure unversioned client (never versioned) still last-write-wins ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    const l1 = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0) });
    ok("first unversioned save stores (stored_unversioned)", l1.ok === true && l1.outcome === "stored_unversioned");
    const l2 = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1) });
    ok("second unversioned save still stores (last-write-wins)", l2.ok === true && l2.outcome === "stored_unversioned");
  }

  // ── CR-037: first versioned save on a RAW legacy Attempt (no autosaveRev field) ──
  {
    const { exam } = await setup();
    // A FRESH student (no setup attempt) so the raw insert doesn't collide with the
    // single-active-attempt index. Insert WITHOUT autosaveRev/autosaveProtocol.
    const legacyStudent = await User.create({ name: "L", email: `l${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true });
    const { insertedId } = await Attempt.collection.insertOne({
      userId: legacyStudent._id, examId: exam._id, startedAt: new Date(), expiresAt: new Date(Date.now() + 3600e3),
      submitted: false, violations: 0, terminated: false,
    });
    const r = await save(exam._id, legacyStudent._id, { attemptId: insertedId, selectedAnswers: ans(0), clientRevision: 1, requestId: "leg1" });
    ok("first versioned save on a raw legacy Attempt STORES (not 'closed')", r.ok === true && r.outcome === "stored" && r.storedRevision === 1);
  }

  // ── CR-037: duplicate requires rev + requestId + PAYLOAD to all match ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 2, requestId: "orig" });
    const sameAll = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 2, requestId: "orig" });
    ok("same rev + same requestId + same body = idempotent duplicate", sameAll.ok === true && sameAll.outcome === "duplicate");
    // THE reproduced defect: same rev + same requestId but DIFFERENT body must be a
    // conflict, NOT a false "duplicate".
    const sameIdDiffBody = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1), clientRevision: 2, requestId: "orig" });
    ok("same rev + same requestId + DIFFERENT body = revision_conflict (not false duplicate)", sameIdDiffBody.ok === false && sameIdDiffBody.outcome === "revision_conflict");
    const diffReq = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1), clientRevision: 2, requestId: "other" });
    ok("same rev + different request = revision_conflict", diffReq.ok === false && diffReq.outcome === "revision_conflict");
    const fresh = await Attempt.findById(id).lean();
    ok("no conflicting write changed the stored answers", fresh.answers[0].answer === 0);
  }

  // ── CR-037: a versioned save MUST carry a valid, bounded requestId ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    const noReq = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 1 }); // missing requestId
    ok("versioned save with a MISSING requestId is rejected (invalid_request)", noReq.ok === false && noReq.outcome === "invalid_request");
    const blank = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 1, requestId: "" });
    ok("blank requestId is rejected (invalid_request)", blank.ok === false && blank.outcome === "invalid_request");
    const overlong = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 1, requestId: "x".repeat(201) });
    ok("overlong requestId is rejected, NOT truncated (invalid_request)", overlong.ok === false && overlong.outcome === "invalid_request");
    ok("no invalid-requestId save stored anything", (await Attempt.findById(id)).autosaveRev === 0);
  }

  // ── invalid / overflow revision ──
  {
    const { exam, student, attempt } = await setup();
    const bad = await save(exam._id, student._id, { attemptId: attempt._id, selectedAnswers: ans(0), clientRevision: -1 });
    ok("negative revision rejected as invalid_revision", bad.ok === false && bad.outcome === "invalid_revision");
    const over = await save(exam._id, student._id, { attemptId: attempt._id, selectedAnswers: ans(0), clientRevision: 2e9 });
    ok("overflow revision rejected as invalid_revision", over.ok === false && over.outcome === "invalid_revision");
  }

  // ── deadline: a past-deadline autosave is dropped (expired), not stored ──
  {
    const { exam, student, attempt } = await setup({ expiresInMs: -1000 }); // already expired
    const r = await save(exam._id, student._id, { attemptId: attempt._id, selectedAnswers: ans(0), clientRevision: 9 });
    ok("expired autosave rejected (outcome expired)", r.ok === false && r.outcome === "expired");
    const fresh = await Attempt.findById(attempt._id).lean();
    ok("expired autosave did not store answers", fresh.autosaveRev === 0);
  }

  // ── autosave vs finalizer at the deadline: finalize a DEFINED revision ──
  {
    const { exam, student, attempt } = await setup({ expiresInMs: 60 * 1000 });
    const id = attempt._id;
    // Acknowledge rev 3 BEFORE the deadline.
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0), clientRevision: 3, requestId: "ok3" });
    // Deadline passes.
    await Attempt.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 5 * 60 * 1000) } });
    await Exam.findByIdAndUpdate(exam._id, { $set: { endDate: new Date(Date.now() - 5 * 60 * 1000) } });
    // A late autosave (rev 4) races the finalizer — must be rejected as expired.
    const late = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1), clientRevision: 4, requestId: "late4" });
    ok("post-deadline autosave rejected (expired)", late.ok === false && late.outcome === "expired");

    await finalizeExpiredAttempts();
    const results = await Result.find({ attemptId: id });
    ok("exactly ONE terminal result", results.length === 1);
    ok("finalized the acknowledged revision (3), not the rejected late 4", results[0].gradedRevision === 3);
    // Re-run finalizer: still idempotent.
    await finalizeExpiredAttempts();
    ok("finalizer idempotent: still one result", (await Result.countDocuments({ attemptId: id })) === 1);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
