/*
 * An admin sees — and can act on — every teacher's lesson plans. A teacher still
 * sees and touches only their own.
 *
 * Before: `mine()` let an admin OPEN any plan, but the list showed only the
 * admin's own, and every write passed the admin's id to a service that fences on
 * `{ _id, owner }`, so saving another teacher's plan came back "not found".
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const LessonPlan = require("../models/lessonPlanModel");
const User = require("../models/userModel");
const c = require("../controllers/lessonPlanController");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); } else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

// Drive a real handler with a fake request; resolve with { status, body } or the thrown error.
const call = (handler, user, { params = {}, body = {}, query = {} } = {}) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler({ user, params, body, query }, res, (err) => resolve({ status: err?.status || err?.statusCode || 500, error: err }));
  });

async function main() {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(rs.getUri());

  const admin = { _id: new mongoose.Types.ObjectId(), role: "admin", name: "Admin", email: "a@e.test" };
  const teacherA = { _id: new mongoose.Types.ObjectId(), role: "teacher", name: "Aysel Müəllim", email: "t1@e.test" };
  const teacherB = { _id: new mongoose.Types.ObjectId(), role: "teacher", name: "Bəxtiyar Müəllim", email: "t2@e.test" };
  await User.collection.insertMany([
    { _id: admin._id, name: admin.name, email: admin.email, role: "admin" },
    { _id: teacherA._id, name: teacherA.name, email: teacherA.email, role: "teacher" },
    { _id: teacherB._id, name: teacherB.name, email: teacherB.email, role: "teacher" },
  ]);

  const planA = await LessonPlan.create({ owner: teacherA._id, ownerName: "", title: "Faizlər", stages: [{ name: "Giriş", minutes: 45 }] });
  const planB = await LessonPlan.create({ owner: teacherB._id, ownerName: "Bəxtiyar Müəllim", title: "Tənliklər", stages: [{ name: "Giriş", minutes: 45 }] });
  const planAdmin = await LessonPlan.create({ owner: admin._id, ownerName: "Admin", title: "Admin planı", stages: [{ name: "Giriş", minutes: 45 }] });

  console.log("\nThe list:");
  {
    const asAdmin = await call(c.listPlans, admin);
    const titles = asAdmin.body.plans.map((p) => p.title).sort();
    ok("an admin sees every teacher's plans", JSON.stringify(titles) === JSON.stringify(["Admin planı", "Faizlər", "Tənliklər"]), titles);
    const a = asAdmin.body.plans.find((p) => p.title === "Faizlər");
    ok("each is labelled with its author's current name", a.ownerName === "Aysel Müəllim", a.ownerName);
    ok("and whether it is the admin's own", a.mine === false && asAdmin.body.plans.find((p) => p.title === "Admin planı").mine === true);
    ok("the response says it is the admin view", asAdmin.body.admin === true);

    const asTeacher = await call(c.listPlans, teacherA);
    ok("a teacher still sees only their own", asTeacher.body.plans.length === 1 && asTeacher.body.plans[0].title === "Faizlər");
    ok("and it is marked as theirs", asTeacher.body.plans[0].mine === true);
    ok("and it is not the admin view", asTeacher.body.admin === false);
  }

  console.log("\nOpening a plan:");
  {
    const open = await call(c.getPlan, admin, { params: { id: String(planB._id) } });
    ok("an admin opens another teacher's plan", open.status === 200 && open.body.plan.title === "Tənliklər");
    ok("and is told it is not theirs", open.body.mine === false);
    const foreign = await call(c.getPlan, teacherA, { params: { id: String(planB._id) } });
    ok("a teacher cannot open another teacher's plan", foreign.status === 403, foreign.status);
  }

  console.log("\nActing on another teacher's plan (the bug):");
  {
    const fresh = await LessonPlan.findById(planA._id).lean();
    const saved = await call(c.updatePlan, admin, { params: { id: String(planA._id) }, body: { topic: "Admin düzəlişi", revision: fresh.revision } });
    ok("an admin's edit is saved instead of 'not found'", saved.status === 200 && saved.body.plan.topic === "Admin düzəlişi", saved.error?.message);
    const after = await LessonPlan.findById(planA._id).lean();
    ok("the plan still belongs to the teacher", String(after.owner) === String(teacherA._id));

    const archived = await call(c.archivePlan, admin, { params: { id: String(planA._id) }, body: { archived: true } });
    ok("an admin can archive it", archived.status === 200 && Boolean(archived.body.plan.archivedAt), archived.error?.message);

    const blocked = await call(c.updatePlan, teacherB, { params: { id: String(planA._id) }, body: { topic: "x", revision: after.revision } });
    ok("another teacher still cannot edit it", blocked.status === 403, blocked.status);
    ok("and nothing changed", (await LessonPlan.findById(planA._id).lean()).topic === "Admin düzəlişi");

    const del = await call(c.deletePlan, admin, { params: { id: String(planB._id) } });
    ok("an admin can delete another teacher's draft", del.status === 200 && del.body.deleted === true, del.error?.message);
    ok("it is gone", (await LessonPlan.countDocuments({ _id: planB._id })) === 0);
  }

  void planAdmin;
  await mongoose.disconnect();
  await rs.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} lesson-plan-admin assertions failed`);
  process.exit(0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
