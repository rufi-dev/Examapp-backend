#!/usr/bin/env node
/*
 * The exam allowance, made to count again (2026-10-27).
 *
 * Exams stopped being created provisional on 2026-09-25, and the allowance was
 * spent only when a provisional exam became real — so no exam made in the
 * builder spent anything since, and the free start's one exam was no limit at
 * all. From now on an exam spends it once, on its first question, and carries
 * `allowanceSpent` (quizController.spendExamAllowance).
 *
 * This run does the two things that change needs:
 *   1. every exam that already has questions is marked spent, so editing an
 *      exam made before today never spends an allowance;
 *   2. a teacher in (or past) the free start who already made exams since it
 *      began gets the allowance those exams should have spent (never raised).
 *
 * Safe to re-run.
 *
 *   node migrations/2026-10-27-exam-allowance.js --dry-run
 *   node migrations/2026-10-27-exam-allowance.js --apply
 *   node migrations/2026-10-27-exam-allowance.js --verify
 */
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/userModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const { STARTER } = require("../config/plans");

const modes = ["dry-run", "apply", "verify"].filter((m) => process.argv.includes(`--${m}`));
if (modes.length !== 1) {
  console.error("REFUSED: pass exactly one of --dry-run, --apply, --verify");
  process.exit(2);
}
const mode = modes[0];
const DAY = 24 * 60 * 60 * 1000;
const UNMARKED = { questions: { $ne: null }, allowanceSpent: { $ne: true } };

// Free-start teachers and what their exams since the start should have left them.
async function starterShortfalls() {
  const teachers = await User.collection.find({ role: "teacher", starterUntil: { $ne: null } }, { projection: { name: 1, starterUntil: 1, examCreatesLeft: 1 } }).toArray();
  const out = [];
  for (const t of teachers) {
    const began = new Date(new Date(t.starterUntil).getTime() - STARTER.days * DAY);
    const exams = await Exam.collection.find({ owner: t._id, createdAt: { $gte: began }, questions: { $ne: null } }, { projection: { questions: 1 } }).toArray();
    let made = 0;
    for (const e of exams) {
      const q = await Question.collection.findOne({ _id: e.questions }, { projection: { n: { $size: { $ifNull: ["$correctAnswers", []] } } } });
      if (q && q.n > 0) made += 1;
    }
    const should = Math.max(0, STARTER.exams - made);
    const left = t.examCreatesLeft;
    if (made > 0 && (left === null || left === undefined || left > should)) out.push({ _id: t._id, name: String(t.name || "").split(" ")[0], made, left, should });
  }
  return out;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const unmarked = await Exam.collection.countDocuments(UNMARKED);
  const short = await starterShortfalls();
  const report = { unmarkedExamsWithQuestions: unmarked, starterTeachersToCorrect: short.map((s) => `${s.name}: made ${s.made}, left ${s.left} → ${s.should}`) };

  if (mode === "dry-run") {
    console.log(JSON.stringify({ mode, ...report }));
  } else if (mode === "apply") {
    const marked = await Exam.collection.updateMany(UNMARKED, { $set: { allowanceSpent: true } });
    let corrected = 0;
    for (const s of short) {
      const res = await User.collection.updateOne(
        { _id: s._id, $or: [{ examCreatesLeft: null }, { examCreatesLeft: { $exists: false } }, { examCreatesLeft: { $gt: s.should } }] },
        { $set: { examCreatesLeft: s.should } }
      );
      corrected += res.modifiedCount;
    }
    console.log(JSON.stringify({ mode, marked: marked.modifiedCount, corrected, before: report }));
  } else {
    const ok = unmarked === 0 && short.length === 0;
    console.log(JSON.stringify({ mode, ok, ...report }));
    process.exitCode = ok ? 0 : 1;
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
