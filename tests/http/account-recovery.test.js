/*
 * AUD-008 (partial) regression: a password-reset token is ONE-TIME. Redeeming it
 * twice — sequentially or in parallel — must let exactly one reset succeed, and
 * the token must be gone afterward. Drives the real resetPassword controller
 * against in-memory Mongo. Test ID: AUD-008-T2.
 *
 * OUT OF SCOPE here (remaining AUD-008 parts — see FIX_RESULTS): identity rate
 * limits (AUD-008-T3), uniform anti-enumeration responses (AUD-008-T1), stronger
 * password policy, and the token TTL/lookup index migration.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud008";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-key-aud008";
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Token = require("../../models/tokenModel");
const { hashToken } = require("../../utils");
const { resetPassword } = require("../../controllers/userController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

const mkRes = () => ({ statusCode: 200, _json: undefined, status(c) { this.statusCode = c; return this; }, json(p) { this._json = p; return this; } });
// resetPassword throws on the not-found/expired path (asyncHandler → next); capture it.
async function doReset(rawToken, newPassword) {
  const res = mkRes();
  try {
    await resetPassword({ params: { resetToken: rawToken }, body: { password: newPassword } }, res, (e) => { if (e) throw e; });
  } catch (e) {
    // controller set res.statusCode before throwing
    return { status: res.statusCode >= 400 ? res.statusCode : 400, error: e.message };
  }
  return { status: res.statusCode, body: res._json };
}
async function seedResetToken(userId) {
  const raw = "raw-reset-" + Math.random().toString(36).slice(2);
  await Token.create({ userId, rToken: hashToken(raw), createdAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000 });
  return raw;
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  // --- Sequential reuse: second redemption fails ---
  {
    const user = await User.create({ name: "U1", email: "u1@e.com", password: "origPass12", role: "student" });
    const raw = await seedResetToken(user._id);
    const first = await doReset(raw, "firstNewPass1");
    ok("first reset succeeds (200)", first.status === 200);
    const second = await doReset(raw, "secondNewPass2");
    ok("SECOND reset with the same token FAILS (404)", second.status === 404);
    ok("token was consumed (0 tokens remain)", (await Token.countDocuments({ userId: user._id })) === 0);
    const after = await User.findById(user._id).select("+password");
    ok("password is the FIRST reset's value (second never applied)", await bcrypt.compare("firstNewPass1", after.password));
    ok("second reset password was NOT applied", !(await bcrypt.compare("secondNewPass2", after.password)));
  }

  // --- Parallel reuse: exactly one of two concurrent redemptions succeeds ---
  {
    const user = await User.create({ name: "U2", email: "u2@e.com", password: "origPass12", role: "student" });
    const raw = await seedResetToken(user._id);
    const [a, b] = await Promise.all([doReset(raw, "parallelA11"), doReset(raw, "parallelB22")]);
    const successes = [a, b].filter((r) => r.status === 200).length;
    const notFound = [a, b].filter((r) => r.status === 404).length;
    ok("exactly ONE parallel reset succeeds", successes === 1);
    ok("the other parallel reset returns 404", notFound === 1);
    ok("token consumed after parallel redemption (0 remain)", (await Token.countDocuments({ userId: user._id })) === 0);
  }

  // --- CR-005: invalid input must NOT consume the one-time token ---
  {
    const user = await User.create({ name: "U3", email: "u3@e.com", password: "origPass12", role: "student" });
    const raw = await seedResetToken(user._id);
    // A 6+ element array passes a bare `.length >= 6` check but is not a string;
    // the old flow claimed the token, then failed Mongoose string casting.
    const bad = await doReset(raw, [1, 2, 3, 4, 5, 6, 7, 8]);
    ok("non-string password is rejected (>=400)", bad.status >= 400);
    ok("non-string password does NOT consume the token", (await Token.countDocuments({ userId: user._id })) === 1);
    const stillOrig = await User.findById(user._id).select("+password");
    ok("password unchanged after invalid input", await bcrypt.compare("origPass12", stillOrig.password));
  }

  // --- CR-005: a POST-COMMIT save error must NOT make the token reusable ---
  // (The dangerous case: the password write commits, then save() throws. A
  //  delete-then-restore scheme would re-enable the token and let it change the
  //  password again. Mark-used forbids that.)
  {
    const user = await User.create({ name: "U5", email: "u5@e.com", password: "origPass12", role: "student" });
    const raw = await seedResetToken(user._id);
    const origSave = User.prototype.save;
    // commit the change, THEN throw
    User.prototype.save = async function (...a) { const r = await origSave.apply(this, a); throw new Error("post-commit-error"); };
    let firstErrored = false;
    try { const r = await doReset(raw, "committedPass1"); firstErrored = r.status >= 400; } catch { firstErrored = true; } finally { User.prototype.save = origSave; }
    ok("post-commit save error surfaces an error", firstErrored);
    ok("password WAS changed by the committed write", await bcrypt.compare("committedPass1", (await User.findById(user._id).select("+password")).password));
    const reuse = await doReset(raw, "attackerPass9");
    ok("token CANNOT be reused after a post-commit error (404)", reuse.status === 404);
    const afterReuse = await User.findById(user._id).select("+password");
    ok("password was NOT changed a second time via the same token",
      (await bcrypt.compare("committedPass1", afterReuse.password)) && !(await bcrypt.compare("attackerPass9", afterReuse.password)));
  }

  // --- CR-005: a PRE-COMMIT failure consumes the token (safe) but the user is
  // NOT irreversibly stranded — a NEW reset link still works ---
  {
    const user = await User.create({ name: "U6", email: "u6@e.com", password: "origPass12", role: "student" });
    const raw = await seedResetToken(user._id);
    const origSave = User.prototype.save;
    User.prototype.save = function () { return Promise.reject(new Error("pre-commit-fail")); };
    let failed = false;
    try { const r = await doReset(raw, "wontApply11"); failed = r.status >= 400; } catch { failed = true; } finally { User.prototype.save = origSave; }
    ok("pre-commit failure surfaces an error", failed);
    ok("password unchanged after pre-commit failure", await bcrypt.compare("origPass12", (await User.findById(user._id).select("+password")).password));
    const reuseSame = await doReset(raw, "retrySame22");
    ok("the failed token is not reusable (404)", reuseSame.status === 404);
    // user recovers with a fresh link
    const raw2 = await seedResetToken(user._id);
    const recover = await doReset(raw2, "recovered33");
    ok("user recovers via a NEW reset link (200)", recover.status === 200);
    ok("recovery changed the password", await bcrypt.compare("recovered33", (await User.findById(user._id).select("+password")).password));
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
