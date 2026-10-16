/*
 * The settings page on a LIVE exam, over real sockets (2026-10-16).
 *
 * Nigar set an exam to 45 minutes in the support chat; a settings page still
 * showing 60 was saved a minute later. Two things went wrong at once:
 *  - the settings page saves with publish:false, and the server then left the
 *    change in the exam record only, while students were served the last
 *    published version — 17 exams of 7 teachers had drifted that way;
 *  - nothing stopped a page loaded earlier from putting old values back.
 * So: a live exam's settings save is published, and a save whose `base` (the
 * values the page loaded) is out of date is refused for the fields it would
 * change back.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-settings-live";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-settings-live";

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log("  ✓", label);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", label, extra ? `- ${extra}` : "");
  }
};

const FIELDS = {
  name: "Hüceyrə və orqanoidlər",
  duration: 3600,
  price: 0,
  videoLink: "",
  passingMarks: 50,
  totalMarks: 100,
  maxTry: 0,
  showScore: true,
  showCorrectAnswers: false,
  revealAfterEnd: false,
  password: "",
  negativeMarking: false,
  wrongPerPenalty: 3,
  correctPerPenalty: 1,
  negMarkUntil: 0,
  preset: "custom",
  antiCheat: false,
  mode: "structured",
  shuffleOptions: false,
  shuffleQuestions: false,
  partialCredit: false,
  studentSolutionPhotos: false,
  coverImage: "",
};

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "settingslive" });
  const User = require("../../models/userModel");
  const Class = require("../../models/classModel");
  const Exam = require("../../models/examModel");
  const ExamVersion = require("../../models/examVersionModel");
  const { generateToken } = require("../../utils");
  const errorHandler = require("../../middleware/errorMiddleware");

  const teacher = await User.create({ name: "Nigar", email: "n@live.test", password: "xxxxxxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const cls = await Class.create({ name: "9-cu sinif — Biologiya", owner: teacher._id });
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use("/api/quiz", require("../../routes/quizRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/quiz`;
  const auth = { Authorization: `Bearer ${generateToken(teacher._id, teacher.sessionVersion)}` };
  const json = (method, url, body) => fetch(url, { method, headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const read = async (res) => {
    const t = await res.text();
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
  const studentsGet = async (id) => {
    const e = await Exam.findById(id).lean();
    const v = e.activeVersionId ? await ExamVersion.findById(e.activeVersionId).lean() : null;
    return { exam: e, version: v, duration: v?.display?.duration };
  };

  // A live exam: created, a question, published.
  const fd = new FormData();
  Object.entries({ ...FIELDS, clientMutationId: `live:${Date.now()}` }).forEach(([k, v]) => fd.append(k, String(v)));
  const created = await read(await fetch(`${base}/addExam/${cls._id}`, { method: "POST", headers: auth, body: fd }));
  const examId = created?.data?._id || created?._id;
  await json("POST", `${base}/addQuestion/${examId}`, {
    correctAnswers: [{ type: "Cm", answer: "0", text: "Hüceyrənin enerji mərkəzi?", choices: [{ text: "Mitoxondri" }, { text: "Ribosom" }], correct: [0] }],
    questionsPerPage: 1,
    forwardOnly: false,
    typePoints: null,
    listeningAudio: "",
    aiPrompt: "",
    deferPublish: true,
  });
  const pub = await json("PATCH", `${base}/editExam/${examId}`, { ...FIELDS, publish: true });
  let s = await studentsGet(examId);
  ok("setup: the exam is live, students get 60 minutes", pub.status === 200 && !!s.version && s.duration === 3600, `${pub.status} ${s.duration}`);

  console.log("\nthe settings page saves a live exam (publish:false, as it sends):");
  const v1 = String(s.exam.activeVersionId);
  const save = await json("PATCH", `${base}/editExam/${examId}`, { ...FIELDS, duration: 2700, publish: false });
  s = await studentsGet(examId);
  ok("saved", save.status === 200, `got ${save.status}`);
  ok("the teacher sees 45 minutes", s.exam.duration === 2700);
  ok("…and so do the students: a new version is published", s.duration === 2700 && String(s.exam.activeVersionId) !== v1, `students ${s.duration}`);

  console.log("\na page loaded earlier cannot put old values back:");
  // Meanwhile the support chat sets 60 (as its card does: the exam, then a new version).
  await Exam.updateOne({ _id: examId }, { $set: { duration: 3600 } });
  const loadedThen = { ...FIELDS, duration: 2700 }; // what the old page had loaded
  const stale = await json("PATCH", `${base}/editExam/${examId}`, { ...FIELDS, duration: 2700, publish: false, base: loadedThen });
  const staleBody = await read(stale);
  s = await studentsGet(examId);
  ok("refused (409, stale)", stale.status === 409 && staleBody.reason === "stale" && staleBody.fields?.includes("duration"), `${stale.status} ${JSON.stringify(staleBody).slice(0, 160)}`);
  ok("…saying what changed, in the teacher's words", /müddət/.test(staleBody.message) && /yeniləyib/.test(staleBody.message), staleBody.message);
  ok("…and the newer 60 minutes stand", s.exam.duration === 3600);

  const fresh = await json("PATCH", `${base}/editExam/${examId}`, { ...FIELDS, duration: 3000, publish: false, base: { ...FIELDS, duration: 3600 } });
  s = await studentsGet(examId);
  ok("a page that loaded the current values saves", fresh.status === 200 && s.exam.duration === 3000 && s.duration === 3000, `${fresh.status} ${s.exam.duration} ${s.duration}`);

  const sameValue = await json("PATCH", `${base}/editExam/${examId}`, { ...FIELDS, duration: 3000, passingMarks: 60, publish: false, base: { ...FIELDS, duration: 2700 } });
  s = await studentsGet(examId);
  ok("an out-of-date field the save leaves as it now is does not block it", sameValue.status === 200 && s.exam.passingMarks === 60, `got ${sameValue.status}`);
  const noBase = await json("PATCH", `${base}/editExam/${examId}`, { ...FIELDS, duration: 3000, passingMarks: 60, publish: false });
  ok("a save without `base` (other callers) is unchanged", noBase.status === 200);

  console.log("\na change made and undone reaches students too (60 → 45 → 60):");
  await json("PATCH", `${base}/editExam/${examId}`, { ...FIELDS, duration: 3600, passingMarks: 60, publish: false });
  await json("PATCH", `${base}/editExam/${examId}`, { ...FIELDS, duration: 2700, passingMarks: 60, publish: false });
  s = await studentsGet(examId);
  ok("…45 published", s.duration === 2700, `students ${s.duration}`);
  await json("PATCH", `${base}/editExam/${examId}`, { ...FIELDS, duration: 3600, passingMarks: 60, publish: false });
  s = await studentsGet(examId);
  ok("…and back to 60: students get 60 again (the earlier version is reused)", s.duration === 3600 && s.exam.duration === 3600, `students ${s.duration}`);

  console.log("\nan exam not yet live is not published by a details save:");
  const fd2 = new FormData();
  Object.entries({ ...FIELDS, name: "Qaralama", clientMutationId: `draft:${Date.now()}` }).forEach(([k, v]) => fd2.append(k, String(v)));
  const draft = await read(await fetch(`${base}/addExam/${cls._id}`, { method: "POST", headers: auth, body: fd2 }));
  const draftId = draft?.data?._id || draft?._id;
  const d = await json("PATCH", `${base}/editExam/${draftId}`, { ...FIELDS, name: "Qaralama", duration: 1800, publish: false });
  const dRow = await Exam.findById(draftId).lean();
  ok("saved, and still unpublished", d.status === 200 && !dRow.activeVersionId && dRow.duration === 1800, `${d.status} ${dRow.activeVersionId}`);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
