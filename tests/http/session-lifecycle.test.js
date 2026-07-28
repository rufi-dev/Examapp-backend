/*
 * AUD-002 (partial) + CR-001/CR-002 regression: a password RESET (driven through
 * the real resetPassword controller) revokes previously-issued tokens, and that
 * revocation is enforced on EVERY auth path — protect (strict), attachUser
 * (optional), and loginStatus. Legacy tokens (no `sv`) stay grandfathered.
 *
 * Controller/middleware integration against in-memory Mongo (no HTTP server).
 * Test IDs: AUD-002-T2 (reset revokes old token), CR-001 (all-path enforcement).
 *
 * OUT OF SCOPE (documented, not asserted as fixed): token expiry, refresh
 * rotation, change-password revocation, reset-token one-time consumption (AUD-008).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud002";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-key-aud002";
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Token = require("../../models/tokenModel");
const { generateToken, hashToken } = require("../../utils");
const { protect, attachUser } = require("../../middleware/authMiddleware");
const { resetPassword, loginStatus } = require("../../controllers/userController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

const mkReq = (token, extra = {}) => ({
  headers: { authorization: `Bearer ${token}`, "user-agent": "jest" },
  cookies: {}, originalUrl: "/x", method: "GET", ip: "127.0.0.1", ...extra,
});
const mkRes = () => ({ statusCode: 200, _json: undefined, status(c) { this.statusCode = c; return this; }, json(p) { this._json = p; return this; } });

async function runProtect(token) {
  const req = mkReq(token), res = mkRes(); let err;
  try { await protect(req, res, (e) => { err = e; }); } catch (e) { err = e; }
  return { ok: !err && !!req.user, status: res.statusCode };
}
async function runAttach(token) {
  const req = mkReq(token), res = mkRes();
  await attachUser(req, res, () => {});
  return { authed: !!req.user };
}
async function runLoginStatus(token) {
  const req = mkReq(token), res = mkRes();
  await loginStatus(req, res, (e) => { if (e) throw e; });
  return res._json;
}
// Accepted by ALL THREE paths?
async function acceptedEverywhere(token) {
  const p = await runProtect(token), a = await runAttach(token), l = await runLoginStatus(token);
  return { protect: p.ok, attach: a.authed, loginStatus: l, protectStatus: p.status };
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const user = await User.create({ name: "U", email: "u@e.com", password: "origPass12", role: "student" });
  ok("new user starts at sessionVersion 0", user.sessionVersion === 0);

  const token0 = generateToken(user._id, user.sessionVersion); // sv = 0
  ok("generateToken embeds sv claim", jwt.decode(token0).sv === 0);

  const before = await acceptedEverywhere(token0);
  ok("current token accepted by protect", before.protect === true);
  ok("current token accepted by attachUser", before.attach === true);
  ok("current token reported valid by loginStatus", before.loginStatus === true);

  // --- Drive the REAL reset controller (CR-002) ---
  const rawReset = "reset-token-raw-abc123";
  await Token.create({
    userId: user._id, rToken: hashToken(rawReset),
    createdAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const oldHash = (await User.findById(user._id).select("+password")).password;

  const resetRes = mkRes();
  await resetPassword({ params: { resetToken: rawReset }, body: { password: "brandNewPass9" } }, resetRes, (e) => { if (e) throw e; });
  ok("resetPassword returns 200", resetRes.statusCode === 200);

  const afterUser = await User.findById(user._id).select("+password");
  ok("reset re-hashed the password (hash changed)", afterUser.password !== oldHash);
  ok("reset stored the NEW password (bcrypt verifies)", await bcrypt.compare("brandNewPass9", afterUser.password));
  ok("reset incremented sessionVersion to 1", afterUser.sessionVersion === 1);

  // --- CR-001: the old token must fail on ALL THREE paths now ---
  const after = await acceptedEverywhere(token0);
  ok("after reset: protect REJECTS old token (401)", after.protect === false && after.protectStatus === 401);
  ok("after reset: attachUser REJECTS old token (anonymous)", after.attach === false);
  ok("after reset: loginStatus reports FALSE for old token", after.loginStatus === false);

  // A freshly-issued token (sv=1) works everywhere again.
  const fresh = generateToken(user._id, afterUser.sessionVersion);
  const freshOk = await acceptedEverywhere(fresh);
  ok("fresh token (sv=1) accepted on all paths", freshOk.protect && freshOk.attach && freshOk.loginStatus === true);

  // Backward-compat: a legacy token with NO sv claim is grandfathered (documented
  // residual risk — NOT global revocation).
  const legacy = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET);
  const legacyOk = await acceptedEverywhere(legacy);
  ok("legacy token (no sv) still accepted on all paths (grandfathered residual)", legacyOk.protect && legacyOk.attach && legacyOk.loginStatus === true);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
