/*
 * AUD-003 CR-034/035 hardening — the adversarial cases the reviewer reproduced:
 * concurrent v2/v3 publish monotonicity, dangling active pointer = integrity
 * failure, frozen-vs-live runner metadata, forbidden mutation/delete of published
 * versions, and unknown-evaluator replay fails closed.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../models/resultModel");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const ExamVersion = require("../models/examVersionModel");
const User = require("../models/userModel");
const { publishExam, hashSnapshot } = require("../helper/examVersion");
const { startAttempt, addResult } = require("../controllers/quizController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const throwsAsync = async (fn) => { try { await fn(); return false; } catch (_) { return true; } };

function mkRes() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function callThrows(fn, { params = {}, body = {}, userId }) {
  const res = mkRes(); let err = null;
  await fn({ params, body, user: { _id: userId } }, res, (e) => (err = e));
  return { res, err };
}
async function call(fn, o) { const r = await callThrows(fn, o); if (r.err) throw r.err; return r.res; }

let seq = 0;
const mkTeacher = () => User.create({ name: "T", email: `t${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
async function mkStudent(examId) { const u = await User.create({ name: "S", email: `s${Date.now()}_${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true }); if (examId) { u.exams.push(examId); await u.save(); } return u; }
async function mkExam(owner, over = {}) {
  const exam = await Exam.create({ name: "E", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, mode: "structured", class: new mongoose.Types.ObjectId(), ...over });
  const q = await Question.create({ exam: exam._id, correctAnswers: [{ type: "Cm", text: "Q1", choices: [{ text: "a" }, { text: "b" }], correct: [0] }, { type: "Cm", text: "Q2", choices: [{ text: "a" }, { text: "b" }], correct: [1] }] });
  exam.questions = q._id; await exam.save();
  return { exam, q };
}
const publish = async (examId) => { const e = await Exam.findById(examId).populate("questions"); return publishExam(e, e.questions, ExamVersion, Exam); };

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Attempt.createIndexes();
  await Result.createIndexes();
  await ExamVersion.createIndexes();

  // ── CR-034: concurrent publishes of different content → pointer is MONOTONIC ──
  {
    const teacher = await mkTeacher();
    const { exam } = await mkExam(teacher);
    await publish(exam._id); // v1
    // Two concurrent publishes of genuinely different content.
    const eB = await Exam.findById(exam._id).populate("questions"); eB.questions.correctAnswers[0].correct = [1];
    const eC = await Exam.findById(exam._id).populate("questions"); eC.questions.correctAnswers[1].correct = [0];
    await Promise.all([publishExam(eB, eB.questions, ExamVersion, Exam), publishExam(eC, eC.questions, ExamVersion, Exam)]);
    const maxNum = Math.max(...(await ExamVersion.find({ examId: exam._id }).distinct("versionNumber")));
    const fresh = await Exam.findById(exam._id).lean();
    ok("active pointer equals the MAX version number (no stale override)", fresh.activeVersionNumber === maxNum && maxNum === 3);
    const active = await ExamVersion.findById(fresh.activeVersionId).lean();
    ok("active version id matches the max-number version", active.versionNumber === maxNum);
  }

  // ── CR-034: a dangling active pointer is an integrity failure at start ──
  {
    const teacher = await mkTeacher();
    const { exam } = await mkExam(teacher);
    await publish(exam._id);
    await Exam.updateOne({ _id: exam._id }, { $set: { activeVersionId: new mongoose.Types.ObjectId() } }); // dangling
    const student = await mkStudent(exam._id);
    const { err } = await callThrows(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    ok("dangling active pointer throws a version integrity error at start", !!err && /integrity|missing/i.test(err.message || ""));
  }

  // ── CR-034: runner metadata is FROZEN with the version, not live ──
  {
    const teacher = await mkTeacher();
    const { exam } = await mkExam(teacher, { duration: 600, questionsPerPage: 2, forwardOnly: true });
    const student = await mkStudent(exam._id);
    const s1 = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    ok("start payload duration comes from the version (600)", s1.body.duration === 600);
    ok("start payload questionsPerPage frozen (2)", s1.body.questionsPerPage === 2);
    // Edit live metadata WITHOUT republishing.
    await Exam.updateOne({ _id: exam._id }, { $set: { duration: 999, questionsPerPage: 9, forwardOnly: false } });
    const s2 = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id }); // resume
    ok("resume still shows FROZEN duration 600 (not live 999)", s2.body.duration === 600);
    ok("resume still shows FROZEN questionsPerPage 2 (not live 9)", s2.body.questionsPerPage === 2);
    ok("resume still shows FROZEN forwardOnly true (not live false)", s2.body.forwardOnly === true);
  }

  // ── CR-035: published versions are immutable across ALL mutation/delete surfaces ──
  {
    const MaintenanceAudit = require("../models/maintenanceAuditModel");
    const { performMaintenance } = require("../services/versionMaintenance");
    const teacher = await mkTeacher();
    const { exam } = await mkExam(teacher);
    const v = await publish(exam._id);
    ok("query updateOne BLOCKED", await throwsAsync(() => ExamVersion.updateOne({ _id: v._id }, { $set: { versionNumber: 99 } })));
    ok("query deleteOne BLOCKED", await throwsAsync(() => ExamVersion.deleteOne({ _id: v._id })));
    ok("findOneAndUpdate BLOCKED", await throwsAsync(() => ExamVersion.findOneAndUpdate({ _id: v._id }, { $set: { contentHash: "x" } })));
    ok("findOneAndReplace BLOCKED", await throwsAsync(() => ExamVersion.findOneAndReplace({ _id: v._id }, { examId: exam._id })));
    ok("bulkWrite BLOCKED", await throwsAsync(() => ExamVersion.bulkWrite([{ deleteOne: { filter: { _id: v._id } } }])));
    // THE reproduced defect: document-level doc.deleteOne() must be blocked too.
    const doc = await ExamVersion.findById(v._id);
    ok("DOCUMENT doc.deleteOne() BLOCKED", await throwsAsync(() => doc.deleteOne()));
    ok("the version still exists after all blocked deletes", (await ExamVersion.countDocuments({ _id: v._id })) === 1);
    doc.versionNumber = 42;
    ok("re-saving a published version doc is BLOCKED", await throwsAsync(() => doc.save()));

    // A public {maintenance:true} option is NO LONGER a bypass.
    ok("public {maintenance:true} option is NOT a bypass", await throwsAsync(() => ExamVersion.deleteOne({ _id: v._id }, { maintenance: true })));

    // The authorized+audited maintenance service requires actor+reason+authorization.
    ok("maintenance service rejects a missing actor/reason", await throwsAsync(() => performMaintenance({ authorized: true }, () => ExamVersion.deleteOne({ _id: v._id }))));
    const before = await MaintenanceAudit.countDocuments({});
    const del = await performMaintenance(
      { actor: "admin:test", reason: "test cleanup", action: "exam_version_delete", authorized: true },
      () => ExamVersion.deleteOne({ _id: v._id })
    );
    ok("authorized+audited maintenance delete succeeds", del.deletedCount === 1);
    ok("a durable audit event was written", (await MaintenanceAudit.countDocuments({})) === before + 1);
  }

  // ── CR-035: an UNKNOWN evaluatorVersion fails closed at grading ──
  {
    const teacher = await mkTeacher();
    const { exam } = await mkExam(teacher);
    const student = await mkStudent(exam._id);
    const started = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    const attemptId = started.body.attemptId;
    const bound = (await Attempt.findById(attemptId)).examVersionId;
    // Native escape: set an UNKNOWN evaluatorVersion AND recompute a matching hash
    // (so integrity verification passes and the EVALUATOR DISPATCHER is what rejects).
    const vdoc = await ExamVersion.findById(bound).lean();
    vdoc.evaluatorVersion = "99";
    const newHash = hashSnapshot(vdoc);
    await ExamVersion.collection.updateOne({ _id: bound }, { $set: { evaluatorVersion: "99", contentHash: newHash } });
    const { res } = await callThrows(addResult, { params: { examId: String(exam._id) }, userId: student._id, body: { attemptId, selectedAnswers: [{ type: "Cm", answer: 0 }], clientRevision: 1, requestId: "r1" } });
    ok("grading with an unknown evaluatorVersion is blocked (409 integrity)", res.statusCode === 409 && res.body && res.body.reason === "version_integrity");
  }

  // ── CR-034: emptying the live draft after publish does NOT block a start ──
  {
    const teacher = await mkTeacher();
    const { exam, q } = await mkExam(teacher);
    await publish(exam._id); // active v1 has questions
    // Empty the live draft WITHOUT publishing (the reproduced 403 no_questions case).
    await Question.findByIdAndDelete(q._id);
    await Exam.updateOne({ _id: exam._id }, { $unset: { questions: 1 } });
    const student = await mkStudent(exam._id);
    const started = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    ok("start on a published exam whose live draft was emptied still works (no_questions checks the VERSION)", !!started.body.attemptId);
    ok("the started attempt still serves the frozen questions", Array.isArray(started.body.questions) && started.body.questions.length === 2);
  }

  // ── CR-034: antiCheat / listeningAudio are FROZEN with the version ──
  {
    const teacher = await mkTeacher();
    const { exam } = await mkExam(teacher, { antiCheat: false, listeningAudio: "" });
    const student = await mkStudent(exam._id);
    const s1 = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    ok("start payload antiCheat frozen false", s1.body.antiCheat === false);
    await Exam.updateOne({ _id: exam._id }, { $set: { antiCheat: true, listeningAudio: "http://x/a.mp3" } }); // live, no publish
    const s2 = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id }); // resume
    ok("resume still shows FROZEN antiCheat false (not live true)", s2.body.antiCheat === false);
    ok("resume still shows FROZEN listeningAudio '' (not the live change)", s2.body.listeningAudio === "");
  }

  // ── CR-034: result photo persistence uses the FROZEN studentSolutionPhotos ──
  {
    // frozen TRUE, live toggled FALSE without publishing → photo IS kept.
    const teacher = await mkTeacher();
    const { exam } = await mkExam(teacher, { studentSolutionPhotos: true });
    const student = await mkStudent(exam._id);
    const started = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    const attemptId = started.body.attemptId;
    await Exam.updateOne({ _id: exam._id }, { $set: { studentSolutionPhotos: false } }); // live, no publish
    await call(addResult, { params: { examId: String(exam._id) }, userId: student._id, body: { attemptId, selectedAnswers: [{ type: "Cm", answer: 0, photo: "http://x/p.jpg" }, { type: "Cm", answer: 1 }], clientRevision: 1 } });
    const r = await Result.findOne({ attemptId });
    ok("frozen photos=true → photo PERSISTED despite live=false", r.selectedAnswers[0].photo === "http://x/p.jpg");
  }
  {
    // frozen FALSE, live toggled TRUE → photo NOT kept.
    const teacher = await mkTeacher();
    const { exam } = await mkExam(teacher, { studentSolutionPhotos: false });
    const student = await mkStudent(exam._id);
    const started = await call(startAttempt, { params: { examId: String(exam._id) }, userId: student._id });
    const attemptId = started.body.attemptId;
    await Exam.updateOne({ _id: exam._id }, { $set: { studentSolutionPhotos: true } });
    await call(addResult, { params: { examId: String(exam._id) }, userId: student._id, body: { attemptId, selectedAnswers: [{ type: "Cm", answer: 0, photo: "http://x/p.jpg" }, { type: "Cm", answer: 1 }], clientRevision: 1 } });
    const r = await Result.findOne({ attemptId });
    ok("frozen photos=false → photo NOT persisted despite live=true", !r.selectedAnswers[0].photo);
  }

  // ── CR-034: republishExam reports NOT success when nothing was published ──
  {
    const { republishExam } = require("../controllers/quizController");
    const teacher = await mkTeacher();
    // An exam with NO question content: publishExam returns null (nothing to publish).
    const exam = await Exam.create({ name: "E", owner: teacher._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, mode: "structured", class: new mongoose.Types.ObjectId() });
    const pub = await republishExam(exam._id);
    ok("republishExam on a question-less exam reports NOT published (ok:false)", pub.ok === false && pub.reason === "not_published");
    ok("no version was activated", (await ExamVersion.countDocuments({ examId: exam._id })) === 0);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
