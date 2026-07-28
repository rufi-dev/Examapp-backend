/*
 * AUD-008 (CR-051 #4 / CR-053 / CR-059) — validate security-relevant numeric
 * configuration at startup. A malformed value FAILS the boot (before listen and
 * before any DB/index mutation) rather than silently disabling a protection.
 *
 * CR-059 hardening: EVERY consumed limiter setting is checked, including
 * AUTH_STORE_MAX. Windows/maxima/capacity must be BOUNDED POSITIVE SAFE INTEGERS
 * in production — `0` is not an undocumented disable switch (test-only disabling
 * stays through the authLimit test seam), fractional/NaN/Infinity/huge are
 * rejected, and PASSWORD_MIN must be compatible with the 72-byte bcrypt boundary.
 */
const { resolvePasswordMin } = require("../utils");

const DAY_MS = 24 * 60 * 60 * 1000;

// Every consumed key → its allowed [min, max] bound (all must be integers).
// Windows are milliseconds; maxima are counts; AUTH_STORE_MAX is capacity.
const WINDOW_KEYS = [
  "AUTH_LOGIN_WINDOW_MS", "AUTH_REGISTER_WINDOW_MS", "AUTH_EMAIL_WINDOW_MS",
  "AUTH_EMAIL_IP_WINDOW_MS", "AUTH_RESET_WINDOW_MS", "AUTH_ACCOUNT_WINDOW_MS",
];
const MAX_KEYS = [
  "AUTH_LOGIN_MAX", "AUTH_REGISTER_MAX", "AUTH_EMAIL_MAX",
  "AUTH_EMAIL_IP_MAX", "AUTH_RESET_MAX", "AUTH_ACCOUNT_MAX",
];
const SPEC = {};
for (const k of WINDOW_KEYS) SPEC[k] = { min: 1, max: DAY_MS };       // 1ms .. 24h
for (const k of MAX_KEYS) SPEC[k] = { min: 1, max: 1_000_000 };        // 1 .. 1e6 attempts
SPEC.AUTH_STORE_MAX = { min: 1, max: 10_000_000 };                     // 1 .. 1e7 entries

// Every numeric key this module validates (used by tests to be exhaustive).
const AUTH_NUMERIC_KEYS = Object.keys(SPEC);

function validateConfig(env = process.env) {
  const errors = [];
  try { resolvePasswordMin(env); } catch (e) { errors.push(e.message); }
  for (const [k, { min, max }] of Object.entries(SPEC)) {
    const raw = env[k];
    if (raw === undefined || raw === "") continue; // unset ⇒ safe default
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      errors.push(`Invalid ${k}="${raw}" (must be an integer in [${min}, ${max}])`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function assertConfig(env = process.env) {
  const { ok, errors } = validateConfig(env);
  if (!ok) throw new Error(`FATAL config: ${errors.join("; ")}`);
}

module.exports = { validateConfig, assertConfig, AUTH_NUMERIC_KEYS, SPEC };
