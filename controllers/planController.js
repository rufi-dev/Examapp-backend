const asyncHandler = require("express-async-handler");
const PlanUpgradeRequest = require("../models/planUpgradeRequestModel");
const User = require("../models/userModel");
const { PLANS, PLAN_IDS, CREDIT_TOPUPS, AI_ACTION_COSTS, paymentInfo } = require("../config/plans");
const { sendTelegram, esc } = require("../helper/telegram");

// GET /api/plan/catalog — public plan/pricing catalog for the pricing page.
// (Limits use Infinity → serialize as null = "unlimited" for JSON.)
const jsonLimits = (l) => ({
  classes: Number.isFinite(l.classes) ? l.classes : null,
  students: Number.isFinite(l.students) ? l.students : null,
  examCreations: Number.isFinite(l.examCreations) ? l.examCreations : null,
});
const getCatalog = asyncHandler(async (req, res) => {
  res.json({
    plans: PLAN_IDS.map((id) => ({
      id,
      label: PLANS[id].label,
      priceAzn: PLANS[id].priceAzn,
      limits: jsonLimits(PLANS[id].limits),
      credits: PLANS[id].credits,
      features: PLANS[id].features,
    })),
    topups: CREDIT_TOPUPS,
    aiActionCosts: AI_ACTION_COSTS,
    // The receiving card is meant to be shown to anyone upgrading, so it rides
    // along on the public catalog — the payment page reads it here without an
    // auth round-trip (the auth-gated /payment-info stays as a fallback).
    payment: paymentInfo(),
  });
});

// GET /api/plan/payment-info — the card a teacher transfers to (auth-gated to
// keep it off public crawlers). Returns configured card details from env.
const getPaymentInfo = asyncHandler(async (req, res) => {
  res.json(paymentInfo());
});

