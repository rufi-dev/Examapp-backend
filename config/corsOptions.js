/*
 * AUD-019 (CR-054) — environment-aware CORS origin policy, extracted so it can be
 * tested directly. The allow-list is derived from VALIDATED config: the primary
 * origin comes from FRONTEND_URL, plus the two examopia.com hosts, plus each
 * VALIDATED entry of ALLOWED_ORIGINS (exact HTTPS in production; wildcard/path/
 * localhost entries are rejected). localhost is permitted ONLY outside production.
 */
const { validatePublicOrigin, validateAllowedOrigins, isPermissiveEnv } = require("./originValidation");

function allowedSet(env = process.env) {
  const set = new Set(["https://examopia.com", "https://www.examopia.com"]);
  // CR-054: the deployment's own frontend origin (validateEnv requires FRONTEND_URL
  // in production; allowedSet must actually honor it).
  if (env.FRONTEND_URL) {
    const r = validatePublicOrigin(env.FRONTEND_URL, env);
    if (r.ok) set.add(r.origin);
  }
  // Only VALID extra origins are added; an invalid ALLOWED_ORIGINS entry is dropped
  // here and additionally fails startup config validation (assertOrigins).
  for (const o of validateAllowedOrigins(env).origins) set.add(o);
  return set;
}

// CR-064: at runtime, a bare-localhost origin is accepted ONLY in a permissive env
// (development or the disposable-E2E marker) — never merely because it isn't
// production. Callers may still pass `permissive` explicitly for unit tests.
function isAllowedOrigin(origin, { env = process.env, permissive = isPermissiveEnv(env) } = {}) {
  if (!origin) return true; // no-origin: curl / server-to-server / same-origin
  if (allowedSet(env).has(origin)) return true;
  if (permissive && /^http:\/\/localhost:\d+$/.test(origin)) return true;
  return false;
}

function corsOrigin(origin, callback) {
  if (isAllowedOrigin(origin)) return callback(null, true);
  const e = new Error("Not allowed by CORS: " + origin);
  e.status = 403;
  callback(e);
}

// Startup guard: refuse to boot on a malformed ALLOWED_ORIGINS / FRONTEND_URL in
// EVERY non-development environment (a wildcard/path/localhost/loopback value must
// never reach the allow-list). CR-072: previously this only ran in production, so
// staging/preview/test accepted a loopback FRONTEND_URL like http://127.0.0.2:5000.
// The disposable-E2E marker still relaxes it (isPermissiveEnv → validatePublicOrigin
// allows loopback ONLY for that verified local harness), never arbitrary public HTTP.
function assertOrigins(env = process.env) {
  const errors = [];
  const ao = validateAllowedOrigins(env);
  if (!ao.ok) for (const b of ao.invalid) errors.push(`ALLOWED_ORIGINS entry "${b.value}" invalid (${b.reason})`);
  if (env.NODE_ENV !== "development" && env.FRONTEND_URL) {
    const r = validatePublicOrigin(env.FRONTEND_URL, env);
    if (!r.ok) errors.push(`FRONTEND_URL "${env.FRONTEND_URL}" invalid (${r.reason})`);
  }
  if (errors.length) throw new Error(`FATAL origin config: ${errors.join("; ")}`);
}

module.exports = { isAllowedOrigin, corsOrigin, allowedSet, assertOrigins };
