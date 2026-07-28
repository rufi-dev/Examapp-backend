/*
 * AUD-003-T3 — golden grading. Pins EXACT scores + rounding for every question
 * type, partial/negative marking, unanswered and open-answer normalization, so the
 * immutable-version extraction (grading now reads the bound snapshot) provably did
 * not change any grading output. Drives the full startAttempt → addResult path, so
 * scores are produced exactly as production does, through the version snapshot.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const ExamVersion = require("../models/examVersionModel");
const User = require("../models/userModel");
const { startAttempt, addResult } = require("../controllers/quizController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, "→ got", c); } };
const eq = (n, got, want) => { const c = got === want; if (c) { passed++; console.log("  ✓", n, "=", got); } else { failed++; console.log(`  ✗ FAIL: ${n} → got ${got}, want ${want}`); } };

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
// Build an exam with explicit typePoints + grading flags, run one attempt with the
// given display-order answers, and return the exact earnPoints.
async function grade(correctAnswers, grading, selectedAnswers) {
  const owner = await User.create({ name: "T", email: `t${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const exam = await Exam.create({
    name: "E", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50,
    mode: "structured", class: new mongoose.Types.ObjectId(),
    typePoints: grading.typePoints,
    partialCredit: !!grading.partialCredit,
    negativeMarking: !!grading.negativeMarking,
    wrongPerPenalty: grading.wrongPerPenalty == null ? 3 : grading.wrongPerPenalty,
    correctPerPenalty: grading.correctPerPenalty == null ? 1 : grading.correctPerPenalty,
    negMarkUntil: grading.negMarkUntil || 0,
  });
  const q = await Question.create({ exam: exam._id, correctAnswers });
  exam.questions = q._id;
  await exam.save();
  const student = await User.create({ name: "S", email: `s${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true });
  student.exams.push(exam._id); await student.save();

  const started = await call(startAttempt, { examId: String(exam._id) }, {}, student._id);
  const attemptId = started.body.attemptId;
  await call(addResult, { examId: String(exam._id) }, { attemptId, selectedAnswers }, student._id);
  const result = await Result.findOne({ attemptId });
  return result.earnPoints;
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();
  await ExamVersion.createIndexes();

  const P = { Cm: 10, Cs: 10, Co: 10, Cd: 10, Cma: 10, Cmu: 10 };

  // 1) Every type correct → full marks (6 × 10 = 60).
  {
    const qs = [
      { type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] },
      { type: "Cs", choices: [{ text: "a" }, { text: "b" }, { text: "c" }], correct: [0, 2] },
      { type: "Co", answers: ["paris"] },
      { type: "Cd", answers: ["6x+2"] },
      { type: "Cma", pairs: [{ left: "L1", right: "R1" }, { left: "L2", right: "R2" }] },
      { type: "Cmu", key: [[0], [1, 2]] },
    ];
    const ans = [
      { type: "Cm", answer: 0 },
      { type: "Cs", answer: [0, 2] },
      { type: "Co", answer: "Paris" },            // case-insensitive
      { type: "Cd", answer: "6 x + 2" },          // loose whitespace normalization
      { type: "Cma", answer: { 0: "R1", 1: "R2" } },
      { type: "Cmu", answer: { 0: [0], 1: [2, 1] } }, // order-insensitive set
    ];
    eq("all types correct", await grade(qs, { typePoints: P }, ans), 60);
  }

  // 2) Partial credit on Cs: pick 1 of 2 correct, no wrong → (1-0)/2 = 0.5 → 5.
  {
    const qs = [{ type: "Cs", choices: [{ text: "a" }, { text: "b" }, { text: "c" }], correct: [0, 1] }];
    eq("Cs partial: 1 of 2 correct → half points",
      await grade(qs, { typePoints: P, partialCredit: true }, [{ type: "Cs", answer: [0] }]), 5);
  }

  // 3) Partial credit with a wrong pick: (1 correct - 1 wrong)/2 = 0 → 0.
  {
    const qs = [{ type: "Cs", choices: [{ text: "a" }, { text: "b" }, { text: "c" }], correct: [0, 1] }];
    eq("Cs partial: one correct + one wrong → zero",
      await grade(qs, { typePoints: P, partialCredit: true }, [{ type: "Cs", answer: [0, 2] }]), 0);
  }

  // 4) Partial OFF: an incomplete Cs is all-or-nothing → 0.
  {
    const qs = [{ type: "Cs", choices: [{ text: "a" }, { text: "b" }, { text: "c" }], correct: [0, 1] }];
    eq("Cs no-partial: incomplete → zero (all-or-nothing)",
      await grade(qs, { typePoints: P, partialCredit: false }, [{ type: "Cs", answer: [0] }]), 0);
  }

  // 5) Unanswered questions contribute 0 and are NOT penalized (no neg marking).
  {
    const qs = [
      { type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] },
      { type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] },
      { type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] },
    ];
    const ans = [{ type: "Cm", answer: 0 }, { type: "Cm", answer: "" }, { type: "Cm", answer: null }];
    eq("unanswered contribute 0 (1 of 3 correct → 10)", await grade(qs, { typePoints: P }, ans), 10);
  }

  // 6) Negative marking: 5 Cm @10, 2 right + 3 wrong, 3-per-penalty cancels 1
  //    correct's-worth (avg 10). 2*10 - floor(3/3)*1*10 = 20 - 10 = 10.
  {
    const qs = Array.from({ length: 5 }, () => ({ type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] }));
    const ans = [
      { type: "Cm", answer: 0 }, { type: "Cm", answer: 0 },   // 2 correct
      { type: "Cm", answer: 1 }, { type: "Cm", answer: 1 }, { type: "Cm", answer: 1 }, // 3 wrong
    ];
    eq("negative marking: 2 right, 3 wrong, 3-per-penalty → 10",
      await grade(qs, { typePoints: P, negativeMarking: true, wrongPerPenalty: 3, correctPerPenalty: 1 }, ans), 10);
  }

  // 7) Negative marking bounded to negMarkUntil: wrongs AFTER the cutoff don't
  //    penalize. 4 Cm @10; correct on Q1; wrong on Q2 (in range) + Q3,Q4 (out of
  //    range, until=2). earned=10, wrongCount(in-range)=1 < 3 → no penalty → 10.
  {
    const qs = Array.from({ length: 4 }, () => ({ type: "Cm", choices: [{ text: "a" }, { text: "b" }], correct: [0] }));
    const ans = [
      { type: "Cm", answer: 0 }, { type: "Cm", answer: 1 },
      { type: "Cm", answer: 1 }, { type: "Cm", answer: 1 },
    ];
    eq("neg marking respects negMarkUntil (out-of-range wrongs ignored) → 10",
      await grade(qs, { typePoints: P, negativeMarking: true, wrongPerPenalty: 3, correctPerPenalty: 1, negMarkUntil: 2 }, ans), 10);
  }

  // 8) Open-answer decimal separator is NOT normalized away: "2,3" ≠ "2.3".
  {
    const qs = [{ type: "Co", answers: ["2.3"] }];
    eq("open answer: comma decimal is not silently accepted → 0",
      await grade(qs, { typePoints: P }, [{ type: "Co", answer: "2,3" }]), 0);
    const qs2 = [{ type: "Co", answers: ["2.3"] }];
    eq("open answer: exact decimal accepted → 10",
      await grade(qs2, { typePoints: P }, [{ type: "Co", answer: "2.3" }]), 10);
  }

  // 9) Cmu correspondence is all-or-nothing: a missing letter scores 0.
  {
    const qs = [{ type: "Cmu", key: [[0], [1, 2]] }];
    eq("Cmu: incomplete correspondence → 0",
      await grade(qs, { typePoints: P }, [{ type: "Cmu", answer: { 0: [0], 1: [1] } }]), 0);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
