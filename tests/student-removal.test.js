/*
 * A teacher can remove a student, and cannot delete one.
 *
 * Those are two different actions that read the same way in a UI, and the gap
 * between them is the whole point of this endpoint. A student usually belongs to
 * several teachers; an account is nobody's to destroy but the admin's. So what a
 * teacher revokes is the MEMBERSHIP, and these tests hold that boundary along
 * with the two things a teacher would be right to worry about: that removing
 * someone does not erase what they already did, and that it cannot reach into a
 * class the teacher does not own.
 *
 * Runs against a real Mongo, because the behaviour under test is which documents
 * survive a delete.
 */
const assert = require("assert");

process.env.NODE_ENV = "test";

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

// The handler is an express-async-handler; drive it with the minimum req/res.
const call = async (handler, req) => {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let thrown = null;
  await handler(req, res, (e) => { thrown = e; }).catch((e) => { thrown = e; });
  return { res, thrown };
};

async function main() {
  console.log("a teacher removing a student");

  const mongoose = require("mongoose");
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "removal" });

  const User = require("../models/userModel");
  const Class = require("../models/classModel");
  const Enrollment = require("../models/enrollmentModel");
  const { removeStudentFromMyClasses } = require("../controllers/enrollmentController");

  const mkUser = (name, role) =>
    User.create({ name, email: `${name}@t.test`, password: "x".repeat(12), role, isVerified: true });

  const teacher = await mkUser("teacher", "teacher");
  const other = await mkUser("other", "teacher");
  const student = await mkUser("student", "student");
  const bystander = await mkUser("bystander", "student");

  const a = await Class.create({ name: "9A", owner: teacher._id });
  const b = await Class.create({ name: "11B", owner: teacher._id });
  const foreign = await Class.create({ name: "Not mine", owner: other._id });

  const enrol = (cls, who, status = "approved") =>
    Enrollment.create({ class: cls._id, student: who._id, teacher: cls.owner, status });

  await enrol(a, student);
  await enrol(b, student, "pending");     // a request still waiting
  /*
   * A class that CHANGED HANDS: its owner is the other teacher, but the
   * enrollment still carries our teacher in its denormalised `teacher` field.
   * Scoping the delete by that field instead of by `Class.owner` would let a
   * previous owner reach into a class that is no longer theirs.
   */
  await Enrollment.create({
    class: foreign._id,
    student: student._id,
    teacher: teacher._id,
    status: "approved",
  });
  await enrol(a, bystander);              // must be untouched

  const { res } = await call(removeStudentFromMyClasses, {
    user: teacher,
    params: { studentId: String(student._id) },
  });

  ok("it reports success", res.statusCode === 200, `got ${res.statusCode}`);
  ok("it removed both of this teacher's memberships", res.body?.removed === 2, JSON.stringify(res.body));
  ok(
    "and names the classes so the teacher can see what happened",
    Array.isArray(res.body?.classes) && res.body.classes.sort().join(",") === "11B,9A",
    JSON.stringify(res.body?.classes)
  );

  const left = await Enrollment.find({ student: student._id }).lean();
  ok("the approved membership is gone", !left.some((r) => String(r.class) === String(a._id)));
  /*
   * A pending row left behind would put the student straight back into the
   * teacher's approval queue, so removing them would not stay done.
   */
  ok("so is the pending request", !left.some((r) => String(r.class) === String(b._id)));
  ok(
    "the other teacher's class is untouched",
    left.length === 1 && String(left[0].class) === String(foreign._id),
    JSON.stringify(left.map((r) => String(r.class)))
  );

  const stillThere = await User.findById(student._id).lean();
  ok("the student's ACCOUNT still exists", !!stillThere && !stillThere.deletedAt);

  const others = await Enrollment.countDocuments({ student: bystander._id });
  ok("no other student in the class was affected", others === 1);

  // Removing someone who is not yours must not confirm that they exist.
  const miss = await call(removeStudentFromMyClasses, {
    user: other,
    params: { studentId: String(bystander._id) },
  });
  ok("a student who is not yours gives a plain 404", miss.res.statusCode === 404 || miss.thrown, "");
  ok(
    "...and the bystander keeps their place",
    (await Enrollment.countDocuments({ student: bystander._id })) === 1
  );

  // The account-delete route is the admin's, and must stay that way.
  const routeSrc = require("fs").readFileSync(require("path").join(__dirname, "../routes/userRoute.js"), "utf8");
  ok(
    "deleting an account is still admin-only",
    /router\.delete\('\/deleteUser\/:id',\s*protect,\s*adminOnly,\s*deleteUser\)/.test(routeSrc)
  );
  const quizRoute = require("fs").readFileSync(require("path").join(__dirname, "../routes/quizRoute.js"), "utf8");
  ok(
    "and the teacher's route is teacherOnly",
    /router\.delete\("\/teacher\/student\/:studentId", protect, teacherOnly, removeStudentFromMyClasses\);/.test(quizRoute)
  );

  await mongoose.disconnect();
  await mem.stop();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
