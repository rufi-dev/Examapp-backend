/*
 * The card wall (owner's decision, 2026-10-26): a teacher works in Examopia only
 * on a paid plan — a card subscription (the 7-day trial counts) or a plan an admin
 * set by hand. Students, parents and admins are never walled, and nothing is
 * deleted behind the wall.
 *
 * Looking around is free (owner, 2026-10-28): a teacher without a plan can open
 * every page and read what is there. The card is asked for the moment they DO
 * something, which on the API is any write, plus the few reads that are doing
 * something themselves. Their students cannot start an exam until they have a
 * plan (quizController.startAttempt).
 *
 * The free start (config/plans.js STARTER) is off; when it is on, it comes before
 * the wall.
 *
 * TEACHER_PAYWALL=on turns it on; anything else turns it off at once (the kill
 * switch if it ever blocks someone it should not).
 */
const User = require("../models/userModel");
const { normalizePlan, planDef, STARTER } = require("../config/plans");

const DAY = 24 * 60 * 60 * 1000;

const paywallOn = () => String(process.env.TEACHER_PAYWALL || "").trim().toLowerCase() === "on";
const starterOn = () => STARTER.days > 0;

// The same answer planLimits.effectivePlan gives, without requiring it here
// (this file sits under the auth middleware).
function hasPaidPlan(user, now = Date.now()) {
  if (normalizePlan(user?.plan) === "free") return false;
  const until = user?.planExpiresAt ? new Date(user.planExpiresAt).getTime() : null;
  return until === null || until > now;
}

// The free start is running. A pending one counts: it begins on this very
// request (beginPendingStarter), so the teacher is never walled in between.
function inStarter(user, now = Date.now()) {
  if (!starterOn() || !user || user.role !== "teacher") return false;
  if (user.starterPending) return true;
  return !!user.starterUntil && new Date(user.starterUntil).getTime() > now;
}

function needsSubscription(user) {
  if (!paywallOn() || !user || user.role !== "teacher") return false;
  return !hasPaidPlan(user) && !inStarter(user);
}

// What a teacher's free start sets at sign-up: when it ends, and its one exam.
function starterFields(now = Date.now()) {
  if (!starterOn()) return {};
  return { starterUntil: new Date(now + STARTER.days * DAY), examCreatesLeft: STARTER.exams };
}

/*
 * A teacher from before the free start who never made an exam gets theirs on
 * their next visit, so the days count from when they come back rather than from
 * the day it was switched on. With it come the welcome credits a new teacher
 * gets, so their one exam can be written by the AI.
 */
async function beginPendingStarter(user, now = Date.now()) {
  if (!user || !user.starterPending || !starterOn()) return user;
  const fields = starterFields(now);
  const aiCredits = Math.max(Number(user.aiCredits) || 0, planDef("free").credits?.welcome || 0);
  const res = await User.updateOne(
    { _id: user._id, starterPending: true },
    { $set: { ...fields, aiCredits }, $unset: { starterPending: "" } }
  );
  if (res.modifiedCount === 1) {
    Object.assign(user, fields, { aiCredits });
  } else {
    // A parallel request began it first: take what it wrote.
    const fresh = await User.findById(user._id).select("starterUntil examCreatesLeft aiCredits").lean();
    if (fresh) Object.assign(user, { starterUntil: fresh.starterUntil, examCreatesLeft: fresh.examCreatesLeft, aiCredits: fresh.aiCredits });
  }
  user.starterPending = undefined;
  return user;
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

// Writes that do nothing in Examopia itself: subscribing, the teacher's own
// account and sign-in, the support chat (confirming one of its cards is checked
// where it runs, chatController.decideAction), unlinking WhatsApp, and the calls
// a page makes in the background while it is only being looked at.
const OPEN_WRITES = [
  /^\/api\/billing(\/|\?|$)/,
  /^\/api\/users\/(logoutAll|app-installed|push\/subscribe|push\/unsubscribe|updateUser|onboarding|sendVerificationEmail|changePassword)(\/|\?|$)/,
  /^\/api\/chat\//,
  /^\/api\/rec\//,
  /^\/api\/updates\/seen(\?|$)/,
  /^\/api\/teacher-success\/welcome-seen(\?|$)/,
  /^\/api\/assignments\/[^/]+\/submissions\/[^/]+\/seen(\?|$)/,
  /^\/api\/whatsapp\/teacher\/logout(\?|$)/,
];

// Reads that are doing something: opening a board (its list stays open), and
// asking for a WhatsApp QR, which starts a browser for the teacher's number.
const WALLED_READS = [
  /^\/api\/boards\/(?!class\/|homework\/)[^/?]+(\/live)?\/?(\?|$)/,
  /^\/api\/whatsapp\/teacher\/qr(\?|$)/,
];

function paywallBlocks(req) {
  if (!needsSubscription(req.user)) return false;
  const url = String(req.originalUrl || req.url || "");
  if (READS.has(String(req.method).toUpperCase())) return WALLED_READS.some((re) => re.test(url));
  return !OPEN_WRITES.some((re) => re.test(url));
}

const PAYWALL_MESSAGE =
  "Bunu etmək üçün aktiv plan lazımdır: «Planım» səhifəsində kartını əlavə et (ilk dəfədirsə, 7 gün pulsuzdur).";

// What a student sees when their teacher has no plan.
const OWNER_WALLED_MESSAGE =
  "Bu imtahan hələ başlaya bilməz: müəllimin Examopia planı aktiv deyil. Müəlliminə bildir.";

module.exports = {
  paywallOn,
  starterOn,
  hasPaidPlan,
  inStarter,
  needsSubscription,
  starterFields,
  beginPendingStarter,
  paywallBlocks,
  PAYWALL_MESSAGE,
  OWNER_WALLED_MESSAGE,
};
