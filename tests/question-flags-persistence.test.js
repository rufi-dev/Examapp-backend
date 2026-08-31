/*
 * GATE 0 — the four question flags Mongoose strict mode silently dropped.
 *
 * `correctAnswers` is a TYPED subdocument array (models/questionModel.js), so any
 * key the schema does not declare is stripped BEFORE the write reaches Mongo — on
 * `Question.create` and on the builder's `findOneAndUpdate({$set:{correctAnswers}})`
 * alike. Four flags were written by the builder and read by the server without ever
 * being declared: `inline`, `gapfill`, `maxPlays`, `allowPause`.
 *
 * The existing suites never caught it because they build fixtures as PLAIN OBJECTS
 * and call the pure scorers directly (tests/gapfill.test.js,
 * tests/question-type-matrix.test.js Part B). This file goes through the REAL path
 * — addQuestion -> publish -> startAttempt -> addResult — which is where the data
 * is actually lost.
 *
 * Live consequences reproduced below:
 *   - a single-blank INLINE gap-fill can never be answered correctly (isMultiBlank
 *     at quizController.js:2461 loses `inline`, so it falls to the open-answer path
 *     whose stored `answer` is "");
 *   - a gap-fill READING (cloze) is not scored at all (isRead at helper/scoring.js:28
 *     loses `gapfill`, so the cloze is treated as a plain passage and
 *     computePointsPlan gives it 0);
 *   - listening `maxPlays`/`allowPause` are never enforced.
 *
 * Part E proves the fix is NOT retroactive: an already-published ExamVersion is
 * frozen (`[Schema.Types.Mixed]`), so historical papers keep their historical
 * grading and only a NEW publish picks the flags up.
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const ExamVersion = require("../models/examVersionModel");
const Attempt = require("../models/attemptModel");
const Result = require("../models/resultModel");
const User = require("../models/userModel");
const { isRead } = require("../helper/scoring");
const {
  addQuestion,
  startAttempt,
  addResult,
  isCorrectAnswer,
  sanitizeQuestionItem,
} = require("../controllers/quizController");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    passed += 1;
    console.log("  ✓", name);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra);
  }
};

function mkRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function call(fn, params, body, user) {
  const req = { params, body, user };
  const res = mkRes();
  let err = null;
  await fn(req, res, (e) => (err = e));
  if (err) throw err;
  return res;
}

let seq = 0;
const uniq = () => `${Date.now()}_${seq++}`;

async function mkTeacher() {
  return User.create({
    name: "T",
    email: `t${uniq()}@e.com`,
    password: "xxxxxxxx",
    role: "teacher",
    teacherApproval: "approved",
    isVerified: true,
  });
}
async function mkExam(owner, typePoints) {
  return Exam.create({
    name: "Flags",
    owner: owner._id,
    duration: 600,
    price: 0,
    totalMarks: 100,
    passingMarks: 50,
    mode: "structured",
    class: new mongoose.Types.ObjectId(),
    typePoints,
  });
}

// The fixtures the drift breaks. All three are exactly what the builder sends.
const CLOZE = {
  type: "reading",
  kind: "reading",
  gapfill: true,
  title: "Cloze",
  text: "Paytaxt ___ , ikinci sheher ___ .",
  blanks: 2,
  blankAnswers: [["Baki"], ["Gence"]],
};
const INLINE_GAP = {
  type: "Co",
  inline: true,
  text: "Su ___ derecede qaynayir.",
  answer: "",
  blanks: 1,
  blankAnswers: [["100"]],
};
const LISTENING = {
  type: "reading",
  kind: "listening",
  title: "Listening",
  audio: "https://example.test/a.mp3",
  maxPlays: 2,
  allowPause: false,
  covers: 0,
};

// ============================ Part A — Question.create ======================
async function partA() {
  console.log("\nPart A — first save (Question.create):");
  const exam = await mkExam(await mkTeacher());
  const q = await Question.create({ exam: exam._id, correctAnswers: [CLOZE, INLINE_GAP, LISTENING] });
  const [cloze, gap, lis] = (await Question.findById(q._id).lean()).correctAnswers;

  ok("create keeps gapfill on the cloze", cloze.gapfill === true, cloze.gapfill);
  ok("create keeps inline on the gap-fill", gap.inline === true, gap.inline);
  ok("create keeps maxPlays on the listening block", lis.maxPlays === 2, lis.maxPlays);
  ok("create keeps allowPause on the listening block", lis.allowPause === false, lis.allowPause);
}

// =================== Part B — the builder's real $set path ==================
// addQuestion uses findOneAndUpdate($set) for EVERY save after the first, so this
// is the path that matters in production.
async function partB() {
  console.log("\nPart B — re-save (findOneAndUpdate $set), the builder's real path:");
  const owner = await mkTeacher();
  const exam = await mkExam(owner, { reading: 10, Co: 10 });
  const params = { examId: String(exam._id) };

  await call(addQuestion, params, { correctAnswers: [CLOZE, INLINE_GAP, LISTENING] }, owner);
  const r2 = await call(addQuestion, params, { correctAnswers: [CLOZE, INLINE_GAP, LISTENING] }, owner);
  ok("second save reports an update", r2.body.message === "Answers updated successfully", r2.body.message);

  const fresh = await Exam.findById(exam._id);
  const [cloze, gap, lis] = (await Question.findById(fresh.questions).lean()).correctAnswers;
  ok("$set keeps gapfill", cloze.gapfill === true, cloze.gapfill);
  ok("$set keeps inline", gap.inline === true, gap.inline);
  ok("$set keeps maxPlays", lis.maxPlays === 2, lis.maxPlays);
  ok("$set keeps allowPause", lis.allowPause === false, lis.allowPause);

  // The behavioural consequences, asserted against the STORED shape.
  ok("stored cloze is scored, not treated as a plain passage", isRead(cloze) === false);
  ok(
    "stored single-blank inline gap-fill can be answered correctly",
    isCorrectAnswer(gap, { answer: { 0: "100" } }) === true
  );
  ok(
    "stored inline gap-fill still rejects a wrong answer",
    isCorrectAnswer(gap, { answer: { 0: "0" } }) === false
  );

  const sent = sanitizeQuestionItem(lis);
  ok("student payload carries maxPlays/allowPause", sent.maxPlays === 2 && sent.allowPause === false);
  ok("student payload carries gapfill", sanitizeQuestionItem(cloze).gapfill === true);
  ok("student payload carries inline", sanitizeQuestionItem(gap).inline === true);
  ok(
    "student payload still hides the answer key",
    sanitizeQuestionItem(cloze).blankAnswers === undefined &&
      sanitizeQuestionItem(gap).answers === undefined
  );
}

// ============ Part C — the whole chain: save -> publish -> attempt ==========
async function partC() {
  console.log("\nPart C — addQuestion -> publish -> startAttempt -> addResult:");
  const owner = await mkTeacher();
  // NOTE: no `reading` entry in typePoints, so the cloze's worth comes from
  // computePointsPlan -- which is exactly where isRead() decides whether a cloze is
  // a scored question or an unscored passage.
  const exam = await mkExam(owner, { Co: 10 });
  const params = { examId: String(exam._id) };
  await call(addQuestion, params, { correctAnswers: [CLOZE, INLINE_GAP] }, owner);

  const student = await User.create({
    name: "S",
    email: `s${uniq()}@e.com`,
    password: "xxxxxxxx",
    role: "student",
    isVerified: true,
  });
  student.exams.push(exam._id);
  await student.save();

  const started = await call(startAttempt, params, {}, student);
  const attemptId = started.body.attemptId;
  ok("attempt started against a published version", Boolean(attemptId), started.body);

  await call(
    addResult,
    params,
    {
      attemptId,
      selectedAnswers: [
        { type: "reading", answer: { 0: "Baki", 1: "Gence" } },
        { type: "Co", answer: { 0: "100" } },
      ],
    },
    student
  );

  const result = await Result.findOne({ attemptId });
  // Golden total. With the flags stored, isRead(cloze) is false so BOTH items are
  // scored questions: questionPoints(2) = [50, 50], then typePoints overrides Co to
  // 10 -> 50 + 10 = 60, both answered correctly.
  //
  // Without the flags this is 0: the cloze is demoted to an unscored passage (0
  // points) and the single-blank inline gap-fill falls to the open-answer path,
  // where the stored `answer` is "" and no typed answer can ever match.
  ok("cloze + inline gap-fill both score through the frozen version", result.earnPoints === 60, result.earnPoints);
}

// ===================== Part D — maxPlays is bounded ========================
async function partD() {
  console.log("\nPart D — maxPlays validation on BOTH write paths:");
  const owner = await mkTeacher();
  const exam = await mkExam(owner);
  const zero = [{ ...LISTENING, maxPlays: 0 }];
  const frac = [{ ...LISTENING, maxPlays: 2.5 }];
  const huge = [{ ...LISTENING, maxPlays: 999 }];
  // null is the dangerous one: the player reads `Number(maxPlays) > 0`
  // (LimitedAudio.jsx:45) and Number(null) is 0, so a stored null reads as
  // "unlimited" and silently lifts the limit the teacher set. Absent (undefined)
  // is the ONLY way to say unlimited, and that is what the builder sends.
  const nul = [{ ...LISTENING, maxPlays: null }];

  const rejectsCreate = async (ca) => {
    try {
      await Question.create({ exam: exam._id, correctAnswers: ca });
      return false;
    } catch (e) {
      return Boolean(e) && e.name === "ValidationError";
    }
  };
  ok("create rejects maxPlays 0", await rejectsCreate(zero));
  ok("create rejects a fractional maxPlays", await rejectsCreate(frac));
  ok("create rejects an out-of-range maxPlays", await rejectsCreate(huge));
  ok("create rejects maxPlays null (would disable the limit)", await rejectsCreate(nul));

  // The update path only validates when runValidators is on — which is the point.
  const q = await Question.create({ exam: exam._id, correctAnswers: [LISTENING] });
  let updateRejected = false;
  try {
    await Question.findOneAndUpdate(
      { _id: q._id, exam: exam._id },
      { $set: { correctAnswers: huge } },
      { new: true, runValidators: true }
    );
  } catch (e) {
    updateRejected = Boolean(e) && e.name === "ValidationError";
  }
  ok("$set rejects an out-of-range maxPlays (runValidators)", updateRejected);

  const after = await Question.findById(q._id).lean();
  ok("a rejected update leaves the stored value untouched", after.correctAnswers[0].maxPlays === 2);

  const good = await Question.create({ exam: exam._id, correctAnswers: [{ ...LISTENING, maxPlays: 20 }] });
  ok(
    "maxPlays 20 is accepted",
    (await Question.findById(good._id).lean()).correctAnswers[0].maxPlays === 20
  );

  // Absent still means unlimited and must remain writable.
  const unlimited = { ...LISTENING };
  delete unlimited.maxPlays;
  const noLimit = await Question.create({ exam: exam._id, correctAnswers: [unlimited] });
  ok(
    "an absent maxPlays is still accepted (unlimited)",
    !("maxPlays" in (await Question.findById(noLimit._id).lean()).correctAnswers[0])
  );

  // ---- the REAL builder path, not a raw model write ----
  const owner2 = await mkTeacher();
  const exam2 = await mkExam(owner2, { reading: 10, Co: 10 });
  const params = { examId: String(exam2._id) };
  await call(addQuestion, params, { correctAnswers: [LISTENING, INLINE_GAP] }, owner2);
  const qid = (await Exam.findById(exam2._id)).questions;

  const reSaveRejects = async (ca) => {
    try {
      await call(addQuestion, params, { correctAnswers: [ca, INLINE_GAP] }, owner2);
      return false;
    } catch (e) {
      return Boolean(e) && e.name === "ValidationError";
    }
  };
  ok("addQuestion re-save rejects maxPlays null", await reSaveRejects({ ...LISTENING, maxPlays: null }));
  ok("addQuestion re-save rejects maxPlays 0", await reSaveRejects({ ...LISTENING, maxPlays: 0 }));
  ok("addQuestion re-save rejects an out-of-range maxPlays", await reSaveRejects({ ...LISTENING, maxPlays: 999 }));

  const stored = (await Question.findById(qid).lean()).correctAnswers[0];
  ok("a rejected re-save leaves the stored maxPlays untouched", stored.maxPlays === 2, stored.maxPlays);
  ok("a rejected re-save leaves allowPause untouched", stored.allowPause === false, stored.allowPause);

  // The whole save is transactional, so nothing else in the payload leaked through.
  const v1 = await ExamVersion.findOne({ examId: exam2._id }).sort({ versionNumber: -1 }).lean();
  ok("no new version was published by a rejected re-save", v1.versionNumber === 1, v1.versionNumber);
}

// ========= Part E — legacy questions and frozen history are untouched ======
async function partE() {
  console.log("\nPart E — no destructive defaults, no retroactive re-grading:");
  const owner = await mkTeacher();

  // 1. A question carrying none of the four flags gets none of them back.
  const exam0 = await mkExam(owner);
  const plain = await Question.create({
    exam: exam0._id,
    correctAnswers: [{ type: "Co", text: "Paytaxt?", answer: "Baki" }],
  });
  const ca = (await Question.findById(plain._id).lean()).correctAnswers[0];
  const absent = ["inline", "gapfill", "maxPlays", "allowPause"].filter((k) => !(k in ca));
  ok("legacy question gains no flag keys at all", absent.length === 4, Object.keys(ca).join(","));

  // 2. A paper published WITHOUT gapfill keeps its historical frozen content when
  //    the teacher later re-saves WITH it. Only the NEW version carries the flag.
  const exam = await mkExam(owner, { reading: 10, Co: 10 });
  const params = { examId: String(exam._id) };
  const legacyCloze = { ...CLOZE };
  delete legacyCloze.gapfill;

  await call(addQuestion, params, { correctAnswers: [legacyCloze, INLINE_GAP] }, owner);
  const v1 = await ExamVersion.findOne({ examId: exam._id, versionNumber: 1 }).lean();
  ok("v1 published", Boolean(v1));
  ok("v1 froze the cloze WITHOUT gapfill", v1.questions[0].gapfill === undefined, v1.questions[0].gapfill);
  const v1Hash = v1.contentHash;

  await call(addQuestion, params, { correctAnswers: [CLOZE, INLINE_GAP] }, owner);
  const v1After = await ExamVersion.findOne({ examId: exam._id, versionNumber: 1 }).lean();
  ok("v1 row is byte-stable after the re-save", v1After.contentHash === v1Hash);
  ok("v1 still has no gapfill — history is not rewritten", v1After.questions[0].gapfill === undefined);

  const v2 = await ExamVersion.findOne({ examId: exam._id, versionNumber: 2 }).lean();
  ok("a NEW version was forked", Boolean(v2) && v2.contentHash !== v1Hash);
  ok("only the new version carries gapfill", Boolean(v2) && v2.questions[0].gapfill === true);
}

async function main() {
  // A REPLICA SET, not a single node: addQuestion saves inside withMongoTransaction,
  // so only a transaction-capable deployment exercises the real production write.
  const mem = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();
  await ExamVersion.createIndexes();

  await partA();
  await partB();
  await partC();
  await partD();
  await partE();

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} question-flag assertions failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(2);
});
