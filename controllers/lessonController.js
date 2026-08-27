const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const QRCode = require("qrcode");
const Lesson = require("../models/lessonModel");
const Attendance = require("../models/attendanceModel");
const ClassModel = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const parentNotify = require("../helper/parentNotify");

const FRONTEND_URL = (process.env.FRONTEND_URL || "https://examopia.com").replace(/\/$/, "");
const isAdmin = (u) => u && u.role === "admin";

// Non-ambiguous code (no 0/O/1/I) for the attendance QR.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genCode(len = 8) {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}
async function uniqueAttendanceCode() {
  for (let i = 0; i < 8; i++) {
    const code = genCode();
    if (!(await Lesson.exists({ attendanceCode: code }))) return code;
  }
  return genCode(12);
}

// Owner (or admin) of this lesson's class may manage it.
function assertOwns(lesson, user, res) {
  if (!isAdmin(user) && String(lesson.owner) !== String(user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }
}

// POST /api/lessons — schedule a lesson for a class. Optionally repeat it weekly
// (same weekday/time) for `repeatWeeks` extra weeks — a quick way to lay out a term.
const createLesson = asyncHandler(async (req, res) => {
  const { classId, title, note, startAt, endAt, price, repeatWeeks } = req.body || {};
  if (!mongoose.isValidObjectId(classId)) {
    res.status(400);
    throw new Error("Sinif seçilməyib");
  }
  const cls = await ClassModel.findOne({ _id: classId, deletedAt: null }).select("owner name").lean();
  if (!cls) {
    res.status(404);
    throw new Error("Sinif tapılmadı");
  }
  if (!isAdmin(req.user) && String(cls.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }
  if (!startAt || Number.isNaN(new Date(startAt).getTime())) {
    res.status(400);
    throw new Error("Başlama vaxtı yanlışdır");
  }
  const baseStart = new Date(startAt);
  let baseEnd = endAt && !Number.isNaN(new Date(endAt).getTime()) ? new Date(endAt) : null;
  if (baseEnd && baseEnd <= baseStart) baseEnd = null; // ignore a nonsensical window
  const price0 = price != null && price !== "" ? Math.max(0, Number(price)) : null;
  const extra = Math.min(51, Math.max(0, Number(repeatWeeks) || 0)); // 0..51 extra weekly copies
  const common = {
    owner: cls.owner,
    class: cls._id,
    title: String(title || "").slice(0, 200),
    note: String(note || "").slice(0, 2000),
    price: price0,
  };
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const docs = [];
  for (let i = 0; i <= extra; i++) {
    docs.push({
      ...common,
      startAt: new Date(baseStart.getTime() + i * WEEK),
      endAt: baseEnd ? new Date(baseEnd.getTime() + i * WEEK) : null,
      attendanceCode: await uniqueAttendanceCode(),
    });
  }
  const created = await Lesson.insertMany(docs);
  res.status(201).json({ lesson: created[0], count: created.length });
});

// GET /api/lessons?classId=&from=&to= — the teacher's lessons (optionally one class,
// optionally within a date range for a calendar month).
const listLessons = asyncHandler(async (req, res) => {
  const q = { deletedAt: null };
  if (!isAdmin(req.user)) q.owner = req.user._id;
  if (req.query.classId && mongoose.isValidObjectId(req.query.classId)) q.class = req.query.classId;
  if (req.query.from || req.query.to) {
    q.startAt = {};
    if (req.query.from && !Number.isNaN(new Date(req.query.from).getTime())) q.startAt.$gte = new Date(req.query.from);
    if (req.query.to && !Number.isNaN(new Date(req.query.to).getTime())) q.startAt.$lte = new Date(req.query.to);
  }
  const lessons = await Lesson.find(q).populate("class", "name").sort({ startAt: 1 }).limit(500).lean();
  // Attach a present-count per lesson so the calendar/list can show attendance at a glance.
  const ids = lessons.map((l) => l._id);
  const counts = ids.length
    ? await Attendance.aggregate([
        { $match: { lesson: { $in: ids }, status: { $ne: "absent" } } },
        { $group: { _id: "$lesson", n: { $sum: 1 } } },
      ])
    : [];
  const byLesson = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json(lessons.map((l) => ({ ...l, presentCount: byLesson.get(String(l._id)) || 0 })));
});

// GET /api/lessons/:id — one lesson + its attendance roster (enrolled students with
// their present/late/absent status) + the check-in QR (data URL) for the teacher.
const getLesson = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findOne({ _id: req.params.id, deletedAt: null }).populate("class", "name").lean();
  if (!lesson) {
    res.status(404);
    throw new Error("Dərs tapılmadı");
  }
  assertOwns(lesson, req.user, res);
  const students = await Enrollment.find({ class: lesson.class._id || lesson.class, status: "approved" })
    .populate("student", "name email photo")
    .lean();
  const marks = await Attendance.find({ lesson: lesson._id }).lean();
  const byStudent = new Map(marks.map((m) => [String(m.student), m]));
  const roster = students
    .filter((r) => r.student)
    .map((r) => {
      const m = byStudent.get(String(r.student._id));
      return {
        student: { _id: r.student._id, name: r.student.name, email: r.student.email, photo: r.student.photo },
        status: m ? m.status : null, // null = not marked yet
        method: m ? m.method : null,
        at: m ? m.at : null,
      };
    });
  const checkinUrl = `${FRONTEND_URL}/checkin/${lesson.attendanceCode}`;
  let qr = null;
  try {
    qr = await QRCode.toDataURL(checkinUrl, { margin: 1, width: 320 });
  } catch {
    /* QR optional */
  }
  res.json({ lesson, roster, checkinUrl, qr });
});

