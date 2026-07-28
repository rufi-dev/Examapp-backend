const jwt = require("jsonwebtoken")
const crypto = require("crypto")

// Generate Token. Embeds the user's current sessionVersion (`sv`) so password
// reset/change can revoke previously-issued tokens (AUD-002, partial). NOTE: the
// token still has no expiry — bounded access lifetime + rotating refresh tokens
// remain a separate, decision-gated change (see FIX_RESULTS AUD-002).
const generateToken = (id, sessionVersion = 0) => {
    return jwt.sign({ id, sv: sessionVersion }, process.env.JWT_SECRET)
}

// Extract the auth JWT from the Authorization: Bearer header FIRST (works on
// every device), falling back to the cookie. The frontend (examopia.com) and API
// (api.examopia.com) are different ORIGINS but the SAME registrable domain, so a
// cookie set by the API host is cross-origin yet same-site (NOT third-party). The
// current cookie is nonetheless observed to be unreliable on Safari/iOS/privacy
// browsers under the present SameSite=None config; the header path is today's
// reliable workaround. See docs/adr/AUD-002-session-lifecycle.md (§1, §2.3) for
// the host-only, same-site cookie that replaces this.
const getToken = (req) => {
    const header = req.headers?.authorization || ""
    if (header.startsWith("Bearer ")) return header.slice(7).trim()
    // AUD-002 (ADR-015/CR-011, Gate 0): the rollback-mode session cookie (a JWT)
    // may authenticate ordinary routes during rollback; otherwise the legacy
    // cookie. The refresh cookie is NEVER read here — only POST /refresh reads it.
    return (req.cookies && (req.cookies["__Host-exq_sess"] || req.cookies.token)) || undefined
}

//Hash Token
const hashToken = (token) => {
    return crypto.createHash("sha256").update(token.toString()).digest("hex");
}

// AUD-008 (CR-050): ONE canonical-identity function. Trim + lowercase only — we do
// NOT strip Gmail dots/plus suffixes for IDENTITY (provider-specific alias rules
// create false positives; those are referral-RISK signals elsewhere, not identity).
// Every registration, login, code, forgot/reset lookup, Google reconciliation,
// admin lookup, referral match and rate-limit key must canonicalize through this
// so `Teacher@Example.com` and `teacher@example.com` are the SAME account.
const normalizeEmail = (raw) => String(raw || "").trim().toLowerCase();

// HMAC an identity for a rate-limit bucket key so the limiter store never retains
// raw email addresses (CR-051). Keyed by JWT_SECRET (already required at boot).
const emailBucketKey = (email) =>
    crypto.createHmac("sha256", process.env.JWT_SECRET || "dev").update(normalizeEmail(email)).digest("hex").slice(0, 32);

// AUD-008 / CR-053: ONE shared password policy for every set/change/reset path.
// The floor is NEVER below 8: a misconfigured PASSWORD_MIN can only raise it, and
// must never fail open (the old `Number(PASSWORD_MIN)` became NaN and disabled the
// check entirely). `resolvePasswordMin` THROWS on an explicitly-invalid value so
// startup config validation catches it; `passwordMinSafe` is the never-NaN floor
// validatePassword actually uses.
const PASSWORD_MIN_FLOOR = 8;
// CR-059: the minimum can never exceed the 72-byte bcrypt input boundary — a
// larger minimum would make EVERY compliant password impossible (min chars >
// max bytes). Refuse it at startup rather than silently substitute.
const PASSWORD_MIN_CEIL = 72;
function resolvePasswordMin(env = process.env) {
    const raw = env.PASSWORD_MIN;
    if (raw === undefined || raw === "") return PASSWORD_MIN_FLOOR;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < PASSWORD_MIN_FLOOR || n > PASSWORD_MIN_CEIL) {
        throw new Error(`Invalid PASSWORD_MIN="${raw}" (must be an integer between ${PASSWORD_MIN_FLOOR} and ${PASSWORD_MIN_CEIL})`);
    }
    return n;
}
function passwordMinSafe(env = process.env) {
    const n = Number(env.PASSWORD_MIN);
    return Number.isInteger(n) && n >= PASSWORD_MIN_FLOOR && n <= PASSWORD_MIN_CEIL ? n : PASSWORD_MIN_FLOOR;
}

// bcrypt silently truncates input at 72 BYTES — so "…72 bytes…A" and "…72 bytes…B"
// would hash identically. Reject anything longer so a password can never be
// weakened by truncation (CR-053).
const BCRYPT_MAX_BYTES = 72;

const validatePassword = (pw, env = process.env) => {
    if (typeof pw !== "string") return { ok: false, message: "Şifrə düzgün deyil" };
    const min = passwordMinSafe(env);
    if (pw.length < min) return { ok: false, message: `Şifrə ən azı ${min} karakter olmalıdır` };
    if (Buffer.byteLength(pw, "utf8") > BCRYPT_MAX_BYTES) {
        return { ok: false, message: "Şifrə çox uzundur (maksimum 72 bayt)" };
    }
    if (!/[A-Za-zƏəĞğİıÖöŞşÇçÜü]/.test(pw) || !/[0-9]/.test(pw)) {
        return { ok: false, message: "Şifrədə ən azı bir hərf və bir rəqəm olmalıdır" };
    }
    if (/^(.)\1+$/.test(pw)) return { ok: false, message: "Şifrə çox sadədir" };
    return { ok: true };
}

module.exports = { generateToken, hashToken, getToken, validatePassword, resolvePasswordMin, passwordMinSafe, BCRYPT_MAX_BYTES, PASSWORD_MIN_FLOOR, normalizeEmail, emailBucketKey }