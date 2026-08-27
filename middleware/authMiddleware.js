const asyncHandler = require("express-async-handler");
const jwt = require("jsonwebtoken");
const User = require("../models/userModel");
const { getToken } = require("../utils/index");
const { recordDebug } = require("../utils/debugLog");
const { flags } = require("../config/featureFlags");
const metrics = require("../utils/authMetrics");

// Shared session validator (AUD-002 / CR-001). THE single place that decides
// whether a token maps to a valid current session: verifies the JWT, loads the
// current user, and enforces the SAME security decisions everywhere — token
// version revocation (`sv` vs `sessionVersion`) and suspended/deleted users. So
// protect (strict), attachUser (optional), and loginStatus can no longer drift.
// Returns { user } on success, or { error: { status, kind, message, detail } }.
// Legacy tokens with no `sv` claim are grandfathered (AUD-002 partial).
async function resolveSessionUser(token) {
  if (!token) {
    return { error: { status: 401, kind: "auth_no_token", message: "Not authorized, please login" } };
  }
  let verified;
  try {
    verified = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return { error: { status: 401, kind: "auth_invalid_token", message: "Not authorized, please login", detail: e.message } };
  }
  // Gate 2 legacy sunset. Phase 1 counts no-`exp` presentations; Phase 2
  // (REQUIRE_EXP_TOKENS) rejects them outright — closing CR-003 for legacy and
  // Phase-0 `sv`/no-`exp` tokens alike. `jwt.verify` already enforces a PRESENT
  // `exp`, so a token reaching here without `exp` is a timeless legacy/Phase-0 one.
  if (verified.exp === undefined) {
    metrics.noExpTokenSeen();
    if (flags.REQUIRE_EXP_TOKENS) {
      return { error: { status: 401, kind: "auth_exp_required", message: "Session expired, please login again", detail: "no_exp" } };
    }
  }
  // AUD-002 (CR-011): enforce token TYPE. Legacy tokens carry no `type` and are
  // grandfathered; new access + rollback JWTs are accepted on protected routes;
  // anything else (e.g. a stray non-access type) is rejected so only intended
  // credentials authenticate a route.
  if (verified.type !== undefined && verified.type !== "access" && verified.type !== "rollback") {
    return { error: { status: 401, kind: "auth_wrong_token_type", message: "Not authorized, please login", detail: String(verified.type) } };
  }
  // CR-011: EMERGENCY_REAUTH is an account-wide kill switch for the NEW model —
  // it must reject new-model credentials on EVERY protected route, not only on
  // /refresh. Access tokens die on their own ≤15-min exp, but a 7-day rollback
  // JWT would otherwise survive emergency mode; reject both.
  if (flags.EMERGENCY_REAUTH && (verified.type === "access" || verified.type === "rollback")) {
    return { error: { status: 401, kind: "auth_emergency_reauth", message: "Session expired, please login again", detail: String(verified.type) } };
  }
  const user = await User.findById(verified.id).select("-password");
  if (!user) {
    return { error: { status: 404, kind: "auth_user_not_found", message: "User not found", detail: String(verified.id) } };
  }
  if (verified.sv !== undefined && verified.sv !== (user.sessionVersion || 0)) {
    return { error: { status: 401, kind: "auth_session_revoked", message: "Session expired, please login again", detail: String(verified.id) } };
  }
  if (user.role === "suspended") {
    return { error: { status: 400, kind: "auth_suspended", message: "User suspended, please contact support" } };
  }
  return { user };
}

const protect = asyncHandler(async (req, res, next) => {
  // Diagnostic context (stored in DebugLog on failure) so a recurring login
  // problem shows the EXACT reason: did a real device send no token at all
  // (header+cookie both missing = the cross-domain issue), or an invalid one?
  const ctx = {
    path: req.originalUrl,
    method: req.method,
    ua: req.headers["user-agent"],
    ip: req.ip,
    hasAuthHeader: !!req.headers.authorization,
    hasCookie: !!(req.cookies && req.cookies.token),
  };
  const isBrowser = /Mozilla/i.test(ctx.ua || ""); // skip curl/bot noise
  try {
    // Authorization: Bearer header first (reliable cross-domain), cookie fallback.
    const { user, error } = await resolveSessionUser(getToken(req));
    if (error) {
      // Preserve prior diagnostics: no-token noise only for real browsers;
      // suspended is a business state, not a "recurring login problem".
      if (error.kind === "auth_no_token") {
        if (isBrowser) recordDebug({ kind: "auth_no_token", ...ctx });
      } else if (error.kind !== "auth_suspended") {
        recordDebug({ kind: error.kind, message: error.detail, ...ctx });
      }
      res.status(error.status);
      throw new Error(error.message);
    }

    // Track activity for the admin user list. Throttled to once every 10
    // minutes per user and deliberately NOT awaited, so an authenticated
    // request never pays for an extra write (this runs on every API call).
    const TEN_MIN = 10 * 60 * 1000;
    if (!user.lastActiveAt || Date.now() - new Date(user.lastActiveAt).getTime() > TEN_MIN) {
      // Same throttled write also refreshes the user's current IP for the admin
      // directory (and visitor↔user matching). req.ip is the real client IP
      // (trust proxy is on behind Caddy).
      const patch = { lastActiveAt: new Date() };
      if (req.ip) patch.lastIp = req.ip;
      User.updateOne({ _id: user._id }, { $set: patch }).catch(() => {});
    }

    req.user = user;
    next();
  } catch (error) {
    if (res.statusCode === 200) {
      res.status(401);
      throw new Error("Not authorized, please login");
    }
    throw error;
  }
});

