/*
 * Teacher Success Journey — HTTP controller (ADR §9/§10/§13, Appendix).
 *
 * Thin handlers over the tested services. Growth level is recognition only and
 * is NEVER used for authorization here. Admin actions are additionally gated by
 * adminOnly at the router. All copy/entitlements come from the single validated
 * config so the frozen positioning cannot drift.
 */
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/userModel");
const creditSvc = require("../services/aiCreditService");
const levelSvc = require("../services/teacherLevelService");
const referralSvc = require("../services/teacherReferralService");
const upgradeSvc = require("../services/teacherUpgradeRequestService");
const activitySvc = require("../services/teacherActivityService");
const eligibility = require("../services/teacherEligibility");
const xpSvc = require("../services/teacherXpService");
const missionSvc = require("../services/teacherMissionService");
const achievementSvc = require("../services/teacherAchievementService");
const TeacherReferral = require("../models/teacherReferralModel");
const TeacherUpgradeRequest = require("../models/teacherUpgradeRequestModel");
const { levels, copy, entitlements, allowances, flag } = require("../config/teacherSuccess");

const levelOf = (u) => (u && u.teacherLevel) || "spark";

// Cursor pagination helper (CR-128#6): validated limit + opaque createdAt/_id cursor.
function pageQuery(req, base = {}) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const q = { ...base };
  if (req.query.cursor) {
    const ts = new Date(req.query.cursor);
    if (!Number.isNaN(ts.getTime())) q.createdAt = { $lt: ts };
  }
  return { q, limit };
}
const nextCursor = (rows) => (rows.length ? rows[rows.length - 1].createdAt : null);

// GET /api/teacher-success/me — the teacher's own Journey snapshot. TEACHER-ONLY.
const getMyJourney = asyncHandler(async (req, res) => {
  const u = req.user;
  // CR-128#5: an admin never participates in /me and never gets an AI period.
  if (u.role !== "teacher") { res.status(403); return res.json({ code: "teacher_only" }); }
  const level = levelOf(u);
  // Credits and activity are independent. Loading them together keeps the first
  // Journey render bounded by the slower branch instead of the sum of both.
  const [credits, metrics] = await Promise.all([
    creditSvc.snapshot(u._id, level),
    activitySvc.metricsFor(u._id),
  ]);
  const elig = eligibility.evaluate({ currentLevel: level, metrics });
  // Reuse the metrics snapshot for missions. Calling progressFor without it used to
  // execute the full exam/result aggregation a second time for every /me request.
  const [missionResult, achievements] = await Promise.all([
    missionSvc.progressFor(u._id, u, { activity: metrics }),
    achievementSvc.evaluate(u._id, metrics),
  ]);
  res.status(200).json({
    enabled: true,
    level,
    labels: levels.LABELS,
    positioning: copy.POSITIONING,
    aiExplanation: copy.AI_EXPLANATION,
    xp: {
      lifetime: metrics.lifetimeXp,
      target: elig.target,
      readyForReview: elig.readyForReview,
      requirements: elig.requirements,
      referralBonus: elig.referralBonus,
    },
    eligibility: elig,
    metrics,
    missions: missionResult.missions,
    chainXp: missionResult.chainXp,
    achievements,
    welcome: { seen: !!u.journeyWelcomeSeenAt, seenAt: u.journeyWelcomeSeenAt || null },
    credits: {
      remaining: credits.remaining,
      baseAllowance: credits.baseAllowance,
      tempGranted: credits.tempGranted,
      used: credits.used,
      reserved: credits.reserved,
      resetAt: credits.resetAt,
      lowBalance: credits.remaining <= Math.floor(credits.baseAllowance * flag.lowBalanceThreshold()),
      exhausted: credits.remaining === 0,
    },
    entitlements: {
      current: entitlements.displayEntitlements(level),
      next: levels.nextLevel(level) ? entitlements.displayEntitlements(levels.nextLevel(level)) : null,
    },
    allowances: allowances.allowanceMap(),
    referral: { qualifiedReferrals: metrics.qualifiedReferrals },
  });
});

// GET /api/teacher-success/activity — the teacher's XP timeline (cursor pagination).
const getMyActivity = asyncHandler(async (req, res) => {
  const u = req.user;
  if (u.role !== "teacher") { res.status(403); return res.json({ code: "teacher_only" }); }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const { items, nextCursor: nc } = await xpSvc.feed({ teacherId: u._id, cursor: req.query.cursor, limit });
  res.status(200).json({ items, nextCursor: nc });
});