// POST /api/plan/upgrade-request — teacher asks to move to Pro/Premium, and
// (when `paid` is set) declares they have transferred the money. Idempotent per
// {teacher, targetPlan}; best-effort pings linked admins on Telegram.
const requestUpgrade = asyncHandler(async (req, res) => {
  const targetPlan = String(req.body?.targetPlan || "");
  if (!["pro", "premium"].includes(targetPlan)) {
    res.status(400);
    throw new Error("Yanlış paket");
  }
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : "";
  const paid = req.body?.paid === true || req.body?.paid === "true";

  // Idempotent: reuse an existing open request for the same target.
  let request = await PlanUpgradeRequest.findOne({
    teacher: req.user._id,
    targetPlan,
    status: "open",
  });
  if (!request) {
    request = await PlanUpgradeRequest.create({
      teacher: req.user._id,
      targetPlan,
      note,
      paidClaimed: paid,
      paidClaimedAt: paid ? new Date() : null,
    });
  } else {
    let dirty = false;
    if (note && note !== request.note) { request.note = note; dirty = true; }
    if (paid && !request.paidClaimed) { request.paidClaimed = true; request.paidClaimedAt = new Date(); dirty = true; }
    if (dirty) await request.save();
  }

  // Best-effort admin ping (never blocks/breaks the request).
  try {
    const admins = await User.find({ role: "admin", telegramChatId: { $nin: [null, ""] } })
      .select("telegramChatId")
      .lean();
    if (admins.length) {
      const text = [
        paid ? "✅ <b>Ödəniş bildirişi</b>" : "💳 <b>Paket yüksəltmə istəyi</b>",
        `👤 ${esc(req.user.name || "Müəllim")}`,
        `📦 ${esc(PLANS[targetPlan].label)} (${PLANS[targetPlan].priceAzn} ₼/ay)`,
        paid ? "💰 Ödədim düyməsini basdı — yoxla və təsdiqlə" : null,
        note ? `📝 ${esc(note)}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      await Promise.allSettled(admins.map((a) => sendTelegram(a.telegramChatId, text)));
    }
  } catch (e) {
    console.error("[PLAN] upgrade-request notify failed:", e.message);
  }

  res.status(201).json({
    ok: true,
    request: { _id: request._id, targetPlan, status: request.status, paidClaimed: request.paidClaimed },
  });
});

// POST /api/plan/credit-request — teacher buys a credit top-up pack (manual
// payment). `paid` records the "Ödədim" claim; admin verifies and adds credits.
const requestCredit = asyncHandler(async (req, res) => {
  const credits = Math.round(Number(req.body?.credits) || 0);
  const pack = CREDIT_TOPUPS.find((t) => t.credits === credits);
  if (!pack) {
    res.status(400);
    throw new Error("Yanlış kredit paketi");
  }
  const paid = req.body?.paid === true || req.body?.paid === "true";

  let request = await PlanUpgradeRequest.findOne({
    teacher: req.user._id,
    kind: "credit",
    credits,
    status: "open",
  });
  if (!request) {
    request = await PlanUpgradeRequest.create({
      teacher: req.user._id,
      kind: "credit",
      credits,
      paidClaimed: paid,
      paidClaimedAt: paid ? new Date() : null,
    });
  } else if (paid && !request.paidClaimed) {
    request.paidClaimed = true;
    request.paidClaimedAt = new Date();
    await request.save();
  }

  try {
    const admins = await User.find({ role: "admin", telegramChatId: { $nin: [null, ""] } })
      .select("telegramChatId")
      .lean();
    if (admins.length) {
      const text = [
        paid ? "✅ <b>Kredit ödənişi</b>" : "🪙 <b>Kredit alma istəyi</b>",
        `👤 ${esc(req.user.name || "Müəllim")}`,
        `🪙 +${credits} kredit (${pack.priceAzn} ₼)`,
        paid ? "💰 Ödədim düyməsini basdı — yoxla və krediti əlavə et" : null,
      ]
        .filter(Boolean)
        .join("\n");
      await Promise.allSettled(admins.map((a) => sendTelegram(a.telegramChatId, text)));
    }
  } catch (e) {
    console.error("[PLAN] credit-request notify failed:", e.message);
  }

  res.status(201).json({ ok: true, request: { _id: request._id, credits, status: request.status } });
});

// GET /api/plan/subscribers — admin package control: every teacher on a paid
// plan with their renewal (planExpiresAt) date, so the admin can see who is due
// and remind them / let them lapse. Sorted by soonest expiry first.
const listSubscribers = asyncHandler(async (req, res) => {
  const rows = await User.find({
    role: { $in: ["teacher", "admin"] },
    plan: { $in: ["pro", "premium"] },
    deletedAt: null,
  })
    .select("name email phone role plan planSince planExpiresAt aiCredits")
    .lean();
  rows.sort((a, b) => {
    const av = a.planExpiresAt ? new Date(a.planExpiresAt).getTime() : Infinity;
    const bv = b.planExpiresAt ? new Date(b.planExpiresAt).getTime() : Infinity;
    return av - bv;
  });
  res.json(rows);
});

// GET /api/plan/downgraded — teachers/admins who were on a paid plan and were
// downgraded back to free (kept visible so the admin can see who they dropped).
const listDowngraded = asyncHandler(async (req, res) => {
  const rows = await User.find({
    role: { $in: ["teacher", "admin"] },
    plan: "free",
    planDowngradedAt: { $ne: null },
    deletedAt: null,
  })
    .select("name email phone role plan planSince planExpiresAt planDowngradedAt aiCredits")
    .sort({ planDowngradedAt: -1 })
    .lean();
  res.json(rows);
});

// GET /api/plan/credited — FREE-plan teachers who have a non-zero AI credit
// balance (e.g. granted or purchased), so the admin can monitor + top them up.
const listCredited = asyncHandler(async (req, res) => {
  // "free" INCLUDES grandfathered accounts whose `plan` field is absent/null
  // (no migration was run — code treats missing plan as free). Searchable +
  // paginated (there can be hundreds).
  const q = String(req.query.q || "").trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit, 10) || 20));
  const filter = {
    role: { $in: ["teacher", "admin"] },
    $or: [{ plan: "free" }, { plan: { $exists: false } }, { plan: null }],
    aiCredits: { $gt: 0 },
    deletedAt: null,
  };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$and = [{ $or: [{ name: rx }, { email: rx }, { phone: rx }] }];
  }
  const total = await User.countDocuments(filter);
  const pages = Math.max(1, Math.ceil(total / limit));
  const rows = await User.find(filter)
    .select("name email phone role plan aiCredits createdAt")
    .sort({ createdAt: -1 }) // newest registrations first
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  res.json({ total, rows, page, pages });
});

// GET /api/plan/upgrade-requests — admin inbox (open first, newest first).
const listUpgradeRequests = asyncHandler(async (req, res) => {
  const rows = await PlanUpgradeRequest.find({})
    .populate("teacher", "name email phone plan")
    .sort({ status: 1, createdAt: -1 })
    .limit(500)
    .lean();
  res.json(rows || []);
});

// PATCH /api/plan/upgrade-requests/:id — admin marks a request done/rejected.
// (Setting the actual plan is a separate call to PATCH /api/users/:id/plan.)
const decideUpgradeRequest = asyncHandler(async (req, res) => {
  const status = String(req.body?.status || "");
  if (!["done", "rejected", "open"].includes(status)) {
    res.status(400);
    throw new Error("Yanlış status");
  }
  const request = await PlanUpgradeRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error("İstək tapılmadı");
  }
  request.status = status;
  request.decidedBy = req.user._id;
  request.decidedAt = new Date();
  await request.save();
  res.json({ ok: true, _id: request._id, status: request.status });
});

module.exports = {
  getCatalog,
  getPaymentInfo,
  requestUpgrade,
  requestCredit,
  listSubscribers,
  listDowngraded,
  listCredited,
  listUpgradeRequests,
  decideUpgradeRequest,
};