// PATCH /api/lessons/:id — edit schedule/title/note/price.
const updateLesson = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findOne({ _id: req.params.id, deletedAt: null });
  if (!lesson) {
    res.status(404);
    throw new Error("Dərs tapılmadı");
  }
  assertOwns(lesson, req.user, res);
  const { title, note, startAt, endAt, price } = req.body || {};
  if (title != null) lesson.title = String(title).slice(0, 200);
  if (note != null) lesson.note = String(note).slice(0, 2000);
  if (startAt && !Number.isNaN(new Date(startAt).getTime())) lesson.startAt = new Date(startAt);
  if (endAt !== undefined) lesson.endAt = endAt && !Number.isNaN(new Date(endAt).getTime()) ? new Date(endAt) : null;
  if (lesson.endAt && lesson.startAt && lesson.endAt <= lesson.startAt) lesson.endAt = null; // ignore a nonsensical window
  if (price !== undefined) lesson.price = price != null && price !== "" ? Math.max(0, Number(price)) : null;
  await lesson.save();
  res.json(lesson);
});

// DELETE /api/lessons/:id — soft delete.
const deleteLesson = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findOne({ _id: req.params.id, deletedAt: null });
  if (!lesson) {
    res.status(404);
    throw new Error("Dərs tapılmadı");
  }
  assertOwns(lesson, req.user, res);
  lesson.deletedAt = new Date();
  lesson.deletedBy = req.user._id;
  lesson.attendanceOpen = false;
  await lesson.save();
  res.json({ ok: true });
});

// POST /api/lessons/:id/attendance/open — open/close QR check-in for a lesson.
const toggleAttendance = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findOne({ _id: req.params.id, deletedAt: null });
  if (!lesson) {
    res.status(404);
    throw new Error("Dərs tapılmadı");
  }
  assertOwns(lesson, req.user, res);
  lesson.attendanceOpen = typeof req.body?.open === "boolean" ? req.body.open : !lesson.attendanceOpen;
  await lesson.save();
  res.json({ ok: true, attendanceOpen: lesson.attendanceOpen });
});

