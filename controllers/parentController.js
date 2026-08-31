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
const bcrypt = require("bcryptjs");
const { validatePassword, normalizeEmail } = require("../utils/index");

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

// ── Managed accounts (a teacher or student creates a parent) ────────────────────
//
// Every rule is enforced HERE, never taken from the request body:
//   • a TEACHER may only act on students enrolled in a class they own,
//   • a STUDENT may only ever act on themselves,
//   • an ADMIN may act on anyone,
//   • no teacher or admin account can be touched through these routes at all.

// Of the student ids asked for, the ones this caller is actually allowed to manage.
async function manageableStudentIds(user, requested) {
  const ids = [...new Set((requested || []).map(String))];
  if (user.role === "student") return ids.filter((id) => id === String(user._id));
  if (!ids.length) return [];
  if (user.role === "admin") return ids;
  const classes = await ClassModel.find({ owner: user._id, deletedAt: null }).select("_id").lean();
  if (!classes.length) return [];
  const rows = await Enrollment.find({
    class: { $in: classes.map((c) => c._id) },
    student: { $in: ids },
    status: "approved",
  })
    .select("student")
    .lean();
  return [...new Set(rows.map((r) => String(r.student)))];
}

// Every student this caller manages — the basis for "is this parent mine?".
async function allManagedStudentIds(user) {
  if (user.role === "student") return [String(user._id)];
  const filter = user.role === "admin" ? { deletedAt: null } : { owner: user._id, deletedAt: null };
  const classes = await ClassModel.find(filter).select("_id").lean();
  if (!classes.length) return [];
  const rows = await Enrollment.find({ class: { $in: classes.map((c) => c._id) }, status: "approved" })
    .select("student")
    .lean();
  return [...new Set(rows.map((r) => String(r.student)))];
}

// POST /api/parent/accounts { name, email, password, phone, studentIds[] }
// A teacher creates a parent for their own students; a student creates one for
// themselves. An email that already belongs to a parent is LINKED rather than
// rejected — and that account's password is never touched.
const createParentAccount = asyncHandler(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const wanted = req.user.role === "student" ? [String(req.user._id)] : req.body?.studentIds;

  if (!name || !email) {
    res.status(400);
    throw new Error("Ad və email tələb olunur");
  }
  const studentIds = await manageableStudentIds(req.user, wanted);
  if (!studentIds.length) {
    res.status(403);
    throw new Error("Yalnız öz şagirdiniz üçün valideyn yarada bilərsiniz");
  }

  let parent = await User.findOne({ email });
  if (parent) {
    // Reuse only a PARENT account: never convert a student's or teacher's login.
    if (parent.role !== "parent") {
      res.status(400);
      throw new Error("Bu email başqa hesaba aiddir");
    }
  } else {
    const pw = validatePassword(password);
    if (!pw.ok) {
      res.status(400);
      throw new Error(pw.message);
    }
    parent = await User.create({
      name,
      email,
      password: await bcrypt.hash(password, 10),
      role: "parent",
      isVerified: true, // created by someone who already knows the family
      phone: String(req.body?.phone || "").trim() || undefined,
    });
  }

  await Promise.all(
    studentIds.map((sid) =>
      ParentLink.updateOne(
        { parent: parent._id, student: sid },
        { $set: { status: "approved" }, $setOnInsert: { parent: parent._id, student: sid, via: "code" } },
        { upsert: true }
      )
    )
  );

  res.status(201).json({
    ok: true,
    parent: { _id: parent._id, name: parent.name, email: parent.email },
    linked: studentIds.length,
  });
});