// POST /api/teacher-success/welcome-seen — stamp the first-login welcome once (idempotent).
const markWelcomeSeen = asyncHandler(async (req, res) => {
  const u = req.user;
  if (u.role !== "teacher") { res.status(403); return res.json({ code: "teacher_only" }); }
  if (!u.journeyWelcomeSeenAt) await User.updateOne({ _id: u._id, journeyWelcomeSeenAt: null }, { $set: { journeyWelcomeSeenAt: new Date() } });
  const fresh = await User.findById(u._id).select("journeyWelcomeSeenAt").lean();
  res.status(200).json({ ok: true, seenAt: fresh ? fresh.journeyWelcomeSeenAt : new Date() });
});

// GET /api/teacher-success/xp-rules — SERVER-owned XP award values for the onboarding
// "how XP is earned" chapter, so the UI never hardcodes a second set of point values.
const getXpRules = asyncHandler(async (req, res) => {
  if (req.user.role !== "teacher") { res.status(403); return res.json({ code: "teacher_only" }); }
  const xp = require("../config/teacherSuccess/xp");
  const activities = [
    { key: "exam.publish", az: "İmtahan yaratmaq və dərc etmək", xp: xp.xpFor("exam.publish") },
    { key: "question.published", az: "Keyfiyyətli suallar hazırlamaq", xp: xp.xpFor("question.published") },
    { key: "attempt.completed", az: "Şagirdlərin imtahanlarda iştirakı", xp: xp.xpFor("attempt.completed") },
    { key: "material.uploaded", az: "Faydalı materiallar yükləmək", xp: xp.xpFor("material.uploaded") },
    { key: "active.day", az: "Müxtəlif günlərdə aktiv olmaq", xp: xp.xpFor("active.day") },
    { key: "referral.qualified", az: "Təsdiqlənmiş müəllim dəvətləri", xp: xp.xpFor("referral.qualified") },
  ];
  // The three levels + their SERVER-owned AI allowances (so the onboarding roadmap
  // never hardcodes the limits either).
  const levelsCfg = require("../config/teacherSuccess/levels");
  const { allowanceFor } = require("../config/teacherSuccess/allowances");
  const levels = levelsCfg.LEVELS.map((l) => ({ level: l, az: levelsCfg.LABELS[l].az, ai: allowanceFor(l) }));
  // Anti-fraud note is server-copy too, so the onboarding claim matches the rules.
  res.status(200).json({ activities, levels, integrity: "XP yalnız real tədris işinə verilir — süni təkrar və saxta hesablar sayılmır." });
});

// POST /api/teacher-success/admin/xp-correct — audited XP correction (signed). ADMIN.
const adminXpCorrect = asyncHandler(async (req, res) => {
  const { teacherId, amount, reason, correctionId } = req.body || {};
  if (!teacherId) { res.status(400); return res.json({ code: "teacher_required" }); }
  const target = await User.findById(teacherId).select("role").lean();
  if (!target || target.role !== "teacher") { res.status(400); return res.json({ code: "not_a_teacher" }); }
  try {
    const r = await xpSvc.adminCorrect({ teacherId, amount, reason, actor: req.user._id, correctionId });
    res.status(200).json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ code: "invalid_correction", message: String(e.message || e) });
  }
});

// GET /api/teacher-success/referral — the teacher's share code (created lazily).
const getMyReferral = asyncHandler(async (req, res) => {
  let u = await User.findById(req.user._id);
  if (!u.referralCode) {
    // Assign a unique code (retry on the rare collision against the unique index).
    for (let i = 0; i < 5 && !u.referralCode; i++) {
      const code = referralSvc.generateCode();
      try { await User.updateOne({ _id: u._id, referralCode: { $in: [null, undefined] } }, { $set: { referralCode: code } }); u = await User.findById(u._id); }
      catch (e) { if (!(e && (e.code === 11000 || e.code === 11001))) throw e; }
    }
  }
  // CR-125#8: fail honestly if a code could not be assigned — never return ref=null.
  if (!u.referralCode) { res.status(503); return res.json({ code: "referral_code_unavailable" }); }
  const [qualified, pending, held] = await Promise.all([
    TeacherReferral.countDocuments({ referrerId: u._id, state: { $in: ["qualified", "rewarded"] } }),
    TeacherReferral.countDocuments({ referrerId: u._id, state: "pending" }),
    TeacherReferral.countDocuments({ referrerId: u._id, state: "held" }),
  ]);
  // Absolute share URL (CR-125#8) from the validated FRONTEND_URL, no trailing slash.
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  const link = `${base}/register?ref=${encodeURIComponent(u.referralCode)}`;
  res.status(200).json({ code: u.referralCode, link, counts: { qualified, pending, held } });
});

