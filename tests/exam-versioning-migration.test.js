/*
 * AUD-003 migration lifecycle (in-memory Mongo, real child-process runs):
 *   dry-run (read-only) → fail-closed on a non-throwaway name → apply (baseline
 *   versions + legacy tagging) → verify → idempotent re-apply → rollback.
 */
const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const Result = require("../models/resultModel");
const ExamVersion = require("../models/examVersionModel");

const BE = path.join(__dirname, "..");
const MIG = "migrations/2026-07-25-exam-versioning.js";
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function run(uri, args) {
  try {
    return { code: 0, out: execFileSync("node", [MIG, ...args], { cwd: BE, env: { ...process.env, MONGO_URI: uri }, encoding: "utf8" }) };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

async function main() {
  const mem = await MongoMemoryServer.create();
  const host = mem.getUri().replace(/\/?$/, "/");
  const TEST_DB = "exq_e2e_test";
  const PROD_DB = "examopia_prod";
  const testUri = host + TEST_DB;
  const prodUri = host + PROD_DB;

  await mongoose.connect(testUri);
  const oid = () => new mongoose.Types.ObjectId();

  // Two exams WITH a question doc, one WITHOUT (ambiguous), plus a legacy result.
  const e1 = await Exam.create({ name: "A", duration: 60, price: 0, totalMarks: 100, passingMarks: 50, owner: oid(), class: oid() });
  const q1 = await Question.create({ exam: e1._id, correctAnswers: [{ type: "Cm", choices: [{ text: "a" }], correct: [0] }] });
  e1.questions = q1._id; await e1.save();
  const e2 = await Exam.create({ name: "B", duration: 60, price: 0, totalMarks: 100, passingMarks: 50, owner: oid(), class: oid() });
  const q2 = await Question.create({ exam: e2._id, correctAnswers: [{ type: "Co", answers: ["x"] }] });
  e2.questions = q2._id; await e2.save();
  await Exam.create({ name: "C-no-key", duration: 60, price: 0, totalMarks: 100, passingMarks: 50, owner: oid(), class: oid() });
  const legacyResult = await Result.create({ userId: oid(), examId: e1._id, earnPoints: 42, attemptId: oid() });

  // ---- 1) DRY RUN is read-only ----
  const dry = run(testUri, ["--dry-run", "--db=" + TEST_DB]);
  ok("dry-run exits 0", dry.code === 0);
  ok("dry-run reports READ ONLY", /READ ONLY/i.test(dry.out));
  ok("dry-run census counts 2 exams-with-questions", /with-questions=2/.test(dry.out));
  ok("dry-run created NO versions", (await ExamVersion.countDocuments({})) === 0);
  ok("dry-run did NOT tag the legacy result", (await Result.findById(legacyResult._id)).legacyUnversioned === false);

  // ---- 2) FAIL-CLOSED on a non-throwaway db, no --db/--force ----
  const blocked = run(prodUri, ["--apply"]);
  ok("apply on non-throwaway NAME refused (exit 3)", blocked.code === 3);
  ok("blocked run created nothing", (await ExamVersion.countDocuments({})) === 0);

  // ---- 3) APPLY: baseline versions + legacy tagging ----
  const apply = run(testUri, ["--apply", "--db=" + TEST_DB]);
  ok("apply exits 0", apply.code === 0);
  ok("apply created exactly 2 baseline versions (one per exam-with-key)", (await ExamVersion.countDocuments({})) === 2);
  ok("each exam-with-key has a v1", (await ExamVersion.countDocuments({ examId: e1._id, versionNumber: 1 })) === 1
    && (await ExamVersion.countDocuments({ examId: e2._id, versionNumber: 1 })) === 1);
  ok("the no-key exam got NO version", (await ExamVersion.countDocuments({ examId: (await Exam.findOne({ name: "C-no-key" }))._id })) === 0);
  ok("legacy result tagged legacyUnversioned", (await Result.findById(legacyResult._id)).legacyUnversioned === true);

  // ---- 4) RE-APPLY is idempotent (no duplicate versions) ----
  const reapply = run(testUri, ["--apply", "--db=" + TEST_DB]);
  ok("re-apply exits 0", reapply.code === 0);
  ok("re-apply created NO duplicate versions (still 2)", (await ExamVersion.countDocuments({})) === 2);

  // ---- 5) ROLLBACK deletes unreferenced versions + untags results ----
  const rollback = run(testUri, ["--rollback", "--db=" + TEST_DB]);
  ok("rollback exits 0", rollback.code === 0);
  ok("rollback removed the unreferenced baseline versions", (await ExamVersion.countDocuments({})) === 0);
  ok("rollback untagged the legacy result", (await Result.findById(legacyResult._id)).legacyUnversioned === false);

  // ---- 6) ROLLBACK preserves a REFERENCED version ----
  run(testUri, ["--apply", "--db=" + TEST_DB]);
  const v = await ExamVersion.findOne({ examId: e1._id });
  await Result.create({ userId: oid(), examId: e1._id, earnPoints: 10, attemptId: oid(), examVersionId: v._id });
  run(testUri, ["--rollback", "--db=" + TEST_DB]);
  ok("rollback KEEPS a version referenced by a result", (await ExamVersion.countDocuments({ _id: v._id })) === 1);
  ok("rollback still dropped the unreferenced version (e2's)", (await ExamVersion.countDocuments({ examId: e2._id })) === 0);

  // ── CR-034: apply → rollback → re-apply leaves NO dangling active pointer ──
  {
    const Exam2 = require("../models/examModel");
    // Fresh exam with an UNREFERENCED version so rollback deletes it.
    const ex = await Exam2.create({ name: "P", duration: 60, price: 0, totalMarks: 100, passingMarks: 50, owner: oid(), class: oid() });
    const q = await Question.create({ exam: ex._id, correctAnswers: [{ type: "Cm", choices: [{ text: "a" }], correct: [0] }] });
    ex.questions = q._id; await ex.save();
    run(testUri, ["--apply", "--db=" + TEST_DB]); // publishes v1 + sets pointer
    const afterApply = await Exam2.findById(ex._id).lean();
    ok("apply set a valid active pointer", afterApply.activeVersionId != null && afterApply.activeVersionNumber === 1);

    run(testUri, ["--rollback", "--db=" + TEST_DB]); // deletes the unreferenced v1
    const afterRollback = await Exam2.findById(ex._id).lean();
    const pointerDangles = afterRollback.activeVersionId != null && !(await ExamVersion.findById(afterRollback.activeVersionId).lean());
    ok("rollback left NO dangling active pointer (cleared or repointed)", !pointerDangles);

    run(testUri, ["--apply", "--db=" + TEST_DB]); // re-apply
    const afterReapply = await Exam2.findById(ex._id).lean();
    const pointerVersion = afterReapply.activeVersionId ? await ExamVersion.findById(afterReapply.activeVersionId).lean() : null;
    ok("re-apply established an EXISTING active pointer", !!pointerVersion);
    ok("re-apply pointer number matches the pointed version", pointerVersion && afterReapply.activeVersionNumber === pointerVersion.versionNumber);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
