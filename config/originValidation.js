/*
 * AUD-019 (CR-054) — strict origin/URL validation, shared by the backend CORS
 * allow-list and env validation. An "origin" is scheme://host[:port] with NO
 * credentials, NO path/query/fragment. Production requires HTTPS and forbids
 * localhost; development may allow http + localhost explicitly.
 */

// CR-063: comprehensive local/loopback detection (localhost + *.localhost,
// 0.0.0.0, 127.0.0.0/8, IPv6 unspecified/loopback + IPv4-mapped loopback).
function isLocalOrLoopback(hostnameRaw) {
  const h = String(hostnameRaw || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h === "::" || h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "0:0:0:0:0:0:0:0") return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h)) return true;
  return false;
}

// Parse and validate that `s` is a clean ORIGIN (no userinfo/path/query/fragment).
// Returns { ok, origin, reason }.
function parseOrigin(s, { allowHttp = false, allowLocalhost = false } = {}) {
  if (typeof s !== "string" || !s.trim()) return { ok: false, reason: "empty" };
  const raw = s.trim();
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: "unparseable" }; }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) return { ok: false, reason: "scheme" };
  if (u.username || u.password) return { ok: false, reason: "credentials" };
  // An origin must have nothing after the host:port.
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return { ok: false, reason: "path_or_fragment" };
  if (isLocalOrLoopback(u.hostname) && !allowLocalhost) return { ok: false, reason: "localhost" };
  if (raw.includes("*")) return { ok: false, reason: "wildcard" };
  // Canonical origin (URL drops a default port and a trailing slash).
  return { ok: true, origin: u.origin };
}

const isProdEnv = (env = process.env) => env.NODE_ENV === "production";

// CR-064: `development` is the ONLY generally permissive mode. Disposable local
// E2E is allowed loopback ONLY through the verified launcher marker, NOT merely
// because NODE_ENV=test (test/staging/preview must be strict like production).
const isPermissiveEnv = (env = process.env) =>
  env.NODE_ENV === "development" || env.EXQ_E2E_DISPOSABLE === "1";

// Validate a single ALLOWED_ORIGINS / FRONTEND_URL entry: exact HTTPS origin, no
// wildcard/path/localhost. `development` may use http + any host. CR-072: the
// disposable-E2E marker is NOT full development — it relaxes to http ONLY for a
// LOOPBACK target (the verified local harness), never an arbitrary public HTTP
// origin. Every other environment is strict HTTPS/non-loopback.
function validatePublicOrigin(s, env = process.env) {
  const dev = env.NODE_ENV === "development";
  const marker = !dev && isPermissiveEnv(env); // disposable-E2E only
  const r = parseOrigin(s, { allowHttp: dev || marker, allowLocalhost: dev || marker });
  if (!r.ok) return r;
  // Under the disposable marker (but not development), the relaxation is
  // loopback-scoped: a public HTTP origin must still be rejected.
  if (marker) {
    let host;
    try { host = new URL(r.origin).hostname; } catch { return { ok: false, reason: "unparseable" }; }
    if (!isLocalOrLoopback(host)) return { ok: false, reason: "non_loopback_under_marker" };
  }
  return r;
}

// Validate the whole ALLOWED_ORIGINS env list. Returns { ok, origins:[], invalid:[] }.
function validateAllowedOrigins(env = process.env) {
  const entries = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const origins = [];
  const invalid = [];
  for (const e of entries) {
    const r = validatePublicOrigin(e, env);
    if (r.ok) origins.push(r.origin); else invalid.push({ value: e, reason: r.reason });
  }
  return { ok: invalid.length === 0, origins, invalid };
}

module.exports = { parseOrigin, validatePublicOrigin, validateAllowedOrigins, isProdEnv, isPermissiveEnv, isLocalOrLoopback };