// GET /api/parent/managed — the parents of this caller's students, one row each.
const managedParents = asyncHandler(async (req, res) => {
  const studentIds = await allManagedStudentIds(req.user);
  if (!studentIds.length) return res.json({ parents: [] });
  const links = await ParentLink.find({ student: { $in: studentIds } })
    .populate("parent", "name email photo phone createdAt parentNotifyPrefs")
    .populate("student", "name email photo")
    .lean();

  const byParent = new Map();
  for (const l of links) {
    if (!l.parent) continue;
    const pid = String(l.parent._id);
    if (!byParent.has(pid)) {
      const p = l.parent.parentNotifyPrefs || {};
      byParent.set(pid, {
        _id: l.parent._id,
        name: l.parent.name || "",
        email: l.parent.email || "",
        photo: l.parent.photo || "",
        phone: l.parent.phone || "",
        createdAt: l.parent.createdAt,
        notify: {
          attendance: p.attendance !== false,
          homework: p.homework !== false,
          exam: p.exam !== false,
          payment: p.payment !== false,
        },
        students: [],
      });
    }
    if (l.student) {
      byParent.get(pid).students.push({
        _id: l.student._id,
        name: l.student.name || "",
        email: l.student.email || "",
        photo: l.student.photo || "",
        status: l.status,
        linkId: l._id,
      });
    }
  }
  const parents = [...byParent.values()].sort((a, b) => {
    const ap = a.students.some((s) => s.status === "pending") ? 0 : 1;
    const bp = b.students.some((s) => s.status === "pending") ? 0 : 1;
    return ap - bp || a.name.localeCompare(b.name);
  });
  res.json({ parents });
});

// PATCH /api/parent/managed/:parentId/notify — mute a category for ONE parent,
// without affecting the other parents of the same child.
const setParentNotify = asyncHandler(async (req, res) => {
  const studentIds = await allManagedStudentIds(req.user);
  const owns = await ParentLink.exists({ parent: req.params.parentId, student: { $in: studentIds } });
  if (!owns) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }
  const set = {};
  for (const k of ["attendance", "homework", "exam", "payment"]) {
    if (req.body?.[k] !== undefined) set[`parentNotifyPrefs.${k}`] = !!req.body[k];
  }
  if (!Object.keys(set).length) return res.json({ ok: true });
  await User.updateOne({ _id: req.params.parentId, role: "parent" }, { $set: set });
  res.json({ ok: true });
});

// PATCH /api/parent/managed/:userId/password — reset the password of one of the
// caller's own students, or of a parent attached to one of them. A teacher or admin
// account can never be targeted here.
const setManagedPassword = asyncHandler(async (req, res) => {
  const password = String(req.body?.password || "");
  const pw = validatePassword(password);
  if (!pw.ok) {
    res.status(400);
    throw new Error(pw.message);
  }
  const target = await User.findById(req.params.userId).select("_id role");
  if (!target) {
    res.status(404);
    throw new Error("İstifadəçi tapılmadı");
  }
  if (!["student", "parent"].includes(target.role)) {
    res.status(403);
    throw new Error("Yalnız şagird və valideyn şifrəsini dəyişmək olar");
  }
  const studentIds = await allManagedStudentIds(req.user);
  const allowed =
    req.user.role === "admin" ||
    (target.role === "student"
      ? studentIds.includes(String(target._id))
      : !!(await ParentLink.exists({ parent: target._id, student: { $in: studentIds } })));
  if (!allowed) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }
  target.password = await bcrypt.hash(password, 10);
  await target.save();
  res.json({ ok: true });
});

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

// The parent's approved children as a { id -> {name,photo} } map.
async function childrenMap(parentId) {
  const ids = await ParentLink.find({ parent: parentId, status: "approved" }).distinct("student");
  if (!ids.length) return { ids: [], byId: new Map() };
  const kids = await User.find({ _id: { $in: ids } }).select("name photo grade").lean();
  return { ids, byId: new Map(kids.map((k) => [String(k._id), { _id: k._id, name: k.name || "", photo: k.photo || "", grade: k.grade || "" }])) };
}

