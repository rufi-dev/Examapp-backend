/*
 * AUD-004 CR-038 — client submit and the deadline finalizer converge on ONE atomic
 * freeze. Reproduces the defect (a client submit grading revision 2 after the
 * finalizer already froze revision 1) and proves the client now grades/reconciles
 * the FROZEN snapshot and reports the loss. Also: freeze-before-submit (client wins
 * while open; the finalizer reconciles the client's frozen snapshot).
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const ExamVersion = require("../models/examVersionModel");
const User = require("../models/userModel");
const { publishExam } = require("../helper/examVersion");
const { autosaveAttempt, addResult, finalizeAttempt } = require("../controllers/quizController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
function mkRes() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function call(fn, params, body, userId) { const res = mkRes(); let err = null; await fn({ params, body, user: { _id: userId } }, res, (e) => (err = e)); if (err) throw err; return res; }

let seq = 0;
async function setup() {
  const owner = await User.create({ name: "T", email: `t${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const student = await User.create({ name: "S", email: `s${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true });
  const exam = await Exam.create({ name: "E", owner: owner._id, duration: 3600, price: 0, totalMarks: 100, passingMarks: 50, mode: "structured", class: new mongoose.Types.ObjectId(), typePoints: { Cm: 50 } });
  const q = await Question.create({ exam: exam._id, correctAnswers: [{ type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] }, { type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [1] }] });
  exam.questions = q._id; await exam.save();
  const pop = await Exam.findById(exam._id).populate("questions");
  const v = await publishExam(pop, pop.questions, ExamVersion, Exam);
  const attempt = await Attempt.create({ userId: student._id, examId: exam._id, examVersionId: v._id, startedAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  return { exam, student, attempt };
}
const save = (examId, userId, body) => call(autosaveAttempt, { examId: String(examId) }, body, userId);
const submit = (examId, userId, body) => call(addResult, { examId: String(examId) }, body, userId);
const ans = (a, b) => [{ type: "Cm", answer: a }, { type: "Cm", answer: b }];

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();
  await ExamVersion.createIndexes();

  // ── THE reproduced defect: client submit AFTER the finalizer froze rev 1 ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    // Acknowledge rev 1: Q1 WRONG (1), Q2 correct (1) => 50 under the frozen snapshot.
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1, 1), clientRevision: 1, requestId: "r1" });
    // The finalizer freezes + scores rev 1.
    await finalizeAttempt(await Attempt.findById(id), { reason: "finalizer" });
    const first = await Result.findOne({ attemptId: id });
    ok("finalizer graded rev 1 (50)", first.earnPoints === 50 && first.gradedRevision === 1);

    // The client now submits rev 2 with FULL-correct answers. It must NOT grade rev 2.
    const r = await submit(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0, 1), clientRevision: 2 });
    ok("client submit reports the FROZEN graded revision 1 (not 2)", r.body.gradedRevision === 1);
    ok("client submit flags loss (late/lostAnswers)", r.body.late === true);
    const after = await Result.findOne({ attemptId: id });
    ok("stored result is UNCHANGED at rev 1 / 50 (not re-graded to full)", after.earnPoints === 50 && after.gradedRevision === 1);
    ok("still exactly ONE result", (await Result.countDocuments({ attemptId: id })) === 1);
  }

  // ── freeze-before-submit: client wins the freeze while open; finalizer reconciles ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1, 1), clientRevision: 1, requestId: "r1" });
    // Client submits rev 2 (full correct) IN-WINDOW — it freezes ITS snapshot.
    const r = await submit(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0, 1), clientRevision: 2 });
    ok("in-window client submit grades its OWN revision 2 (100)", r.body.gradedRevision === 2 && r.body.earnPoints === 100);
    ok("no loss reported for a clean in-window submit", r.body.late === false);
    const a = await Attempt.findById(id).lean();
    ok("attempt frozen at the client's revision 2", a.finalizeState === "frozen" && a.frozenRev === 2);
    // A later finalizer pass must reconcile, not re-grade.
    await finalizeAttempt(await Attempt.findById(id), { reason: "finalizer" });
    ok("finalizer reconciled: still ONE result at rev 2 / 100", (await Result.countDocuments({ attemptId: id })) === 1 && (await Result.findOne({ attemptId: id })).earnPoints === 100);
  }

  // ── CR-038: a FRESH attempt (autosave never landed) + a client submit w/ revision ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    // No autosave fired (debounce) — the client submits rev 2 with its answers.
    const r = await submit(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0, 1), clientRevision: 2 });
    ok("fresh-attempt client submit grades the CLIENT answers (100) at its revision", r.body.gradedRevision === 2 && r.body.earnPoints === 100);
    const a = await Attempt.findById(id).lean();
    ok("attempt frozen at the client revision 2 with the client answers", a.frozenRev === 2 && Number(a.frozenAnswers[0].answer) === 0);
  }

  // ── CR-038 stale-submit: acked server rev 5, a stale client rev 2 submits FIRST ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    // The server has acknowledged rev 5 with the FULL-correct answers (100).
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0, 1), clientRevision: 5, requestId: "r5" });
    // A stale tab submits rev 2 with a WRONG answer, before any finalizer.
    const r = await submit(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1, 1), clientRevision: 2 });
    ok("stale client rev 2 does NOT overwrite the acknowledged rev 5", r.body.gradedRevision === 5);
    ok("official score is the acknowledged rev 5's (100), not the stale rev 2's", r.body.earnPoints === 100);
    const a = await Attempt.findById(id).lean();
    ok("attempt frozen at the acknowledged rev 5 (not the stale 2)", a.frozenRev === 5);
    const res = await Result.findOne({ attemptId: id });
    ok("stored result graded rev 5", res.gradedRevision === 5 && res.earnPoints === 100);
  }

  // ── CR-038: after acked rev 5, a stale submit with an OMITTED/MALFORMED revision
  //    must NEVER grade stale client answers or label them rev 5 ──
  for (const [label, rev] of [
    ["omitted", undefined], ["null", null], ["empty string", ""], ["false", false],
    ["array", []], ["negative", -1], ["fractional", 2.5], ["overflow", 2e9],
  ]) {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    // Server acknowledges rev 5 = FULL correct (100).
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0, 1), clientRevision: 5, requestId: "r5" });
    // A stale caller submits WRONG answers with a bad/omitted revision.
    const body = { attemptId: id, selectedAnswers: ans(1, 1) };
    if (rev !== undefined) body.clientRevision = rev;
    const r = await submit(exam._id, student._id, body);
    const res = await Result.findOne({ attemptId: id });
    ok(`rev="${label}": graded the SERVER rev 5 answers (100), not the stale client`, res.earnPoints === 100);
    ok(`rev="${label}": Result.gradedRevision is 5 and its answers ARE rev 5's (not stale mislabelled)`, res.gradedRevision === 5 && Number(res.selectedAnswers[0].answer) === 0);
    const a = await Attempt.findById(id).lean();
    ok(`rev="${label}": frozen at rev 5 with rev-5 answers (not frozenRev:null + stale)`, a.frozenRev === 5 && Number(a.frozenAnswers[0].answer) === 0);
    ok(`rev="${label}": the refusal is reported as a loss`, r.body.late === true);
  }

  // ── CR-038: protocol-cutover RACE — a stale read (protocol 0), then an autosave
  //    commits protocol 1 / rev 5, then a legacy-shaped submit must NOT freeze stale
  //    answers. The absent-safe autosaveProtocol<1 predicate IN the CAS catches it. ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    // Server acknowledges rev 5 = FULL correct (DB now protocol 1, autosaveRev 5).
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0, 1), clientRevision: 5, requestId: "r5" });
    // Simulate the controller's STALE read: addResult loads the attempt via
    // Attempt.findOne — stub it to return a protocol-0 snapshot (as if read BEFORE the
    // autosave committed). The freeze CAS still runs against the REAL DB (protocol 1).
    const staleDoc = await Attempt.findById(id);
    staleDoc.autosaveProtocol = 0;
    staleDoc.autosaveRev = 0;
    const realFindOne = Attempt.findOne;
    Attempt.findOne = () => Promise.resolve(staleDoc);
    let r;
    try {
      // Legacy shape (OMIT clientRevision). A stale classification would take the
      // legacy branch — the CAS predicate must still catch the committed protocol 1.
      r = await submit(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1, 1) });
    } finally {
      Attempt.findOne = realFindOne;
    }
    const res = await Result.findOne({ attemptId: id });
    ok("race: legacy freeze CAS blocked by the committed protocol 1 (graded 100)", res.earnPoints === 100);
    ok("race: graded rev 5 answers, not stale (gradedRevision 5, answer index 0)", res.gradedRevision === 5 && Number(res.selectedAnswers[0].answer) === 0);
    const a = await Attempt.findById(id).lean();
    ok("race: frozen at rev 5 with rev-5 answers (frozenRev 5, NOT null)", a.frozenRev === 5 && Number(a.frozenAnswers[0].answer) === 0);
    ok("race: reported as a loss", r.body.late === true);
  }

  // ── an autosave after the client's freeze is rejected ──
  {
    const { exam, student, attempt } = await setup();
    const id = attempt._id;
    await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0, 1), clientRevision: 1, requestId: "r1" });
    await submit(exam._id, student._id, { attemptId: id, selectedAnswers: ans(0, 1), clientRevision: 1 });
    // The attempt is now submitted+frozen; a late autosave finds no active attempt.
    const late = await save(exam._id, student._id, { attemptId: id, selectedAnswers: ans(1, 1), clientRevision: 2, requestId: "r2" });
    ok("autosave after submit/freeze is rejected", late.body.ok === false);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
