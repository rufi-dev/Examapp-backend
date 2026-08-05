// Server-side onboarding gate: an account created AFTER the gate shipped must
// have a real phone (+ grade for students) before it can act. Pure req/res mock —
// no DB. Pairs with the frontend ProfileCompletionGate + helper/profileComplete.js.
const assert = require("assert");
const { requireCompleteProfile } = require("../middleware/authMiddleware");

const GATE_SINCE = 1785670907000; // must match ONBOARD_GATE_SINCE
const POST = GATE_SINCE + 86400000; // a day after the gate
const PRE = GATE_SINCE - 86400000; // a day before the gate

let passed = 0,
  failed = 0;
const mkRes = () => ({
  statusCode: 200,
  body: null,
  status(c) {
    this.statusCode = c;
    return this;
  },
  json(b) {
    this.body = b;
    return this;
  },
});
async function run(label, user, expect) {
  const req = { user };
  const res = mkRes();
  let nexted = false;
  await requireCompleteProfile(req, res, () => (nexted = true));
  const blocked = res.statusCode === 403 && res.body && res.body.reason === "incomplete_profile";
  const ok = expect === "block" ? blocked && !nexted : nexted && !blocked;
  if (ok) {
    passed++;
    console.log("  ok  ", label);
  } else {
    failed++;
    console.log("  FAIL", label, JSON.stringify({ statusCode: res.statusCode, body: res.body, nexted }));
  }
}

(async () => {
  // Post-gate students missing phone or grade are blocked.
  await run("post-gate student, default phone +994, no grade → block", { role: "student", phone: "+994", grade: "", createdAt: new Date(POST) }, "block");
  await run("post-gate student, valid phone, no grade → block", { role: "student", phone: "+994 55 123 45 67", grade: "", createdAt: new Date(POST) }, "block");
  await run("post-gate student, no phone, has grade → block", { role: "student", phone: "+994", grade: "9", createdAt: new Date(POST) }, "block");
  // Post-gate student fully complete → allowed.
  await run("post-gate student, valid phone + grade → allow", { role: "student", phone: "+994 55 123 45 67", grade: "9", createdAt: new Date(POST) }, "allow");
  // Post-gate teacher needs only a valid phone.
  await run("post-gate teacher, default phone → block", { role: "teacher", phone: "+994", createdAt: new Date(POST) }, "block");
  await run("post-gate teacher, valid phone → allow", { role: "teacher", phone: "+994 50 987 65 43", createdAt: new Date(POST) }, "allow");
  // Pre-gate accounts are grandfathered even when incomplete.
  await run("pre-gate student, no phone/grade → allow (grandfathered)", { role: "student", phone: "+994", grade: "", createdAt: new Date(PRE) }, "allow");
  // Missing/unparseable createdAt is treated as OLD → allowed.
  await run("no createdAt → allow (treated as old)", { role: "student", phone: "+994", grade: "" }, "allow");
  // No user (defensive) → allowed.
  await run("no user → allow", null, "allow");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
