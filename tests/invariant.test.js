/*
 * Runtime test of the attemptId-keyed Result invariant, against in-memory Mongo.
 *   node tests/invariant.test.js        (or: npm test)
 * Covers: partial-unique index, required-on-new attemptId, idempotent scoring,
 * result-first finalization, monotonic terminate-upgrade, ANTI-CHEAT (a late
 * client submit can never overwrite a finalized Result), and unscorable finalize.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const User = require("../models/userModel");
const { finalizeAttempt, scoreAndCreateResult } = require("../controllers/quizController");

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log("  ✓", name); } else { failed++; console.log("  ✗ FAIL:", name); } };

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  // Build the indexes exactly as the migration would.
  await Attempt.createIndexes();
  await Result.createIndexes();

  const idx = (await Result.collection.indexes()).find((i) => i.name === "uniq_result_attempt");
  ok("uniq_result_attempt index built (unique+partial)", !!idx && idx.unique && !!idx.partialFilterExpression);

  // 1) Partial-unique index: legacy null-attemptId Results DON'T collide.
  //    (Raw inserts: legacy docs predate the isNew-gated attemptId requirement.)
  await Result.collection.insertOne({ userId: new mongoose.Types.ObjectId(), examId: new mongoose.Types.ObjectId(), earnPoints: 1 });
  await Result.collection.insertOne({ userId: new mongoose.Types.ObjectId(), examId: new mongoose.Types.ObjectId(), earnPoints: 2 });
  ok("two legacy Results (no attemptId) coexist (partial index)", true);
  let reqBlocked = false;
  try { await Result.create({ userId: new mongoose.Types.ObjectId(), examId: new mongoose.Types.ObjectId(), earnPoints: 3 }); }
  catch (e) { reqBlocked = /attemptId/.test(e.message); }
  ok("new Result WITHOUT attemptId rejected (required-on-new)", reqBlocked);

  // 2) Duplicate attemptId REJECTED by the unique index.
  const aid = new mongoose.Types.ObjectId();
  const uid = new mongoose.Types.ObjectId();
  const eid = new mongoose.Types.ObjectId();
  await Result.create({ userId: uid, examId: eid, attemptId: aid, earnPoints: 5 });
  let dupBlocked = false;
  try {
    await Result.create({ userId: uid, examId: eid, attemptId: aid, earnPoints: 6 });
  } catch (e) { dupBlocked = e.code === 11000; }
  ok("duplicate attemptId Result rejected (E11000)", dupBlocked);

  // 3) scoreAndCreateResult idempotency + terminate-upgrade.
  const user = await User.create({ name: "T", email: `t${Date.now()}@e.com`, password: "xxxxxxxx" });
  const questions = { correctAnswers: [
    { type: "Cm", choices: ["a", "b", "c"], correct: [0] },
    { type: "Cm", choices: ["a", "b", "c"], correct: [1] },
  ] };
  const examDoc = await Exam.create({
    name: "Exam", owner: user._id, duration: 600, price: 0,
    totalMarks: 100, passingMarks: 50, class: new mongoose.Types.ObjectId(),
  });
  // scoreAndCreateResult reads exam.questions.correctAnswers (normally populated);
  // pass a plain object mirroring a populated exam. linkResult updates the real DB doc.
  const exam = { _id: examDoc._id, questions, results: [] };
  const attempt = await Attempt.create({
    userId: user._id, examId: exam._id, startedAt: new Date(), expiresAt: new Date(Date.now() + 6e5),
    answers: [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }],
  });

  const p1 = await scoreAndCreateResult(exam, user, attempt,
    [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }],
    { violations: 0, terminated: false, suppressNotifications: true });
  const at1 = await Attempt.findById(attempt._id).lean();
  ok("first score: exactly one Result for the attempt", (await Result.countDocuments({ attemptId: attempt._id })) === 1);
  ok("first score: attempt marked submitted (result-first)", at1.submitted === true);
  ok("first score: both correct -> earnPoints > 0", p1 > 0);

  const p2 = await scoreAndCreateResult(exam, user, attempt,
    [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }],
    { violations: 0, terminated: false, suppressNotifications: true });
  ok("retry idempotent: still exactly one Result", (await Result.countDocuments({ attemptId: attempt._id })) === 1);
  ok("retry idempotent: same earnPoints returned", p2 === p1);

  const examAfter = await Exam.findById(exam._id).lean();
  const userAfter = await User.findById(user._id).lean();
  ok("Exam no longer grows a duplicated results array", (examAfter.results || []).length === 0);
  ok("User no longer grows a duplicated results array", (userAfter.results || []).length === 0);

  await scoreAndCreateResult(exam, user, attempt,
    [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }],
    { violations: 2, terminated: true, suppressNotifications: true });
  const rFinal = await Result.findOne({ attemptId: attempt._id }).lean();
  ok("terminate-upgrade: still one Result (no dup)", (await Result.countDocuments({ attemptId: attempt._id })) === 1);
  ok("terminate-upgrade: terminated=true, earnPoints=0", rFinal.terminated === true && rFinal.earnPoints === 0);
  ok("terminate-upgrade: violations monotonic (>=2)", (rFinal.violations || 0) >= 2);
  ok("terminate-upgrade: terminationNotifiedAt set (suppressed)", !!rFinal.terminationNotifiedAt);

  // 3b) ANTI-CHEAT: a late client submit must NOT overwrite a finalized Result.
  const attempt2 = await Attempt.create({
    userId: user._id, examId: exam._id, startedAt: new Date(), expiresAt: new Date(Date.now() + 6e5),
    answers: [{ type: "Cm", answer: 1 }, { type: "Cm", answer: 0 }], // BOTH WRONG (autosave)
  });
  const autoPts = await scoreAndCreateResult(exam, user, attempt2,
    [{ type: "Cm", answer: 1 }, { type: "Cm", answer: 0 }],
    { violations: 0, terminated: false, suppressNotifications: true, auto: true });
  const rAuto = await Result.findOne({ attemptId: attempt2._id }).lean();
  ok("finalizer result marked autoSubmitted:true", rAuto.autoSubmitted === true);
  ok("finalizer result scored the (wrong) autosave -> 0", autoPts === 0);
  // A POST-DEADLINE client submit with the CORRECT answers must be REFUSED (no overwrite).
  const clientPts = await scoreAndCreateResult(exam, user, attempt2,
    [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }],
    { violations: 0, terminated: false, suppressNotifications: true }); // auto=false (client)
  const rClient = await Result.findOne({ attemptId: attempt2._id }).lean();
  ok("anti-cheat: still exactly one Result (no dup)", (await Result.countDocuments({ attemptId: attempt2._id })) === 1);
  ok("anti-cheat: autoSubmitted UNCHANGED (still true)", rClient.autoSubmitted === true);
  ok("anti-cheat: score NOT changed by the late client submit (stays 0)", clientPts === 0 && rClient.earnPoints === 0);
  // A monotonic termination signal IS still merged (safe — one-way, can't lower).
  const termPts = await scoreAndCreateResult(exam, user, attempt2,
    [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }],
    { violations: 5, terminated: true, suppressNotifications: true });
  const rTerm = await Result.findOne({ attemptId: attempt2._id }).lean();
  ok("reconcile still merges termination/violations monotonically", rTerm.terminated === true && (rTerm.violations || 0) >= 5 && termPts === 0);

  // 4) finalizeAttempt on a deleted exam -> terminal unscorable, no Result.
  const orphanAttempt = await Attempt.create({
    userId: user._id, examId: new mongoose.Types.ObjectId(), startedAt: new Date(),
    expiresAt: new Date(Date.now() + 6e5),
  });
  const r = await finalizeAttempt(orphanAttempt, { reason: "test", suppressNotifications: true });
  const oa = await Attempt.findById(orphanAttempt._id).lean();
  ok("finalizeAttempt(missing exam): returns null", r === null);
  ok("finalizeAttempt(missing exam): attempt unscorable=deleted_exam", oa.unscorable === true && oa.unscorableReason === "deleted_exam");
  ok("finalizeAttempt(missing exam): no Result created", (await Result.countDocuments({ attemptId: orphanAttempt._id })) === 0);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
