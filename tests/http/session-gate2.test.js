/*
 * AUD-002 Gate 2 regression: legacy-sunset Phase-2 switch, CSRF origin allow-list,
 * reset-password session revocation (no double epoch bump), and metrics.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud002-gate2";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Session = require("../../models/sessionModel");
const { generateToken } = require("../../utils/index");
const { generateAccessToken } = require("../../utils/refreshToken");
const { resolveSessionUser } = require("../../middleware/authMiddleware");
const { _setForTest } = require("../../config/featureFlags");
const svc = require("../../services/sessionService");
const { csrfProtect } = require("../../middleware/csrf");
const metrics = require("../../utils/authMetrics");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const mkUser = () => User.create({ name: "U", email: `u${Math.random().toString(36).slice(2)}@e.com`, password: "origPass12", role: "student" });

// Minimal middleware runner
function runCsrf(req) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; } };
    csrfProtect(req, res, (err) => resolve({ status: res.statusCode, blocked: !!err }));
  });
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  // Phase-2 legacy sunset (REQUIRE_EXP_TOKENS)
  {
    metrics._reset();
    const u = await mkUser();
    const noExp = generateToken(u._id, u.sessionVersion || 0); // legacy, no exp
    const withExp = generateAccessToken(u._id, u.sessionVersion || 0, "sid1", 15 * 60 * 1000);

    _setForTest({ flags: { REQUIRE_EXP_TOKENS: false } }); // Phase 1
    ok("Phase 1: no-exp legacy token is ACCEPTED", !!(await resolveSessionUser(noExp)).user);
    ok("Phase 1: no-exp presentation is counted", (await metrics.snapshot()).counters.auth_no_exp_token_total >= 1);

    _setForTest({ flags: { REQUIRE_EXP_TOKENS: true } }); // Phase 2
    const rej = await resolveSessionUser(noExp);
    ok("Phase 2: no-exp token is REJECTED", !!rej.error && rej.error.kind === "auth_exp_required");
    ok("Phase 2: an exp-bearing access token still authenticates", !!(await resolveSessionUser(withExp)).user);
    _setForTest({ flags: { REQUIRE_EXP_TOKENS: false } });
  }

  // CSRF origin allow-list
  {
    ok("CSRF: safe GET passes", (await runCsrf({ method: "GET", headers: {} })).status === 200);
    ok("CSRF: Bearer-auth POST bypasses (not cookie-CSRF)", (await runCsrf({ method: "POST", headers: { authorization: "Bearer x" } })).status === 200);
    ok("CSRF: cookie POST with allowed Origin passes", (await runCsrf({ method: "POST", headers: { origin: "https://examopia.com" } })).status === 200);
    ok("CSRF: cookie POST with disallowed Origin ⇒ 403", (await runCsrf({ method: "POST", headers: { origin: "https://evil.example" } })).status === 403);
    ok("CSRF: cookie POST with NO Origin ⇒ 403", (await runCsrf({ method: "POST", headers: {} })).status === 403);
    ok("CSRF: Referer fallback (allowed) passes", (await runCsrf({ method: "POST", headers: { referer: "https://examopia.com/profile" } })).status === 200);
  }

  // Reset-password session revocation: EPOCH-SCOPED cleanup (revoke old-epoch
  // sessions below the committed target), no second epoch bump (CR-015).
  {
    const u = await mkUser(); // sessionVersion 0
    const s1 = await svc.createSession(u, {}); // authVersion 0
    const s2 = await svc.createSession(await User.findById(u._id), {}); // authVersion 0
    // Reset bumps the epoch to 1 (durable fence) then calls cleanup with target=1.
    await User.updateOne({ _id: u._id }, { $inc: { sessionVersion: 1 } });
    const before = (await User.findById(u._id)).sessionVersion || 0; // 1
    await svc.revokeAllSessions(u._id, before);
    const after = (await User.findById(u._id)).sessionVersion || 0;
    ok("reset cleanup: old-epoch sessions revoked", !!(await Session.findById(s1.sid)).revokedAt && !!(await Session.findById(s2.sid)).revokedAt);
    ok("reset cleanup: revokeAllSessions did NOT bump the epoch again", after === before);
    // A NEW current-epoch session created before cleanup drains must survive.
    const uNow = await User.findById(u._id);
    const sNew = await svc.createSession(uNow, {}); // authVersion 1 (current)
    await svc.revokeAllSessions(u._id, 1); // re-run cleanup with the same target
    ok("CR-015: a new current-epoch session is NOT revoked by old cleanup", !(await Session.findById(sNew.sid)).revokedAt);
  }

  // Metrics snapshot shape (label-safe: no PII in labels)
  {
    metrics._reset();
    metrics.refreshOutcome("rotated"); metrics.refreshOutcome("theft_403"); metrics.theftConfirmed();
    const snap = await metrics.snapshot();
    ok("metrics: refresh outcomes recorded by bounded label", snap.refreshOutcomeTotal.rotated === 1 && snap.refreshOutcomeTotal.theft_403 === 1);
    ok("metrics: confirmed theft counted", snap.counters.auth_refresh_theft_total === 1);
    ok("metrics: live gauges present", typeof snap.gauges.activeSessions === "number" && typeof snap.gauges.fenceDepth === "number");
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
