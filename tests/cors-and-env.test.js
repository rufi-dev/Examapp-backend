/*
 * AUD-019 — environment-aware CORS origin policy + fail-fast env validation.
 * Pure unit tests (no server), driving the extracted config modules directly.
 */
const { isAllowedOrigin } = require("../config/corsOptions");
const { validateEnv, ALWAYS_REQUIRED } = require("../config/validateEnv");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

const prod = { permissive: false, env: {} };
const dev = { permissive: true, env: {} };

// ── CORS ──
ok("no-origin (curl/server-to-server) is allowed", isAllowedOrigin(undefined, prod) === true);
ok("allow-listed https://examopia.com allowed in prod", isAllowedOrigin("https://examopia.com", prod) === true);
ok("www allowed in prod", isAllowedOrigin("https://www.examopia.com", prod) === true);
ok("localhost is REJECTED in production", isAllowedOrigin("http://localhost:5173", prod) === false);
ok("localhost is ALLOWED in dev", isAllowedOrigin("http://localhost:5173", dev) === true);
ok("a random origin is rejected in prod", isAllowedOrigin("https://evil.example", prod) === false);
ok("a random origin is rejected in dev too", isAllowedOrigin("https://evil.example", dev) === false);
ok("extra ALLOWED_ORIGINS env is honored", isAllowedOrigin("https://staging.examopia.com", { isProduction: true, env: { ALLOWED_ORIGINS: "https://staging.examopia.com" } }) === true);

// ── env validation ──
const full = { MONGO_URI: "m", JWT_SECRET: "j", CRYPTR_KEY: "c", FRONTEND_URL: "https://examopia.com" };
ok("validateEnv ok when all required present (prod)", validateEnv(full, { isProduction: true }).ok === true);
ok("validateEnv FAILS when JWT_SECRET missing", validateEnv({ ...full, JWT_SECRET: "" }, { isProduction: true }).ok === false);
ok("missing var is reported by name", validateEnv({ ...full, MONGO_URI: "" }, { isProduction: true }).missing.includes("MONGO_URI"));
ok("production additionally requires FRONTEND_URL", validateEnv({ MONGO_URI: "m", JWT_SECRET: "j", CRYPTR_KEY: "c" }, { isProduction: true }).ok === false);
ok("dev does NOT require FRONTEND_URL", validateEnv({ MONGO_URI: "m", JWT_SECRET: "j", CRYPTR_KEY: "c" }, { isProduction: false }).ok === true);
ok("ALWAYS_REQUIRED lists the three secrets", ALWAYS_REQUIRED.includes("MONGO_URI") && ALWAYS_REQUIRED.includes("JWT_SECRET") && ALWAYS_REQUIRED.includes("CRYPTR_KEY"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
