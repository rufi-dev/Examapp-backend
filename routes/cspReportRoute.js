const express = require("express");
const router = express.Router();
const metrics = require("../utils/authMetrics");
const { recordDebug } = require("../utils/debugLog");

/*
 * AUD-019 CR-055/CR-061 — CSP violation report collector for the frontend's
 * Report-Only rollout (report-uri target). Public + UNAUTHENTICATED, so it is a
 * hardened sink:
 *   - a HARD 16 KB body cap enforced by its OWN raw pipeline (mounted BEFORE the
 *     global express.json, so the cap is never bypassed) — oversized ⇒ exact 413;
 *   - a bounded per-IP request limiter + a GLOBAL write budget + per-directive
 *     dedup, so a public caller can't cause unbounded DebugLog writes;
 *   - only a FIXED allow-listed CSP directive name is recorded — never blocked/
 *     document URLs or any PII.
 */
const MAX_BODY = 16 * 1024;
const IP_WINDOW_MS = 60 * 1000, IP_MAX = 60;         // reports/min/IP before we stop writing
const WRITE_WINDOW_MS = 60 * 1000, WRITE_MAX = 120;  // total DebugLog writes/min (all IPs)
const DEDUP_MS = 10 * 1000;                          // don't rewrite the same directive within 10s

const CSP_DIRECTIVES = new Set([
  "default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem",
  "style-src-attr", "img-src", "font-src", "connect-src", "media-src", "frame-src", "object-src",
  "base-uri", "frame-ancestors", "form-action", "worker-src", "manifest-src", "child-src", "prefetch-src",
]);

let ipHits = new Map();
let writeWindowStart = 0, writeCount = 0;
let recentDirectives = new Map();

const nowMs = () => Date.now();
function ipAllowed(ip) {
  const t = nowMs();
  if (ipHits.size > 10000) { for (const [k, v] of ipHits) if (t > v.resetAt) ipHits.delete(k); while (ipHits.size > 10000) ipHits.delete(ipHits.keys().next().value); }
  let e = ipHits.get(ip);
  if (!e || t > e.resetAt) { e = { count: 0, resetAt: t + IP_WINDOW_MS }; ipHits.set(ip, e); }
  e.count += 1;
  return e.count <= IP_MAX;
}
function writeBudget() {
  const t = nowMs();
  if (t - writeWindowStart > WRITE_WINDOW_MS) { writeWindowStart = t; writeCount = 0; }
  if (writeCount >= WRITE_MAX) return false;
  writeCount += 1;
  return true;
}

// Own raw-body reader with a hard cap — independent of any global JSON parser.
// On the FIRST byte past 16KB it replies 413 and stops buffering; it then DRAINS
// (discards) the rest so the 413 is delivered cleanly, and only truly abusive
// bodies (past HARD_ABORT) get the socket destroyed.
const HARD_ABORT = 256 * 1024;
function rawBody(req, res, next) {
  let size = 0;
  const chunks = [];
  let over = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > HARD_ABORT) { req.destroy(); return; }
    if (size > MAX_BODY) { if (!over) { over = true; if (!res.headersSent) res.status(413).end(); } return; } // drain, don't buffer
    chunks.push(c);
  });
  req.on("end", () => { if (over || res.headersSent) return; req.rawBody = Buffer.concat(chunks); next(); });
  req.on("error", () => { if (!res.headersSent) res.status(400).end(); });
}

router.post("/", rawBody, (req, res) => {
  metrics.cspReportSeen();
  try {
    const ip = String(req.ip || "anon");
    let body = {};
    try { body = JSON.parse((req.rawBody && req.rawBody.toString("utf8")) || "{}"); } catch { body = null; } // malformed ⇒ counted, not written
    const r = (body && (body["csp-report"] || (Array.isArray(body) ? (body[0] && body[0].body) : body))) || {};
    const directive = String(r["violated-directive"] || r.effectiveDirective || "").split(/\s+/)[0].slice(0, 40);
    if (CSP_DIRECTIVES.has(directive) && ipAllowed(ip) && writeBudget()) {
      const last = recentDirectives.get(directive) || 0;
      if (nowMs() - last > DEDUP_MS) {
        if (recentDirectives.size > 1000) recentDirectives.clear();
        recentDirectives.set(directive, nowMs());
        recordDebug({ kind: "csp_report", message: directive }); // directive NAME only — no URLs/PII
      }
    }
  } catch { /* never fail a report sink */ }
  if (!res.headersSent) res.status(204).end();
});

// TEST-ONLY: reset the bounded in-memory state between cases.
router.__resetForTest = () => { ipHits = new Map(); writeWindowStart = 0; writeCount = 0; recentDirectives = new Map(); };

module.exports = router;