// POST /api/teacher-success/upgrade-request — request the next level.
const submitUpgradeRequest = asyncHandler(async (req, res) => {
  const u = req.user;
  const currentLevel = levelOf(u);
  const targetLevel = levels.nextLevel(currentLevel);
  if (!targetLevel) { res.status(400); throw new Error("Already at the top level"); }
  const r = await upgradeSvc.submit({
    teacherId: u._id, currentLevel, targetLevel,
    classStudentSize: req.body.classStudentSize, intendedUse: req.body.intendedUse,
    requestedBenefit: req.body.requestedBenefit, reason: req.body.reason, contactPreference: req.body.contactPreference,
    evidenceSnapshot: { level: currentLevel, qualifiedReferrals: await referralSvc.qualifiedCount(u._id) },
  });
  if (!r.ok) { res.status(400); throw new Error(r.code); }
  res.status(200).json({ ok: true, idempotent: !!r.idempotent, request: r.request });
});

const getMyUpgradeRequests = asyncHandler(async (req, res) => {
  res.status(200).json({ requests: await upgradeSvc.listForTeacher(req.user._id) });
});

// ── Admin ──────────────────────────────────────────────────────────────────
const idempotencyKey = () => crypto.randomBytes(12).toString("base64url");
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GET /admin/teachers?cursor=<objectId>&limit=25&q=<name|email|level>
// Bounded admin directory. The list returns identity, level/version and the current
// AI period only; the heavier activity/mission derivation is loaded on demand by
// adminGetTeacher so opening the console never runs source aggregations for every
// teacher in the database.
const adminListTeachers = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 50);
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length > 80) { res.status(400); return res.json({ code: "query_too_long" }); }

  const filter = { role: "teacher" };
  if (req.query.cursor) {
    if (!mongoose.isValidObjectId(req.query.cursor)) { res.status(400); return res.json({ code: "bad_cursor" }); }
    filter._id = { $lt: new mongoose.Types.ObjectId(req.query.cursor) };
  }
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: rx }, { email: rx }];
    if (levels.isLevel(q.toLowerCase())) filter.$or.push({ teacherLevel: q.toLowerCase() });
  }

  const rows = await User.find(filter)
    .select("name email teacherApproval teacherLevel levelVersion levelSince createdAt")
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
  const page = rows.slice(0, limit);
  const teachers = await Promise.all(page.map(async (u) => {
    const level = levelOf(u);
    const credits = await creditSvc.snapshot(u._id, level);
    return {
      id: String(u._id),
      name: u.name || "",
      email: u.email || "",
      approval: u.teacherApproval || "none",
      level,
      levelVersion: Number(u.levelVersion || 0),
      levelSince: u.levelSince || null,
      createdAt: u.createdAt || null,
      credits,
    };
  }));
  res.status(200).json({
    teachers,
    nextCursor: rows.length > limit && page.length ? String(page[page.length - 1]._id) : null,
  });
});

// GET /admin/teacher/:id
// One server-authoritative drill-down: real activity metrics, derived missions,
// eligibility requirements, current AI period and immutable level history.
const adminGetTeacher = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404); return res.json({ code: "teacher_not_found" }); }
  const u = await User.findOne({ _id: req.params.id, role: "teacher" })
    .select("name email teacherApproval teacherLevel levelVersion levelSince createdAt")
    .lean();
  if (!u) { res.status(404); return res.json({ code: "teacher_not_found" }); }

  const level = levelOf(u);
  const metrics = await activitySvc.metricsFor(u._id);
  const [credits, missionResult, levelHistory] = await Promise.all([
    creditSvc.snapshot(u._id, level),
    missionSvc.progressFor(u._id, u, { persist: false, activity: metrics }),
    levelSvc.history(u._id),
  ]);
  const elig = eligibility.evaluate({ currentLevel: level, metrics });
  res.status(200).json({
    teacher: {
      id: String(u._id),
      name: u.name || "",
      email: u.email || "",
      approval: u.teacherApproval || "none",
      level,
      levelVersion: Number(u.levelVersion || 0),
      levelSince: u.levelSince || null,
      createdAt: u.createdAt || null,
    },
    metrics,
    missions: missionResult.missions,
    requirements: elig.requirements,
    target: elig.target,
    readyForReview: elig.readyForReview,
    credits,
    levelHistory,
  });
});

