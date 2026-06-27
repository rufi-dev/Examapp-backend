const asyncHandler = require("express-async-handler");
const Enrollment = require("../models/enrollmentModel");
const Class = require("../models/classModel");
const User = require("../models/userModel");
const { notifyEnrollment } = require("../helper/telegram");

const isAdmin = (u) => !!u && u.role === "admin";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genJoinCode(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
async function uniqueJoinCode() {
  for (let i = 0; i < 8; i++) {
    const code = genJoinCode();
    // eslint-disable-next-line no-await-in-loop
    if (!(await Class.exists({ joinCode: code }))) return code;
  }
  return genJoinCode(8);
}

// ---- student side -----------------------------------------------------------

// Join a class by its code. Having the code IS the permission — the student is
// enrolled (approved) immediately. There is no pending/approval step anymore.
const joinClass = asyncHandler(async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  if (!code) {
    res.status(400);
    throw new Error("Sinif kodunu daxil edin");
  }
  const cls = await Class.findOne({ joinCode: code });
  if (!cls) {
    res.status(404);
    throw new Error("Bu kodla sinif tapılmadı");
  }

  const existing = await Enrollment.findOne({ student: req.user._id, class: cls._id });
  if (existing) {
    // Upgrade any legacy pending request to approved — the code is enough.
    if (existing.status !== "approved") {
      existing.status = "approved";
      await existing.save();
    }
    return res.status(200).json({
      status: "approved",
      message: "Siz artıq bu sinifə qoşulmusunuz",
    });
  }

  await Enrollment.create({
    student: req.user._id,
    class: cls._id,
    teacher: cls.owner,
    status: "approved",
  });
  // Telegram: tell the class owner a student joined (fire-and-forget; gated by
  // the owner's onJoin flag + class scope).
  notifyEnrollment(cls, req.user, false);
  res.status(201).json({ status: "approved", message: "Sinifə qoşuldunuz" });
});

// The student's own enrollments (any status), with class info.
const myEnrollments = asyncHandler(async (req, res) => {
  const rows = await Enrollment.find({ student: req.user._id })
    .populate({ path: "class", select: "name level" })
    .sort({ createdAt: -1 })
    .lean();
  res.status(200).json(rows || []);
});

// Leave a class (or cancel a pending request).
const leaveClass = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  await Enrollment.deleteOne({ student: req.user._id, class: classId });
  res.status(200).json({ message: "Sinifdən çıxdınız" });
});

// ---- teacher side -----------------------------------------------------------

// Pending join requests across all of the teacher's classes.
const teacherRequests = asyncHandler(async (req, res) => {
  const filter = isAdmin(req.user) ? {} : { owner: req.user._id };
  const classIds = await Class.find(filter).distinct("_id");
  const rows = await Enrollment.find({ class: { $in: classIds }, status: "pending" })
    .populate("student", "name email photo")
    .populate({ path: "class", select: "name level" })
    .sort({ createdAt: 1 })
    .lean();
  res.status(200).json(rows || []);
});

// The teacher's classes with their join code and member counts.
const teacherClasses = asyncHandler(async (req, res) => {
  const filter = isAdmin(req.user) ? {} : { owner: req.user._id };
  const classes = await Class.find(filter).sort({ createdAt: -1 }).lean();

  const ids = classes.map((c) => c._id);
  const counts = await Enrollment.aggregate([
    { $match: { class: { $in: ids } } },
    { $group: { _id: { class: "$class", status: "$status" }, n: { $sum: 1 } } },
  ]);
  const map = {};
  counts.forEach((c) => {
    const k = String(c._id.class);
    map[k] = map[k] || { approved: 0, pending: 0 };
    map[k][c._id.status] = c.n;
  });

  const out = classes.map((c) => ({
    ...c,
    students: map[String(c._id)]?.approved || 0,
    pending: map[String(c._id)]?.pending || 0,
  }));
  res.status(200).json(out);
});

