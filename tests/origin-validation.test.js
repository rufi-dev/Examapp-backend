/*
 * AUD-019 CR-054 — strict origin/URL validation + CORS allow-list derivation.
 * Production rejects credentials, paths, fragments, non-HTTPS, localhost and
 * wildcards; the CORS allow-list is derived from a validated FRONTEND_URL +
 * validated ALLOWED_ORIGINS; startup refuses a malformed value.
 */
const { parseOrigin, validatePublicOrigin, validateAllowedOrigins } = require("../config/originValidation");
const { isAllowedOrigin, allowedSet, assertOrigins } = require("../config/corsOptions");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const prod = { NODE_ENV: "production" };
const dev = { NODE_ENV: "development" };

// ── parseOrigin (production strictness) ──
ok("accepts a clean https origin", parseOrigin("https://examopia.com").ok === true);
ok("drops default port / trailing slash to canonical origin", parseOrigin("https://examopia.com/").origin === "https://examopia.com");
ok("rejects credentials", parseOrigin("https://user:pass@examopia.com").reason === "credentials");
ok("rejects a path", parseOrigin("https://examopia.com/api").reason === "path_or_fragment");
ok("rejects a fragment", parseOrigin("https://examopia.com/#x").reason === "path_or_fragment");
ok("rejects a query", parseOrigin("https://examopia.com/?x=1").reason === "path_or_fragment");
ok("rejects http when not allowed", parseOrigin("http://examopia.com").reason === "scheme");
ok("rejects localhost when not allowed", parseOrigin("https://localhost:5173").reason === "localhost");
ok("rejects a wildcard", parseOrigin("https://*.examopia.com").ok === false);
ok("allows http+localhost when permitted (dev)", parseOrigin("http://localhost:5173", { allowHttp: true, allowLocalhost: true }).ok === true);

// ── validatePublicOrigin honors env ──
ok("prod: https origin ok", validatePublicOrigin("https://staging.examopia.com", prod).ok === true);
ok("prod: http origin rejected", validatePublicOrigin("http://x.examopia.com", prod).ok === false);
ok("prod: localhost rejected", validatePublicOrigin("http://localhost:3000", prod).ok === false);
ok("dev: localhost allowed", validatePublicOrigin("http://localhost:3000", dev).ok === true);

// ── validateAllowedOrigins ──
ok("prod: a wildcard entry is invalid", validateAllowedOrigins({ ...prod, ALLOWED_ORIGINS: "https://*.x.com" }).ok === false);
ok("prod: a path entry is invalid", validateAllowedOrigins({ ...prod, ALLOWED_ORIGINS: "https://x.com/app" }).ok === false);
ok("prod: valid https entries pass + are canonicalized", (() => { const r = validateAllowedOrigins({ ...prod, ALLOWED_ORIGINS: "https://a.examopia.com, https://b.examopia.com/" }); return r.ok && r.origins.includes("https://b.examopia.com"); })());

// ── CORS allow-list derives from FRONTEND_URL ──
ok("FRONTEND_URL origin is allowed by CORS", isAllowedOrigin("https://app.examopia.com", { env: { NODE_ENV: "production", FRONTEND_URL: "https://app.examopia.com" }, isProduction: true }) === true);
ok("allowedSet includes the two base hosts", allowedSet({}).has("https://examopia.com") && allowedSet({}).has("https://www.examopia.com"));
ok("prod: localhost origin rejected by CORS", isAllowedOrigin("http://localhost:5173", { isProduction: true }) === false);
ok("dev: localhost origin allowed by CORS (permissive)", isAllowedOrigin("http://localhost:5173", { permissive: true }) === true);
ok("CR-064: prod: localhost origin rejected by CORS (permissive false)", isAllowedOrigin("http://localhost:5173", { permissive: false }) === false);

