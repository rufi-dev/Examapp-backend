const asyncHandler = require("express-async-handler");
const ExamPaymentRequest = require("../models/examPaymentRequestModel");
const Exam = require("../models/examModel");
const User = require("../models/userModel");
const { paymentInfo } = require("../config/payment");
const { sendTelegram, linkedAdmins } = require("../helper/telegram");

const isAdmin = (u) => u?.role === "admin";

// GET /api/payments/payment-info — the card students transfer to.
const getPaymentInfo = asyncHandler(async (req, res) => {
  res.status(200).json(paymentInfo());
});

// POST /api/payments/request  body { examId, paid } — the "Ödədim" action.
// Idempotent: reuses an existing open request for this (student, exam).
const createRequest = asyncHandler(async (req, res) => {
  const { examId, paid } = req.body;
  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404);
    throw new Error("İmtahan tapılmadı");
  }
  const price = Number(exam.price) || 0;
  if (price <= 0) {
    res.status(400);
    throw new Error("Bu imtahan pulsuzdur");
  }

  const student = req.user;
  const owns =
    (student.exams || []).some((e) => String(e) === String(examId)) ||
    (exam.users || []).some((u) => String(u) === String(student._id));
  if (owns) {
    res.status(400);
    throw new Error("Bu imtahan artıq sizdədir");
  }

  let request = await ExamPaymentRequest.findOne({
    student: student._id,
    exam: examId,
    status: "open",
  });
  if (request) {
    if (paid) {
      request.paidClaimed = true;
      request.paidClaimedAt = new Date();
    }
    request.amount = price;
    await request.save();
  } else {
    request = await ExamPaymentRequest.create({
      student: student._id,
      exam: examId,
      amount: price,
      paidClaimed: !!paid,
      paidClaimedAt: paid ? new Date() : null,
    });
  }

  // Best-effort Telegram ping to linked admins.
  try {
    const admins = await linkedAdmins();
    const text =
      `💳 Yeni ödəniş bildirişi\n` +
      `Şagird: ${student.name || "—"}\n` +
      `İmtahan: ${exam.name || "—"}\n` +
      `Məbləğ: ${price} ₼`;
    await Promise.allSettled((admins || []).map((a) => sendTelegram(a.telegramChatId, text)));
  } catch {
    /* non-fatal */
  }

  res.status(200).json({ ok: true, request });
});

// GET /api/payments/requests — admin sees all; teacher sees only requests for
// exams they own.
const listRequests = asyncHandler(async (req, res) => {
  let filter = {};
  if (!isAdmin(req.user)) {
    const ownExamIds = await Exam.find({ owner: req.user._id }).distinct("_id");
    filter = { exam: { $in: ownExamIds } };
  }
  const requests = await ExamPaymentRequest.find(filter)
    .populate("student", "name email phone")
    .populate("exam", "name price owner")
    .sort({ status: 1, createdAt: -1 })
    .limit(500);
  res.status(200).json(requests || []);
});

// PATCH /api/payments/requests/:id  body { status } — approve/reject.
// Approving GRANTS access (pushes into user.exams + exam.users), idempotently.
const decideRequest = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!["done", "rejected", "open"].includes(status)) {
    res.status(400);
    throw new Error("Yanlış status");
  }

  const request = await ExamPaymentRequest.findById(id).populate("exam", "name owner");
  if (!request) {
    res.status(404);
    throw new Error("Sorğu tapılmadı");
  }

  // A teacher may only decide requests for exams they own; admins decide all.
  if (!isAdmin(req.user) && String(request.exam?.owner) !== String(req.user._id)) {
    res.status(403);
    throw new Error("Bu ödənişi təsdiqləmək icazəniz yoxdur");
  }

  if (status === "done") {
    const user = await User.findById(request.student);
    const exam = await Exam.findById(request.exam?._id || request.exam);
    if (user && exam) {
      if (!(user.exams || []).some((e) => String(e) === String(exam._id))) {
        user.exams.push(exam._id);
        await user.save();
      }
      if (!(exam.users || []).some((u) => String(u) === String(user._id))) {
        exam.users.push(user._id);
        await exam.save();
      }
    }
  }

  request.status = status;
  request.decidedBy = req.user._id;
  request.decidedAt = new Date();
  await request.save();
  res.status(200).json({ ok: true, request });
});

module.exports = { getPaymentInfo, createRequest, listRequests, decideRequest };
