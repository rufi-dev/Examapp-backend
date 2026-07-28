/*
 * `npm run journey:preview` SAFETY guard — the preview must refuse every cloud /
 * public / non-loopback / non-throwaway Mongo URI. Pure (no DB, no servers).
 */
const {
  assertSafeUri,
  isLoopback,
  isThrowaway,
  isPrivateLanIpv4,
  resolvePreviewHost,
} = require("../scripts/journeyPreview.cjs");
const {
  isSafeHttpJourneyPreview,
  legacyCookiePolicy,
} = require("../controllers/authSessionController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const refuses = (uri) => { try { assertSafeUri(uri); return false; } catch { return true; } };
const accepts = (uri) => { try { assertSafeUri(uri); return true; } catch { return false; } };

// ── loopback + throwaway is accepted ──
ok("loopback + ephemeral db accepted", accepts("mongodb://127.0.0.1:5000/tsj_preview_ephemeral"));
ok("localhost + test db accepted", accepts("mongodb://localhost:27017/preview_test"));

// ── non-loopback hosts refused ──
ok("cloud srv host refused", refuses("mongodb+srv://user:pass@cluster0.abcd.mongodb.net/examopia"));
ok("public IP host refused", refuses("mongodb://10.0.0.5:27017/tsj_preview_ephemeral"));
ok("named cloud host refused", refuses("mongodb://db.example.com:27017/preview_ephemeral"));

// ── loopback but NON-throwaway db refused ──
ok("loopback + production db name refused", refuses("mongodb://127.0.0.1:27017/examopia"));
ok("loopback + examopia_live refused", refuses("mongodb://localhost:27017/examopia_live"));

// ── helpers ──
ok("isLoopback true for 127.0.0.1/localhost/::1", isLoopback("127.0.0.1") && isLoopback("localhost") && isLoopback("::1"));
ok("isLoopback false for a public host", !isLoopback("cluster0.mongodb.net"));
ok("isThrowaway matches ephemeral/preview/test", isThrowaway("tsj_preview_ephemeral") && isThrowaway("x_test") && isThrowaway("e2e_db"));
ok("isThrowaway false for a prod name", !isThrowaway("examopia") && !isThrowaway("examopia_live"));

// Optional phone preview may bind only to a private Wi-Fi address.
ok("private Wi-Fi IPv4 ranges accepted", isPrivateLanIpv4("10.179.78.122") && isPrivateLanIpv4("172.16.1.2") && isPrivateLanIpv4("172.31.255.2") && isPrivateLanIpv4("192.168.1.20"));
ok("public and special IPv4 ranges refused", !isPrivateLanIpv4("8.8.8.8") && !isPrivateLanIpv4("0.0.0.0") && !isPrivateLanIpv4("127.0.0.1"));
ok("blank and loopback preview hosts stay local", resolvePreviewHost("") === "localhost" && resolvePreviewHost("localhost") === "localhost" && resolvePreviewHost("127.0.0.1") === "localhost");
ok("private Wi-Fi preview host retained", resolvePreviewHost("10.179.78.122") === "10.179.78.122");
ok("public preview host is refused", (() => { try { resolvePreviewHost("example.com"); return false; } catch { return true; } })());

const safeHttpPreview = {
  NODE_ENV: "development",
  EXQ_JOURNEY_PREVIEW_HTTP: "1",
  TEACHER_SUCCESS_JOURNEY_ENABLED: "1",
  MONGO_URI: "mongodb://127.0.0.1:27017/tsj_preview_ephemeral",
  FRONTEND_URL: "http://10.179.78.122:5212",
};
ok("run-owned LAN preview is the only mode that receives the reload-safe HTTP cookie",
  isSafeHttpJourneyPreview(safeHttpPreview)
  && legacyCookiePolicy(safeHttpPreview).secure === false
  && legacyCookiePolicy(safeHttpPreview).sameSite === "lax");
ok("production can never relax the Secure cookie even if the preview marker is present",
  !isSafeHttpJourneyPreview({ ...safeHttpPreview, NODE_ENV: "production" })
  && legacyCookiePolicy({ ...safeHttpPreview, NODE_ENV: "production" }).secure === true);
ok("a cloud Mongo target can never relax the Secure cookie",
  !isSafeHttpJourneyPreview({ ...safeHttpPreview, MONGO_URI: "mongodb+srv://cluster.example.com/tsj_preview_ephemeral" }));
ok("a production-named local database can never relax the Secure cookie",
  !isSafeHttpJourneyPreview({ ...safeHttpPreview, MONGO_URI: "mongodb://127.0.0.1:27017/examopia" }));
ok("a public or HTTPS frontend never enters the HTTP-preview exception",
  !isSafeHttpJourneyPreview({ ...safeHttpPreview, FRONTEND_URL: "http://example.com" })
  && !isSafeHttpJourneyPreview({ ...safeHttpPreview, FRONTEND_URL: "https://10.179.78.122:5212" }));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
