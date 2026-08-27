const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Payment = require("../models/paymentModel");
const ClassModel = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const User = require("../models/userModel");
const parentNotify = require("../helper/parentNotify");

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

module.exports = { createPayment, listPayments, updatePayment, deletePayment };
