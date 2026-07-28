const asyncHandler = require("express-async-handler");
const jwt = require("jsonwebtoken");
const { flags, params } = require("../config/featureFlags");
const svc = require("../services/sessionService");
const { getToken, generateToken } = require("../utils/index");
const { generateRollbackToken } = require("../utils/refreshToken");
const metrics = require("../utils/authMetrics");

// AUD-002 HTTP layer (docs/adr/AUD-002-session-lifecycle.md §8). Thin wrappers
// over the tested sessionService. Everything is inert while SESSION_MODEL_ENABLED
// is off (Rule 5). Cookie names (Gate 0 final tuple): `__Host-` REQUIRES Path=/,
// so it cannot name the narrow-path refresh cookie — the refresh cookie uses
// `__Secure-` (host-only via omitted Domain + narrow Path); the root-path
// rollback cookie uses `__Host-` (host-only guaranteed, Path=/).
const REFRESH_COOKIE = "__Secure-exq_rt"; // Path=/api/users/refresh
const ROLLBACK_COOKIE = "__Host-exq_sess"; // Path=/
const LEGACY_COOKIE = "token";
const REFRESH_PATH = "/api/users/refresh";

function isPrivateLanIpv4(host) {
  const parts = String(host || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// The interactive Journey preview may be opened from a phone over plain HTTP.
// Browsers correctly refuse the production Secure cookie on that private-LAN
// origin, which previously meant every reload looked logged out. The preview
// cookie relaxation is deliberately difficult to activate accidentally:
// development + explicit preview marker + Journey flag + a loopback,
// recognizably-throwaway Mongo database + an HTTP loopback/private-LAN frontend
// must ALL be true. Any missing/malformed value falls back to production policy.
function isSafeHttpJourneyPreview(env = process.env) {
  if (
    env.NODE_ENV !== "development"
    || env.EXQ_JOURNEY_PREVIEW_HTTP !== "1"
    || env.TEACHER_SUCCESS_JOURNEY_ENABLED !== "1"
  ) return false;

  try {
    const mongo = new URL(String(env.MONGO_URI || "").replace(/^mongodb(?:\+srv)?:\/\//i, "http://"));
    const dbName = decodeURIComponent(mongo.pathname.replace(/^\/+/, "").split("/")[0] || "");
    const mongoLoopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(mongo.hostname);
    const throwaway = /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral|preview)($|[_-])/i.test(dbName);
    const frontend = new URL(String(env.FRONTEND_URL || ""));
    const frontendHost = frontend.hostname;
    const localFrontend = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(frontendHost)
      || isPrivateLanIpv4(frontendHost);
    return mongoLoopback && throwaway && frontend.protocol === "http:" && localFrontend;
  } catch {
    return false;
  }
}

function legacyCookiePolicy(env = process.env) {
  return isSafeHttpJourneyPreview(env)
    ? { sameSite: "lax", secure: false }
    : { sameSite: "none", secure: true };
}

// CR-014: cap the browser cookie at the ACTUAL remaining server-valid lifetime
// (min of sliding + absolute), never a flat sliding window that could outlive it.
function setRefreshCookie(res, refreshToken, refreshExpiresAt, absoluteExpiresAt) {
  const deadline = Math.min(new Date(refreshExpiresAt).getTime(), new Date(absoluteExpiresAt).getTime());
  const maxAge = Math.max(0, deadline - Date.now());
  res.cookie(REFRESH_COOKIE, refreshToken, {
    path: REFRESH_PATH, httpOnly: true, secure: true, sameSite: "lax", maxAge,
  });
}

function clearLegacyCookie(res) {
  res.clearCookie(LEGACY_COOKIE, { path: "/" });
}

// Clear EVERY credential cookie (ADR-015) so no stale cross-mode cookie lingers.
function clearAuthCookies(res) {
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
  res.clearCookie(ROLLBACK_COOKIE, { path: "/" });
  clearLegacyCookie(res);
}

// Flag-gate middleware placed BEFORE auth middleware (CR-011) so a route that
// must be invisible while the flag is off returns 404, not 401.
const requireSessionFlag = (req, res, next) => {
  if (!flags.SESSION_MODEL_ENABLED) { res.status(404); return next(new Error("Not found")); }
  next();
};

// New-model issuance: create a Session, set the (capped) refresh cookie, drop
// the legacy cookie, and return the short-lived access token.
async function issueSessionForUser(req, res, user) {
  const { accessToken, refreshToken, refreshExpiresAt, absoluteExpiresAt } = await svc.createSession(user, {
    userAgent: req.headers["user-agent"], ip: req.ip,
  });
  clearAuthCookies(res); // clear any stale credential first
  setRefreshCookie(res, refreshToken, refreshExpiresAt, absoluteExpiresAt);
  return accessToken;
}

// Rollback-mode issuance (master on, ISSUE_NEW_MODEL off): a bounded-exp,
// reload-safe HttpOnly session cookie — NEVER the legacy no-exp token (CR-011).
//
// CR-011: the rollback JWT is **cookie-only**. It is NOT returned in the JSON
// body (that would defeat the HttpOnly transport and, with the current
// localStorage frontend, leak a 7-day credential to XSS). `maxAge` is derived
// from the token's SIGNED `exp` (second-granularity), never a flat ms TTL, so
// `Max-Age <= exp` holds exactly.
function issueRollbackForUser(req, res, user) {
  const sv = user.sessionVersion || 0;
  const token = generateRollbackToken(user._id, sv, params.ROLLBACK_COOKIE_TTL_MS);
  const decoded = jwt.decode(token); // { exp } in seconds
  const maxAge = Math.max(0, decoded.exp * 1000 - Date.now());
  clearAuthCookies(res);
  res.cookie(ROLLBACK_COOKIE, token, {
    path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge,
  });
  return null; // cookie-only: nothing sensitive in the JSON body
}

// The single entry point login/register paths call while the master flag is on.
// Returns the token to place in the JSON body (null in rollback mode — the
// credential is cookie-only). Legacy path is the caller's responsibility when
// the master flag is off.
async function issueAuthForUser(req, res, user) {
  if (flags.ISSUE_NEW_MODEL) return await issueSessionForUser(req, res, user);
  return issueRollbackForUser(req, res, user); // master on but issuance rolled back
}

// THE one helper EVERY issuance site calls (CR-011: all five migrate together).
// Master off ⇒ byte-identical legacy behavior; master on ⇒ session or rollback.
// `legacyCookieOpts` preserves each entry point's ORIGINAL flag-off cookie
// attributes (CR-011: code-login + both Google branches historically set a
// 1-day expiry; password-login + register set a session cookie). Returns the
// token to put in the JSON body (null when cookie-only under the new model).
async function issueLoginToken(req, res, user, legacyCookieOpts = {}) {
  if (flags.SESSION_MODEL_ENABLED) return await issueAuthForUser(req, res, user);
  const token = generateToken(user._id, user.sessionVersion);
  res.cookie(LEGACY_COOKIE, token, { path: "/", httpOnly: true, ...legacyCookiePolicy(), ...legacyCookieOpts });
  return token;
}

// POST /api/users/refresh — epoch-fenced rotation + the §2.2 precedence.
const refreshHandler = asyncHandler(async (req, res) => {
  // EMERGENCY_REAUTH: hard kill — refresh always forces re-auth (CR-011).
  if (flags.EMERGENCY_REAUTH) { clearAuthCookies(res); return res.status(401).json({ error: "reauthenticate" }); }
  // HONOR_EXISTING_REFRESH off: rollback intends to STOP serving refresh (CR-011).
  if (!flags.HONOR_EXISTING_REFRESH) { clearAuthCookies(res); return res.status(401).json({ error: "reauthenticate" }); }

  const raw = req.cookies ? req.cookies[REFRESH_COOKIE] : undefined;
  const r = await svc.refreshSession(raw);
  metrics.refreshOutcome(r.outcome);
  if (r.outcome === "theft_403") metrics.theftConfirmed();
  switch (r.status) {
    case 200:
      setRefreshCookie(res, r.refreshToken, r.refreshExpiresAt, r.absoluteExpiresAt);
      return res.status(200).json({ token: r.accessToken });
    case 409:
      return res.status(409).json({ error: "refresh_in_progress" });
    case 403:
      clearAuthCookies(res);
      return res.status(403).json({ error: "reauthenticate" });
    case 500:
      return res.status(500).json({ error: "server_error" });
    default: // 401 family
      clearAuthCookies(res);
      return res.status(401).json({ error: "reauthenticate" });
  }
});

// POST /api/users/logoutAll — bump the epoch fence, revoke every session.
const logoutAllHandler = asyncHandler(async (req, res) => {
  await svc.revokeAllForUser(req.user._id, "logout-all");
  clearAuthCookies(res);
  return res.status(204).end();
});

// Session-aware single-device logout (called from the existing logout route,
// flag-gated). Revokes the current Session (sid from the access token) and
// clears BOTH credential cookies (CR-011). Best-effort: logout always succeeds.
async function sessionAwareLogout(req, res) {
  try {
    const tok = getToken(req);
    if (tok) {
      const decoded = jwt.decode(tok);
      if (decoded && decoded.sid) await svc.revokeOne(decoded.sid);
    }
  } catch (_) { /* logout is best-effort */ }
  clearAuthCookies(res);
}

module.exports = {
  refreshHandler,
  logoutAllHandler,
  requireSessionFlag,
  issueAuthForUser,
  issueLoginToken,
  issueSessionForUser,
  issueRollbackForUser,
  sessionAwareLogout,
  setRefreshCookie,
  clearAuthCookies,
  clearLegacyCookie,
  legacyCookiePolicy,
  isSafeHttpJourneyPreview,
  REFRESH_COOKIE,
  ROLLBACK_COOKIE,
};
