/*
 * Anti-cheat absences, against in-memory Mongo.   node tests/anticheat-away.test.js
 *
 * 2026-11-08: one evening auto-stopped 44 attempts with 0 points; a live sample
 * showed 11 of 15 strikes were absences of a few seconds. The runner now only
 * COUNTS long absences and reports the short ones as forgiven. Covers:
 *   - an OLD runner's report ({reason, attemptId}) still counts exactly as before
 *   - a forgiven absence (/away) is logged, never counted
 *   - "back" closes a counted absence without adding a second one
 *   - two strikes landing together are both counted (atomic), 3 → terminated
 *   - the teacher's "restore result": re-scores the saved answers, clears the
 *     termination, owner/admin only, and a late submit can't terminate it again
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const User = require("../models/userModel");
const qc = require("../controllers/quizController");

let passed = 0,
  failed = 0;
const ok = (name, cond) => {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failed++;
    console.log("  ✗ FAIL:", name);
  }
};

// Drive an express handler with a fake req/res; resolves with {code, body}.
const call = (fn, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        resolve({ code: this.statusCode, body: b });
        return this;
      },
    };
    fn(req, res, (err) => resolve({ code: res.statusCode, err: err && err.message }));
  });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();

  const teacher = await User.create({ name: "Teacher", email: `t${Date.now()}@e.com`, password: "xxxxxxxx", role: "teacher" });
  const other = await User.create({ name: "Other", email: `o${Date.now()}@e.com`, password: "xxxxxxxx", role: "teacher" });
  const student = await User.create({ name: "Student", email: `s${Date.now()}@e.com`, password: "xxxxxxxx" });
  const exam = await Exam.create({
    name: "Sınaq",
    owner: teacher._id,
    duration: 3600,
    price: 0,
    totalMarks: 100,
    passingMarks: 50,
    class: new mongoose.Types.ObjectId(),
    antiCheat: true,
    startDate: new Date(Date.now() - 3600e3),
    endDate: new Date(Date.now() + 3600e3),
  });
  const newAttempt = () =>
    Attempt.create({
      userId: student._id,
      examId: exam._id,
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600e3),
    });
  const report = (fn, attempt, body) =>
    call(fn, { params: { examId: String(exam._id) }, body: { attemptId: String(attempt._id), ...body }, user: student });

  // ── 1) old runner: {reason, attemptId} only → counts, as before ──
  let a = await newAttempt();
  let r = await report(qc.reportViolation, a, { reason: "hidden" });
  let doc = await Attempt.findById(a._id).lean();
  ok("old runner's report still counts (1 violation)", r.body.violations === 1 && doc.violations === 1);
  ok("…and is logged as a counted absence", doc.awayLog.length === 1 && doc.awayLog[0].counted === true && doc.awayCount === 1);

  // ── 2) forgiven absence → logged, NOT counted ──
  r = await report(qc.reportAway, a, { reason: "hidden", awayMs: 5200, count: true /* ignored on /away */ });
  doc = await Attempt.findById(a._id).lean();
  ok("forgiven absence is not counted (still 1)", r.body.violations === 1 && doc.violations === 1);
  ok("…but logged with its length", doc.awayLog.length === 2 && doc.awayLog[1].counted === false && doc.awayLog[1].awayMs === 5200);
  ok("…and adds to the absence tally", doc.awayCount === 2 && doc.awayMs === 5200);

  // ── 3) a counted absence still away, then "back" with the whole length ──
  await report(qc.reportViolation, a, { reason: "blur", awayMs: 30250, stillAway: true, count: true });
  await report(qc.reportAway, a, { reason: "back", awayMs: 95000 });
  doc = await Attempt.findById(a._id).lean();
  ok("still-away strike counted (2)", doc.violations === 2 && doc.awayLog[2].stillAway === true);
  ok('"back" is logged but is not a second absence', doc.awayCount === 3 && doc.awayLog[3].reason === "back" && doc.violations === 2);
  ok("not terminated at 2", doc.terminated === false);

  // ── 4) atomic: two strikes at once → both counted; reaching 3 terminates ──
  const b = await newAttempt().catch(async () => {
    await Attempt.updateOne({ _id: a._id }, { $set: { submitted: true } });
    return newAttempt();
  });
  await Promise.all([
    report(qc.reportViolation, b, { reason: "hidden", awayMs: 40000, count: true }),
    report(qc.reportViolation, b, { reason: "hidden", awayMs: 41000, count: true }),
  ]);
  doc = await Attempt.findById(b._id).lean();
  ok("two simultaneous strikes are both counted", doc.violations === 2);
  r = await report(qc.reportViolation, b, { reason: "reload", awayMs: 600000, count: true });
  doc = await Attempt.findById(b._id).lean();
  ok("third strike terminates", r.body.terminated === true && doc.terminated === true && doc.violations === 3);
  r = await report(qc.reportAway, b, { reason: "hidden", awayMs: 3000 });
  ok("a forgiven report never un-terminates or counts", r.body.violations === 3 && r.body.terminated === true);
  const bad = await call(qc.reportAway, { params: { examId: String(exam._id) }, body: { attemptId: String(new mongoose.Types.ObjectId()) }, user: student });
  ok("a foreign attemptId is refused", bad.code === 409);

  // ── 5) teacher restores a terminated result ──
  // Score through the real path: terminated attempt → 0 points.
  const examWithQs = {
    _id: exam._id,
    questions: {
      correctAnswers: [
        { type: "Cm", choices: ["a", "b", "c"], correct: [0] },
        { type: "Cm", choices: ["a", "b", "c"], correct: [1] },
      ],
    },
    results: [],
  };
  // The real exam points at a Question doc holding the key (pardon populates it).
  const Question = require("../models/questionModel");
  const qDoc = await Question.collection.insertOne({ correctAnswers: examWithQs.questions.correctAnswers });
  await Exam.updateOne({ _id: exam._id }, { $set: { questions: qDoc.insertedId } });
  const pts = await qc.scoreAndCreateResult(
    examWithQs,
    student,
    await Attempt.findById(b._id),
    [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }],
    { violations: 3, terminated: true, suppressNotifications: true }
  );
  let res = await Result.findOne({ attemptId: b._id }).lean();
  ok("terminated result scored 0", pts === 0 && res.terminated === true && res.earnPoints === 0);

  r = await call(qc.pardonResult, { params: { resultId: String(res._id) }, user: other });
  ok("another teacher can't restore it (403)", r.code === 403);
  r = await call(qc.pardonResult, { params: { resultId: String(res._id) }, user: teacher });
  res = await Result.findById(res._id).lean();
  const att = await Attempt.findById(b._id).lean();
  ok("owner restores: no longer terminated", r.code === 200 && res.terminated === false && !!res.pardonedAt);
  ok("…the saved answers are scored again (both right → > 0)", res.earnPoints > 0 && r.body.earnPoints === res.earnPoints);
  ok("…the attempt is no longer terminated either", att.terminated === false);
  ok("…violations are kept for the record", res.violations === 3);

  // A queued / retried submit still carrying terminated:true must not zero it again.
  await qc.scoreAndCreateResult(
    examWithQs,
    student,
    await Attempt.findById(b._id),
    [{ type: "Cm", answer: 0 }, { type: "Cm", answer: 1 }],
    { violations: 3, terminated: true, suppressNotifications: true }
  );
  const res2 = await Result.findById(res._id).lean();
  ok("a late submit with terminated:true can't re-terminate a restored result", res2.terminated === false && res2.earnPoints === res.earnPoints);
  r = await call(qc.pardonResult, { params: { resultId: String(res._id) }, user: teacher });
  ok("restoring twice is harmless", r.code === 200 && r.body.already === true);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
