/*
 * AUD-019 — the API sets defense-in-depth response headers, and HSTS only over
 * HTTPS. Exercised over a real socket through the real securityHeaders middleware.
 */
const http = require("http");
const express = require("express");
const securityHeaders = require("../../middleware/securityHeaders");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function request(server, headers = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/", headers }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject); req.end();
  });
}

async function main() {
  const app = express();
  app.use(securityHeaders);
  app.get("/", (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const plain = await request(server);
  ok("X-Content-Type-Options: nosniff", plain.headers["x-content-type-options"] === "nosniff");
  ok("X-Frame-Options: DENY", plain.headers["x-frame-options"] === "DENY");
  ok("Referrer-Policy: no-referrer", plain.headers["referrer-policy"] === "no-referrer");
  ok("Permissions-Policy present + locks camera/mic", /camera=\(\)/.test(plain.headers["permissions-policy"] || "") && /microphone=\(\)/.test(plain.headers["permissions-policy"] || ""));
  ok("Content-Security-Policy blocks default + framing", /default-src 'none'/.test(plain.headers["content-security-policy"] || "") && /frame-ancestors 'none'/.test(plain.headers["content-security-policy"] || ""));
  ok("NO HSTS over plain http", !plain.headers["strict-transport-security"]);

  // Behind the proxy an HTTPS request is signalled via x-forwarded-proto.
  const secure = await request(server, { "x-forwarded-proto": "https" });
  ok("HSTS emitted over https (1 year, includeSubDomains, preload)", /max-age=31536000/.test(secure.headers["strict-transport-security"] || "") && /includeSubDomains/.test(secure.headers["strict-transport-security"] || "") && /preload/.test(secure.headers["strict-transport-security"] || ""));
  ok("HSTS handles a comma-separated x-forwarded-proto", !!(await request(server, { "x-forwarded-proto": "https, http" })).headers["strict-transport-security"]);

  await new Promise((r) => server.close(r));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
