/*
 * Paid packages — plan config + limit guards. Pure/mocked (no live DB): the
 * Mongoose model statics used by helper/planLimits are stubbed per-case.
 */
const assert = require("assert");
const plans = require("../config/plans");
const User = require("../models/userModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const planLimits = require("../helper/planLimits");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
async function throws402(fn, resource) {
  try { await fn(); return false; } catch (e) {
    return e && e.statusCode === 402 && e.code === "plan_limit" && (!resource || e.details?.resource === resource);
  }
}

(async () => {
  // ── config/plans ──────────────────────────────────────────────────────────
  ok("normalizePlan: missing → free", plans.normalizePlan(undefined) === "free" && plans.normalizePlan("bogus") === "free");
  ok("free limits", (() => { const l = plans.limitsFor("free"); return l.classes === 1 && l.students === 10 && l.examCreations === 3; })());
  ok("pro limits", (() => { const l = plans.limitsFor("pro"); return l.classes === 5 && l.students === 40 && l.examCreations === Infinity; })());
  ok("premium unlimited", (() => { const l = plans.limitsFor("premium"); return l.classes === Infinity && l.students === Infinity; })());
  ok("isUnlimited(Infinity/null)", plans.isUnlimited(Infinity) && plans.isUnlimited(null));

  // ── planLimitError shape ────────────────────────────────────────────────────
  {
    const e = planLimits.planLimitError("classes", 1, 3, "free");
    ok("planLimitError → 402 plan_limit with details", e.statusCode === 402 && e.code === "plan_limit" && e.details.resource === "classes" && e.details.limit === 1 && e.details.current === 3 && e.details.plan === "free");
  }

  // ── class cap ───────────────────────────────────────────────────────────────
  const origCount = Class.countDocuments;
  Class.countDocuments = async () => 1;
  ok("free at class cap (1) → 402", await throws402(() => planLimits.assertUnderClassCap({ _id: "u", role: "teacher", plan: "free" }), "classes"));
  Class.countDocuments = async () => 0;
  ok("free under class cap → ok", (await planLimits.assertUnderClassCap({ _id: "u", role: "teacher", plan: "free" })) === undefined);
  Class.countDocuments = async () => 999;
  ok("admin bypasses class cap", (await planLimits.assertUnderClassCap({ _id: "a", role: "admin", plan: "free" })) === undefined);
  ok("premium bypasses class cap (unlimited)", (await planLimits.assertUnderClassCap({ _id: "p", role: "teacher", plan: "premium" })) === undefined);
  Class.countDocuments = origCount;

  // ── student cap (owner-scoped) ──────────────────────────────────────────────
  const origUserFind = User.findById;
  const origClassFind = Class.find;
  const origEnrollFind = Enrollment.find;
  User.findById = () => ({ select: () => ({ lean: async () => ({ plan: "free", role: "teacher" }) }) });
  Class.find = () => ({ distinct: async () => ["c1"] });
  Enrollment.find = () => ({ distinct: async () => ["s1","s2","s3","s4","s5","s6","s7","s8","s9","s10"] }); // 10 = at cap
  ok("free at student cap (10) → 402", await throws402(() => planLimits.assertUnderStudentCap("owner"), "students"));
  ok("at cap: already-counted student joining another class → allowed", (await planLimits.assertUnderStudentCap("owner", "s5")) === undefined);
  ok("at cap: NEW student → 402", await throws402(() => planLimits.assertUnderStudentCap("owner", "sNEW"), "students"));
  Enrollment.find = () => ({ distinct: async () => ["s1"] });
  ok("free under student cap → ok", (await planLimits.assertUnderStudentCap("owner")) === undefined);
  User.findById = () => ({ select: () => ({ lean: async () => ({ plan: "premium", role: "teacher" }) }) });
  Enrollment.find = () => ({ distinct: async () => new Array(9999).fill("s") });
  ok("premium owner bypasses student cap", (await planLimits.assertUnderStudentCap("owner")) === undefined);
  User.findById = origUserFind; Class.find = origClassFind; Enrollment.find = origEnrollFind;

  // ── exam allowance (decrementing, CAS) ──────────────────────────────────────
  const origUpdate = User.updateOne;
  ok("pro skips exam decrement (unlimited)", (await planLimits.consumeExamCreate({ _id: "u", role: "teacher", plan: "pro" })) === undefined);
  ok("admin skips exam decrement", (await planLimits.consumeExamCreate({ _id: "u", role: "admin", plan: "free" })) === undefined);
  // free with allowance → init no-op, decrement succeeds
  User.updateOne = async (filter) => (filter.examCreatesLeft && filter.examCreatesLeft.$gt !== undefined ? { modifiedCount: 1 } : { modifiedCount: 0 });
  ok("free with allowance → decrement ok", (await planLimits.consumeExamCreate({ _id: "u", role: "teacher", plan: "free" })) === undefined);
  // free exhausted → decrement matches nothing → 402
  User.updateOne = async () => ({ modifiedCount: 0 });
  ok("free exhausted → 402 exams", await throws402(() => planLimits.consumeExamCreate({ _id: "u", role: "teacher", plan: "free" }), "exams"));
  User.updateOne = origUpdate;

  // ── expiry ──────────────────────────────────────────────────────────────────
  const past = new Date(Date.now() - 86400000);
  const future = new Date(Date.now() + 86400000);
  ok("isExpired: paid + past expiry → true", planLimits.isExpired({ plan: "pro", planExpiresAt: past }) === true);
  ok("isExpired: paid + future expiry → false", planLimits.isExpired({ plan: "pro", planExpiresAt: future }) === false);
  ok("isExpired: paid + no expiry → false", planLimits.isExpired({ plan: "pro" }) === false);
  ok("isExpired: free → false", planLimits.isExpired({ plan: "free", planExpiresAt: past }) === false);
  ok("effectivePlan: expired pro → free", planLimits.effectivePlan({ plan: "pro", planExpiresAt: past }) === "free");
  ok("effectivePlan: active pro → pro", planLimits.effectivePlan({ plan: "pro", planExpiresAt: future }) === "pro");

  // expired pro reverts to free caps: has 2 classes vs free cap 1 → 402 expired
  const oc = Class.countDocuments;
  Class.countDocuments = async () => 2;
  {
    let e;
    try { await planLimits.assertUnderClassCap({ _id: "u", role: "teacher", plan: "pro", planExpiresAt: past }); } catch (x) { e = x; }
    ok("expired pro over free class cap → 402 expired", !!e && e.statusCode === 402 && e.details.expired === true);
  }
  Class.countDocuments = oc;
  // expired exam creation is hard-blocked
  ok("expired exam create → 402 expired", await (async () => { try { await planLimits.consumeExamCreate({ _id: "u", role: "teacher", plan: "pro", planExpiresAt: past }); return false; } catch (e) { return e.statusCode === 402 && e.details.expired === true; } })());

  assert.strictEqual(failed, 0, `${failed} test(s) failed`);
  console.log(`\n${passed} passed, ${failed} failed`);
})();
