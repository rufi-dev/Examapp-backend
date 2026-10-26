/*
 * The card wall (owner's decision, 2026-10-26): a teacher works in Examopia only
 * on a paid plan — a card subscription (the 7-day trial counts) or a plan an admin
 * set by hand. Everyone else is asked for a card first. Students, parents and
 * admins are never walled, and nothing is deleted behind the wall.
 *
 * TEACHER_PAYWALL=on turns it on; anything else turns it off at once (the kill
 * switch if it ever blocks someone it should not).
 */
const { normalizePlan } = require("../config/plans");

const paywallOn = () => String(process.env.TEACHER_PAYWALL || "").trim().toLowerCase() === "on";

// The same answer planLimits.effectivePlan gives, without requiring it here
// (this file sits under the auth middleware).
function hasPaidPlan(user, now = Date.now()) {
  if (normalizePlan(user?.plan) === "free") return false;
  const until = user?.planExpiresAt ? new Date(user.planExpiresAt).getTime() : null;
  return until === null || until > now;
}

function needsSubscription(user) {
  if (!paywallOn() || !user || user.role !== "teacher") return false;
  return !hasPaidPlan(user);
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

module.exports = { paywallOn, hasPaidPlan, needsSubscription, paywallBlocks, PAYWALL_MESSAGE };
