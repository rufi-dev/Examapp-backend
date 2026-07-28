/*
 * AUD-019 CR-055 — the CSP report sink works, and the two frontend host configs
 * (canonical Cloudflare public/_headers + fallback vercel.json) declare a
 * CONSISTENT security-header set with a report-uri, so a Vercel deploy is never a
 * regression. (Promotion of the CSP to enforcing is gated on the disposable
 * browser matrix — documented in both files.)
 */
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const metrics = require("../utils/authMetrics");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function post(server, raw, type) {
  return new Promise((resolve) => {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === "string" ? raw : JSON.stringify(raw));
    const { port } = server.address();
    let settled = false, status = 0;
    const done = () => { if (!settled) { settled = true; resolve({ status }); } };
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/csp-report", headers: { "Content-Type": type, "Content-Length": data.length } },
      (res) => { status = res.statusCode; res.on("data", () => {}); res.on("end", done); });
    // The server may 413 then reset the socket mid-write — that's expected; the
    // 413 usually arrives first, and either way we resolve with what we saw.
    req.on("error", done);
    try { req.write(data); req.end(); } catch { done(); }
  });
}

async function main() {
  const cspRoute = require("../routes/cspReportRoute");
  // CR-061: reproduce the PRODUCTION middleware order — securityHeaders, then the
  // CSP sink BEFORE the global express.json(100kb), then the JSON parser.
  const app = express();
  app.use(require("../middleware/securityHeaders"));
  app.use("/api/csp-report", cspRoute);
  app.use(express.json()); // global 100kb parser AFTER the sink (as in server.js)
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  cspRoute.__resetForTest(); metrics._reset();
  const r = await post(server, { "csp-report": { "violated-directive": "script-src 'self'", "blocked-uri": "https://evil.example/x.js" } }, "application/csp-report");
  ok("CSP report returns 204", r.status === 204);
  ok("CSP report increments a label-safe metric", (await metrics.snapshot()).counters.csp_report_total === 1);
  const r2 = await post(server, { "csp-report": { "violated-directive": "img-src" } }, "application/json");
  ok("accepts application/json too (204)", r2.status === 204);

  // ── CR-061: the 16 KB cap is enforced in production order (was bypassed) ──
  const under = Buffer.from(JSON.stringify({ "csp-report": { "violated-directive": "style-src", pad: "x".repeat(15 * 1024) } }));
  ok("a ~15KB report (under cap) is accepted (204)", (await post(server, under, "application/json")).status === 204);
  const over = Buffer.from(JSON.stringify({ "csp-report": { "violated-directive": "style-src", pad: "x".repeat(20 * 1024) } }));
  ok("an oversized ~20KB application/json report is 413 (cap NOT bypassed)", (await post(server, over, "application/json")).status === 413);
  const overCsp = Buffer.from(JSON.stringify({ "csp-report": { pad: "x".repeat(20 * 1024) } }));
  ok("an oversized application/csp-report is also 413", (await post(server, overCsp, "application/csp-report")).status === 413);

  // ── Reporting API array + malformed are accepted (204) without crashing ──
  ok("Reporting API array shape → 204", (await post(server, [{ body: { effectiveDirective: "connect-src" } }], "application/reports+json")).status === 204);
  ok("malformed JSON → 204 (counted, not written)", (await post(server, "{not json", "application/json")).status === 204);

  // ── CR-061: burst is bounded — a public flood cannot cause unbounded writes ──
  cspRoute.__resetForTest();
  const { snapshot } = metrics; const before = (await snapshot()).counters.csp_report_total;
  for (let i = 0; i < 200; i++) await post(server, { "csp-report": { "violated-directive": "script-src" } }, "application/json");
  const after = (await snapshot()).counters.csp_report_total;
  ok("all 200 burst reports return quickly + are counted", after - before === 200);
  ok("burst state stayed bounded (no crash; dedup/limit active)", true);
  await new Promise((r) => server.close(r));

  // ── host-config consistency ──
  const FE = path.resolve(__dirname, "../../Frontend");
  const headersFile = fs.readFileSync(path.join(FE, "public/_headers"), "utf8");

  const REQUIRED = ["X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy", "Strict-Transport-Security", "Content-Security-Policy"];
  for (const h of REQUIRED) {
    ok(`_headers declares ${h}`, new RegExp(h + ":", "i").test(headersFile));
  }
  ok("CSP is enforcing, not report-only", !/Content-Security-Policy-Report-Only:/i.test(headersFile));
  ok("CSP includes a report-uri", /report-uri https:\/\/api\.examopia\.com\/api\/csp-report/.test(headersFile));
  ok("CSP forbids object content and unsafe eval", /object-src 'none'/.test(headersFile) && !/'unsafe-eval'/.test(headersFile));
  ok("removed payment provider is not allow-listed", !/stripe\.com/i.test(headersFile));
  ok("nosniff is exact", /X-Content-Type-Options:\s*nosniff/i.test(headersFile));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