// ── CR-064: only `development` (or the disposable-E2E marker) is permissive.
//    test / staging / preview must be strict like production. ──
const LOOP = ["http://localhost:5000", "https://127.0.0.2:5000", "https://0.0.0.0:5000", "https://[::1]:5000", "https://[::ffff:127.0.0.1]:5000"];
for (const mode of ["test", "staging", "preview", "production"]) {
  for (const url of LOOP) {
    ok(`CR-064 ${mode}: loopback ${url} REJECTED`, validatePublicOrigin(url, { NODE_ENV: mode }).ok === false);
  }
  ok(`CR-064 ${mode}: a normal HTTPS origin is accepted`, validatePublicOrigin("https://api.examopia.com", { NODE_ENV: mode }).ok === true);
  ok(`CR-064 ${mode}: http is rejected`, validatePublicOrigin("http://api.examopia.com", { NODE_ENV: mode }).ok === false);
}
ok("CR-064 development: loopback+http allowed", validatePublicOrigin("http://127.0.0.2:5000", { NODE_ENV: "development" }).ok === true);
ok("CR-064 test + EXQ_E2E_DISPOSABLE=1: loopback allowed ONLY via the launcher marker", validatePublicOrigin("http://localhost:5000", { NODE_ENV: "test", EXQ_E2E_DISPOSABLE: "1" }).ok === true);
ok("CR-064 test WITHOUT the marker: loopback rejected", validatePublicOrigin("http://localhost:5000", { NODE_ENV: "test" }).ok === false);

// ── CR-063: loopback/local aliases rejected in production ──
for (const host of ["0.0.0.0", "127.0.0.1", "127.0.0.2", "127.255.255.254", "sub.localhost", "[::1]", "[::]", "[::ffff:127.0.0.1]"]) {
  ok(`prod: loopback alias ${host} rejected`, validatePublicOrigin(`https://${host}:5000`, prod).ok === false);
}
ok("dev: 127.0.0.2 allowed (dev may use loopback)", validatePublicOrigin("http://127.0.0.2:5000", dev).ok === true);
ok("prod: a non-loopback host is still allowed (scope not broadened)", validatePublicOrigin("https://api.examopia.com", prod).ok === true);

// ── assertOrigins (startup) ──
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
ok("assertOrigins ok on clean env", !throws(() => assertOrigins({ NODE_ENV: "production", FRONTEND_URL: "https://examopia.com" })));
ok("assertOrigins THROWS on a wildcard ALLOWED_ORIGINS in prod", throws(() => assertOrigins({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://*.x.com" })));
ok("assertOrigins THROWS on a localhost FRONTEND_URL in prod", throws(() => assertOrigins({ NODE_ENV: "production", FRONTEND_URL: "http://localhost:5000" })));

// ── CR-072: assertOrigins enforces FRONTEND_URL in EVERY non-development env ──
// (the reproduced defect: staging/preview/test accepted http://127.0.0.2:5000).
for (const env of ["test", "staging", "preview", "production"]) {
  ok(`assertOrigins THROWS on loopback FRONTEND_URL 127.0.0.2 in ${env}`, throws(() => assertOrigins({ NODE_ENV: env, FRONTEND_URL: "http://127.0.0.2:5000" })));
  ok(`assertOrigins THROWS on http localhost FRONTEND_URL in ${env}`, throws(() => assertOrigins({ NODE_ENV: env, FRONTEND_URL: "http://localhost:5174" })));
  ok(`assertOrigins ok on a real HTTPS FRONTEND_URL in ${env}`, !throws(() => assertOrigins({ NODE_ENV: env, FRONTEND_URL: "https://examopia.com" })));
}
// development may use loopback/http.
ok("assertOrigins ok on loopback FRONTEND_URL in development", !throws(() => assertOrigins({ NODE_ENV: "development", FRONTEND_URL: "http://127.0.0.2:5000" })));
// the disposable-E2E marker is a SCOPED loopback exception, not arbitrary public HTTP.
ok("assertOrigins ok on localhost FRONTEND_URL under EXQ_E2E_DISPOSABLE", !throws(() => assertOrigins({ NODE_ENV: "test", EXQ_E2E_DISPOSABLE: "1", FRONTEND_URL: "http://localhost:5174" })));
ok("assertOrigins STILL THROWS on a public HTTP FRONTEND_URL under the disposable marker", throws(() => assertOrigins({ NODE_ENV: "test", EXQ_E2E_DISPOSABLE: "1", FRONTEND_URL: "http://evil.example.com" })));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
