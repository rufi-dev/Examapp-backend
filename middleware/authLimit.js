/*
 * AUD-008 — abuse limiting for the UNAUTHENTICATED identity endpoints.
 *
 * NAT-safe (CR-051): generous per-IP windows keep a shared-classroom NAT usable,
 * while a per-ACCOUNT failed-login bucket (keyed by an HMAC of the CANONICAL email,
 * never a raw address) bounds a DISTRIBUTED attack on one identity across many IPs.
 * The email-send routes add a tight per-recipient cap so one address can't be
 * spammed. All AUTH_* config is validated at startup (config/validateConfig).
 *
 * Storage is behind a small interface (LimiterStore). The default MemoryStore is a
 * HARD-BOUNDED map (evicts expired, then oldest) — valid ONLY for the documented
 * single-process deployment. Multiple replicas must inject a shared/durable (Redis)
 * store implementing hit/peek/bump/clear.
 */
const { emailBucketKey } = require("../utils");
const metrics = require("../utils/authMetrics");

const MIN = 60 * 1000;
const num = (v, d) => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const D = (envKey, prod) => num(process.env[envKey], process.env.NODE_ENV === "test" ? 1e9 : prod);

const config = {
  login:    { windowMs: num(process.env.AUTH_LOGIN_WINDOW_MS, 15 * MIN), max: D("AUTH_LOGIN_MAX", 40) },
  register: { windowMs: num(process.env.AUTH_REGISTER_WINDOW_MS, 60 * MIN), max: D("AUTH_REGISTER_MAX", 20) },
  email:    { windowMs: num(process.env.AUTH_EMAIL_WINDOW_MS, 15 * MIN), max: D("AUTH_EMAIL_MAX", 5) },
  emailIp:  { windowMs: num(process.env.AUTH_EMAIL_IP_WINDOW_MS, 15 * MIN), max: D("AUTH_EMAIL_IP_MAX", 30) },
  reset:    { windowMs: num(process.env.AUTH_RESET_WINDOW_MS, 15 * MIN), max: D("AUTH_RESET_MAX", 30) },
  // Per-ACCOUNT FAILED-login bucket (counts failures, cleared on success).
  account:  { windowMs: num(process.env.AUTH_ACCOUNT_WINDOW_MS, 15 * MIN), max: D("AUTH_ACCOUNT_MAX", 10) },
};

// ── bounded store interface ──
class MemoryStore {
  constructor(max) { this.max = max > 0 ? max : 50000; this.map = new Map(); }
  _evict(now) {
    if (this.map.size <= this.max) return;
    for (const [k, v] of this.map) { if (now > v.resetAt) this.map.delete(k); if (this.map.size <= this.max) return; }
    while (this.map.size > this.max) { const k = this.map.keys().next().value; this.map.delete(k); } // oldest first (insertion order)
  }
  peek(key, now) { const e = this.map.get(key); return e && now <= e.resetAt ? e : null; }
  // increment within the window, creating/rolling the window as needed
  bump(key, windowMs, now) {
    let e = this.map.get(key);
    if (!e || now > e.resetAt) { this.map.delete(key); e = { count: 0, resetAt: now + windowMs }; this.map.set(key, e); this._evict(now); }
    e.count += 1; return e;
  }
  clear(key) { this.map.delete(key); }
  clearAll() { this.map.clear(); }
  get size() { return this.map.size; }
}
let store = new MemoryStore(num(process.env.AUTH_STORE_MAX, 50000));

const ipKey = (req) => "ip:" + String(req.ip || "anon");
const rawEmail = (req) => (req.params && req.params.email) || (req.body && req.body.email) || "";
const emailKey = (req) => "em:" + emailBucketKey(rawEmail(req));
const accountBucket = (email) => "account|em:" + emailBucketKey(email);

function reject(res, entry, now, kind) {
  metrics.throttleBlocked(kind);
  res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
  res.status(429);
  throw new Error("Çox sayda cəhd göndərdiniz. Zəhmət olmasa bir azdan yenidən cəhd edin.");
}

// A counting limiter (every request counts). `kind` is the metric label.
function make(name, keyFn, kind) {
  return function limiter(req, res, next) {
    const { windowMs, max } = config[name];
    if (!(max > 0)) return next();
    const now = Date.now();
    const e = store.bump(name + "|" + keyFn(req), windowMs, now);
    if (e.count > max) return reject(res, e, now, kind);
    next();
  };
}

// Per-ACCOUNT gate: checks (does NOT count) the FAILED-login bucket BEFORE the
// controller runs, so flooding an identity from many IPs is bounded. The controller
// records the actual result via recordLoginResult (increment on fail, clear on ok).
function accountGuard(req, res, next) {
  const { max } = config.account;
  if (!(max > 0)) return next();
  const now = Date.now();
  const e = store.peek(accountBucket(rawEmail(req)), now);
  if (e && e.count >= max) return reject(res, e, now, "account");
  next();
}
function recordLoginResult(email, success) {
  const key = accountBucket(email);
  if (success) return store.clear(key);
  store.bump(key, config.account.windowMs, Date.now());
}

const loginLimiter = make("login", ipKey, "ip");
const registerLimiter = make("register", ipKey, "ip");
const resetLimiter = make("reset", ipKey, "ip");
const emailSendLimiter = make("email", emailKey, "email");
const emailSendIpLimiter = make("emailIp", ipKey, "ip");

// TEST-ONLY seams.
function __setForTest(overrides) {
  if (process.env.NODE_ENV !== "test") throw new Error("authLimit override is test-only");
  for (const k of Object.keys(overrides || {})) config[k] = { ...config[k], ...overrides[k] };
}
function __resetForTest(opts = {}) {
  if (process.env.NODE_ENV !== "test") throw new Error("authLimit reset is test-only");
  if (opts.storeMax) store = new MemoryStore(opts.storeMax);
  else store.clearAll();
}
const __storeSize = () => store.size;

module.exports = {
  loginLimiter, registerLimiter, resetLimiter, emailSendLimiter, emailSendIpLimiter,
  accountGuard, recordLoginResult,
  __setForTest, __resetForTest, __storeSize, MemoryStore,
};
