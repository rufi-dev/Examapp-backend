/*
 * AUD-019 — fail-fast environment validation. "Keep working" fallbacks (a missing
 * secret silently defaulting) are how a preview/dev process ends up mutating
 * production. The server asserts its required configuration at boot and refuses to
 * start if anything critical is missing, instead of limping on with a fallback.
 */
const ALWAYS_REQUIRED = ["MONGO_URI", "JWT_SECRET", "CRYPTR_KEY"];
// Additional variables that must be explicit in production (no safe default).
const PROD_REQUIRED = ["FRONTEND_URL"];

function validateEnv(env = process.env, { isProduction = (env.NODE_ENV === "production") } = {}) {
  const required = isProduction ? [...ALWAYS_REQUIRED, ...PROD_REQUIRED] : ALWAYS_REQUIRED;
  const missing = required.filter((k) => !env[k] || String(env[k]).trim() === "");
  return { ok: missing.length === 0, missing, isProduction };
}

// Boot guard: throw (crash the process) when required config is absent.
function assertEnv(env = process.env) {
  const { ok, missing } = validateEnv(env);
  if (!ok) {
    throw new Error(`FATAL: missing required environment variable(s): ${missing.join(", ")}`);
  }
  // CR-107: when mail is ENABLED, the SMTP config (host/port/user/pass/from) and the
  // frontend origin must be valid, or the process must fail to start.
  const { assertMailConfig } = require("../utils/mailConfig");
  assertMailConfig(env);
}

module.exports = { validateEnv, assertEnv, ALWAYS_REQUIRED, PROD_REQUIRED };
