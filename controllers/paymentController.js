const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Payment = require("../models/paymentModel");
const RecurringPayment = require("../models/recurringPaymentModel");
const ClassModel = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const User = require("../models/userModel");
const parentNotify = require("../helper/parentNotify");

const AZ_MONTHS = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "İyun", "İyul", "Avqust", "Sentyabr", "Oktyabr", "Noyabr", "Dekabr"];
const periodOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const isAdmin = (u) => u && u.role === "admin";

// The teacher owns a payment if they own its class OR they created it. For creation we
// verify the student is in a class the teacher owns.
async function assertClassOwner(classId, user, res) {
  const cls = await ClassModel.findOne({ _id: classId, deletedAt: null }).select("owner").lean();
  if (!cls) {
    res.status(404);
    throw new Error("Sinif tapılmadı");
  }
  if (!isAdmin(user) && String(cls.owner) !== String(user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }
  return cls;
}

// POST /api/payments — record a charge for a student (monthly fee, lesson fee, etc.).
const createPayment = asyncHandler(async (req, res) => {
  const { classId, studentId, amount, label, lessonId, dueDate, paid } = req.body || {};
  if (!mongoose.isValidObjectId(studentId)) {
    res.status(400);
    throw new Error("Şagird seçilməyib");
  }
  if (!mongoose.isValidObjectId(classId)) {
    res.status(400);
    throw new Error("Sinif seçilməyib");
  }
  await assertClassOwner(classId, req.user, res);
  const enrolled = await Enrollment.exists({ class: classId, student: studentId, status: "approved" });
  if (!enrolled) {
    res.status(400);
    throw new Error("Şagird bu sinifdə deyil");
  }
  const student = await User.findById(studentId).select("name").lean();
  const payment = await Payment.create({
    owner: req.user._id,
    class: classId,
    student: studentId,
    studentName: student?.name || "",
    lesson: mongoose.isValidObjectId(lessonId) ? lessonId : null,
    label: String(label || "").slice(0, 200),
    amount: Math.max(0, Number(amount) || 0),
    paid: !!paid,
    paidAt: paid ? new Date() : null,
    dueDate: dueDate && !Number.isNaN(new Date(dueDate).getTime()) ? new Date(dueDate) : null,
  });
  res.status(201).json(payment);
  parentNotify
    .payment(studentId, classId, { childName: student?.name, label: payment.label, amount: payment.amount, paid: payment.paid, dueDate: payment.dueDate })
    .catch(() => {});
});

// GET /api/payments?classId=&studentId= — the teacher's payment ledger.
const listPayments = asyncHandler(async (req, res) => {
  const q = { deletedAt: null };
  if (!isAdmin(req.user)) q.owner = req.user._id;
  if (req.query.classId && mongoose.isValidObjectId(req.query.classId)) q.class = req.query.classId;
  if (req.query.studentId && mongoose.isValidObjectId(req.query.studentId)) q.student = req.query.studentId;
  const payments = await Payment.find(q).sort({ createdAt: -1 }).limit(1000).lean();
  res.json(payments);
});

// PATCH /api/payments/:id — toggle paid / edit label/amount/dueDate.
const updatePayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, deletedAt: null });
  if (!payment) {
    res.status(404);
    throw new Error("Ödəniş tapılmadı");
  }
  if (!isAdmin(req.user) && String(payment.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }
  const { amount, label, paid, dueDate } = req.body || {};
  if (amount !== undefined) payment.amount = Math.max(0, Number(amount) || 0);
  if (label !== undefined) payment.label = String(label).slice(0, 200);
  if (dueDate !== undefined) payment.dueDate = dueDate && !Number.isNaN(new Date(dueDate).getTime()) ? new Date(dueDate) : null;
  if (paid !== undefined) {
    payment.paid = !!paid;
    payment.paidAt = paid ? new Date() : null;
  }
  await payment.save();
  res.json(payment);
});

// DELETE /api/payments/:id — soft delete.
const deletePayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, deletedAt: null });
  if (!payment) {
    res.status(404);
    throw new Error("Ödəniş tapılmadı");
  }
  if (!isAdmin(req.user) && String(payment.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }
  payment.deletedAt = new Date();
  await payment.save();
  res.json({ ok: true });
});

