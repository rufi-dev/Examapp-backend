/*
 * The card wall (owner's decision, 2026-10-26): a teacher works in Examopia only
 * on a paid plan — a card subscription (the 7-day trial counts) or a plan an admin
 * set by hand. Everyone else is asked for a card first. Students, parents and
 * admins are never walled, and nothing is deleted behind the wall.
 *
 * The free start (2026-10-27) comes before it: a teacher who never paid first
 * gets STARTER.days on the free tier's limits with ONE exam (config/plans.js).
 * Reaching past a limit shows the wall while the days still run; once they end,
 * the wall stays.
 *
 * TEACHER_PAYWALL=on turns it on; anything else turns it off at once (the kill
 * switch if it ever blocks someone it should not).
 */
const User = require("../models/userModel");
const { normalizePlan, planDef, STARTER } = require("../config/plans");

const DAY = 24 * 60 * 60 * 1000;

const paywallOn = () => String(process.env.TEACHER_PAYWALL || "").trim().toLowerCase() === "on";

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
  if (!user || user.role !== "teacher") return false;
  if (user.starterPending) return true;
  return !!user.starterUntil && new Date(user.starterUntil).getTime() > now;
}

function needsSubscription(user) {
  if (!paywallOn() || !user || user.role !== "teacher") return false;
  return !hasPaidPlan(user) && !inStarter(user);
}

// What a teacher's free start sets: when it ends, and its one exam.
function starterFields(now = Date.now()) {
  return { starterUntil: new Date(now + STARTER.days * DAY), examCreatesLeft: STARTER.exams };
}

/*
 * A teacher from before the free start who never made an exam gets theirs on
 * their next visit, so the days count from when they come back rather than from
 * the day it was switched on. With it come the welcome credits a new teacher
 * gets, so their one exam can be written by the AI.
 */
async function beginPendingStarter(user, now = Date.now()) {
  if (!user || !user.starterPending) return user;
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

// What a walled teacher can still reach on the API: subscribing itself.
const OPEN_PATHS = [/^\/api\/billing(\/|\?|$)/];

function paywallBlocks(req) {
  if (!needsSubscription(req.user)) return false;
  const url = String(req.originalUrl || req.url || "");
  return !OPEN_PATHS.some((re) => re.test(url));
}

const PAYWALL_MESSAGE =
  "Examopia-dan istifadə etmək üçün abunə ol: «Planım» səhifəsində 7 günlük pulsuz sınağa başla və ya kartla ödə.";

module.exports = {
  paywallOn,
  hasPaidPlan,
  inStarter,
  needsSubscription,
  starterFields,
  beginPendingStarter,
  paywallBlocks,
  PAYWALL_MESSAGE,
};
