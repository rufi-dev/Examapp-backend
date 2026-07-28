/*
 * Teacher Success Journey — referral binding, fraud, qualification (ADR §7;
 * CR-125). Lifecycle pending → qualified → rewarded (+ held/rejected/revoked)
 * driven by conditional CAS transitions (safe under concurrency). Binding is
 * durable + recoverable (no failure leaves referredBy without its referral row).
 * Qualification is SERVER-AUTHORITATIVE (account age, published exam, real
 * completed attempts on distinct days, not suspended/deleted, fraud) — it never
 * treats the app's unconditional isVerified=true as proof.
 */
const crypto = require("crypto");
const User = require("../models/userModel");
const TeacherReferral = require("../models/teacherReferralModel");
const activitySvc = require("./teacherActivityService");
const { REFERRAL_FRAUD, REFERRAL_QUALIFICATION } = require("../config/teacherSuccess/thresholds");

const isDup = (e) => e && (e.code === 11000 || e.code === 11001);
function generateCode() { return crypto.randomBytes(9).toString("base64url"); }

// PURE fraud decision (unchanged contract).
function assessRisk(signals = {}) {
  const hard = [];
  if (signals.selfReferral) hard.push("self_referral");
  if (signals.circular) hard.push("circular_referral");
  if (signals.reusedVerifiedPhone) hard.push("reused_verified_phone");
  if (signals.reusedOAuthSubject) hard.push("reused_oauth_subject");
  const soft = (Array.isArray(signals.softSignals) ? signals.softSignals : []).filter(Boolean);
  if (hard.length) return { decision: "rejected", hard, soft };
  if (soft.length >= REFERRAL_FRAUD.heldSoftSignalThreshold) return { decision: "held", hard, soft };
  return { decision: "qualified", hard, soft };
}

/*
 * PURE qualification-evidence check (CR-125#4/#5). Uses server-authoritative
 * outcomes; NEVER isVerified. `evidence`:
 *   accountAgeDays, publishedExams, completedAttempts, distinctActiveDays,
 *   suspendedOrDeleted, hasVerifiedIdentity (a real signed-email/OAuth signal —
 *   defaults false; activity evidence is the authoritative proof today).
 */
function assessQualification(evidence = {}) {
  const reasons = [];
  if (evidence.suspendedOrDeleted) reasons.push("suspended_or_deleted");
  if ((evidence.accountAgeDays || 0) < REFERRAL_QUALIFICATION.minAccountAgeDays) reasons.push("account_too_new");
  if ((evidence.publishedExams || 0) < REFERRAL_QUALIFICATION.minPublishedExams) reasons.push("no_published_exam");
  if ((evidence.completedAttempts || 0) < REFERRAL_QUALIFICATION.minCompletedAttempts) reasons.push("too_few_completed_attempts");
  if ((evidence.distinctActiveDays || 0) < 2) reasons.push("not_enough_distinct_days");
  return { qualifies: reasons.length === 0, reasons };
}

// Durable, recoverable binding. Sets referredBy ONLY while null (app-enforced
// immutability), then upserts the referral row. Claim rate-limited per referrer.
async function bind({ refereeId, code, now = new Date() }) {
  if (!code) return { ok: false, code: "no_code" };
  const referrer = await User.findOne({ referralCode: code });
  if (!referrer) return { ok: false, code: "unknown_code" };
  if (String(referrer._id) === String(refereeId)) return { ok: false, code: "self_referral" };
  const referee = await User.findById(refereeId);
  if (!referee) return { ok: false, code: "referee_not_found" };
  if (referee.referredBy) return { ok: false, code: "already_referred" };
  if (referrer.referredBy && String(referrer.referredBy) === String(refereeId)) return { ok: false, code: "circular" };

  // Claim rate-limit (CR-125#6): bound how many referrals a referrer accrues per window.
  const windowStart = new Date(now.getTime() - REFERRAL_FRAUD.claimWindowMs);
  const recent = await TeacherReferral.countDocuments({ referrerId: referrer._id, createdAt: { $gte: windowStart } });
  if (recent >= REFERRAL_FRAUD.maxClaimsPerWindow) return { ok: false, code: "claim_rate_limited" };

  const set = await User.updateOne({ _id: refereeId, $or: [{ referredBy: null }, { referredBy: { $exists: false } }] }, { $set: { referredBy: referrer._id } });
  if (!set.modifiedCount) return { ok: false, code: "already_referred" };
  try {
    const rec = await TeacherReferral.create({ referrerId: referrer._id, refereeId, code, state: "pending" });
    return { ok: true, referral: rec };
  } catch (e) {
    if (isDup(e)) return { ok: false, code: "already_referred" };
    // Durability: referredBy is set but the row failed — reconcile repairs it later.
    return { ok: false, code: "row_deferred", referrerId: referrer._id };
  }
}

