/*
 * Live exam cameras, over real sockets (2026-10-18). The owner: "in a live exam,
 * open the students' cameras and the teacher watches"; "only if enabled in the
 * settings"; "a student who doesn't open it can still take the exam".
 *
 * The backend only signs LiveKit passes (helper/liveCamera); the video never
 * passes through it. So: the setting saves (and a save that does not send it
 * leaves it alone); a student with an exam under way gets a pass to send ONE
 * camera and see no one; the exam's teacher gets a hidden pass to watch; nobody
 * else gets either; nothing at all with the setting off; and without the video
 * server configured, the student is told so (and takes the exam without one).
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-live-camera";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-live-camera";
process.env.LIVEKIT_URL = "wss://lk.test.example";
process.env.LIVEKIT_API_KEY = "APItestkey";
process.env.LIVEKIT_API_SECRET = "test-livekit-secret-0123456789";

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
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
  name: "Hüceyrə", duration: 3600, price: 0, videoLink: "", passingMarks: 50, totalMarks: 100, maxTry: 0,
  showScore: true, showCorrectAnswers: false, revealAfterEnd: false, password: "", negativeMarking: false,
  wrongPerPenalty: 3, correctPerPenalty: 1, negMarkUntil: 0, preset: "custom", antiCheat: false, mode: "structured",
  shuffleOptions: false, shuffleQuestions: false, partialCredit: false, studentSolutionPhotos: false, coverImage: "",
};

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "livecamera" });
  const User = require("../../models/userModel");
  const Class = require("../../models/classModel");
  const Exam = require("../../models/examModel");
  const Attempt = require("../../models/attemptModel");
  const { generateToken } = require("../../utils");
  const errorHandler = require("../../middleware/errorMiddleware");

  const mk = (name, email, role) => User.create({ name, email, password: "xxxxxxxxxxxx", role, teacherApproval: "approved", isVerified: true });
  const teacher = await mk("Nigar", "n@cam.test", "teacher");
  const other = await mk("Başqa müəllim", "o@cam.test", "teacher");
  const student = await mk("Murad Əliyev", "s@cam.test", "student");
  const cls = await Class.create({ name: "9-A", owner: teacher._id });

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use("/api/quiz", require("../../routes/quizRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/quiz`;
  const as = (u) => ({ Authorization: `Bearer ${generateToken(u._id, u.sessionVersion)}` });
  const call = async (u, method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers: { ...as(u), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty */
    }
    return { status: res.status, body: json, cache: res.headers.get("cache-control") };
  };
  const decode = (t) => jwt.verify(t, process.env.LIVEKIT_API_SECRET, { algorithms: ["HS256"] });

  // An exam with a question, as the builder makes it.
  const fd = new FormData();
  Object.entries({ ...FIELDS, clientMutationId: `cam:${Date.now()}` }).forEach(([k, v]) => fd.append(k, String(v)));
  const created = await (await fetch(`${base}/addExam/${cls._id}`, { method: "POST", headers: as(teacher), body: fd })).json();
  const examId = created?.data?._id || created?._id;
  await call(teacher, "POST", `/addQuestion/${examId}`, {
    correctAnswers: [{ type: "Cm", answer: "0", text: "Hüceyrənin enerji mərkəzi?", choices: [{ text: "Mitoxondri" }, { text: "Ribosom" }], correct: [0] }],
    questionsPerPage: 1, forwardOnly: false, typePoints: null, listeningAudio: "", aiPrompt: "", deferPublish: true,
  });

  console.log("\nthe setting:");
  ok("off for a new exam", (await Exam.findById(examId).lean()).cameraMonitoring === false);
  let r = await call(student, "GET", `/exam/${examId}/camera/token`);
  ok("off: no pass for anyone (409)", r.status === 409, `${r.status}`);
  const save = await call(teacher, "PATCH", `/editExam/${examId}`, { ...FIELDS, cameraMonitoring: true, publish: false });
  ok("the settings page turns it on", save.status === 200 && (await Exam.findById(examId).lean()).cameraMonitoring === true, `${save.status}`);
  await call(teacher, "PATCH", `/editExam/${examId}`, { ...FIELDS, duration: 2700, publish: false });
  ok("a save that does not send it leaves it on", (await Exam.findById(examId).lean()).cameraMonitoring === true);

  console.log("\na student's pass to send:");
  r = await call(student, "GET", `/exam/${examId}/camera/token`);
  ok("no exam under way: no pass (403)", r.status === 403, `${r.status}`);
  await Attempt.create({ userId: student._id, examId, startedAt: new Date(), expiresAt: new Date(Date.now() + 40 * 60 * 1000), submitted: false });
  r = await call(student, "GET", `/exam/${examId}/camera/token`);
  ok("taking the exam: a pass, and where to send", r.status === 200 && r.body?.url === "wss://lk.test.example" && !!r.body?.token, `${r.status} ${JSON.stringify(r.body)}`);
  ok("never cached", /no-store/.test(r.cache || ""));
  const sp = decode(r.body.token);
  ok("signed with the video server's key, for this student", sp.iss === "APItestkey" && sp.sub === `u-${student._id}` && sp.name === "Murad Əliyev");
  ok("the exam's own room", sp.video?.room === `exam-${examId}` && sp.video?.roomJoin === true);
  ok("may send a camera and a microphone — nothing else (no screen)", sp.video?.canPublish === true && JSON.stringify(sp.video?.canPublishSources) === '["camera","microphone"]');
  ok("sees no one, sends no data", sp.video?.canSubscribe === false && sp.video?.canPublishData === false);
  ok("good for the exam's time (and a little more), not for ever", sp.exp - sp.iat >= 40 * 60 && sp.exp - sp.iat <= 52 * 60, `${sp.exp - sp.iat}s`);
  const lp = decode(r.body.listen || "");
  ok("…and a pass to hear the teacher, in the separate voice room", lp.sub === `u-${student._id}` && lp.video?.room === `exam-${examId}-voice` && lp.video?.roomJoin === true);
  ok("there it only listens, unseen by the other students, sends nothing", lp.video?.canSubscribe === true && lp.video?.canPublish === false && lp.video?.hidden === true && lp.video?.canPublishData === false);
  ok("…for the exam's time too", lp.exp - lp.iat >= 40 * 60 && lp.exp - lp.iat <= 52 * 60);
  r = await call(teacher, "GET", `/exam/${examId}/camera/token`);
  ok("a teacher who is not taking it gets no student pass", r.status === 403, `${r.status}`);

  console.log("\nthe teacher's pass to watch:");
  r = await call(teacher, "GET", `/exam/${examId}/camera/watch`);
  ok("the exam's teacher: a pass", r.status === 200 && !!r.body?.token, `${r.status}`);
  const tp = decode(r.body.token);
  ok("watches and listens to every student, hidden, sends nothing there", tp.video?.canSubscribe === true && tp.video?.hidden === true && tp.video?.canPublish === false && tp.video?.room === `exam-${examId}`);
  const kp = decode(r.body.talk || "");
  ok("…and a pass to speak, in the voice room, as the same person", kp.sub === tp.sub && kp.video?.room === `exam-${examId}-voice`);
  ok("there: a microphone only, says whom to (attributes), hears no one, visible to students", kp.video?.canPublish === true && JSON.stringify(kp.video?.canPublishSources) === '["microphone"]' && kp.video?.canUpdateOwnMetadata === true && kp.video?.canSubscribe === false && !kp.video?.hidden);
  ok("a different identity for each tab (no one kicks another out)", tp.sub.startsWith(`t-${teacher._id}-`) && decode((await call(teacher, "GET", `/exam/${examId}/camera/watch`)).body.token).sub !== tp.sub);
  ok("another teacher: no (403)", (await call(other, "GET", `/exam/${examId}/camera/watch`)).status === 403);
  ok("a student: no (403)", (await call(student, "GET", `/exam/${examId}/camera/watch`)).status === 403);

  console.log("\nthe live board knows the cameras:");
  r = await call(teacher, "GET", `/exam/${examId}/live`);
  ok("cameras on, and the video server there", r.body?.cameraMonitoring === true && r.body?.cameraReady === true);
  const row = (r.body?.students || []).find((x) => !x.finished);
  ok("each student's card carries the id their camera comes under", row?.userId === String(student._id), JSON.stringify(row || {}).slice(0, 120));

  console.log("\nwithout the video server:");
  const saved = process.env.LIVEKIT_API_SECRET;
  delete process.env.LIVEKIT_API_SECRET;
  r = await call(student, "GET", `/exam/${examId}/camera/token`);
  ok("the student is told (503) — and takes the exam without a camera", r.status === 503, `${r.status}`);
  ok("the board says the service is not there", (await call(teacher, "GET", `/exam/${examId}/live`)).body?.cameraReady === false);
  process.env.LIVEKIT_API_SECRET = saved;

  console.log("\nturned off again:");
  await call(teacher, "PATCH", `/editExam/${examId}`, { ...FIELDS, cameraMonitoring: false, publish: false });
  ok("no pass for the student", (await call(student, "GET", `/exam/${examId}/camera/token`)).status === 409);
  ok("nor for the teacher", (await call(teacher, "GET", `/exam/${examId}/camera/watch`)).status === 409);

  await new Promise((done) => server.close(done));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
