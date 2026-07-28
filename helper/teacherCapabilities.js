/*
 * Teacher Success Journey — capability decomposition (ADR §4, the security spine).
 *
 * The broad teacher permission is decomposed into NAMED server-derived
 * capabilities. A new teacher is auto-granted the SAFE OWN-SCOPE subset so they
 * receive value immediately (ADR §3); risky capabilities stay behind
 * verification/admin approval; admin actions stay admin-only.
 *
 * HARD INVARIANTS:
 *  - Capability is derived ONLY from role + teacherApproval (persisted server
 *    state) — never from the request body, never from the bare role string.
 *  - Growth level (spark/momentum/impact) is NEVER consulted here (D10). This
 *    module must not import teacherLevel.
 *  - Object ownership is enforced separately in the controllers (ownsOrAdmin).
 *    A capability grants the RIGHT KIND of action; ownership decides WHICH
 *    objects. Both are required for an own-scope mutation.
 *  - Flag-off preserves today's behavior exactly: a pending teacher gets no
 *    capability (same as the current teacherOnly 403); an approved teacher and
 *    an admin are unchanged. The ONLY thing the flag adds is auto-granting
 *    own-scope to a not-yet-approved teacher.
 */
const asyncHandler = require("express-async-handler");
const { isJourneyEnabled } = require("../config/teacherSuccess/flag");

// Mirror of the middleware's approved set (kept identical to authMiddleware).
const APPROVED_TEACHER_STATES = new Set(["approved", "approved_legacy"]);

// Safe own-scope capabilities — auto-granted to a new (Spark) teacher when the
// Journey is enabled, and always held by an approved teacher. Ownership is still
// enforced in the controller for every one of these.
const OWN_SCOPE = new Set([
  "class:manage:own",
  "exam:create:own",
  "exam:manage:own",
  "exam:publish:own",
  "results:view:own",
  // CR-124: every teacher LEVEL may use AI within its own monthly allowance
  // (metered by the credit engine + provider rate limits). Ownership is still
  // enforced in the controllers; the level only sizes the allowance, never authz.
  "ai:use:own",
]);

// Risky capabilities a teacher only holds once APPROVED (verification/admin).
// Unchanged from today's approved-teacher behavior.
const GATED_TEACHER = new Set([
  "invite:bulk",
  "messaging:bulk",
  "export:students:bulk",
  "ops:high-volume",
]);

// Admin-only capabilities. Never granted to a teacher by any level or activity.
const ADMIN = new Set([
  "data:access:other-owner",
  "mutation:global",
  "mutation:public",
  "admin",
]);

const ALL = new Set([...OWN_SCOPE, ...GATED_TEACHER, ...ADMIN]);
const isCapability = (c) => ALL.has(c);

/*
 * The set of capabilities a user actually holds. journeyEnabled defaults to the
 * live flag; callers may inject it for tests. NEVER reads teacherLevel.
 */
function capabilitiesFor(user, { journeyEnabled = isJourneyEnabled() } = {}) {
  const caps = new Set();
  if (!user) return caps;
  if (user.role === "admin") {
    for (const c of ALL) caps.add(c);
    return caps;
  }
  if (user.role === "teacher") {
    const approved = APPROVED_TEACHER_STATES.has(user.teacherApproval);
    if (approved) {
      for (const c of OWN_SCOPE) caps.add(c);
      for (const c of GATED_TEACHER) caps.add(c);
    } else if (journeyEnabled) {
      // Immediate value for a new Spark teacher: safe own-scope only.
      for (const c of OWN_SCOPE) caps.add(c);
    }
  }
  return caps;
}

const hasCapability = (user, cap, opts) => capabilitiesFor(user, opts).has(cap);

/*
 * Express middleware factory. Requires `cap`; mirrors teacherOnly's 403-vs-401
 * distinction so a teacher lacking the capability gets a clear 403 while a
 * non-teacher/anonymous gets 401. Reads the live flag per request.
 */
function requireCapability(cap) {
  if (!isCapability(cap)) throw new Error(`requireCapability: unknown capability "${cap}"`);
  const mw = asyncHandler(async (req, res, next) => {
    if (hasCapability(req.user, cap, { journeyEnabled: isJourneyEnabled() })) return next();
    if (req.user && req.user.role === "teacher") {
      res.status(403);
      throw new Error("Insufficient teacher capability");
    }
    res.status(401);
    throw new Error("Not authorized as teacher or admin");
  });
  // Tag the returned middleware so router-registration tests can detect the exact
  // capability wired onto a shipping route (each call returns a fresh function).
  mw._requiredCapability = cap;
  return mw;
}

module.exports = {
  OWN_SCOPE,
  GATED_TEACHER,
  ADMIN,
  ALL,
  APPROVED_TEACHER_STATES,
  isCapability,
  capabilitiesFor,
  hasCapability,
  requireCapability,
};