const adminOnly = asyncHandler(async (req, res, next) => {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    res.status(401);
    throw new Error("Not authorized as an admin");
  }
});

// AUD-005: the granted teacher CAPABILITY is derived on the SERVER from the
// user's persisted approval state — never from the request body or the bare
// `role` string. Requesting `role:"teacher"` at sign-up no longer grants
// anything: a teacher must be `approved` (admin action) or `approved_legacy`
// (grandfathered, pending review). A `pending` teacher is authenticated but
// has NO privileged capability. Admins always have it.
const APPROVED_TEACHER_STATES = new Set(["approved", "approved_legacy"]);
function hasTeacherCapability(user) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return user.role === "teacher" && APPROVED_TEACHER_STATES.has(user.teacherApproval);
}

// Parent area gate: a parent-role account (or an admin, for support). Mirrors
// adminOnly — role is a bare string, so this is the whole check.
const parentOnly = asyncHandler(async (req, res, next) => {
  if (req.user && (req.user.role === "parent" || req.user.role === "admin")) {
    next();
  } else {
    res.status(401);
    throw new Error("Not authorized as a parent");
  }
});

const teacherOnly = asyncHandler(async (req, res, next) => {
  if (hasTeacherCapability(req.user)) {
    next();
  } else if (req.user && req.user.role === "teacher") {
    // Authenticated as a teacher TYPE but the capability is not yet granted
    // (pending/none). Distinct message; still a hard deny.
    res.status(403);
    throw new Error("Teacher account is pending approval");
  } else {
    res.status(401);
    throw new Error("Not authorized as teacher or admin");
  }
});

const verifiedOnly = asyncHandler(async (req, res, next) => {
  if (req.user && req.user.isVerified) {
    next();
  } else {
    res.status(401);
    throw new Error("Not authorized, account not verified!");
  }
});

// Server-side onboarding gate. A signed-up account created AFTER the gate shipped
// must have a real phone (+ a grade for students) before it can DO anything that
// matters — join a class or start an exam. The client has a matching
// ProfileCompletionGate, but that is only UX; this is the enforcement, so a Google
// signup that skipped the form (phone defaults to "+994", no grade) can NEVER act.
// Pre-gate accounts are grandfathered (createdAt missing/older ⇒ allowed), so
// long-time users are never locked out. Must match the frontend GATE_SINCE.
const ONBOARD_GATE_SINCE = 1785670907000; // 2026-08-02 (Azerbaijan time)
const hasValidPhone = (p) => String(p || "").replace(/\D/g, "").length >= 9;
function profileIncomplete(user) {
  if (!user) return false;
  const created = user.createdAt ? new Date(user.createdAt).getTime() : 0;
  if (!created || created < ONBOARD_GATE_SINCE) return false; // grandfathered
  const noPhone = !hasValidPhone(user.phone);
  const noGrade = user.role === "student" && !String(user.grade || "").trim();
  return noPhone || noGrade;
}
const requireCompleteProfile = asyncHandler(async (req, res, next) => {
  if (profileIncomplete(req.user)) {
    res.status(403);
    return res.json({
      reason: "incomplete_profile",
      message:
        req.user.role === "student"
          ? "Davam etmək üçün profilini tamamla (telefon və sinif)."
          : "Davam etmək üçün telefon nömrəni əlavə et.",
    });
  }
  next();
});

// Attaches req.user when a valid token is present and carries on regardless.
//
// For routes that serve BOTH signed-in and anonymous callers — a public share
// link where the teacher may or may not have required sign-in. Never rejects:
// the route itself decides what an anonymous caller is allowed to see, so an
// expired token degrades to "anonymous" instead of a 401 on a public page.
const attachUser = asyncHandler(async (req, res, next) => {
  // CR-001: same validator as protect. A revoked (sv-mismatched) or suspended
  // token now degrades to anonymous here too, instead of authenticating on
  // share routes.
  const { user } = await resolveSessionUser(getToken(req));
  if (user) req.user = user;
  next();
});

module.exports = { protect, adminOnly, parentOnly, teacherOnly, verifiedOnly, requireCompleteProfile, attachUser, resolveSessionUser, hasTeacherCapability };