// POST /api/lessons/:id/attendance/mark — teacher sets a student's status by hand.
const markAttendance = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findOne({ _id: req.params.id, deletedAt: null });
  if (!lesson) {
    res.status(404);
    throw new Error("Dərs tapılmadı");
  }
  assertOwns(lesson, req.user, res);
  const { studentId, status } = req.body || {};
  if (!mongoose.isValidObjectId(studentId) || !["present", "late", "absent"].includes(status)) {
    res.status(400);
    throw new Error("Yanlış məlumat");
  }
  const enrolled = await Enrollment.exists({ class: lesson.class, student: studentId, status: "approved" });
  if (!enrolled) {
    res.status(400);
    throw new Error("Şagird bu sinifdə deyil");
  }
  const student = await mongoose.model("User").findById(studentId).select("name").lean();
  const prev = await Attendance.findOne({ lesson: lesson._id, student: studentId }).select("status").lean();
  const doc = await Attendance.findOneAndUpdate(
    { lesson: lesson._id, student: studentId },
    { $set: { status, method: "manual", at: new Date(), class: lesson.class, studentName: student?.name || "" } },
    { upsert: true, new: true }
  );
  res.json({ ok: true, attendance: doc });
  // Notify parents only when the status actually changed (avoids re-click spam).
  if (!prev || prev.status !== status) {
    parentNotify
      .attendance(studentId, lesson.class, { childName: student?.name, lessonTitle: lesson.title, status, at: doc.at })
      .catch(() => {});
  }
});

// POST /api/lessons/checkin/:code — a STUDENT self-checks-in by scanning the QR. Any
// logged-in student enrolled (approved) in the lesson's class may check in while the
// teacher has check-in open.
const checkin = asyncHandler(async (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  const lesson = await Lesson.findOne({ attendanceCode: code, deletedAt: null }).populate("class", "name").lean();
  if (!lesson) {
    res.status(404);
    throw new Error("Dərs tapılmadı");
  }
  if (!lesson.attendanceOpen) {
    res.status(403);
    throw new Error("Bu dərs üçün qeydiyyat bağlıdır");
  }
  const enrolled = await Enrollment.exists({ class: lesson.class._id, student: req.user._id, status: "approved" });
  if (!enrolled) {
    res.status(403);
    throw new Error("Siz bu sinifin şagirdi deyilsiniz");
  }
  // Late if checking in more than 15 min after the lesson's start.
  const late = lesson.startAt && Date.now() - new Date(lesson.startAt).getTime() > 15 * 60 * 1000;
  const existing = await Attendance.findOne({ lesson: lesson._id, student: req.user._id }).lean();
  if (existing) {
    return res.json({ ok: true, already: true, status: existing.status, lesson: { title: lesson.title, className: lesson.class?.name } });
  }
  await Attendance.create({
    lesson: lesson._id,
    class: lesson.class._id,
    student: req.user._id,
    studentName: req.user.name || "",
    status: late ? "late" : "present",
    method: "qr",
    at: new Date(),
  });
  res.json({ ok: true, status: late ? "late" : "present", lesson: { title: lesson.title, className: lesson.class?.name } });
  parentNotify
    .attendance(req.user._id, lesson.class._id, {
      childName: req.user.name,
      className: lesson.class?.name,
      lessonTitle: lesson.title,
      status: late ? "late" : "present",
      at: new Date(),
    })
    .catch(() => {});
});

// GET /api/lessons/my — a STUDENT's own lessons (approved classes), recent + upcoming,
// with their attendance status. When check-in is open, the code is returned so the
// student can check in from inside the app (no camera needed).
const myLessons = asyncHandler(async (req, res) => {
  const classIds = await Enrollment.find({ student: req.user._id, status: "approved" }).distinct("class");
  if (!classIds.length) return res.json({ lessons: [] });
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // last 30 days + future
  const lessons = await Lesson.find({ class: { $in: classIds }, deletedAt: null, startAt: { $gte: since } })
    .populate("class", "name")
    .sort({ startAt: 1 })
    .limit(300)
    .lean();
  const ids = lessons.map((l) => l._id);
  const marks = ids.length ? await Attendance.find({ lesson: { $in: ids }, student: req.user._id }).lean() : [];
  const byLesson = new Map(marks.map((m) => [String(m.lesson), m]));
  res.json({
    lessons: lessons.map((l) => ({
      _id: l._id,
      title: l.title,
      className: l.class?.name || "",
      startAt: l.startAt,
      endAt: l.endAt,
      attendanceOpen: !!l.attendanceOpen,
      attendanceCode: l.attendanceOpen ? l.attendanceCode : null,
      myStatus: byLesson.get(String(l._id))?.status || null,
    })),
  });
});

module.exports = {
  createLesson,
  listLessons,
  getLesson,
  updateLesson,
  deleteLesson,
  toggleAttendance,
  markAttendance,
  checkin,
  myLessons,
};