// POST /admin/promote { teacherId, fromLevel, fromVersion, reason }
const adminPromote = asyncHandler(async (req, res) => {
  const { teacherId, fromLevel, fromVersion, reason } = req.body;
  const r = await levelSvc.promote({ teacherId, actorId: req.user._id, reason, fromLevel, fromVersion: Number(fromVersion), source: "admin" });
  if (!r.ok) { res.status(r.code === "reason_required" ? 400 : 409); return res.json(r); }
  res.status(200).json(r);
});

// POST /admin/correct { teacherId, toLevel, fromLevel, fromVersion, reason }
const adminCorrect = asyncHandler(async (req, res) => {
  const { teacherId, toLevel, fromLevel, fromVersion, reason } = req.body;
  const r = await levelSvc.correct({ teacherId, actorId: req.user._id, toLevel, fromLevel, fromVersion: Number(fromVersion), reason });
  if (!r.ok) { res.status(r.code === "reason_required" ? 400 : 409); return res.json(r); }
  res.status(200).json(r);
});

// POST /admin/grant { teacherId, amount, reason, expiresAt?, grantKey } (CR-123#5)
const adminGrant = asyncHandler(async (req, res) => {
  const { teacherId, amount, reason, expiresAt, grantKey } = req.body;
  if (!grantKey) { res.status(400); return res.json({ code: "grant_key_required" }); }
  const target = await User.findById(teacherId).lean();
  if (!target || target.role !== "teacher") { res.status(400); return res.json({ code: "target_not_teacher" }); }
  try {
    const r = await creditSvc.grant(teacherId, {
      level: target.teacherLevel || "spark", amount: Number(amount), actor: req.user._id, reason,
      expiresAt: expiresAt ? new Date(expiresAt) : null, grantKey,
    });
    res.status(200).json(r);
  } catch (e) {
    const code = e && e.code ? e.code : "grant_failed";
    res.status(400).json({ code });
  }
});

// GET /admin/referrals?state=held&cursor=<iso>&limit=25 (CR-128#6)
const REFERRAL_STATES = new Set(["pending", "qualified", "rewarded", "held", "rejected", "revoked"]);
const adminListReferrals = asyncHandler(async (req, res) => {
  const base = {};
  if (req.query.state) { if (!REFERRAL_STATES.has(req.query.state)) { res.status(400); return res.json({ code: "bad_state" }); } base.state = req.query.state; }
  const { q, limit } = pageQuery(req, base);
  const referrals = await TeacherReferral.find(q).sort({ createdAt: -1 }).limit(limit).lean();
  res.status(200).json({ referrals, nextCursor: nextCursor(referrals) });
});

// POST /admin/referral/:id/review { action: reward|revoke|reject, reason }
const adminReviewReferral = asyncHandler(async (req, res) => {
  const { action, reason } = req.body;
  const id = req.params.id;
  let r;
  if (action === "reward") r = await referralSvc.reward({ referralId: id, rewardKey: req.body.rewardKey || idempotencyKey() });
  else if (action === "revoke") r = await referralSvc.revoke({ referralId: id, reason, actorId: req.user._id });
  else { res.status(400); throw new Error("bad_action"); }
  res.status(r.ok ? 200 : 400).json(r);
});

// GET /admin/upgrade-requests?status=open&cursor=<iso>&limit=25 (CR-128#6)
const UPREQ_STATUSES = new Set(["open", "approved", "denied", "info_requested"]);
const adminListUpgradeRequests = asyncHandler(async (req, res) => {
  const status = req.query.status || "open";
  if (!UPREQ_STATUSES.has(status)) { res.status(400); return res.json({ code: "bad_status" }); }
  const { q, limit } = pageQuery(req, { status });
  const requests = await TeacherUpgradeRequest.find(q).sort({ createdAt: -1 }).limit(limit).lean();
  res.status(200).json({ requests, nextCursor: nextCursor(requests) });
});

// POST /admin/upgrade-request/:id/decide { status, decisionReason }
const adminDecideUpgrade = asyncHandler(async (req, res) => {
  const r = await upgradeSvc.decide({ requestId: req.params.id, reviewer: req.user._id, status: req.body.status, decisionReason: req.body.decisionReason });
  res.status(r.ok ? 200 : 400).json(r);
});

module.exports = {
  getMyJourney, getMyActivity, markWelcomeSeen, getXpRules, getMyReferral, submitUpgradeRequest, getMyUpgradeRequests,
  adminListTeachers, adminGetTeacher, adminPromote, adminCorrect, adminGrant, adminXpCorrect, adminListReferrals, adminReviewReferral,
  adminListUpgradeRequests, adminDecideUpgrade,
};