// GET /api/parent/results — ALL children's exam results, newest first, each tagged
// with the child. (Aggregated sidebar view.)
const allResults = asyncHandler(async (req, res) => {
  const { ids, byId } = await childrenMap(req.user._id);
  if (!ids.length) return res.json({ results: [] });
  const rows = await Result.find({ userId: { $in: ids } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(300)
    .populate("examId", "name totalMarks passingMarks")
    .lean();
  const results = rows.map((r) => ({
    _id: r._id,
    child: byId.get(String(r.userId)) || null,
    exam: r.examId ? { _id: r.examId._id, name: r.examId.name || "İmtahan", totalMarks: r.examId.totalMarks, passingMarks: r.examId.passingMarks } : null,
    earnPoints: r.earnPoints,
    createdAt: r.createdAt,
    terminated: !!r.terminated,
    violations: r.violations || 0,
    pending: !!r.pendingReview,
  }));
  res.json({ results });
});

// GET /api/parent/homework — ALL children's assignments + submission status, newest
// activity first (submitted, else due, else created).
const allHomework = asyncHandler(async (req, res) => {
  const { ids, byId } = await childrenMap(req.user._id);
  if (!ids.length) return res.json({ assignments: [] });
  // Each child's approved classes.
  const enrolls = await Enrollment.find({ student: { $in: ids }, status: "approved" }).select("student class").lean();
  const classesByChild = new Map();
  enrolls.forEach((e) => {
    const k = String(e.student);
    if (!classesByChild.has(k)) classesByChild.set(k, []);
    classesByChild.get(k).push(e.class);
  });
  const allClassIds = [...new Set(enrolls.map((e) => String(e.class)))];
  if (!allClassIds.length) return res.json({ assignments: [] });
  const assignments = await Assignment.find({ class: { $in: allClassIds }, deletedAt: null }).populate("class", "name").sort({ createdAt: -1 }).lean();
  const subs = await Submission.find({ assignment: { $in: assignments.map((a) => a._id) }, student: { $in: ids } }).lean();
  const subKey = (assignment, student) => `${assignment}:${student}`;
  const subByKey = new Map(subs.map((s) => [subKey(String(s.assignment), String(s.student)), s]));
  const items = [];
  for (const a of assignments) {
    const clsId = String(a.class?._id || a.class);
    // one row per child enrolled in this assignment's class
    for (const childId of ids) {
      const childClasses = (classesByChild.get(String(childId)) || []).map(String);
      if (!childClasses.includes(clsId)) continue;
      const s = subByKey.get(subKey(String(a._id), String(childId)));
      items.push({
        _id: `${a._id}-${childId}`,
        child: byId.get(String(childId)) || null,
        title: a.title,
        dueAt: a.dueAt,
        maxPoints: a.maxPoints,
        class: a.class ? { _id: a.class._id, name: a.class.name } : null,
        submission: s ? { status: s.status, grade: s.grade, feedback: s.feedback || "", submittedAt: s.submittedAt, late: !!s.late } : null,
        sortAt: s?.submittedAt || a.dueAt || a.createdAt,
      });
    }
  }
  items.sort((x, y) => new Date(y.sortAt || 0) - new Date(x.sortAt || 0));
  res.json({ assignments: items.slice(0, 300) });
});

// GET /api/parent/attendance — ALL children's attendance, newest first.
const allAttendance = asyncHandler(async (req, res) => {
  const { ids, byId } = await childrenMap(req.user._id);
  if (!ids.length) return res.json({ attendance: [] });
  const rows = await Attendance.find({ student: { $in: ids } })
    .sort({ at: -1 })
    .limit(300)
    .populate({ path: "lesson", select: "title startAt", populate: { path: "class", select: "name" } })
    .lean();
  const attendance = rows
    .filter((r) => r.lesson)
    .map((r) => ({
      _id: r._id,
      child: byId.get(String(r.student)) || null,
      status: r.status,
      at: r.at,
      lessonTitle: r.lesson?.title || "",
      className: r.lesson?.class?.name || "",
      startAt: r.lesson?.startAt || r.at,
    }));
  res.json({ attendance });
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
  allResults,
  allHomework,
  allAttendance,
  teacherStudents,
  decideParentLink,
  myParentRequests,
  myParents,
  decideMyParentLink,
  createParentAccount,
  managedParents,
  setParentNotify,
  setManagedPassword,
};
