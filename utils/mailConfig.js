/*
 * CR-107/CR-108 — ONE shared, side-effect-free SMTP configuration used by BOTH mail
 * delivery (utils/sendEmail.js) and the health probe (healthController), so they can
 * never drift. Certificate verification is ALWAYS on (no `rejectUnauthorized:false`,
 * no runtime switch to disable it). Templates are a typed, server-owned allowlist —
 * a client can never select one. Health output is reduced to stable category codes
 * that never echo the provider error, host, credentials, recipient or content.
 */
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

// Typed, SERVER-OWNED notification kinds → EXACT shipping template basenames. `link`
// says how the notification's link/context is treated: a same-origin URL, a bounded
// CODE (loginCode), or none. Test templates are deliberately excluded.
const NOTIFICATION_KINDS = Object.freeze({
  verify: { template: "verifyEmail", link: "url" },
  loginCode: { template: "loginCode", link: "code" },
  forgotPassword: { template: "forgotPassword", link: "url" },
  passwordChanged: { template: "changePassword", link: "none" },
  roleChanged: { template: "changeRole", link: "url" },
});
// Only these basenames may ever reach the Handlebars view engine.
const ALLOWED_TEMPLATES = new Set(Object.values(NOTIFICATION_KINDS).map((k) => k.template));
// A safe basename: our shipping templates are plain letters (no separators, dots,
// extensions, traversal or encoded separators can pass).
const SAFE_TEMPLATE_RE = /^[A-Za-z][A-Za-z0-9]*$/;

const hasCRLF = (v) => typeof v === "string" && /[\r\n]/.test(v);

function assertNoHeaderInjection(fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (v != null && hasCRLF(String(v))) throw new Error(`mail: illegal control char in ${k}`);
  }
}

// Resolve a notification link to the configured FRONTEND origin, or reject anything
// that escapes it. Returns the absolute href.
function resolveFrontendLink(pathOrUrl, env = process.env) {
  if (hasCRLF(String(pathOrUrl == null ? "" : pathOrUrl))) throw new Error("mail: illegal control char in link");
  const origin = env.FRONTEND_URL;
  let base;
  try { base = new URL(origin); } catch { throw new Error("mail: FRONTEND_URL is not a valid origin"); }
  let u;
  try { u = new URL(pathOrUrl, base); } catch { throw new Error("mail: invalid notification link"); }
  if (u.origin !== base.origin) throw new Error("mail: link escapes the frontend origin");
  if (hasCRLF(u.href)) throw new Error("mail: illegal control char in link");
  return u.href;
}

// A bounded one-time code (loginCode) — never a URL, never header-injected.
function assertBoundedCode(code) {
  const s = String(code == null ? "" : code);
  if (!s || s.length > 64 || hasCRLF(s)) throw new Error("mail: invalid notification code");
  return s;
}

// Look up the allowlisted template basename for a typed kind (throws on anything else).
function resolveKind(kind) {
  const spec = NOTIFICATION_KINDS[kind];
  if (!spec || !ALLOWED_TEMPLATES.has(spec.template) || !SAFE_TEMPLATE_RE.test(spec.template)) {
    throw new Error("mail: unknown notification kind");
  }
  return spec;
}

const isPort = (p) => Number.isInteger(p) && p > 0 && p <= 65535;

// Build the strict, cert-VERIFIED transporter config from EMAIL_* env. Pure — opens
// no connection. Throws a stable message on any invalid field. 465 = implicit TLS;
// 587 = STARTTLS with requireTLS. Bounded timeouts on every phase.
function buildMailConfig(env = process.env) {
  const host = env.EMAIL_HOST;
  const port = Number(env.EMAIL_PORT || 587);
  const user = env.EMAIL_USER;
  const pass = env.EMAIL_PASS;
  if (!host || typeof host !== "string" || hasCRLF(host)) throw new Error("mail: invalid EMAIL_HOST");
  if (!isPort(port)) throw new Error("mail: invalid EMAIL_PORT");
  if (!user || typeof user !== "string" || hasCRLF(user)) throw new Error("mail: invalid EMAIL_USER");
  if (!pass || typeof pass !== "string") throw new Error("mail: invalid EMAIL_PASS");
  const secure = port === 465;
  const config = {
    host, port, secure,
    auth: { user, pass },
    requireTLS: !secure, // STARTTLS mandatory on 587
    // Certificate verification is ON (nodemailer default). We only PIN a floor and
    // never expose a disable switch.
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    dnsTimeout: 10_000,
  };
  // Optional reviewed private CA — an explicit ABSOLUTE file path only; fail if invalid.
  const caPath = env.EMAIL_CA_FILE;
  if (caPath) {
    if (!path.isAbsolute(caPath)) throw new Error("mail: EMAIL_CA_FILE must be an absolute path");
    try { config.tls.ca = fs.readFileSync(caPath); } catch { throw new Error("mail: EMAIL_CA_FILE unreadable"); }
  }
  return config;
}

// Boot-time gate: when mail is ENABLED, the whole config (incl. a valid frontend
// origin) must be valid or the process must fail to start.
function assertMailConfig(env = process.env) {
  if (env.EMAIL_ENABLED !== "true") return;
  buildMailConfig(env); // validates host/port/user/pass + CA
  try { new URL(env.FRONTEND_URL); } catch { throw new Error("mail: invalid FRONTEND_URL"); }
}

// Shared transporter factory — one config, no drift between delivery and health.
function createMailTransporter(env = process.env) {
  return nodemailer.createTransport(buildMailConfig(env));
}

// Map any raw SMTP/transport error to a STABLE category. NEVER leaks the provider
// message, host, credentials, recipient, subject or content.
function healthCategory(err) {
  const code = String((err && (err.code || err.responseCode || err.command)) || "").toUpperCase();
  const msg = String((err && err.message) || "").toLowerCase();
  if (code.includes("TIMEOUT") || code.includes("TIMEDOUT") || msg.includes("timeout") || msg.includes("timed out")) return "smtp_timeout";
  if (code === "EAUTH" || msg.includes("invalid login") || msg.includes("auth") || msg.includes("credential") || msg.includes("535")) return "smtp_auth";
  if (msg.includes("certificate") || msg.includes("self-signed") || msg.includes("self signed") || msg.includes(" tls") || msg.includes("ssl") || code === "ESOCKET") return "smtp_tls";
  return "smtp_unavailable";
}

module.exports = {
  NOTIFICATION_KINDS, ALLOWED_TEMPLATES, resolveKind,
  assertNoHeaderInjection, resolveFrontendLink, assertBoundedCode,
  buildMailConfig, assertMailConfig, createMailTransporter, healthCategory, hasCRLF,
};
