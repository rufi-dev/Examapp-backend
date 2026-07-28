// AUD-002 CSRF (Gate 2). Strict Origin/Referer allow-list on COOKIE-authenticated
// state-changing routes (refresh, logout, logout-all, cookie-auth password
// mutation). A request that authenticates with an `Authorization: Bearer` header
// is NOT ambient-cookie-driven, so it cannot be forged cross-site and bypasses
// this check. CORS alone does not stop a cross-origin POST from being SENT, so
// this server-side origin check is required (Decision D17).

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Configured allow-list. Production + explicit dev origins; extend via
// ALLOWED_ORIGINS (comma-separated). No wildcard.
function allowedOrigins() {
  const base = [
    "https://examopia.com",
    "https://www.examopia.com",
    "https://api.examopia.com",
  ];
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return new Set([...base, ...extra]);
}

function originOf(req) {
  if (req.headers.origin) return req.headers.origin;
  // Fall back to the Referer's origin when Origin is absent.
  const ref = req.headers.referer || req.headers.referrer;
  if (ref) { try { const u = new URL(ref); return `${u.protocol}//${u.host}`; } catch (_) { /* ignore */ } }
  return null;
}

// Enforce on cookie-authenticated, state-changing requests.
const csrfProtect = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  // Bearer-authenticated requests are not CSRF-exploitable (no ambient cookie).
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return next();
  const origin = originOf(req);
  if (!origin || !allowedOrigins().has(origin)) {
    res.status(403);
    return next(new Error("Cross-site request blocked"));
  }
  return next();
};

module.exports = { csrfProtect, allowedOrigins };
