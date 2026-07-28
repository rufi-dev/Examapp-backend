/*
 * AUD-008 CR-053 — password configuration cannot fail open, and bcrypt truncation
 * cannot weaken a password. Reproduces the reported defect: PASSWORD_MIN="not-a-
 * number" previously let the 2-char password "a1" pass; it must now be rejected.
 */
const { execFileSync } = require("child_process");
const path = require("path");
const { validatePassword, resolvePasswordMin, passwordMinSafe, BCRYPT_MAX_BYTES } = require("../utils");
const { validateConfig, AUTH_NUMERIC_KEYS } = require("../config/validateConfig");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

// ── the reproduced bug: garbage PASSWORD_MIN must NOT disable the min-length check ──
ok('PASSWORD_MIN="not-a-number": "a1" is REJECTED (fail-closed floor 8)', validatePassword("a1", { PASSWORD_MIN: "not-a-number" }).ok === false);
ok('PASSWORD_MIN="not-a-number": a genuine 8+ password still passes', validatePassword("goodpass1", { PASSWORD_MIN: "not-a-number" }).ok === true);
ok('PASSWORD_MIN="0": floor stays 8 ("short1a" rejected)', validatePassword("short1a", { PASSWORD_MIN: "0" }).ok === false);
ok('PASSWORD_MIN="-5": floor stays 8', validatePassword("short1a", { PASSWORD_MIN: "-5" }).ok === false);
ok('PASSWORD_MIN="8.5": floor stays 8', passwordMinSafe({ PASSWORD_MIN: "8.5" }) === 8);

// ── passwordMinSafe never returns NaN / below floor ──
ok("passwordMinSafe default is 8", passwordMinSafe({}) === 8);
ok("passwordMinSafe honors a valid higher min", passwordMinSafe({ PASSWORD_MIN: "12" }) === 12);
ok('PASSWORD_MIN="12": an 8-char password is rejected', validatePassword("goodpas1", { PASSWORD_MIN: "12" }).ok === false);
ok('PASSWORD_MIN="12": a 12-char password passes', validatePassword("goodpassw0rd", { PASSWORD_MIN: "12" }).ok === true);

// ── resolvePasswordMin throws on invalid (so startup config validation catches it) ──
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
ok("resolvePasswordMin throws on non-numeric", throws(() => resolvePasswordMin({ PASSWORD_MIN: "abc" })));
ok("resolvePasswordMin throws on < 8", throws(() => resolvePasswordMin({ PASSWORD_MIN: "6" })));
ok("resolvePasswordMin throws on fractional", throws(() => resolvePasswordMin({ PASSWORD_MIN: "8.5" })));
ok("CR-059: resolvePasswordMin throws on > 72 (bcrypt boundary — impossible policy)", throws(() => resolvePasswordMin({ PASSWORD_MIN: "100" })));
ok("resolvePasswordMin accepts 72 (the ceiling)", resolvePasswordMin({ PASSWORD_MIN: "72" }) === 72);
ok("resolvePasswordMin returns 8 for empty/undefined", resolvePasswordMin({}) === 8);
ok("resolvePasswordMin accepts a valid value", resolvePasswordMin({ PASSWORD_MIN: "10" }) === 10);

// ── bcrypt 72-byte truncation guard ──
ok("bcrypt max is 72 bytes", BCRYPT_MAX_BYTES === 72);
const bytes = (s) => Buffer.byteLength(s, "utf8");
const at72 = "a".repeat(70) + "b1"; // 72 ascii bytes, has letter+digit
ok("exactly 72 bytes is accepted", bytes(at72) === 72 && validatePassword(at72).ok === true);
const over72 = "a".repeat(72) + "b1"; // 74 bytes
ok("> 72 bytes is rejected (no silent truncation)", validatePassword(over72).ok === false);
const multibyte = "ə".repeat(36) + "a1"; // 36*2 + 2 = 74 bytes but 38 chars
ok("multibyte over-72-bytes rejected even though char-length is small", bytes(multibyte) > 72 && validatePassword(multibyte).ok === false);

// ── CR-059: startup config validation — table-driven, EVERY consumed key ──
ok("validateConfig ok on clean env", validateConfig({ MONGO_URI: "m" }).ok === true);
ok("validateConfig ok with valid AUTH_* + PASSWORD_MIN", validateConfig({ PASSWORD_MIN: "10", AUTH_LOGIN_MAX: "40", AUTH_STORE_MAX: "50000" }).ok === true);

// Every consumed numeric key is validated (incl. AUTH_STORE_MAX — the reproduced gap).
for (const key of AUTH_NUMERIC_KEYS) {
  const isWindow = key.endsWith("_WINDOW_MS");
  ok(`${key}: NaN string rejected`, validateConfig({ [key]: "not-a-number" }).ok === false);
  ok(`${key}: zero rejected (0 is not a disable switch)`, validateConfig({ [key]: "0" }).ok === false);
  ok(`${key}: negative rejected`, validateConfig({ [key]: "-5" }).ok === false);
  ok(`${key}: fractional rejected`, validateConfig({ [key]: "1.5" }).ok === false);
  ok(`${key}: Infinity rejected`, validateConfig({ [key]: "Infinity" }).ok === false);
  ok(`${key}: huge/overflow rejected`, validateConfig({ [key]: "99999999999999" }).ok === false);
  ok(`${key}: a valid positive integer is accepted`, validateConfig({ [key]: isWindow ? "60000" : "50" }).ok === true);
}
ok("CR-059: AUTH_STORE_MAX is now in the validated set", AUTH_NUMERIC_KEYS.includes("AUTH_STORE_MAX"));
ok('CR-059: PASSWORD_MIN="100" (> 72) FAILS validation', validateConfig({ PASSWORD_MIN: "100" }).ok === false);

// ── CR-059 #6: an invalid config aborts a subprocess (assertConfig throws) BEFORE
//    any listen/DB work — proven by running the boot guard in a child node. ──
function assertConfigExit(env) {
  try {
    execFileSync("node", ["-e", "require('./config/validateConfig').assertConfig(); console.log('BOOTED')"],
      { cwd: path.join(__dirname, ".."), env: { ...process.env, ...env }, encoding: "utf8" });
    return { code: 0 };
  } catch (e) { return { code: e.status == null ? 1 : e.status, out: (e.stdout || "") + (e.stderr || "") }; }
}
ok("boot guard passes with valid config", assertConfigExit({ AUTH_LOGIN_MAX: "40", PASSWORD_MIN: "10" }).code === 0);
const badBoot = assertConfigExit({ AUTH_LOGIN_MAX: "0" });
ok("boot guard EXITS NONZERO on invalid config (before listen/DB)", badBoot.code !== 0 && /FATAL config/.test(badBoot.out || ""));
const badStore = assertConfigExit({ AUTH_STORE_MAX: "not-a-number" });
ok("boot guard exits nonzero on invalid AUTH_STORE_MAX", badStore.code !== 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
