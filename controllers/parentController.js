const asyncHandler = require("express-async-handler");
const ParentLink = require("../models/parentLinkModel");
const User = require("../models/userModel");
const ClassModel = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const Assignment = require("../models/assignmentModel");
const Submission = require("../models/submissionModel");
const Result = require("../models/resultModel");
const Attendance = require("../models/attendanceModel");
const Payment = require("../models/paymentModel");
const Attempt = require("../models/attemptModel");

// Compact child DTO — never leak more of a student's account than a parent needs.
const childDto = (u) => ({
  _id: u._id,
  name: u.name || "",
  email: u.email || "",
  photo: u.photo || "",
  grade: u.grade || "",
});

// Case-insensitive exact-email matcher (stored emails may differ in case).
const emailRegex = (raw) => new RegExp(`^${String(raw).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

// True when this parent has an APPROVED link to this student. A pending (email) link
// grants no data access until it is approved.
const isLinked = (parentId, studentId) => ParentLink.exists({ parent: parentId, student: studentId, status: "approved" });

// POST /api/parent/link { code } — link the caller (a parent) to the student who owns
// this parentCode. Always APPROVED (the code is the shared secret). Upgrades a prior
// pending email request to approved. Idempotent.
const linkChild = asyncHandler(async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  if (!code) {
    res.status(400);
    throw new Error("Kod daxil edin");
  }
  const student = await User.findOne({ parentCode: code, role: "student" }).select("name email photo grade");
  if (!student) {
    res.status(404);
    throw new Error("Kod tapılmadı");
  }
  if (String(student._id) === String(req.user._id)) {
    res.status(400);
    throw new Error("Özünüzü əlavə edə bilməzsiniz");
  }
  await ParentLink.updateOne(
    { parent: req.user._id, student: student._id },
    { $set: { status: "approved" }, $setOnInsert: { parent: req.user._id, student: student._id, via: "code" } },
    { upsert: true }
  );
  res.json({ ok: true, child: { ...childDto(student), status: "approved" } });
});

// POST /api/parent/link-email { email } — request to follow a student by their email.
// Creates a PENDING link (email is guessable, so it can't auto-grant access). The
// student or one of their teachers approves it before any data is shared.
const linkChildByEmail = asyncHandler(async (req, res) => {
  const raw = String(req.body.email || "").trim();
  if (!raw) {
    res.status(400);
    throw new Error("Email daxil edin");
  }
  const student = await User.findOne({ email: emailRegex(raw), role: "student" }).select("name email photo grade");
  if (!student) {
    res.status(404);
    throw new Error("Bu email ilə şagird tapılmadı");
  }
  if (String(student._id) === String(req.user._id)) {
    res.status(400);
    throw new Error("Özünüzü əlavə edə bilməzsiniz");
  }
  const existing = await ParentLink.findOne({ parent: req.user._id, student: student._id }).lean();
  if (existing) {
    return res.json({ ok: true, child: { ...childDto(student), status: existing.status } });
  }
  await ParentLink.create({ parent: req.user._id, student: student._id, status: "pending", via: "email" });
  res.json({ ok: true, child: { ...childDto(student), status: "pending" } });
});

// GET /api/parent/children — the caller's linked children (with link status).
const listChildren = asyncHandler(async (req, res) => {
  const links = await ParentLink.find({ parent: req.user._id }).sort({ createdAt: -1 }).lean();
  const ids = links.map((l) => l.student);
  const kids = ids.length ? await User.find({ _id: { $in: ids } }).select("name email photo grade").lean() : [];
  const byId = new Map(kids.map((k) => [String(k._id), k]));
  const children = links
    .map((l) => {
      const k = byId.get(String(l.student));
      return k ? { ...childDto(k), status: l.status } : null;
    })
    .filter(Boolean);
  res.json({ children });
});

// DELETE /api/parent/children/:childId — unlink a child from the caller.
const unlinkChild = asyncHandler(async (req, res) => {
  await ParentLink.deleteOne({ parent: req.user._id, student: req.params.childId });
  res.json({ ok: true });
});

// GET /api/parent/children/:childId/results — the child's exam results (read-only).
const childResults = asyncHandler(async (req, res) => {
  if (!(await isLinked(req.user._id, req.params.childId))) {
    res.status(403);
    throw new Error("Bu şagirdə girişiniz yoxdur");
  }
  const rows = await Result.find({ userId: req.params.childId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(300)
    .populate("examId", "name totalMarks passingMarks")
    .lean();
  const results = rows.map((r) => ({
    _id: r._id,
    exam: r.examId
      ? { _id: r.examId._id, name: r.examId.name || "İmtahan", totalMarks: r.examId.totalMarks, passingMarks: r.examId.passingMarks }
      : null,
    earnPoints: r.earnPoints,
    attemptOrdinal: r.attemptOrdinal,
    createdAt: r.createdAt,
    terminated: !!r.terminated,
    violations: r.violations || 0,
    // Still being manually graded — the score isn't final, so the UI hides pass/fail.
    pending: !!r.pendingReview,
  }));
  res.json({ results });
});

// GET /api/parent/children/:childId/homework — the child's assignments + their
// submission status (read-only). Mirrors the student branch of myAssignments.
const childHomework = asyncHandler(async (req, res) => {
  if (!(await isLinked(req.user._id, req.params.childId))) {
    res.status(403);
    throw new Error("Bu şagirdə girişiniz yoxdur");
  }
  const classIds = await Enrollment.find({ student: req.params.childId, status: "approved" }).distinct("class");
  if (!classIds.length) return res.json({ assignments: [] });
  const assignments = await Assignment.find({ class: { $in: classIds }, deletedAt: null })
    .populate("class", "name")
    .sort({ createdAt: -1 })
    .lean();
  const ids = assignments.map((a) => a._id);
  const subs = await Submission.find({ assignment: { $in: ids }, student: req.params.childId }).lean();
  const byA = new Map(subs.map((s) => [String(s.assignment), s]));
  const assignmentsOut = assignments.map((a) => {
    const s = byA.get(String(a._id));
    return {
      _id: a._id,
      title: a.title,
      description: a.description || "",
      dueAt: a.dueAt,
      maxPoints: a.maxPoints,
      class: a.class ? { _id: a.class._id, name: a.class.name } : null,
      submission: s
        ? {
            status: s.status,
            grade: s.grade,
            feedback: s.feedback || "",
            submittedAt: s.submittedAt,
            late: !!s.late,
            fileCount: (s.files || []).length,
            hasBoard: !!s.board,
          }
        : null,
    };
  });
  res.json({ assignments: assignmentsOut });
});

// GET /api/parent/children/:childId/attendance — the child's recent attendance,
// newest first, with the lesson's title/time.
const childAttendance = asyncHandler(async (req, res) => {
  if (!(await isLinked(req.user._id, req.params.childId))) {
    res.status(403);
    throw new Error("Bu şagirdə girişiniz yoxdur");
  }
  const rows = await Attendance.find({ student: req.params.childId })
    .sort({ at: -1 })
    .limit(200)
    .populate({ path: "lesson", select: "title startAt", populate: { path: "class", select: "name" } })
    .lean();
  const attendance = rows
    .filter((r) => r.lesson)
    .map((r) => ({
      _id: r._id,
      status: r.status,
      at: r.at,
      lessonTitle: r.lesson?.title || "",
      className: r.lesson?.class?.name || "",
      startAt: r.lesson?.startAt || r.at,
    }));
  res.json({ attendance });
});

// GET /api/parent/children/:childId/payments — the child's payment ledger.
const childPayments = asyncHandler(async (req, res) => {
  if (!(await isLinked(req.user._id, req.params.childId))) {
    res.status(403);
    throw new Error("Bu şagirdə girişiniz yoxdur");
  }
  const rows = await Payment.find({ student: req.params.childId, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  const payments = rows.map((p) => ({
    _id: p._id,
    label: p.label,
    amount: p.amount,
    paid: p.paid,
    paidAt: p.paidAt,
    dueDate: p.dueDate,
    createdAt: p.createdAt,
  }));
  const unpaidTotal = rows.filter((p) => !p.paid).reduce((s, p) => s + (p.amount || 0), 0);
  res.json({ payments, unpaidTotal });
});

// GET /api/parent/live — the parent's children who are TAKING an exam right now
// (in-progress attempts), with lightweight progress. Mirrors the teacher live board
// but scoped to the parent's approved children and without the live answer key.
const childrenLive = asyncHandler(async (req, res) => {
  const childIds = await ParentLink.find({ parent: req.user._id, status: "approved" }).distinct("student");
  if (!childIds.length) return res.json({ live: [] });
  const cutoff = new Date(Date.now() - 2 * 60 * 1000); // in-progress = not long-expired
  const attempts = await Attempt.find({ userId: { $in: childIds }, submitted: false, expiresAt: { $gt: cutoff } })
    .populate("userId", "name photo")
    .populate("examId", "name totalMarks")
    .sort({ lastSeenAt: -1 })
    .lean();
  const now = Date.now();
  const live = attempts
    .filter((a) => a.examId && a.userId)
    .map((a) => ({
      attemptId: a._id,
      child: { _id: a.userId._id, name: a.userId.name || "", photo: a.userId.photo || "" },
      examName: a.examId.name || "İmtahan",
      currentQuestion: a.currentQuestion || 0,
      answeredCount: a.answeredCount || 0,
      violations: a.violations || 0,
      startedAt: a.startedAt,
      expiresAt: a.expiresAt,
      // "writing now" if a heartbeat landed in the last 30s.
      active: a.lastSeenAt ? now - new Date(a.lastSeenAt).getTime() < 30 * 1000 : false,
    }));
  res.json({ live });
});

// GET /api/parent/teacher/students — the teacher's students (across their classes),
// each with their class(es), the owning teacher, and their linked parents + status.
// Admins see every class (and which teacher owns it).
const teacherStudents = asyncHandler(async (req, res) => {
  const admin = req.user.role === "admin";
  const classes = await ClassModel.find(admin ? { deletedAt: null } : { owner: req.user._id, deletedAt: null })
    .select("_id name owner")
    .lean();
  if (!classes.length) return res.json({ students: [] });
  const classById = new Map(classes.map((c) => [String(c._id), c]));
  const ownerIds = [...new Set(classes.map((c) => String(c.owner)))];
  const owners = await User.find({ _id: { $in: ownerIds } }).select("name").lean();
  const ownerName = new Map(owners.map((o) => [String(o._id), o.name]));

  const enrolls = await Enrollment.find({ class: { $in: classes.map((c) => c._id) }, status: "approved" })
    .populate("student", "name email photo grade")
    .lean();
  const byStudent = new Map();
  for (const e of enrolls) {
    if (!e.student) continue;
    const sid = String(e.student._id);
    if (!byStudent.has(sid)) {
      byStudent.set(sid, {
        student: { _id: e.student._id, name: e.student.name, email: e.student.email, photo: e.student.photo, grade: e.student.grade },
        classes: [],
        parents: [],
      });
    }
    const c = classById.get(String(e.class));
    if (c) byStudent.get(sid).classes.push({ _id: c._id, name: c.name, teacherName: ownerName.get(String(c.owner)) || "" });
  }

  const studentIds = [...byStudent.keys()];
  const links = studentIds.length
    ? await ParentLink.find({ student: { $in: studentIds } }).populate("parent", "name email photo").lean()
    : [];
  for (const l of links) {
    const entry = byStudent.get(String(l.student));
    if (entry && l.parent) {
      entry.parents.push({ linkId: l._id, name: l.parent.name || "", email: l.parent.email || "", photo: l.parent.photo || "", status: l.status });
    }
  }
  // Students with a pending parent request first, then by name.
  const students = [...byStudent.values()].sort((a, b) => {
    const ap = a.parents.some((p) => p.status === "pending") ? 0 : 1;
    const bp = b.parents.some((p) => p.status === "pending") ? 0 : 1;
    return ap - bp || (a.student.name || "").localeCompare(b.student.name || "");
  });
  res.json({ students });
});

// PATCH /api/parent/teacher/link/:linkId { action } — a teacher approves/rejects a
// pending parent request for one of THEIR students.
const decideParentLink = asyncHandler(async (req, res) => {
  const link = await ParentLink.findById(req.params.linkId);
  if (!link) {
    res.status(404);
    throw new Error("Sorğu tapılmadı");
  }
  if (req.user.role !== "admin") {
    const myClassIds = await ClassModel.find({ owner: req.user._id, deletedAt: null }).distinct("_id");
    const inMyClass = await Enrollment.exists({ student: link.student, status: "approved", class: { $in: myClassIds } });
    if (!inMyClass) {
      res.status(403);
      throw new Error("Bu şagird sizin sinifdə deyil");
    }
  }
  const action = req.body?.action;
  if (action === "approve") {
    link.status = "approved";
    await link.save();
    return res.json({ ok: true, status: "approved" });
  }
  if (action === "reject") {
    await link.deleteOne();
    return res.json({ ok: true, status: "removed" });
  }
  res.status(400);
  throw new Error("Yanlış əməliyyat");
});

// GET /api/parent/student/requests — a STUDENT's own pending parent requests.
const myParentRequests = asyncHandler(async (req, res) => {
  const links = await ParentLink.find({ student: req.user._id, status: "pending" }).populate("parent", "name email photo").lean();
  res.json({ requests: links.filter((l) => l.parent).map((l) => ({ linkId: l._id, name: l.parent.name || "", email: l.parent.email || "", photo: l.parent.photo || "" })) });
});

// GET /api/parent/student/parents — a STUDENT's parents, split into pending requests
// (to approve/deny) and approved links (which they can remove). Full student control.
const myParents = asyncHandler(async (req, res) => {
  const links = await ParentLink.find({ student: req.user._id }).populate("parent", "name email photo").sort({ createdAt: -1 }).lean();
  const map = (l) => ({ linkId: l._id, name: l.parent?.name || "", email: l.parent?.email || "", photo: l.parent?.photo || "", via: l.via || "code" });
  res.json({
    pending: links.filter((l) => l.status === "pending" && l.parent).map(map),
    approved: links.filter((l) => l.status === "approved" && l.parent).map(map),
  });
});

// PATCH /api/parent/student/link/:linkId { action } — a STUDENT approves/rejects a
// pending parent request for themselves.
const decideMyParentLink = asyncHandler(async (req, res) => {
  const link = await ParentLink.findOne({ _id: req.params.linkId, student: req.user._id });
  if (!link) {
    res.status(404);
    throw new Error("Sorğu tapılmadı");
  }
  const action = req.body?.action;
  if (action === "approve") {
    link.status = "approved";
    await link.save();
    return res.json({ ok: true });
  }
  if (action === "reject") {
    await link.deleteOne();
    return res.json({ ok: true });
  }
  res.status(400);
  throw new Error("Yanlış əməliyyat");
});

module.exports = {
  linkChild,
  linkChildByEmail,
  listChildren,
  unlinkChild,
  childResults,
  childHomework,
  childAttendance,
  childPayments,
  childrenLive,
  teacherStudents,
  decideParentLink,
  myParentRequests,
  myParents,
  decideMyParentLink,
};
