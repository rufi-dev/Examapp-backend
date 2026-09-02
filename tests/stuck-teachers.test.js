/*
 * Who counts as "stuck" — the rule that decides who receives an unsolicited
 * WhatsApp asking what went wrong.
 *
 * Getting this wrong in the generous direction is expensive in a way a bug report
 * never captures: a teacher with ten live exams was queued for a "what went wrong?"
 * message because she had made two empty classes for next term. Messaging an active
 * customer as though she had failed is worse than not messaging her at all.
 *
 * Run against a real in-memory Mongo, because the whole thing is an aggregation
 * over exams, questions and classes.
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/userModel");
const Class = require("../models/classModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const { stuckStateForOwners } = require("../helper/stuckTeachers");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

let seq = 0;
const teacher = async () => {
  seq += 1;
  return User.create({
    name: `Müəllim ${seq}`,
    email: `st${seq}@example.com`,
    password: "x".repeat(20),
    role: "teacher",
  });
};

// An exam with real questions in it — what "got going" actually means.
async function readyExam(owner, cls) {
  const exam = await Exam.create({
    name: "Real", owner: owner._id, class: cls._id,
    duration: 30, totalMarks: 10, passingMarks: 5,
  });
  const q = await Question.create({
    exam: exam._id,
    correctAnswers: [{ type: "Cs", statement: "2+2", answer: "4" }],
  });
  await Exam.updateOne({ _id: exam._id }, { $set: { questions: q._id } });
  return exam;
}
const emptyExam = (owner, cls) =>
  Exam.create({
    name: "Boş", owner: owner._id, class: cls._id,
    duration: 30, totalMarks: 10, passingMarks: 5,
  });

const stateOf = async (t) => (await stuckStateForOwners([t._id])).get(String(t._id));

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  console.log("\n1. Genuinely stuck teachers are still found:");
  {
    const t1 = await teacher();
    ok("signed up, made nothing → stuck", (await stateOf(t1)).isStuck === true);

    const t2 = await teacher();
    await Class.create({ owner: t2._id, name: "Boş sinif" });
    const s2 = await stateOf(t2);
    ok("a class with no exams → stuck", s2.isStuck === true && s2.hasEmptyClass === true);

    const t3 = await teacher();
    const c3 = await Class.create({ owner: t3._id, name: "Sinif" });
    await emptyExam(t3, c3);
    const s3 = await stateOf(t3);
    ok("an exam with no questions and no PDF → stuck", s3.isStuck === true && s3.hasEmptyExam === true);
    ok("and it counts as no working exam", s3.readyExams === 0, s3.readyExams);
  }

  console.log("\n2. An active teacher is NOT stuck, whatever else is lying around:");
  {
    // The exact shape of the real case: plenty of working exams, plus empty
    // classes made for a future term.
    const t = await teacher();
    const a = await Class.create({ owner: t._id, name: "İnformatika 11" });
    await Class.create({ owner: t._id, name: "Magistr" });          // empty
    await Class.create({ owner: t._id, name: "Dövlət Qulluğu" });   // empty
    await readyExam(t, a);
    await readyExam(t, a);

    const s = await stateOf(t);
    ok("two empty classes are still REPORTED", s.emptyClasses === 2, s.emptyClasses);
    ok("her working exams are counted", s.readyExams === 2, s.readyExams);
    ok("but she is NOT stuck", s.isStuck === false, JSON.stringify(s));

    // A leftover draft beside working exams is housekeeping, not a stall.
    const t2 = await teacher();
    const c2 = await Class.create({ owner: t2._id, name: "Sinif" });
    await readyExam(t2, c2);
    await emptyExam(t2, c2);
    const s2 = await stateOf(t2);
    ok("a draft next to a working exam is reported", s2.hasEmptyExam === true);
    ok("and does not make them stuck", s2.isStuck === false, JSON.stringify(s2));
  }

  console.log("\n3. A PDF exam counts as working, same as a question exam:");
  {
    const t = await teacher();
    const c = await Class.create({ owner: t._id, name: "Sinif" });
    await Class.create({ owner: t._id, name: "Boş" });
    await Exam.create({
      name: "PDF imtahan", owner: t._id, class: c._id, pdf: new mongoose.Types.ObjectId(),
      duration: 30, totalMarks: 10, passingMarks: 5,
    });
    const s = await stateOf(t);
    ok("a PDF exam is a working exam", s.readyExams === 1, s.readyExams);
    ok("so a PDF teacher is not stuck", s.isStuck === false, JSON.stringify(s));
  }

  console.log("\n4. Edge cases:");
  {
    ok("an empty id list returns an empty map", (await stuckStateForOwners([])).size === 0);
    const t = await teacher();
    const s = await stuckStateForOwners([t._id, null, undefined]);
    ok("nulls are ignored rather than throwing", s.size === 1);
    // A deleted exam must not count as working — otherwise deleting everything
    // would quietly remove a teacher from outreach.
    const t2 = await teacher();
    const c2 = await Class.create({ owner: t2._id, name: "Sinif" });
    const e = await readyExam(t2, c2);
    await Exam.updateOne({ _id: e._id }, { $set: { deletedAt: new Date() } });
    const s2 = await stateOf(t2);
    ok("a deleted exam is not a working exam", s2.readyExams === 0, s2.readyExams);
    ok("so they are stuck again", s2.isStuck === true, JSON.stringify(s2));
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} stuck-teacher assertions failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
