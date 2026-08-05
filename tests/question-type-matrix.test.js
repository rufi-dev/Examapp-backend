/*
 * GOLDEN PER-TYPE E2E MATRIX.
 *
 * Proves every supported question type works across the whole lifecycle:
 *   create/save (fixtures mirror the stored `correctAnswers` shape)
 *     → student opens attempt (sanitizeQuestionItem = the exact payload the
 *        student receives; asserts the answer key is NEVER leaked)
 *     → answers → grade (isCorrectAnswer = the single server-side source of
 *        scoring truth) → result score.
 *
 * Part C additionally drives the REAL startAttempt → addResult path through the
 * frozen exam version, with reading + listening blocks and a figure-carrying
 * question mixed in, so the whole chain is exercised exactly as production does.
 *
 * This is a TEST-ONLY addition. No product behavior is changed.
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const ExamVersion = require("../models/examVersionModel");
const User = require("../models/userModel");
const {
  isCorrectAnswer,
  sanitizeQuestionItem,
  startAttempt,
  addResult,
  gradeManualAnswer,
} = require("../controllers/quizController");
const { _setForTest } = require("../config/featureFlags");

let passed = 0;
let failed = 0;
const ok = (name, cond) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name); }
};
const eq = (name, got, want) => ok(`${name} (= ${JSON.stringify(got)})`, got === want);

// ---- fixtures: one representative, correctly-formed question per type -------
// The shape here is exactly what buildPayload/addQuestion persists into
// exam.questions.correctAnswers.
const FIX = {
  Cm: { type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] },
  Cs: { type: "Cs", choices: [{ text: "a" }, { text: "b" }, { text: "c" }], correct: [0, 2] },
  Co: { type: "Co", answers: ["paris", "paris fransa"] },
  Cd: { type: "Cd", answers: ["6x+2"] },
  Cma: { type: "Cma", pairs: [{ left: "L1", right: "R1" }, { left: "L2", right: "R2" }] },
  Cmu: { type: "Cmu", leftCount: 2, rightCount: 3, key: [[0], [1, 2]] },
  inlineGap: { type: "Co", inline: true, blanks: 1, blankAnswers: [["Baku", "Bakı"]], text: "[[1]] is the capital." },
  clozeReading: { type: "reading", gapfill: true, blanks: 2, blankAnswers: [["baku", "bakı"], ["caspian"]], text: "[[1]] sits on the [[2]] sea." },
  table: { type: "Co", blanks: 2, blankAnswers: [["42"], ["7"]], table: [[{ text: "x" }, { blank: true, answer: "42" }], [{ text: "y" }, { blank: true, answer: "7" }]] },
  readingBlock: { type: "reading", title: "Passage", text: "A long reading passage the questions below refer to." },
  listeningBlock: { type: "reading", kind: "listening", audio: "https://res.cloudinary.com/x/a.mp3", maxPlays: 2, allowPause: true, title: "Listening" },
  figure: { type: "Cm", image: "https://res.cloudinary.com/x/fig.png", choices: [{ text: "a" }, { text: "b" }], correct: [1] },
};

// ============================ Part A — grading ==============================
// isCorrectAnswer: a CORRECT answer scores true, a WRONG/empty one scores false.
function partA() {
  console.log("\nPart A — isCorrectAnswer per type (correct ✓ / wrong ✗):");

  ok("Cm correct", isCorrectAnswer(FIX.Cm, { answer: 0 }) === true);
  ok("Cm wrong", isCorrectAnswer(FIX.Cm, { answer: 1 }) === false);

  ok("Cs correct (exact set)", isCorrectAnswer(FIX.Cs, { answer: [0, 2] }) === true);
  ok("Cs wrong (incomplete)", isCorrectAnswer(FIX.Cs, { answer: [0] }) === false);

  ok("Co correct (case-insensitive)", isCorrectAnswer(FIX.Co, { answer: "Paris" }) === true);
  ok("Co correct (2nd accepted variant)", isCorrectAnswer(FIX.Co, { answer: "paris fransa" }) === true);
  ok("Co wrong", isCorrectAnswer(FIX.Co, { answer: "London" }) === false);
  ok("Co empty", isCorrectAnswer(FIX.Co, { answer: "" }) === false);

  ok("Cd correct (loose whitespace)", isCorrectAnswer(FIX.Cd, { answer: "6 x + 2" }) === true);
  ok("Cd wrong", isCorrectAnswer(FIX.Cd, { answer: "6x-2" }) === false);

  ok("Cma correct", isCorrectAnswer(FIX.Cma, { answer: { 0: "R1", 1: "R2" } }) === true);
  ok("Cma wrong (swapped)", isCorrectAnswer(FIX.Cma, { answer: { 0: "R2", 1: "R1" } }) === false);

  ok("Cmu correct (order-insensitive)", isCorrectAnswer(FIX.Cmu, { answer: { 0: [0], 1: [2, 1] } }) === true);
  ok("Cmu wrong (incomplete)", isCorrectAnswer(FIX.Cmu, { answer: { 0: [0], 1: [1] } }) === false);

  ok("inline gap-fill correct (alt spelling)", isCorrectAnswer(FIX.inlineGap, { answer: { 0: "bakı" } }) === true);
  ok("inline gap-fill wrong", isCorrectAnswer(FIX.inlineGap, { answer: { 0: "Ganja" } }) === false);

  ok("cloze reading correct (all blanks)", isCorrectAnswer(FIX.clozeReading, { answer: { 0: "Baku", 1: "Caspian" } }) === true);
  ok("cloze reading wrong (one blank off)", isCorrectAnswer(FIX.clozeReading, { answer: { 0: "Baku", 1: "Black" } }) === false);

  ok("table correct (all cells)", isCorrectAnswer(FIX.table, { answer: { 0: "42", 1: "7" } }) === true);
  ok("table wrong (one cell off)", isCorrectAnswer(FIX.table, { answer: { 0: "42", 1: "9" } }) === false);

  ok("figure question grades on its choices (image ignored)", isCorrectAnswer(FIX.figure, { answer: 1 }) === true);
  ok("figure question wrong choice", isCorrectAnswer(FIX.figure, { answer: 0 }) === false);

  // Non-scored blocks are never marked correct.
  ok("plain reading block is non-scored", isCorrectAnswer(FIX.readingBlock, { answer: { 0: "x" } }) === false);
  ok("listening block is non-scored", isCorrectAnswer(FIX.listeningBlock, { answer: { 0: "x" } }) === false);
}

// ===================== Part B — student payload safety ======================
// sanitizeQuestionItem: the student gets renderable content but NEVER the key.
function partB() {
  console.log("\nPart B — sanitizeQuestionItem never leaks the answer key:");

  const cm = sanitizeQuestionItem(FIX.Cm);
  ok("Cm: choices sent", Array.isArray(cm.choices) && cm.choices.length === 2);
  ok("Cm: 'correct' index stripped", cm.correct === undefined);

  const cs = sanitizeQuestionItem(FIX.Cs);
  ok("Cs: 'correct' stripped", cs.correct === undefined);

  const co = sanitizeQuestionItem(FIX.Co);
  ok("Co: answers stripped", co.answers === undefined && co.blankAnswers === undefined);
  ok("Co: no answer key field", !("answer" in co) || co.answer === "");

  const cma = sanitizeQuestionItem(FIX.Cma);
  ok("Cma: lefts/rights sent", Array.isArray(cma.lefts) && Array.isArray(cma.rights));
  ok("Cma: 'pairs' key stripped", cma.pairs === undefined);

  const cmu = sanitizeQuestionItem(FIX.Cmu);
  ok("Cmu: grid dims sent", cmu.leftCount === 2 && cmu.rightCount === 3);
  ok("Cmu: 'key' stripped", cmu.key === undefined);

  const gap = sanitizeQuestionItem(FIX.inlineGap);
  ok("inline gap: inline flag + text sent", gap.inline === true && typeof gap.text === "string");
  ok("inline gap: blankAnswers stripped", gap.blankAnswers === undefined);

  const cloze = sanitizeQuestionItem(FIX.clozeReading);
  ok("cloze: gapfill flag + text sent", cloze.gapfill === true && typeof cloze.text === "string");
  ok("cloze: blankAnswers stripped", cloze.blankAnswers === undefined);

  const tbl = sanitizeQuestionItem(FIX.table);
  ok("table: grid sent", Array.isArray(tbl.table));
  ok("table: blankAnswers stripped", tbl.blankAnswers === undefined);
  const cellsHaveNoAnswer = tbl.table.every((row) => row.every((c) => !("answer" in c)));
  ok("table: per-cell answer stripped", cellsHaveNoAnswer);

  const lis = sanitizeQuestionItem(FIX.listeningBlock);
  ok("listening: kind + audio sent", lis.kind === "listening" && typeof lis.audio === "string");

  const fig = sanitizeQuestionItem(FIX.figure);
  ok("figure: image sent", typeof fig.image === "string");
  ok("figure: 'correct' stripped", fig.correct === undefined);
}

// ===================== Part C — full startAttempt → addResult ===============
function mkRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(fn, params, body, userId) {
  const req = { params, body, user: { _id: userId } };
  const res = mkRes();
  let err = null;
  await fn(req, res, (e) => (err = e));
  if (err) throw err;
  return res;
}
let seq = 0;
async function runAttempt(correctAnswers, typePoints, selectedAnswers) {
  const owner = await User.create({ name: "T", email: `t${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const exam = await Exam.create({
    name: "Matrix", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50,
    mode: "structured", class: new mongoose.Types.ObjectId(), typePoints,
  });
  const q = await Question.create({ exam: exam._id, correctAnswers });
  exam.questions = q._id;
  await exam.save();
  const student = await User.create({ name: "S", email: `s${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true });
  student.exams.push(exam._id);
  await student.save();
  const started = await call(startAttempt, { examId: String(exam._id) }, {}, student._id);
  const attemptId = started.body.attemptId;
  await call(addResult, { examId: String(exam._id) }, { attemptId, selectedAnswers }, student._id);
  const result = await Result.findOne({ attemptId });
  return result.earnPoints;
}

async function partC() {
  console.log("\nPart C — full startAttempt → addResult (blocks + figure mixed in):");
  const P = { Cm: 10, Cs: 10, Co: 10, Cd: 10, Cma: 10, Cmu: 10 };

  // Reading + listening blocks are interleaved among 7 scored questions
  // (Cm, Cs, Co, Cd, Cma, Cmu, and a figure-carrying Cm). Blocks score 0.
  const qs = [
    FIX.readingBlock,
    FIX.Cm,
    FIX.Cs,
    FIX.Co,
    FIX.Cd,
    FIX.Cma,
    FIX.Cmu,
    FIX.listeningBlock,
    FIX.figure, // a Cm that also carries an image
  ];
  const rd = { type: "reading", answer: null };
  const allCorrect = [
    rd,
    { type: "Cm", answer: 0 },
    { type: "Cs", answer: [0, 2] },
    { type: "Co", answer: "Paris" },
    { type: "Cd", answer: "6 x + 2" },
    { type: "Cma", answer: { 0: "R1", 1: "R2" } },
    { type: "Cmu", answer: { 0: [0], 1: [2, 1] } },
    rd,
    { type: "Cm", answer: 1 },
  ];
  eq("all 7 scored correct, 2 blocks contribute 0 → 70", await runAttempt(qs, P, allCorrect), 70);

  // Same, but the figure question is answered wrong → 70 - 10 = 60. Proves the
  // figure question really is graded and the blocks still don't break anything.
  const figureWrong = allCorrect.slice();
  figureWrong[8] = { type: "Cm", answer: 0 };
  eq("figure question wrong → 60 (blocks unaffected)", await runAttempt(qs, P, figureWrong), 60);

  // An all-blocks-only 'exam' with no scored questions grades to 0 and does not throw.
  eq("blocks-only exam → 0 (non-scored, no crash)",
    await runAttempt([FIX.readingBlock, FIX.listeningBlock], P, [rd, rd]), 0);
}

// ===================== Part D — manual grading (MANUAL_GRADING_ENABLED) ======
// A manualGrade open question is held out of the auto score, the result is
// pendingReview with a provisional score, and the teacher's verdict recomputes it.
async function partD() {
  console.log("\nPart D — manual grading (flag on):");
  _setForTest({ flags: { MANUAL_GRADING_ENABLED: true } });
  try {
    const owner = await User.create({ name: "T", email: `mt${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
    const exam = await Exam.create({
      name: "Manual", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50,
      mode: "structured", class: new mongoose.Types.ObjectId(), typePoints: { Cm: 10, Co: 10 },
    });
    const correctAnswers = [
      { type: "Cm", text: "1+1?", choices: [{ text: "2" }, { text: "3" }], correct: [0] },
      { type: "Co", text: "Fikrini yaz.", manualGrade: true }, // no auto answer key
    ];
    const q = await Question.create({ exam: exam._id, correctAnswers });
    exam.questions = q._id;
    await exam.save();
    const student = await User.create({ name: "S", email: `ms${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true });
    student.exams.push(exam._id);
    await student.save();
    const started = await call(startAttempt, { examId: String(exam._id) }, {}, student._id);
    const attemptId = started.body.attemptId;
    await call(addResult, { examId: String(exam._id) }, {
      attemptId,
      selectedAnswers: [ { type: "Cm", answer: 0 }, { type: "Co", answer: "mənim fikrim budur" } ],
    }, student._id);

    const result = await Result.findOne({ attemptId });
    eq("auto-only score before grading → 10 (manual Co excluded)", result.earnPoints, 10);
    eq("pendingReview set", result.pendingReview, true);
    eq("autoEarnPoints base = 10", result.autoEarnPoints, 10);
    eq("one manual item pending", (result.manualItems || []).filter((m) => m.verdict === "pending").length, 1);

    // Teacher awards partial 6 of 10 on the manual question → 10 + 6 = 16, done.
    await call(gradeManualAnswer, { resultId: String(result._id) }, { index: 1, verdict: "partial", awardedPoints: 6 }, owner._id);
    const after = await Result.findById(result._id);
    eq("recomputed score = 10 + 6 = 16", after.earnPoints, 16);
    eq("pendingReview cleared after grading", after.pendingReview, false);

    // A student may NOT grade (authorization fails closed).
    let denied = false;
    try {
      await call(gradeManualAnswer, { resultId: String(result._id) }, { index: 1, verdict: "correct" }, student._id);
    } catch (_) { denied = true; }
    eq("student cannot grade (403)", denied, true);
  } finally {
    _setForTest({ flags: { MANUAL_GRADING_ENABLED: false } });
  }
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();
  await ExamVersion.createIndexes();

  partA();
  partB();
  await partC();
  await partD();

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} matrix assertions failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
