/*
 * AUD-013 CR-057 — the AUTHORIZED private exam-PDF stream. Full matrix over real
 * sockets: owner / admin / attempt-holder / result-holder / unrelated teacher /
 * unrelated student / anonymous / deleted exam / invalid id / missing pdf, with a
 * NO-EXISTENCE-LEAK guarantee (denied == missing) and correct Range / Content-Type
 * / private-cache / nosniff contracts.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-cr057";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-cr057";
// CR-076: both the private store AND the upload staging dir live under OS-temp —
// this test must NEVER create Backend/uploads. Set BEFORE requires.
process.env.EXAM_PDF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "exampdf-priv-"));
process.env.PDF_STAGING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "exampdf-stg-"));

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Exam = require("../../models/examModel");
const Attempt = require("../../models/attemptModel");
const Result = require("../../models/resultModel");
const PDF = require("../../models/pdfModel");
const { generateToken } = require("../../utils");
const multer = require("multer");
const { protect, teacherOnly } = require("../../middleware/authMiddleware");
const { streamExamPdf, uploadPdf, getPdfByExam } = require("../../controllers/quizController");
const { newKey, pathForKey, ensureDir, isValidKey, EXAM_PDF_DIR } = require("../../helper/examPdfStorage");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const { ObjectId } = mongoose.Types;

function request(server, { path: p, token, range }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(range ? { Range: range } : {}) };
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: p, headers }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    });
    req.on("error", reject); req.end();
  });
}

const PDF_BYTES = Buffer.from("%PDF-1.7\n" + "A".repeat(100) + "\n%%EOF\n", "latin1");

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await ensureDir();

  const owner = await User.create({ name: "O", email: "o@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const other = await User.create({ name: "OT", email: "ot@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const admin = await User.create({ name: "A", email: "a@e.com", password: "xxxxxxxx", role: "admin", isVerified: true });
  const sAttempt = await User.create({ name: "SA", email: "sa@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  const sResult = await User.create({ name: "SR", email: "sr@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  const sNone = await User.create({ name: "SN", email: "sn@e.com", password: "xxxxxxxx", role: "student", isVerified: true });

  const key = newKey();
  fs.writeFileSync(pathForKey(key), PDF_BYTES);
  const pdfDoc = await PDF.create({ key });
  const exam = await Exam.create({ name: "E", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: new ObjectId(), pdf: pdfDoc._id });
  await Attempt.create({ userId: sAttempt._id, examId: exam._id, startedAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  await Result.create({ userId: sResult._id, examId: exam._id, attempts: 1, earnPoints: 10, attemptId: new ObjectId() });

  const app = express();
  // uploadPdf reads the multer file from the CONFIGURED staging dir (OS-temp).
  const STG = process.env.PDF_STAGING_DIR;
  const upload = multer({ storage: multer.diskStorage({ destination: (rq, f, cb) => { fs.mkdirSync(STG, { recursive: true }); cb(null, STG); }, filename: (rq, f, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}.pdf`) }) });
  app.post("/api/quiz/uploadPdf", protect, teacherOnly, upload.single("file"), uploadPdf);
  app.get("/api/quiz/getPdfByExam/:examId", protect, getPdfByExam);
  app.get("/api/quiz/exam/:examId/pdf/stream", protect, streamExamPdf);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const tok = (u) => generateToken(u._id, u.sessionVersion);
  const url = `/api/quiz/exam/${exam._id}/pdf/stream`;
  const get = (u, range) => request(server, { path: url, token: u && tok(u), range });

  // ── ALLOWED principals ──
  const o = await get(owner);
  ok("owner streams the PDF (200)", o.status === 200 && o.body.equals(PDF_BYTES));
  ok("Content-Type application/pdf + nosniff + private cache + Accept-Ranges", o.headers["content-type"] === "application/pdf" && o.headers["x-content-type-options"] === "nosniff" && /private/.test(o.headers["cache-control"] || "") && o.headers["accept-ranges"] === "bytes");
  ok("admin streams (200)", (await get(admin)).status === 200);
  ok("attempt holder streams (200)", (await get(sAttempt)).status === 200);
  ok("result holder streams (200)", (await get(sResult)).status === 200);

  // ── DENIED — all identical opaque 404 (no existence leak) ──
  const unrelTeacher = await get(other);
  const unrelStudent = await get(sNone);
  ok("unrelated teacher denied (404)", unrelTeacher.status === 404);
  ok("unrelated student denied (404)", unrelStudent.status === 404);
  const missing = await request(server, { path: `/api/quiz/exam/${new ObjectId()}/pdf/stream`, token: tok(other) });
  ok("missing exam → 404", missing.status === 404);
  const deniedBody = JSON.parse(unrelTeacher.body.toString());
  const missingBody = JSON.parse(missing.body.toString());
  ok(
    "NO existence leak: denied-existing == missing stable contract",
    unrelTeacher.status === missing.status &&
      deniedBody.code === "pdf_not_found" &&
      missingBody.code === deniedBody.code &&
      missingBody.message === deniedBody.message
  );

  // ── anonymous / deleted / invalid / no-pdf ──
  ok("anonymous → 401 (protect)", (await get(null)).status === 401);
  await Exam.updateOne({ _id: exam._id }, { $set: { deletedAt: new Date() } });
  ok("deleted/revoked exam → 404 (even for the owner)", (await get(owner)).status === 404);
  await Exam.updateOne({ _id: exam._id }, { $set: { deletedAt: null } });
  const invalidId = await request(server, { path: `/api/quiz/exam/not-an-id/pdf/stream`, token: tok(owner) });
  ok("invalid exam id → typed 400", invalidId.status === 400 && JSON.parse(invalidId.body).code === "invalid_exam_id");
  const noPdfExam = await Exam.create({ name: "N", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: new ObjectId() });
  ok("exam with no PDF key → 404 (uniform)", (await request(server, { path: `/api/quiz/exam/${noPdfExam._id}/pdf/stream`, token: tok(owner) })).status === 404);

  // ── Range streaming ──
  const r1 = await get(owner, "bytes=0-3");
  ok("Range 0-3 → 206 + Content-Range + 4 bytes", r1.status === 206 && r1.headers["content-range"] === `bytes 0-3/${PDF_BYTES.length}` && r1.body.length === 4 && r1.body.equals(PDF_BYTES.slice(0, 4)));
  const suffix = await get(owner, "bytes=-5");
  ok("suffix Range -5 → last 5 bytes (206)", suffix.status === 206 && suffix.body.equals(PDF_BYTES.slice(-5)));
  const invalidRange = await get(owner, "bytes=10-2");
  ok("Range start>end → typed 416", invalidRange.status === 416 && JSON.parse(invalidRange.body).code === "invalid_range");
  ok("Range beyond size → 416", (await get(owner, `bytes=0-${PDF_BYTES.length + 10}`)).status === 416);
  ok("empty Range bytes=- → 416", (await get(owner, "bytes=-")).status === 416);

  const originalStat = fs.promises.stat;
  fs.promises.stat = async () => {
    const error = new Error("mongodb://secret-host/private/path.js");
    error.code = "EIO";
    throw error;
  };
  const infra = await get(owner);
  fs.promises.stat = originalStat;
  const infraBody = JSON.parse(infra.body.toString());
  ok(
    "storage infrastructure fault is a redacted typed 500",
    infra.status === 500 &&
      infraBody.code === "pdf_storage_unavailable" &&
      infraBody.message === "PDF storage unavailable" &&
      !infra.body.toString().includes("secret-host")
  );

  // ── CR-057b: uploadPdf stores PRIVATELY (returns an opaque key; nothing in /uploads) ──
  const upRes = await new Promise((resolve) => {
    const boundary = "----b" + Math.random().toString(36).slice(2);
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="q.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), PDF_BYTES, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const { port } = server.address();
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/quiz/uploadPdf", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length, Authorization: `Bearer ${tok(owner)}` } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString() || "{}") })); });
    req.write(body); req.end();
  });
  // CR-069: uploadPdf returns an opaque OWNER-BOUND staged-upload id (not the key).
  ok("uploadPdf → 200 with an opaque uploadId (url === uploadId, an ObjectId)", upRes.status === 200 && ObjectId.isValid(String(upRes.body.url)) && upRes.body.uploadId === upRes.body.url);
  const stagedDoc = await PDF.findById(upRes.body.uploadId);
  ok("staged record is owner-bound + state 'staged' + keyed with a private file", stagedDoc && stagedDoc.state === "staged" && String(stagedDoc.owner) === String(owner._id) && isValidKey(stagedDoc.key) && fs.existsSync(pathForKey(stagedDoc.key)));
  // CR-076: this test stages under its OWN OS-temp dir; the private file lands in
  // the private dir and NOTHING is written into a workspace uploads/ dir.
  ok("private file is NOT in the staging dir; no PDF written to Backend/uploads", !fs.existsSync(path.join(process.env.PDF_STAGING_DIR, `${stagedDoc.key}.pdf`)) && (() => { try { return fs.readdirSync(path.join(process.cwd(), "uploads")).filter((n) => n.endsWith(".pdf")).length === 0; } catch { return true; } })());

  // ── CR-057b: getPdfByExam returns a streamUrl (no public path) for a keyed PDF ──
  const gp = await request(server, { path: `/api/quiz/getPdfByExam/${exam._id}`, token: tok(owner) });
  ok("getPdfByExam returns streamUrl + NO public path for a keyed PDF", gp.status === 200 && /\/api\/quiz\/exam\/.*\/pdf\/stream/.test(JSON.parse(gp.body.toString()).streamUrl) && JSON.parse(gp.body.toString()).path === undefined);

  // ── CR-057d: the public express.static('uploads') mount must stay REMOVED ──
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  const activeUploadsStatic = serverSrc.split("\n").some((l) => !l.trimStart().startsWith("//") && /express\.static\(\s*['"]uploads['"]/.test(l));
  ok("no active express.static('uploads') mount in server.js (public /uploads removed)", !activeUploadsStatic);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  for (const d of [process.env.EXAM_PDF_DIR, process.env.PDF_STAGING_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
