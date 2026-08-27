const asyncHandler = require("express-async-handler");
const ParentLink = require("../models/parentLinkModel");
const User = require("../models/userModel");
const Enrollment = require("../models/enrollmentModel");
const Assignment = require("../models/assignmentModel");
const Submission = require("../models/submissionModel");
const Result = require("../models/resultModel");
const Attendance = require("../models/attendanceModel");
const Payment = require("../models/paymentModel");

// Compact child DTO — never leak more of a student's account than a parent needs.
const childDto = (u) => ({
  _id: u._id,
  name: u.name || "",
  email: u.email || "",
  photo: u.photo || "",
  grade: u.grade || "",
});

// True when this parent is linked to this student.
const isLinked = (parentId, studentId) => ParentLink.exists({ parent: parentId, student: studentId });

// POST /api/parent/link { code } — link the caller (a parent) to the student who owns
// this parentCode. Idempotent: entering the same code twice is a no-op.
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
    { $setOnInsert: { parent: req.user._id, student: student._id, status: "approved" } },
    { upsert: true }
  );
  res.json({ ok: true, child: childDto(student) });
});

// GET /api/parent/children — the caller's linked children.
const listChildren = asyncHandler(async (req, res) => {
  const ids = await ParentLink.find({ parent: req.user._id }).sort({ createdAt: -1 }).distinct("student");
  const kids = ids.length ? await User.find({ _id: { $in: ids } }).select("name email photo grade").lean() : [];
  // Preserve link recency order (distinct loses it) by re-sorting to the id order.
  const order = new Map(ids.map((id, i) => [String(id), i]));
  kids.sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
  res.json({ children: kids.map(childDto) });
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

module.exports = { linkChild, listChildren, unlinkChild, childResults, childHomework, childAttendance, childPayments };
