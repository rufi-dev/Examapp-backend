/*
 * AUD-019 — defense-in-depth response headers for the API host (api.examopia.com).
 * The host serves JSON and PDF/file bytes (never an HTML app), so a strict policy
 * is safe: nothing is allowed to frame it, sniff its content type, or (when a
 * response is viewed directly) load active content.
 *
 * HSTS is only emitted over HTTPS (behind Caddy, detected via x-forwarded-proto /
 * req.secure with `trust proxy` set), so it never pins an insecure dev origin.
 */
function securityHeaders(req, res, next) {
  // Never let a browser second-guess a declared Content-Type (matters for /uploads).
  res.setHeader("X-Content-Type-Options", "nosniff");
  // The API must never be framed.
  res.setHeader("X-Frame-Options", "DENY");
  // Don't leak API URLs/tokens via the Referer header.
  res.setHeader("Referrer-Policy", "no-referrer");
  // Lock down powerful features for any directly-viewed response.
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  // API responses carry no first-party scripts; block active content + framing if a
  // response (e.g. an /uploads PDF) is ever opened directly in a browser.
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");

  const isHttps = req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  if (isHttps) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  next();
}

module.exports = securityHeaders;
