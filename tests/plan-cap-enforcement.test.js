/*
 * Closing the "one month of Premium buys a permanent roster" gap.
 *
 * Every cap was checked only when ADDING a student and never re-checked, so a
 * teacher could buy Premium, enrol two hundred students, drop to Pro, and keep
 * running a two-hundred-student business on the forty-student price for ever.
 *
 * Run against a real in-memory Mongo, because the whole thing is distinct-student
 * counting across enrollments and that is exactly where a mocked test would lie.
 *
 * The properties that matter:
 *   - a downgrade brings the roster down to the new cap, immediately;
 *   - NOTHING is deleted — the excess is parked on the same waitlist the system
 *     already uses, and comes back automatically when the cap rises;
 *   - a student in several of the teacher's classes counts ONCE and is frozen
 *     completely, or the count would not actually fall;
 *   - the students who were there BEFORE the upgrade keep their places;
 *   - a plan that has merely LAPSED is enforced too, by the sweep;
 *   - a teacher's own rejections are never confused with a plan freeze.
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/userModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const planLimits = require("../helper/planLimits");
const { sweepExpiredPlans } = require("../jobs/planExpiry");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

async function teacher(plan, planExpiresAt = null) {
  seq += 1;
  return User.create({
    name: `Müəllim ${seq}`,
    email: `t${seq}@example.com`,
    password: "x".repeat(20),
    role: "teacher",
    plan,
    planExpiresAt,
  });
}

// n students enrolled in one class, oldest first, one minute apart so the
// ordering the enforcement depends on is unambiguous.
async function enrol(cls, n, from = 0) {
  const made = [];
  for (let i = 0; i < n; i++) {
    seq += 1;
    const st = await User.create({
      name: `Şagird ${seq}`,
      email: `s${seq}@example.com`,
      password: "x".repeat(20),
      role: "student",
    });
    await Enrollment.create({
      student: st._id,
      class: cls._id,
      teacher: cls.owner,
      status: "approved",
      createdAt: new Date(Date.now() - (1000 - from - i) * 60000),
    });
    made.push(st);
  }
  return made;
}

const approvedCount = (ownerId) => planLimits.studentCount(ownerId);

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  console.log("\n1. Downgrading brings the roster down to the new cap:");
  {
    const t = await teacher("premium");
    const cls = await Class.create({ owner: t._id, name: "9A" });
    const students = await enrol(cls, 50);
    ok("precondition: 50 approved on premium", (await approvedCount(t._id)) === 50);
    ok("premium enforces nothing", (await planLimits.enforceStudentCap(t._id)) === 0);

    // The exploit: pay once, enrol everyone, drop to the cheaper tier.
    await User.updateOne({ _id: t._id }, { $set: { plan: "pro" } });
    const frozen = await planLimits.enforceStudentCap(t._id);
    ok("pro (cap 40) freezes exactly the excess", frozen === 10, frozen);
    ok("the roster is now at the cap", (await approvedCount(t._id)) === 40, await approvedCount(t._id));

    // Nothing is destroyed: the enrollments are still there, just waiting.
    const total = await Enrollment.countDocuments({ class: cls._id });
    ok("no enrollment was deleted", total === 50, total);
    ok("the frozen ten are marked as plan-frozen", (await Enrollment.countDocuments({ class: cls._id, frozenByPlan: true })) === 10);
    ok("and the usage snapshot reports them", (await planLimits.frozenStudentCount(t._id)) === 10);

    // The teacher keeps the students they had BEFORE upgrading; the last ten in
    // are the ones that wait.
    const stillIn = new Set(
      (await Enrollment.find({ class: cls._id, status: "approved" }).distinct("student")).map(String)
    );
    ok("the earliest 40 keep their places", students.slice(0, 40).every((s) => stillIn.has(String(s._id))));
    ok("the newest 10 are the ones frozen", students.slice(40).every((s) => !stillIn.has(String(s._id))));

    ok("running it again changes nothing", (await planLimits.enforceStudentCap(t._id)) === 0);
  }

  console.log("\n2. Upgrading gives them straight back:");
  {
    const t = await teacher("premium");
    const cls = await Class.create({ owner: t._id, name: "9B" });
    await enrol(cls, 45);
    await User.updateOne({ _id: t._id }, { $set: { plan: "pro" } });
    await planLimits.enforceStudentCap(t._id);
    ok("precondition: 5 frozen on pro", (await planLimits.frozenStudentCount(t._id)) === 5);

    await User.updateOne({ _id: t._id }, { $set: { plan: "premium" } });
    const { promoted, frozen } = await planLimits.reconcileStudentCap(t._id);
    ok("re-upgrading promotes them back", promoted === 5, promoted);
    ok("and freezes nobody", frozen === 0);
    ok("the whole roster is active again", (await approvedCount(t._id)) === 45, await approvedCount(t._id));
    ok("the plan-frozen mark is cleared", (await planLimits.frozenStudentCount(t._id)) === 0);
  }

  console.log("\n3. A student in several classes counts once and freezes completely:");
  {
    const t = await teacher("premium");
    const a = await Class.create({ owner: t._id, name: "A" });
    const b = await Class.create({ owner: t._id, name: "B" });
    const first = await enrol(a, 40);
    const extra = await enrol(a, 3, 100);
    // The three over the cap are ALSO in a second class.
    for (const s of extra) {
      await Enrollment.create({ student: s._id, class: b._id, teacher: t._id, status: "approved" });
    }
    ok("precondition: 43 distinct students", (await approvedCount(t._id)) === 43, await approvedCount(t._id));

    await User.updateOne({ _id: t._id }, { $set: { plan: "pro" } });
    ok("three distinct students are frozen", (await planLimits.enforceStudentCap(t._id)) === 3);
    ok("the distinct count really falls to the cap", (await approvedCount(t._id)) === 40, await approvedCount(t._id));
    // If only one of the two enrollments were frozen the student would still be
    // approved somewhere, and the count above would not have moved.
    ok(
      "their SECOND enrollment is frozen too",
      (await Enrollment.countDocuments({ class: b._id, status: "approved" })) === 0
    );
    ok("the 40 originals are untouched", first.length === 40 && (await Enrollment.countDocuments({ class: a._id, status: "approved" })) === 40);
  }

  console.log("\n4. A lapsed plan is enforced by the sweep, not left for ever:");
  {
    const t = await teacher("premium", new Date(Date.now() - 2 * DAY));
    const cls = await Class.create({ owner: t._id, name: "Lapsed" });
    await enrol(cls, 30);
    ok("precondition: 30 approved, plan expired 2 days ago", (await approvedCount(t._id)) === 30);

    const r = await sweepExpiredPlans();
    ok("the sweep found the lapsed account", r.checked >= 1, JSON.stringify(r));
    ok("free-tier cap (10) is applied", (await approvedCount(t._id)) === 10, await approvedCount(t._id));
    ok("the other 20 are waiting, not gone", (await planLimits.frozenStudentCount(t._id)) === 20);
    ok("nothing was deleted", (await Enrollment.countDocuments({ class: cls._id })) === 30);

    // Already settled: it must not re-scan the same account on every pass.
    const again = await sweepExpiredPlans();
    ok("a settled account is not swept again", again.checked === 0, JSON.stringify(again));

    const stamped = await User.findById(t._id).select("planCapEnforcedAt").lean();
    ok("and it is stamped", !!stamped.planCapEnforcedAt);
  }

  console.log("\n5. It never touches what it should not:");
  {
    // An unlimited plan is a no-op even with a big roster.
    const t = await teacher("premium");
    const cls = await Class.create({ owner: t._id, name: "Big" });
    await enrol(cls, 60);
    ok("premium freezes nobody", (await planLimits.enforceStudentCap(t._id)) === 0);
    ok("the roster is intact", (await approvedCount(t._id)) === 60);

    // A teacher's OWN waitlist is not a plan freeze, and must not be mislabelled.
    seq += 1;
    const waiting = await User.create({ name: "W", email: `w${seq}@example.com`, password: "x".repeat(20), role: "student" });
    await Enrollment.create({ student: waiting._id, class: cls._id, teacher: t._id, status: "pending" });
    ok("a normal pending join is not counted as plan-frozen", (await planLimits.frozenStudentCount(t._id)) === 0);

    // Admins are never capped.
    seq += 1;
    const adm = await User.create({ name: "A", email: `a${seq}@example.com`, password: "x".repeat(20), role: "admin", plan: "free" });
    const acls = await Class.create({ owner: adm._id, name: "Admin" });
    await enrol(acls, 25);
    ok("an admin is never capped", (await planLimits.enforceStudentCap(adm._id)) === 0);
    ok("their roster is untouched", (await approvedCount(adm._id)) === 25);

    // A teacher with no classes at all must not blow up.
    const empty = await teacher("free");
    ok("a teacher with no classes is a no-op", (await planLimits.enforceStudentCap(empty._id)) === 0);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} plan-cap assertions failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
