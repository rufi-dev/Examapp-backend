/*
 * Payments removed — server-side proof: exam price is FORCED to 0 on create/edit
 * (even for a forged positive price), a free exam enrols directly, and the OLD
 * Stripe purchase-callback params (token / session_id / success) can NEVER
 * associate an exam. The defensive Permissions-Policy: payment=() header stays.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-pay";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-pay";
process.env.EXAM_PDF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pay-priv-"));
process.env.PDF_STAGING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pay-stg-"));

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Exam = require("../../models/examModel");
const ClassModel = require("../../models/classModel");
const { generateToken } = require("../../utils");
const { protect, teacherOnly } = require("../../middleware/authMiddleware");
const securityHeaders = require("../../middleware/securityHeaders");
const Enrollment = require("../../models/enrollmentModel");
const { addExam, editExam, addExamToUser, startAttempt, rebuildExamUsersIndex, getExam, deleteMyExam, addExamToUserById, purgeExam } = require("../../controllers/quizController");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const { ObjectId } = mongoose.Types;

function req(server, { method = "GET", path: p, token, body }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) };
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })() }));
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const owner = await User.create({ name: "O", email: "o@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const student = await User.create({ name: "S", email: "s@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  const klass = await ClassModel.create({ name: "C", owner: owner._id, students: [] });
  const tok = (u) => generateToken(u._id, u.sessionVersion);

  const app = express();
  app.use(securityHeaders);
  app.post("/addExam/:classId", protect, teacherOnly, express.json(), addExam);
  app.patch("/editExam/:examId", protect, teacherOnly, express.json(), editExam);
  app.post("/addExamToUser/:examId", protect, addExamToUser);
  app.post("/exam/:examId/start", protect, express.json(), startAttempt);
  app.get("/getExam/:id", protect, getExam);
  app.delete("/deleteMyExam/:examId", protect, deleteMyExam);
  app.post("/addExamToUserById/:userId", protect, teacherOnly, express.json(), addExamToUserById);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // ── Permissions-Policy: payment=() retained ──
  const anyRes = await req(server, { method: "POST", path: `/addExamToUser/${new ObjectId()}`, token: tok(student) });
  ok("Permissions-Policy: payment=() header retained", /payment=\(\)/.test(anyRes.headers["permissions-policy"] || ""));

  // ── addExam FORCES price 0 even with a forged positive price ──
  const created = await req(server, { method: "POST", path: `/addExam/${klass._id}`, token: tok(owner),
    body: { name: "Forged paid", duration: 600, totalMarks: 100, passingMarks: 50, price: 999, mode: "structured" } });
  ok("addExam returns 201", created.status === 201);
  const createdExam = await Exam.findById(created.body?.data?._id);
  ok("addExam stored price 0 despite forged price=999", createdExam && createdExam.price === 0);

  // ── editExam FORCES price 0 even with a forged positive price ──
  await req(server, { method: "PATCH", path: `/editExam/${createdExam._id}`, token: tok(owner),
    body: { name: "Forged paid", duration: 600, totalMarks: 100, passingMarks: 50, price: 500 } });
  const editedExam = await Exam.findById(createdExam._id);
  ok("editExam stored price 0 despite forged price=500", editedExam.price === 0);

  // ── a free exam enrols directly ──
  const freeExam = await Exam.create({ name: "Free", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  const enrol = await req(server, { method: "POST", path: `/addExamToUser/${freeExam._id}`, token: tok(student) });
  ok("free exam enrols directly (200)", enrol.status === 200);
  ok("student now owns the free exam", (await User.findById(student._id)).exams.map(String).includes(String(freeExam._id)));

  // ── OLD Stripe callback params (token/session_id/success) NEVER associate an exam. ──
  const other = await Exam.create({ name: "Other", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  for (const qs of ["token=TOK", "session_id=SESS", "success=true", "token=TOK&session_id=SESS&success=true"]) {
    const r = await req(server, { method: "POST", path: `/addExamToUser/${other._id}?${qs}`, token: tok(student) });
    ok(`stale Stripe callback (?${qs}) refused with 410`, r.status === 410);
  }
  ok("no exam was associated via any stale callback", !(await User.findById(student._id)).exams.map(String).includes(String(other._id)));

  // A benign `?exam_purchase=1` grants NO different behavior — it is ignored and the
  // acquire behaves exactly as a normal free acquire (200).
  const epExam = await Exam.create({ name: "EP", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  const epRes = await req(server, { method: "POST", path: `/addExamToUser/${epExam._id}?exam_purchase=1`, token: tok(student) });
  ok("STRIPE-002: ?exam_purchase=1 grants no different behavior (plain free acquire, 200)", epRes.status === 200 && (await User.findById(student._id)).exams.map(String).includes(String(epExam._id)));

  // ── STRIPE-002: "free" is not "public" — HIDDEN and DELETED exams are DENIED with
  //    the same opaque 404 (no existence leak), and never associated. ──
  const hiddenExam = await Exam.create({ name: "Hidden", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id, hidden: true });
  const trashedExam = await Exam.create({ name: "Trashed", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id, deletedAt: new Date() });
  const hRes = await req(server, { method: "POST", path: `/addExamToUser/${hiddenExam._id}`, token: tok(student) });
  const dRes = await req(server, { method: "POST", path: `/addExamToUser/${trashedExam._id}`, token: tok(student) });
  ok("STRIPE-002: a HIDDEN exam is denied (404) and not associated", hRes.status === 404 && !(await User.findById(student._id)).exams.map(String).includes(String(hiddenExam._id)));
  ok("STRIPE-002: a DELETED exam is denied (404) and not associated", dRes.status === 404 && !(await User.findById(student._id)).exams.map(String).includes(String(trashedExam._id)));
  ok("STRIPE-002: a forged token query cannot bypass hidden-exam denial", (await req(server, { method: "POST", path: `/addExamToUser/${hiddenExam._id}?token=x`, token: tok(student) })).status !== 200);

  // ── STRIPE-002: duplicate + CONCURRENT acquisition — no duplicate / one-sided association. ──
  const dupStudent = await User.create({ name: "D", email: "d@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  const concExam = await Exam.create({ name: "Conc", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  const results = await Promise.all(Array.from({ length: 6 }, () => req(server, { method: "POST", path: `/addExamToUser/${concExam._id}`, token: tok(dupStudent) })));
  const okCount = results.filter((r) => r.status === 200).length;
  const dupUser = await User.findById(dupStudent._id);
  const dupExam = await Exam.findById(concExam._id);
  const userRefs = dupUser.exams.map(String).filter((x) => x === String(concExam._id)).length;
  const examRefs = dupExam.users.map(String).filter((x) => x === String(dupStudent._id)).length;
  ok("STRIPE-002: exactly ONE concurrent acquire succeeds; the rest are refused", okCount === 1 && results.every((r) => r.status === 200 || r.status === 400));
  ok("STRIPE-002: no DUPLICATE reference on either side (user↔exam each exactly once)", userRefs === 1 && examRefs === 1);
  // A second (sequential) duplicate acquire is a plain 400.
  ok("STRIPE-002: a repeat acquire is refused 400 (idempotent, still one ref)", (await req(server, { method: "POST", path: `/addExamToUser/${concExam._id}`, token: tok(dupStudent) })).status === 400 && (await Exam.findById(concExam._id)).users.map(String).filter((x) => x === String(dupStudent._id)).length === 1);

  // ── CR-098: a HIDDEN draft may be self-acquired ONLY by its EXACT owner or an
  //    admin. An unrelated approved teacher, a pending teacher and a student all get
  //    the SAME opaque 404 as a MISSING exam; a DELETED exam is unavailable to all;
  //    no denied request mutates either relationship. ──
  const admin = await User.create({ name: "A", email: "a@e.com", password: "xxxxxxxx", role: "admin", isVerified: true });
  const otherTeacher = await User.create({ name: "OT", email: "ot@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const pendingTeacher = await User.create({ name: "PT", email: "pt@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "pending", isVerified: true });
  const hiddenDraft = await Exam.create({ name: "HiddenDraft", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id, hidden: true });
  const missingId = new ObjectId();
  const acq = (u, id) => req(server, { method: "POST", path: `/addExamToUser/${id}`, token: tok(u) });

  ok("CR-098: the EXACT owner may self-acquire their hidden draft (200)", (await acq(owner, hiddenDraft._id)).status === 200);
  ok("CR-098: an ADMIN may acquire a hidden draft (200)", (await acq(admin, hiddenDraft._id)).status === 200);
  const otAcq = await acq(otherTeacher, hiddenDraft._id);
  const missAcq = await acq(otherTeacher, missingId);
  ok("CR-098: an unrelated approved teacher is DENIED — SAME opaque 404 as a missing exam", otAcq.status === 404 && otAcq.status === missAcq.status);
  ok("CR-098: a student is DENIED a hidden draft (opaque 404)", (await acq(student, hiddenDraft._id)).status === 404);
  ok("CR-098: a pending teacher is DENIED a hidden draft (opaque 404)", (await acq(pendingTeacher, hiddenDraft._id)).status === 404);
  ok("CR-098: a DELETED exam is unavailable even to an admin (404)", (await acq(admin, trashedExam._id)).status === 404);
  ok("CR-098: NO denied principal was associated (neither side mutated)", await (async () => {
    const holders = (await Exam.findById(hiddenDraft._id)).users.map(String);
    const deniedNotHeld = ![otherTeacher, student, pendingTeacher].some((u) => holders.includes(String(u._id)));
    const deniedNoExam = (await Promise.all([otherTeacher, student, pendingTeacher].map(async (u) => (await User.findById(u._id)).exams.map(String).includes(String(hiddenDraft._id))))).every((x) => !x);
    return deniedNotHeld && deniedNoExam;
  })());

  // ── CR-097: canonical acquisition survives a FAILED derived reverse-index write.
  //    User.exams (canonical) is durable and access works; Exam.users (derived) is
  //    rebuildable; a retry is idempotent. ──
  const canonExam = await Exam.create({ name: "Canon", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  const canonStudent = await User.create({ name: "CS", email: "cs@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  const origExamUpdateOne = Exam.updateOne.bind(Exam);
  Exam.updateOne = async () => { throw new Error("injected reverse-index failure"); };
  const failAcq = await acq(canonStudent, canonExam._id);
  Exam.updateOne = origExamUpdateOne;
  ok("CR-097: acquisition SUCCEEDS (200) even when the derived reverse write FAILS", failAcq.status === 200);
  ok("CR-097: the CANONICAL User.exams is durable despite the reverse failure", (await User.findById(canonStudent._id)).exams.map(String).includes(String(canonExam._id)));
  ok("CR-097: the derived Exam.users missed the write (as injected — one-sided at the projection only)", !(await Exam.findById(canonExam._id)).users.map(String).includes(String(canonStudent._id)));
  await Enrollment.create({ student: canonStudent._id, class: klass._id, status: "approved" }).catch(() => {});
  const canonStart = await req(server, { method: "POST", path: `/exam/${canonExam._id}/start`, token: tok(canonStudent) });
  ok("CR-097: access reads the CANONICAL side — startAttempt is NOT not_owned with a missing reverse index", !(canonStart.status === 403 && canonStart.body && canonStart.body.reason === "not_owned"));
  await rebuildExamUsersIndex(canonExam._id);
  ok("CR-097: rebuildExamUsersIndex durably RECONSTRUCTS the reverse index from the canonical side", (await Exam.findById(canonExam._id)).users.map(String).includes(String(canonStudent._id)));
  const retryAcq = await acq(canonStudent, canonExam._id);
  ok("CR-097: a retry is idempotent (400, still exactly one canonical ref)", retryAcq.status === 400 && (await User.findById(canonStudent._id)).exams.map(String).filter((x) => x === String(canonExam._id)).length === 1);

  // ══ CR-101: `User.exams` is the SOLE authorization source; `Exam.users` never grants ══
  const getE = (u, id) => req(server, { method: "GET", path: `/getExam/${id}`, token: tok(u) });
  const del = (u, id) => req(server, { method: "DELETE", path: `/deleteMyExam/${id}`, token: tok(u) });

  // 1) STALE reverse-only reference must NOT grant access (the reproduced defect).
  const revExam = await Exam.create({ name: "RevOnly", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  const revStudent = await User.create({ name: "RV", email: "rv@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  await Exam.updateOne({ _id: revExam._id }, { $addToSet: { users: revStudent._id } }); // reverse-only, canonical empty
  const revGet = await getE(revStudent, revExam._id);
  ok("CR-101: getExam DENIES a stale reverse-only reference when User.exams is empty (403)", revGet.status === 403);
  ok("CR-101: the reverse-only student truly has an empty canonical list", (await User.findById(revStudent._id)).exams.length === 0);

  // 2) CANONICAL-only acquisition grants access even with an empty reverse index.
  const canonView = await Exam.create({ name: "CanonView", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  const canonViewer = await User.create({ name: "CV", email: "cv@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  await User.updateOne({ _id: canonViewer._id }, { $addToSet: { exams: canonView._id } }); // canonical only, Exam.users empty
  const canonGet = await getE(canonViewer, canonView._id);
  ok("CR-101: getExam GRANTS canonical-only acquisition (200) with an empty reverse index", canonGet.status === 200);
  // enrollment access is preserved (a class-enrolled, non-canonical student still sees it).
  const enrView = await User.create({ name: "EV", email: "ev@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  await Enrollment.create({ student: enrView._id, class: klass._id, status: "approved" });
  ok("CR-101: getExam still GRANTS an approved-enrolled student (enrollment access preserved)", (await getE(enrView, canonView._id)).status === 200);

  // 3) Canonical REMOVAL survives an injected reverse-projection failure and REVOKES access.
  const rmExam = await Exam.create({ name: "RmExam", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  const rmStudent = await User.create({ name: "RM", email: "rm@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  await acq(rmStudent, rmExam._id);
  const rmOrig = Exam.updateOne.bind(Exam);
  Exam.updateOne = async () => { throw new Error("injected reverse pull failure"); };
  const rmRes = await del(rmStudent, rmExam._id);
  Exam.updateOne = rmOrig;
  ok("CR-101: deleteMyExam SUCCEEDS (200) despite the injected reverse-pull failure", rmRes.status === 200);
  ok("CR-101: the CANONICAL removal is durable (User.exams no longer holds it)", !(await User.findById(rmStudent._id)).exams.map(String).includes(String(rmExam._id)));
  ok("CR-101: access is REVOKED — getExam is 403 even though the reverse pull failed (Exam.users may still hold a stale ref)", (await getE(rmStudent, rmExam._id)).status === 403);

  // 4) Concurrent acquire/remove converge — never a duplicate or split canonical ref.
  const ccExam = await Exam.create({ name: "CcExam", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  const ccStudent = await User.create({ name: "CCX", email: "ccx@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  await Promise.all([acq(ccStudent, ccExam._id), del(ccStudent, ccExam._id), acq(ccStudent, ccExam._id)]);
  const ccRefs = (await User.findById(ccStudent._id)).exams.map(String).filter((x) => x === String(ccExam._id)).length;
  const ccGet = await getE(ccStudent, ccExam._id);
  ok("CR-101: concurrent acquire/remove leave at most ONE canonical ref (no duplicate/split)", ccRefs <= 1);
  ok("CR-101: access matches the canonical state after the race (grant iff exactly one ref)", (ccRefs === 1) === (ccGet.status === 200));
  // a retry after a remove re-grants cleanly.
  await del(ccStudent, ccExam._id);
  await acq(ccStudent, ccExam._id);
  ok("CR-101: acquire→remove→acquire retry re-grants access (one canonical ref)", (await getE(ccStudent, ccExam._id)).status === 200 && (await User.findById(ccStudent._id)).exams.map(String).filter((x) => x === String(ccExam._id)).length === 1);

  // 5) Teacher ASSIGNMENT is canonical-first and survives a reverse failure.
  const asgExam = await Exam.create({ name: "AsgExam", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  const asgStudent = await User.create({ name: "AS", email: "as@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  await Enrollment.create({ student: asgStudent._id, class: klass._id, status: "approved" });
  const asgOrig = Exam.updateOne.bind(Exam);
  Exam.updateOne = async () => { throw new Error("injected reverse assignment failure"); };
  const asgRes = await req(server, { method: "POST", path: `/addExamToUserById/${asgStudent._id}`, token: tok(owner), body: { examId: String(asgExam._id) } });
  Exam.updateOne = asgOrig;
  ok("CR-101: teacher assignment SUCCEEDS (200) despite the injected reverse failure", asgRes.status === 200);
  ok("CR-101: assignment set the CANONICAL User.exams (access granted)", (await User.findById(asgStudent._id)).exams.map(String).includes(String(asgExam._id)) && (await getE(asgStudent, asgExam._id)).status === 200);

  // ══ CR-103: runtime canonical-removal paths pull the acquisition-migration marker
  //    atomically with the exam ref, and the marker never leaks into any DTO. ══
  const rawUser = (id) => mongoose.connection.db.collection("users").findOne({ _id: id });
  // deleteMyExam pulls the marker together with the exam ref.
  const mkExam = await Exam.create({ name: "MkExam", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  const mkStudent = await User.create({ name: "MK", email: "mk@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  await acq(mkStudent, mkExam._id);
  await User.updateOne({ _id: mkStudent._id }, { $addToSet: { _acqMig: { exam: mkExam._id, batch: "b-test", nonce: "n1" } } }); // simulate a migration marker
  ok("CR-103: a migration marker is present before removal", ((await rawUser(mkStudent._id))._acqMig || []).length === 1);
  await del(mkStudent, mkExam._id);
  ok("CR-103: deleteMyExam pulled the marker atomically with the exam ref (both gone)", !(await User.findById(mkStudent._id)).exams.map(String).includes(String(mkExam._id)) && ((await rawUser(mkStudent._id))._acqMig || []).length === 0);

  // purgeExam pulls the marker for every holder.
  const pgExam = await Exam.create({ name: "PgExam", owner: owner._id, duration: 600, price: 0, totalMarks: 100, passingMarks: 50, class: klass._id });
  const pgStudent = await User.create({ name: "PG", email: "pg@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  await acq(pgStudent, pgExam._id);
  await User.updateOne({ _id: pgStudent._id }, { $addToSet: { _acqMig: { exam: pgExam._id, batch: "b-test", nonce: "n2" } } });
  await purgeExam(pgExam._id);
  ok("CR-103: purgeExam pulled the marker + exam ref from every holder", !(await User.findById(pgStudent._id)).exams.map(String).includes(String(pgExam._id)) && ((await rawUser(pgStudent._id))._acqMig || []).length === 0);

  // The marker is select:false — it never appears in a default-projected User DTO.
  const dtoStudent = await User.create({ name: "DTO", email: "dto@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  await User.updateOne({ _id: dtoStudent._id }, { $addToSet: { _acqMig: { exam: mkExam._id, batch: "b-test", nonce: "n3" } } });
  const dtoDefault = await User.findById(dtoStudent._id).lean();
  ok("CR-103: _acqMig is select:false — absent from a default User DTO (login/profile/admin)", dtoDefault._acqMig === undefined && ((await rawUser(dtoStudent._id))._acqMig || []).length === 1);

  // ── STRIPE-002 #4: access is NEVER gated on price — a LEGACY positive-price exam
  //    behaves as free. An approved-enrolled student is NOT denied `not_owned`. ──
  const legacyPaid = await Exam.create({ name: "LegacyPaid", owner: owner._id, duration: 600, price: 10, totalMarks: 100, passingMarks: 50, class: klass._id, mode: "pdf" });
  const enrolledStudent = await User.create({ name: "E", email: "e2@e.com", password: "xxxxxxxx", role: "student", isVerified: true });
  await Enrollment.create({ student: enrolledStudent._id, class: klass._id, status: "approved" });
  const startRes = await req(server, { method: "POST", path: `/exam/${legacyPaid._id}/start`, token: tok(enrolledStudent) });
  ok("STRIPE-002: a legacy positive-price exam does NOT deny an enrolled student as not_owned (price-free access)", !(startRes.status === 403 && startRes.body && startRes.body.reason === "not_owned"));

  // ── the Stripe route/controller files are gone; server.js mounts no /api/stripe ──
  ok("stripeController.js removed", !fs.existsSync(path.join(__dirname, "..", "..", "controllers", "stripeController.js")));
  ok("stripeRoute.js removed", !fs.existsSync(path.join(__dirname, "..", "..", "routes", "stripeRoute.js")));
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  ok("server.js has no active /api/stripe mount", !serverSrc.split("\n").some((l) => !l.trimStart().startsWith("//") && /\/api\/stripe/.test(l)));
  ok("package.json no longer depends on stripe", !/\"stripe\"\s*:/.test(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")));
  // STRIPE-001: the dependency is gone from BOTH sides + not installed.
  ok("stripe is not installed (node_modules/stripe absent)", !fs.existsSync(path.join(__dirname, "..", "..", "node_modules", "stripe")));
  ok("package-lock.json has no stripe entry", !/node_modules\/stripe|\/stripe\/-\/stripe|\"stripe\"\s*:/.test(fs.readFileSync(path.join(__dirname, "..", "..", "package-lock.json"), "utf8")));

  // ── health checker no longer probes Stripe ──
  const healthSrc = fs.readFileSync(path.join(__dirname, "..", "..", "controllers", "healthController.js"), "utf8");
  ok("healthController has no active Stripe probe", !/stripeProbe|stripe\.balance|require\(["']stripe["']\)/.test(healthSrc));
  ok("healthController loads without stripe", (() => { try { require("../../controllers/healthController"); return true; } catch { return false; } })());

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  for (const d of [process.env.EXAM_PDF_DIR, process.env.PDF_STAGING_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