// GET /api/payments/my — a STUDENT's own payment ledger + unpaid total (read-only).
const myPayments = asyncHandler(async (req, res) => {
  const rows = await Payment.find({ student: req.user._id, deletedAt: null }).sort({ createdAt: -1 }).limit(300).lean();
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

// ── Recurring monthly plans ──────────────────────────────────────────────────

// POST /api/payments/recurring — set (or update) a student's monthly fee for a class.
const upsertRecurring = asyncHandler(async (req, res) => {
  const { classId, studentId, amount, label, dayOfMonth } = req.body || {};
  if (!mongoose.isValidObjectId(classId) || !mongoose.isValidObjectId(studentId)) {
    res.status(400);
    throw new Error("Sinif və şagird seçin");
  }
  await assertClassOwner(classId, req.user, res);
  const enrolled = await Enrollment.exists({ class: classId, student: studentId, status: "approved" });
  if (!enrolled) {
    res.status(400);
    throw new Error("Şagird bu sinifdə deyil");
  }
  const student = await User.findById(studentId).select("name").lean();
  const day = Math.min(28, Math.max(1, Number(dayOfMonth) || 1));
  const plan = await RecurringPayment.findOneAndUpdate(
    { student: studentId, class: classId },
    {
      $set: { amount: Math.max(0, Number(amount) || 0), label: String(label || "").slice(0, 120), dayOfMonth: day, active: true, owner: req.user._id, studentName: student?.name || "" },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.status(201).json(plan);
});

// GET /api/payments/recurring?classId= — the teacher's monthly plans.
const listRecurring = asyncHandler(async (req, res) => {
  const q = {};
  if (req.user.role !== "admin") q.owner = req.user._id;
  if (req.query.classId && mongoose.isValidObjectId(req.query.classId)) q.class = req.query.classId;
  const plans = await RecurringPayment.find(q).lean();
  res.json(plans);
});

// PATCH /api/payments/recurring/:id — edit amount/day/label or toggle active.
const updateRecurring = asyncHandler(async (req, res) => {
  const plan = await RecurringPayment.findById(req.params.id);
  if (!plan) {
    res.status(404);
    throw new Error("Plan tapılmadı");
  }
  if (req.user.role !== "admin" && String(plan.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }
  const { amount, label, dayOfMonth, active } = req.body || {};
  if (amount !== undefined) plan.amount = Math.max(0, Number(amount) || 0);
  if (label !== undefined) plan.label = String(label).slice(0, 120);
  if (dayOfMonth !== undefined) plan.dayOfMonth = Math.min(28, Math.max(1, Number(dayOfMonth) || 1));
  if (active !== undefined) plan.active = !!active;
  await plan.save();
  res.json(plan);
});

// DELETE /api/payments/recurring/:id — stop the plan (past Payments are kept).
const deleteRecurring = asyncHandler(async (req, res) => {
  const plan = await RecurringPayment.findById(req.params.id);
  if (!plan) {
    res.status(404);
    throw new Error("Plan tapılmadı");
  }
  if (req.user.role !== "admin" && String(plan.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("İcazə yoxdur");
  }
  await plan.deleteOne();
  res.json({ ok: true });
});

// Daily sweep: for each active plan whose due day has arrived this month and whose
// Payment hasn't been generated yet, create it (claiming the period atomically first so
// concurrent runs never double-charge), then notify parents. Returns a count.
async function runRecurringSweep(now = new Date()) {
  const period = periodOf(now);
  const today = now.getDate();
  const monthLabel = `${AZ_MONTHS[now.getMonth()]} ayı`;
  let created = 0;

  // ── (1) Per-student plans (manual, from the payments page). ──
  const plans = await RecurringPayment.find({ active: true, lastGeneratedPeriod: { $ne: period } }).lean();
  for (const plan of plans) {
    if (today < plan.dayOfMonth) continue; // due day not reached yet this month
    // Atomically claim this period so a second sweep (or the worker) can't duplicate.
    const claim = await RecurringPayment.updateOne(
      { _id: plan._id, lastGeneratedPeriod: { $ne: period } },
      { $set: { lastGeneratedPeriod: period } }
    );
    if (!claim.modifiedCount) continue;
    const enrolled = await Enrollment.exists({ class: plan.class, student: plan.student, status: "approved" });
    if (!enrolled) continue;
    const dueDate = new Date(now.getFullYear(), now.getMonth(), plan.dayOfMonth);
    const label = plan.label || monthLabel;
    await Payment.create({ owner: plan.owner, class: plan.class, student: plan.student, studentName: plan.studentName || "", label, amount: plan.amount, paid: false, dueDate, auto: true, period });
    created += 1;
    parentNotify.payment(plan.student, plan.class, { childName: plan.studentName, label, amount: plan.amount, paid: false, dueDate }).catch(() => {});
  }

  // ── (2) Class-wide monthly fees — every approved (and newly joined) student. ──
  const ClassModel = require("../models/classModel");
  const User = require("../models/userModel");
  const feeClasses = await ClassModel.find({ "monthlyFee.active": true, deletedAt: null }).select("owner monthlyFee").lean();
  for (const cls of feeClasses) {
    const fee = cls.monthlyFee || {};
    if (!(fee.amount > 0)) continue;
    if (today < (fee.dayOfMonth || 1)) continue;
    const studentIds = await Enrollment.find({ class: cls._id, status: "approved" }).distinct("student");
    if (!studentIds.length) continue;
    const dueDate = new Date(now.getFullYear(), now.getMonth(), Math.min(28, fee.dayOfMonth || 1));
    for (const sid of studentIds) {
      // One class payment per student per month — idempotent claim via a unique-ish key.
      const exists = await Payment.exists({ student: sid, class: cls._id, period, auto: true });
      if (exists) continue;
      const student = await User.findById(sid).select("name").lean();
      try {
        await Payment.create({ owner: cls.owner, class: cls._id, student: sid, studentName: student?.name || "", label: monthLabel, amount: fee.amount, paid: false, dueDate, auto: true, period });
        created += 1;
        parentNotify.payment(sid, cls._id, { childName: student?.name, label: monthLabel, amount: fee.amount, paid: false, dueDate }).catch(() => {});
      } catch (e) {
        /* ignore per-student failure, continue */
      }
    }
  }
  return created;
}

module.exports = {
  createPayment,
  listPayments,
  updatePayment,
  deletePayment,
  myPayments,
  upsertRecurring,
  listRecurring,
  updateRecurring,
  deleteRecurring,
  runRecurringSweep,
};