// Students a teacher/admin can ADD to a class (not already enrolled in it).
// Admin → every student; teacher → only their own existing students (so the
// scoping isn't bypassed — brand-new students still join via the code).
const assignableStudents = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const cls = await Class.findById(classId);
  if (!cls) {
    res.status(404);
    throw new Error("Sinif tapılmadı");
  }
  if (!isAdmin(req.user) && String(cls.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }

  const enrolledIds = await Enrollment.find({ class: classId }).distinct("student");

  let candidates;
  if (isAdmin(req.user)) {
    candidates = await User.find({
      role: { $in: ["student", "suspended"] },
      _id: { $nin: enrolledIds },
    })
      .select("name email photo")
      .sort("name")
      .lean();
  } else {
    const myClassIds = await Class.find({ owner: req.user._id }).distinct("_id");
    const myStudentIds = await Enrollment.find({
      class: { $in: myClassIds },
      status: "approved",
    }).distinct("student");
    const enrolledSet = new Set(enrolledIds.map(String));
    const ids = myStudentIds.filter((id) => !enrolledSet.has(String(id)));
    candidates = await User.find({ _id: { $in: ids } })
      .select("name email photo")
      .sort("name")
      .lean();
  }
  res.status(200).json(candidates || []);
});

// Add a selected student to a class (approved immediately). Admin → any student;
// teacher → only one of their own existing students, into a class they own.
const addStudentToClass = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const { studentId } = req.body;
  const cls = await Class.findById(classId);
  if (!cls) {
    res.status(404);
    throw new Error("Sinif tapılmadı");
  }
  if (!isAdmin(req.user) && String(cls.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }

  const student = await User.findById(studentId);
  if (!student) {
    res.status(404);
    throw new Error("Tələbə tapılmadı");
  }
  if (!["student", "suspended"].includes(student.role)) {
    res.status(400);
    throw new Error("Yalnız tələbə əlavə edilə bilər");
  }

  if (!isAdmin(req.user)) {
    const myClassIds = await Class.find({ owner: req.user._id }).distinct("_id");
    const isMine = await Enrollment.exists({
      class: { $in: myClassIds },
      student: studentId,
      status: "approved",
    });
    if (!isMine) {
      res.status(403);
      throw new Error("Yalnız öz tələbənizi əlavə edə bilərsiniz");
    }
  }

  // Idempotent: upsert as approved (re-adding a pending request just approves it).
  await Enrollment.updateOne(
    { student: studentId, class: classId },
    { $set: { student: studentId, class: classId, teacher: cls.owner, status: "approved" } },
    { upsert: true }
  );
  res.status(200).json({ message: "Tələbə sinfə əlavə edildi" });
});

// Approved students of a class the teacher owns (the per-class roster).
const classStudents = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const cls = await Class.findById(classId);
  if (!cls) {
    res.status(404);
    throw new Error("Sinif tapılmadı");
  }
  if (!isAdmin(req.user) && String(cls.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }
  const rows = await Enrollment.find({ class: classId, status: "approved" })
    .populate("student", "name email photo role")
    .sort({ createdAt: -1 })
    .lean();
  res.status(200).json(rows.filter((r) => r.student));
});

// Approve / reject (or remove) an enrollment. Only the owning teacher (or admin).
const decideEnrollment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const action = req.body.action;
  const enr = await Enrollment.findById(id).populate("class", "owner");
  if (!enr) {
    res.status(404);
    throw new Error("Sorğu tapılmadı");
  }
  if (!isAdmin(req.user) && String(enr.class?.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }

  if (action === "approve") {
    enr.status = "approved";
    await enr.save();
    return res.status(200).json({ message: "Təsdiqləndi", status: "approved" });
  }
  // reject a request OR remove an enrolled student: either way drop the row so
  // they could request again later.
  if (action === "reject" || action === "remove") {
    await enr.deleteOne();
    return res.status(200).json({ message: "Silindi", status: "removed" });
  }
  res.status(400);
  throw new Error("Naməlum əməliyyat");
});

// Update a class's join settings (toggle approval, regenerate code, backfill).
const setJoinSettings = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const cls = await Class.findById(classId);
  if (!cls) {
    res.status(404);
    throw new Error("Sinif tapılmadı");
  }
  if (!isAdmin(req.user) && String(cls.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }
  if (typeof req.body.autoApprove === "boolean") cls.autoApprove = req.body.autoApprove;
  // Visibility: false = public (open to everyone), true = code-only. Stored as a
  // strict boolean so the class becomes explicitly public/private.
  if (typeof req.body.requireCode === "boolean") cls.requireCode = req.body.requireCode;
  if (req.body.regenerate || !cls.joinCode) cls.joinCode = await uniqueJoinCode();
  await cls.save();
  res.status(200).json({
    joinCode: cls.joinCode,
    autoApprove: cls.autoApprove,
    requireCode: cls.requireCode,
  });
});

module.exports = {
  joinClass,
  myEnrollments,
  leaveClass,
  teacherRequests,
  teacherClasses,
  classStudents,
  assignableStudents,
  addStudentToClass,
  decideEnrollment,
  setJoinSettings,
};