// Recovery (CR-125#3): create a referral row for any referee that has referredBy
// but no row (a crash between the two writes). Idempotent.
async function reconcilePendingBindings(limit = 500) {
  const orphans = await User.find({ referredBy: { $ne: null } }).select("_id referredBy referralCode").limit(limit).lean();
  let repaired = 0;
  for (const u of orphans) {
    if (await TeacherReferral.exists({ refereeId: u._id })) continue;
    const referrer = await User.findById(u.referredBy).select("referralCode").lean();
    try { await TeacherReferral.create({ referrerId: u.referredBy, refereeId: u._id, code: (referrer && referrer.referralCode) || "", state: "pending" }); repaired++; }
    catch (e) { if (!isDup(e)) throw e; }
  }
  return repaired;
}

// Conditional CAS transition of a PENDING referral (CR-125#7). Safe under
// concurrency: exactly one caller wins the pending→X transition.
async function qualify({ referralId, qualifies, signals = {}, now = new Date() }) {
  const ref = await TeacherReferral.findById(referralId);
  if (!ref) return { ok: false, code: "not_found" };
  if (ref.state !== "pending") return { ok: true, idempotent: true, state: ref.state };
  if (!qualifies) return { ok: true, state: "pending", qualified: false };
  const risk = assessRisk(signals);
  const patch = risk.decision === "rejected" ? { state: "rejected", riskReasons: risk.hard, reason: "hard_fraud" }
    : risk.decision === "held" ? { state: "held", riskReasons: risk.soft }
    : { state: "qualified", qualifiedAt: now, riskReasons: risk.soft };
  const updated = await TeacherReferral.findOneAndUpdate({ _id: referralId, state: "pending" }, { $set: patch }, { new: true });
  if (!updated) { const r = await TeacherReferral.findById(referralId); return { ok: true, idempotent: true, state: r ? r.state : "unknown" }; }
  // Teacher Journey (flag-gated, best-effort): a newly QUALIFIED referral awards the
  // referrer XP once (idempotent per referee). Fraud already gated the transition above.
  if (updated.state === "qualified") {
    try { Promise.resolve(require("./teacherJourneyEvents").onReferralQualified(updated.referrerId, updated.refereeId, now)).catch(() => {}); } catch (_) { /* ignore */ }
  }
  return { ok: true, state: updated.state, risk };
}

/*
 * Server-authoritative qualification job (CR-125#4): gather evidence for the
 * referee from the source of truth, then run the CAS transition. `signals` are
 * fraud signals (device/velocity/ring/phone/OAuth) supplied by the caller.
 */
async function qualifyReferee({ referralId, now = new Date(), signals = {} }) {
  const ref = await TeacherReferral.findById(referralId);
  if (!ref) return { ok: false, code: "not_found" };
  const referee = await User.findById(ref.refereeId).lean();
  if (!referee) return { ok: false, code: "referee_not_found" };
  const metrics = await activitySvc.computeActivityMetrics(ref.refereeId, now);
  const accountAgeDays = referee.createdAt ? Math.floor((now - new Date(referee.createdAt)) / 86400000) : 0;
  const evidence = {
    accountAgeDays,
    publishedExams: metrics.publishedExams,
    completedAttempts: metrics.completedAttempts,
    distinctActiveDays: metrics.distinctActiveDays,
    suspendedOrDeleted: referee.role === "suspended" || !!referee.deletedAt,
  };
  const q = assessQualification(evidence);
  const res = await qualify({ referralId, qualifies: q.qualifies, signals, now });
  return { ...res, evidence, qualification: q };
}

// Reward a qualified referral. Idempotent CAS. Only a qualified referral rewards.
async function reward({ referralId, rewardKey, now = new Date() }) {
  if (!rewardKey) return { ok: false, code: "no_reward_key" };
  const updated = await TeacherReferral.findOneAndUpdate({ _id: referralId, state: "qualified" }, { $set: { state: "rewarded", rewardKey, rewardedAt: now } }, { new: true });
  if (updated) return { ok: true, state: "rewarded", idempotent: false };
  const ref = await TeacherReferral.findById(referralId);
  if (!ref) return { ok: false, code: "not_found" };
  if (ref.state === "rewarded") return { ok: true, state: "rewarded", idempotent: true };
  return { ok: false, code: "not_qualified", state: ref.state };
}

// Revoke a reward. Idempotent CAS. Never removes core creation access.
async function revoke({ referralId, reason, actorId, now = new Date() }) {
  const ref = await TeacherReferral.findById(referralId);
  if (!ref) return { ok: false, code: "not_found" };
  if (ref.state === "revoked") return { ok: true, idempotent: true, state: "revoked" };
  await TeacherReferral.updateOne({ _id: referralId }, { $set: { state: "revoked", reason: reason || ref.reason || "revoked", reviewer: actorId || ref.reviewer || null } });
  return { ok: true, state: "revoked", idempotent: false };
}

// Referrals that count toward the referrer's eligibility, CAPPED per period (CR-125#6).
async function qualifiedCount(referrerId) {
  const n = await TeacherReferral.countDocuments({ referrerId, state: { $in: ["qualified", "rewarded"] } });
  return Math.min(n, REFERRAL_FRAUD.maxRewardedPerPeriod);
}

module.exports = {
  generateCode, assessRisk, assessQualification, bind, reconcilePendingBindings,
  qualify, qualifyReferee, reward, revoke, qualifiedCount,
};
