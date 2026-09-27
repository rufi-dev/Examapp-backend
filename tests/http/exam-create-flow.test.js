/*
 * Creating an exam, over real sockets, exactly as the builder does it.
 *
 * This test exists because the path it covers was broken in production for a
 * day and nothing caught it. Every exam created in that window - nineteen of
 * them - came out empty, because the save died on its first call and the
 * teacher, seeing an error, pressed the button again.
 *
 * Both faults were the same KIND of fault: the request the client sends was
 * written out by hand from the field list rather than taken from what the
 * server actually requires. A unit test of either side would have passed. So
 * this one makes the real calls, against the real router with its real
 * middleware, in the real order, and asserts the thing a teacher cares about -
 * that at the end there is an exam with their questions in it.
 *
 * It also pins the two refusals, so the requirements cannot be quietly dropped
 * from the server without this failing loudly.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-create-flow";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-create-flow";

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

/* The exam-record fields the builder sends on a first save. */
const EXAM_FIELDS = {
  name: "Adsız imtahan",
  duration: 3600,
  price: 0,
  videoLink: "",
  passingMarks: 0,
  totalMarks: 0,
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

const QUESTION = {
  type: "Cm",
  answer: "0",
  text: "2 + 2 = ?",
  choices: [{ text: "3" }, { text: "4" }],
  correct: [0],
};

async function main() {
  console.log("creating an exam the way the builder does");

  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "createflow" });

  const User = require("../../models/userModel");
  const Class = require("../../models/classModel");
  const Exam = require("../../models/examModel");
  const Question = require("../../models/questionModel");
  const { generateToken } = require("../../utils");
  const errorHandler = require("../../middleware/errorMiddleware");

  const teacher = await User.create({
    name: "T",
    email: "t@create.test",
    password: "xxxxxxxxxxxx",
    role: "teacher",
    teacherApproval: "approved",
    isVerified: true,
  });
  const cls = await Class.create({ name: "9-A", owner: teacher._id });

  // The REAL router, with its real middleware chain - not a reconstruction of
  // it, because reconstructing the contract by hand is the bug this is for.
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use("/api/quiz", require("../../routes/quizRoute"));
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const token = generateToken(teacher._id, teacher.sessionVersion);
  const base = `http://127.0.0.1:${port}/api/quiz`;
  const auth = { Authorization: `Bearer ${token}` };

  const form = (extra = {}) => {
    const fd = new FormData();
    Object.entries({ ...EXAM_FIELDS, ...extra }).forEach(([k, v]) => fd.append(k, String(v)));
    return fd;
  };
  const jsonReq = (method, url, body) =>
    fetch(url, {
      method,
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const read = async (res) => {
    const t = await res.text();
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
  const post = (extra) =>
    fetch(`${base}/addExam/${cls._id}`, { method: "POST", headers: auth, body: form(extra) });
  const owned = () => Exam.countDocuments({ owner: teacher._id, deletedAt: null });

  // -- what the server requires ------------------------------------------
  console.log("\nwhat the server requires:");
  const noKey = await post();
  ok(
    "a create with no idempotency key is refused",
    noKey.status === 400 && /idempotency/i.test(JSON.stringify(await read(noKey))),
    `got ${noKey.status}`
  );
  ok("and nothing was written", (await owned()) === 0);

  // -- the first save, in the builder's order ----------------------------
  console.log("\nthe first save:");
  const KEY = `exq:flow:${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const created = await post({ clientMutationId: KEY });
  const createdBody = await read(created);
  const examId = createdBody?.data?._id || createdBody?._id;
  ok("the exam is created", created.status === 201 && !!examId, `got ${created.status}`);

  /*
   * The publish details go on BEFORE the questions, which is the order the
   * builder uses - so the request has to say publishing is deferred. Without
   * it the server reads an absent flag as "publish now" and refuses, because
   * there are no questions yet: they are in the very next call.
   */
  const DETAILS = {
    name: "Adsız imtahan",
    duration: 3600,
    preset: "custom",
    shuffleOptions: false,
    shuffleQuestions: false,
  };
  const noFlag = await jsonReq("PATCH", `${base}/editExam/${examId}`, DETAILS);
  ok(
    "details are refused while it has no questions and no deferral flag",
    noFlag.status === 400,
    `got ${noFlag.status}`
  );

  const details = await jsonReq("PATCH", `${base}/editExam/${examId}`, { ...DETAILS, publish: false });
  ok("...and accepted when it says publishing is deferred", details.status === 200, `got ${details.status}`);

  const saved = await jsonReq("POST", `${base}/addQuestion/${examId}`, {
    correctAnswers: [QUESTION],
    questionsPerPage: 1,
    forwardOnly: false,
    typePoints: null,
    listeningAudio: "",
    aiPrompt: "",
    deferPublish: true,
  });
  ok("the questions are saved", saved.status === 200 || saved.status === 201, `got ${saved.status}`);

  // -- what the teacher is left with -------------------------------------
  console.log("\nwhat the teacher is left with:");
  const row = await Exam.findById(examId).lean();
  ok("the exam exists", !!row);
  ok("it is in their class", String(row.class) === String(cls._id));
  const qdoc = row.questions ? await Question.findById(row.questions).lean() : null;
  ok("it HAS the question they wrote", (qdoc?.correctAnswers || []).length === 1);
  ok("and it is the one they wrote", qdoc?.correctAnswers?.[0]?.text === QUESTION.text);
  ok("one exam, not several", (await owned()) === 1);

  /*
   * Pressing save twice must not make a second paper. This is the other half of
   * what a teacher saw: fourteen empty exams in one evening, one per press of a
   * button that could not work.
   */
  console.log("\npressing save again:");
  const retry = await post({ clientMutationId: KEY });
  const retryId = (await read(retry))?.data?._id;
  ok("resolves to the SAME exam", String(retryId) === String(examId), `got ${retryId}`);
  ok("and leaves one exam, not two", (await owned()) === 1);

  // A genuinely separate attempt must still make a separate exam.
  const second = await post({ clientMutationId: `${KEY}-2`, name: "İkinci" });
  const secondId = (await read(second))?.data?._id;
  ok("a new attempt still makes a new exam", !!secondId && String(secondId) !== String(examId));

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
