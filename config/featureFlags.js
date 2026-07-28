// AUD-002 session-lifecycle rollout flags.
//
// EVERYTHING here defaults to the SAFE/OFF value, so with no environment
// configuration the application behaves EXACTLY as it did before AUD-002 work
// began: legacy no-exp tokens, no Session records, no /refresh, no logout-all.
// The new session model only activates when SESSION_MODEL_ENABLED is explicitly
// set truthy. See docs/adr/AUD-002-session-lifecycle.md (§2.0, §3, §14).

const truthy = (v) => v === true || v === "true" || v === "1" || v === "yes";

const flags = {
  // Master switch. OFF ⇒ none of the session-model code paths run; login/register
  // keep issuing the legacy token exactly as today (Rule 5: preserve behavior).
  SESSION_MODEL_ENABLED: truthy(process.env.SESSION_MODEL_ENABLED),

  // Rollback component flags (ADR-005/ADR-010). Meaningful only while
  // SESSION_MODEL_ENABLED is on. Defaults chosen so a bare "enabled" is the
  // normal, fully-on posture.
  ISSUE_NEW_MODEL: process.env.ISSUE_NEW_MODEL === undefined ? true : truthy(process.env.ISSUE_NEW_MODEL),
  HONOR_EXISTING_REFRESH: process.env.HONOR_EXISTING_REFRESH === undefined ? true : truthy(process.env.HONOR_EXISTING_REFRESH),
  EMERGENCY_REAUTH: truthy(process.env.EMERGENCY_REAUTH),

  // Gate 2 (legacy sunset). Phase 1: OFF — no-`exp` tokens are counted but
  // accepted. Phase 2: ON — `resolveSessionUser` rejects EVERY token without a
  // valid `exp` (including `sv`-bearing Phase-0 tokens), closing CR-003.
  REQUIRE_EXP_TOKENS: truthy(process.env.REQUIRE_EXP_TOKENS),
};

// Proposed values from the ADR §2.0 decision table, kept in ONE place so a
// sign-off change is a config edit, not a code hunt. Durations in milliseconds.
//
// CR-014: `Number(env) || default` silently accepts negatives and replaces 0.
// posInt() validates each value: an env override must parse to a positive
// integer, otherwise the safe default is used AND a warning is logged (so a
// typo cannot quietly produce a zero TTL or a negative window).
const posInt = (raw, def, name) => {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    // eslint-disable-next-line no-console
    console.warn(`[featureFlags] ignoring invalid ${name}=${raw}; using default ${def}`);
    return def;
  }
  return n;
};

const params = {
  ACCESS_TTL_MS: posInt(process.env.ACCESS_TTL_MS, 15 * 60 * 1000, "ACCESS_TTL_MS"), // D1: 15 min
  REFRESH_SLIDING_MS: posInt(process.env.REFRESH_SLIDING_MS, 30 * 24 * 60 * 60 * 1000, "REFRESH_SLIDING_MS"), // D3: 30 d
  REFRESH_ABSOLUTE_MS: posInt(process.env.REFRESH_ABSOLUTE_MS, 90 * 24 * 60 * 60 * 1000, "REFRESH_ABSOLUTE_MS"), // D3: 90 d
  RING_DEPTH: posInt(process.env.RING_DEPTH, 10, "RING_DEPTH"), // D7: N = 10
  GRACE_WINDOW_MS: posInt(process.env.GRACE_WINDOW_MS, 10 * 1000, "GRACE_WINDOW_MS"), // D6: 10 s
  ROLLBACK_COOKIE_TTL_MS: posInt(process.env.ROLLBACK_COOKIE_TTL_MS, 7 * 24 * 60 * 60 * 1000, "ROLLBACK_COOKIE_TTL_MS"), // D15: 7 d
};

// Test/helper hook: allow a suite to force values without env plumbing.
// NEVER used by production code paths beyond reading `flags`/`params`.
const _setForTest = (overrides = {}) => {
  Object.assign(flags, overrides.flags || {});
  Object.assign(params, overrides.params || {});
};

module.exports = { flags, params, _setForTest };
