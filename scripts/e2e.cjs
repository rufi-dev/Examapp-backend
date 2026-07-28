// Test data for the end-to-end suite.
//
// Lives in the backend because it needs Mongo and the app's own .env; the
// frontend test run shells out to it. Everything it creates is prefixed
// __e2e so a cleanup can never touch a real account, and cleanup runs by that
// prefix rather than by remembering ids — an aborted run still gets swept up
// on the next one.
//
//   node scripts/e2e.cjs seed     -> prints { email, password } as JSON
//   node scripts/e2e.cjs cleanup  -> removes every __e2e account and its data
require("dotenv").config();
const fs = require("fs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const PREFIX = "__e2e";
const PASSWORD = "e2e-test-password";

async function seed(db) {
  const stamp = Date.now();
  const email = `${PREFIX}.${stamp}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const { insertedId } = await db.collection("users").insertOne({
    name: `${PREFIX} teacher`,
    email,
    password: hash,
    role: "teacher", teacherApproval: "approved",
    phone: "+994500000000",
    isVerified: true,
    onboarded: true,
    userAgent: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(JSON.stringify({ email, password: PASSWORD, userId: String(insertedId) }));
}

async function seedPendingTeacher(db) {
  const stamp = Date.now();
  const email = `${PREFIX}.pending.${stamp}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const { insertedId } = await db.collection("users").insertOne({
    name: `${PREFIX} pending teacher`,
    email,
    password: hash,
    role: "teacher",
    teacherApproval: "pending",
    teacherApprovalMeta: { method: "self", at: new Date() },
    phone: "+994500000002",
    isVerified: true,
    onboarded: true,
    userAgent: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(JSON.stringify({ email, password: PASSWORD, userId: String(insertedId) }));
}

// AUD-004: seed a fully takeable structured exam owned by a fresh __e2e teacher.
// The teacher takes their OWN exam (startAttempt lets staff bypass ownership), so
// no enrolment is needed. Prints { email, password, examId }. Used by the autosave
// E2E specs, which only run under the disposable launcher (ephemeral Mongo).
async function seedExam(db) {
  const stamp = Date.now();
  const email = `${PREFIX}.${stamp}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const { insertedId: userId } = await db.collection("users").insertOne({
    name: `${PREFIX} teacher`, email, password: hash, role: "teacher", teacherApproval: "approved",
    phone: "+994500000000", isVerified: true, onboarded: true, userAgent: [],
    createdAt: new Date(), updatedAt: new Date(),
  });
  const { insertedId: classId } = await db.collection("classes").insertOne({
    name: `${PREFIX} class`, owner: userId, students: [], createdAt: new Date(), updatedAt: new Date(),
  });
  const { insertedId: questionId } = await db.collection("questions").insertOne({
    exam: null,
    correctAnswers: [
      { type: "Cm", text: "Question One", choices: [{ text: "alfa" }, { text: "beta" }], correct: [0] },
      { type: "Cm", text: "Question Two", choices: [{ text: "gamma" }, { text: "delta" }], correct: [1] },
      { type: "Cm", text: "Question Three", choices: [{ text: "epsilon" }, { text: "zeta" }], correct: [0] },
    ],
    createdAt: new Date(), updatedAt: new Date(),
  });
  const now = Date.now();
  const { insertedId: examId } = await db.collection("exams").insertOne({
    name: `${PREFIX} exam`, duration: 3600, price: 0, totalMarks: 100, passingMarks: 50,
    mode: "structured", class: classId, owner: userId, questions: questionId,
    hidden: false, maxTry: 0, antiCheat: false,
    startDate: new Date(now - 3600e3), endDate: new Date(now + 3600e3),
    showScore: true, showCorrectAnswers: true, revealAfterEnd: false,
    users: [], results: [], createdAt: new Date(), updatedAt: new Date(),
  });
  await db.collection("questions").updateOne({ _id: questionId }, { $set: { exam: examId } });
  console.log(JSON.stringify({ email, password: PASSWORD, examId: String(examId), userId: String(userId) }));
}

// CR-040: a takeable exam with a SHORT deadline so the finalizer runs within the
// E2E (paired with FINALIZE_INTERVAL_MS/GRACE overrides in the launcher). Duration
// and endDate are ~8s out. Same shape as seedExam otherwise.
async function seedExamShort(db) {
  const stamp = Date.now();
  const email = `${PREFIX}.${stamp}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const { insertedId: userId } = await db.collection("users").insertOne({
    name: `${PREFIX} teacher`, email, password: hash, role: "teacher", teacherApproval: "approved",
    phone: "+994500000000", isVerified: true, onboarded: true, userAgent: [],
    createdAt: new Date(), updatedAt: new Date(),
  });
  const { insertedId: classId } = await db.collection("classes").insertOne({
    name: `${PREFIX} class`, owner: userId, students: [], createdAt: new Date(), updatedAt: new Date(),
  });
  const { insertedId: questionId } = await db.collection("questions").insertOne({
    exam: null,
    correctAnswers: [
      { type: "Cm", text: "Question One", choices: [{ text: "alfa" }, { text: "beta" }], correct: [0] },
      { type: "Cm", text: "Question Two", choices: [{ text: "gamma" }, { text: "delta" }], correct: [1] },
      { type: "Cm", text: "Question Three", choices: [{ text: "epsilon" }, { text: "zeta" }], correct: [0] },
    ],
    createdAt: new Date(), updatedAt: new Date(),
  });
  const now = Date.now();
  const { insertedId: examId } = await db.collection("exams").insertOne({
    name: `${PREFIX} short exam`, duration: 8, price: 0, totalMarks: 100, passingMarks: 50,
    mode: "structured", class: classId, owner: userId, questions: questionId,
    hidden: false, maxTry: 0, antiCheat: false,
    startDate: new Date(now - 3600e3), endDate: new Date(now + 8000),
    showScore: true, showCorrectAnswers: true, revealAfterEnd: false,
    users: [], results: [], createdAt: new Date(), updatedAt: new Date(),
  });
  await db.collection("questions").updateOne({ _id: questionId }, { $set: { exam: examId } });
  console.log(JSON.stringify({ email, password: PASSWORD, examId: String(examId), userId: String(userId) }));
}

// AUD-013 CR-071: seed a PDF-mode exam whose real PDF lives in PRIVATE storage
// (the run-owned EXAM_PDF_DIR), so the browser can render it through PDF.js via
// the authorized stream. Prints { email, password, examId }.
// Shared: create a teacher + a multi-page PDF-mode exam whose bytes live in the
// run-owned private store. Returns ids for callers to build on.
async function createPdfExam(db) {
  const PDFKit = require("pdfkit");
  const { newKey, pathForKey, ensureDir } = require("../helper/examPdfStorage");
  // Many pages of DENSE text so the file is well over pdf.js's ~64KB range-chunk
  // size — pdf.js then range-fetches later pages LAZILY as the reader scrolls,
  // which is what the mid-view 401 recovery test needs to exercise.
  // compress:false keeps the (otherwise highly compressible) text UNCOMPRESSED so
  // the file comfortably exceeds pdf.js's ~64KB range-chunk size and later pages
  // are fetched LAZILY as the reader scrolls (needed by the mid-view 401 test).
  const doc = new PDFKit({ size: [612, 792], compress: false });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const ended = new Promise((r) => doc.on("end", r));
  // AUD-013 CR-090: a large, multi-page fixture so pdf.js (disableAutoFetch +
  // disableStream) leaves far pages UNLOADED — a page jump after the token goes
  // stale then forces the VIEWER itself to request an unloaded range.
  const filler = "Examopia sınaq imtahanı — mətn bloku, oxu və analiz üçün. ".repeat(180);
  for (let p = 1; p <= 160; p++) {
    if (p > 1) doc.addPage();
    doc.fontSize(22).text(`Examopia PDF — page ${p}`, 40, 50);
    doc.fontSize(11).text(filler, 40, 90, { width: 520 });
  }
  doc.end();
  await ended;
  // CR-116: allow a pre-generated fixture (e.g. a qpdf-linearized or xref-stream
  // variant) to be streamed through the REAL upload→private-storage→stream path,
  // so the PDF.js-6 fixture matrix is tested against the authorized endpoint, not
  // just a static file. Falls back to the generated PDFKit fixture.
  const fixtureOverride = process.env.E2E_PDF_FIXTURE;
  const bytes = fixtureOverride && fs.existsSync(fixtureOverride)
    ? fs.readFileSync(fixtureOverride)
    : Buffer.concat(chunks);
  await ensureDir();
  const key = newKey();
  fs.writeFileSync(pathForKey(key), bytes);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");

  const email = `${PREFIX}.${Date.now()}@example.test`;
  const pwHash = await bcrypt.hash(PASSWORD, 10);
  const { insertedId: userId } = await db.collection("users").insertOne({
    name: `${PREFIX} teacher`, email, password: pwHash, role: "teacher", teacherApproval: "approved",
    phone: "+994500000000", isVerified: true, onboarded: true, userAgent: [],
    createdAt: new Date(), updatedAt: new Date(),
  });
  const { insertedId: classId } = await db.collection("classes").insertOne({
    name: `${PREFIX} class`, owner: userId, students: [], createdAt: new Date(), updatedAt: new Date(),
  });
  const { insertedId: pdfId } = await db.collection("pdfs").insertOne({
    key, owner: userId, state: "attached", size: bytes.length, hash, createdAt: new Date(), updatedAt: new Date(),
  });
  const now = Date.now();
  const { insertedId: examId } = await db.collection("exams").insertOne({
    name: `${PREFIX} pdf exam`, duration: 3600, price: 0, totalMarks: 100, passingMarks: 50,
    mode: "pdf", class: classId, owner: userId, pdf: pdfId,
    hidden: false, maxTry: 0, antiCheat: false,
    startDate: new Date(now - 3600e3), endDate: new Date(now + 3600e3),
    showScore: true, showCorrectAnswers: true, revealAfterEnd: false,
    users: [], results: [], createdAt: new Date(), updatedAt: new Date(),
  });
  return { teacherEmail: email, userId, classId, pdfId, examId };
}

async function seedPdfExam(db) {
  const { teacherEmail, userId, examId } = await createPdfExam(db);
  console.log(JSON.stringify({ email: teacherEmail, password: PASSWORD, examId: String(examId), userId: String(userId) }));
}

// AUD-013 CR-082: seed a real Result for the PDF exam so the browser can open the
// shipping /result/:resultId/review route and render the private PDF. The STUDENT
// who owns the result reviews it. Prints { email, password, examId, resultId }.
async function seedPdfResult(db) {
  const { classId, examId } = await createPdfExam(db);
  const email = `${PREFIX}.stu.${Date.now()}@example.test`;
  const pwHash = await bcrypt.hash(PASSWORD, 10);
  const { insertedId: studentId } = await db.collection("users").insertOne({
    // grade is REQUIRED for a student or ProfileCompletionGate blocks every route.
    name: `${PREFIX} student`, email, password: pwHash, role: "student", grade: "11",
    phone: "+994500000001", isVerified: true, onboarded: true, userAgent: [],
    exams: [examId], createdAt: new Date(), updatedAt: new Date(),
  });
  await db.collection("classes").updateOne({ _id: classId }, { $addToSet: { students: studentId } });
  await db.collection("exams").updateOne({ _id: examId }, { $addToSet: { users: studentId } });
  const { insertedId: attemptId } = await db.collection("attempts").insertOne({
    userId: studentId, examId, startedAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() + 3600e3),
    finalizeState: "frozen", createdAt: new Date(), updatedAt: new Date(),
  });
  const { insertedId: resultId } = await db.collection("results").insertOne({
    userId: studentId, examId, attemptId, attempts: 1, earnPoints: 80, terminated: false,
    selectedAnswers: [], createdAt: new Date(), updatedAt: new Date(),
  });
  console.log(JSON.stringify({ email, password: PASSWORD, examId: String(examId), resultId: String(resultId) }));
}

// CR-040: inspect the SERVER Result for an attempt so E2E can assert the official
// record (count, gradedRevision, score), not only the screen.
//   node scripts/e2e.cjs result <attemptId>
async function resultFor(db, attemptId) {
  const mongoose = require("mongoose");
  const _id = mongoose.Types.ObjectId.isValid(attemptId) ? new mongoose.Types.ObjectId(attemptId) : null;
  if (!_id) { console.log(JSON.stringify({ count: 0 })); return; }
  const rows = await db.collection("results").find({ attemptId: _id }).toArray();
  const r = rows[0];
  console.log(JSON.stringify({
    count: rows.length,
    gradedRevision: r ? r.gradedRevision : null,
    earnPoints: r ? r.earnPoints : null,
    examVersionId: r ? String(r.examVersionId) : null,
    selectedAnswers: r ? r.selectedAnswers : null,
  }));
}

async function cleanup(db) {
  const users = await db
    .collection("users")
    .find({ email: { $regex: `^${PREFIX}\\.` } })
    .project({ _id: 1 })
    .toArray();
  const ids = users.map((u) => u._id);
  if (!ids.length) return console.log(JSON.stringify({ removed: 0 }));

  const classes = await db
    .collection("classes")
    .find({ owner: { $in: ids } })
    .project({ _id: 1 })
    .toArray();
  const classIds = classes.map((c) => c._id);
  const exams = await db
    .collection("exams")
    .find({ owner: { $in: ids } })
    .project({ _id: 1, questions: 1, pdf: 1 })
    .toArray();

  // CR-067: delete the EXACT pdf rows these exams reference (by id) so the
  // disposable DB stays consistent. NEVER touch the filesystem here — the
  // disposable launcher owns and removes the run's private/staging dirs. No
  // globs, no rm, no workspace paths.
  const pdfIds = exams.map((e) => e.pdf).filter(Boolean);
  if (pdfIds.length) await db.collection("pdfs").deleteMany({ _id: { $in: pdfIds } });

  await db.collection("questions").deleteMany({
    _id: { $in: exams.map((e) => e.questions).filter(Boolean) },
  });
  await db.collection("exams").deleteMany({ owner: { $in: ids } });
  await db.collection("enrollments").deleteMany({
    $or: [{ student: { $in: ids } }, { class: { $in: classIds } }],
  });
  await db.collection("classes").deleteMany({ _id: { $in: classIds } });
  await db.collection("aiusages").deleteMany({ user: { $in: ids } });
  await db.collection("users").deleteMany({ _id: { $in: ids } });
  console.log(
    JSON.stringify({ removed: ids.length, classes: classIds.length, exams: exams.length })
  );
}

(async () => {
  const cmd = process.argv[2];
  const handlers = {
    seed, "seed-pending-teacher": seedPendingTeacher,
    "seed-exam": seedExam, "seed-exam-short": seedExamShort, "seed-pdf-exam": seedPdfExam, "seed-pdf-result": seedPdfResult, cleanup,
    result: (db) => resultFor(db, process.argv[3]),
  };
  if (!handlers[cmd]) {
    console.error("usage: node scripts/e2e.cjs seed|seed-pending-teacher|seed-exam|seed-exam-short|seed-pdf-exam|seed-pdf-result|result <attemptId>|cleanup");
    process.exit(2);
  }
  await mongoose.connect(process.env.MONGO_URI);
  try {
    await handlers[cmd](mongoose.connection.db);
  } finally {
    await mongoose.disconnect();
  }
})();
