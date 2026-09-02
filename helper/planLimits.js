// Plan-limit enforcement — the count queries + guards used at each resource
// create-point. Limits come from config/plans.js. A blocked create throws a
// typed HTTP 402 the frontend turns into a friendly "upgrade / renew" prompt.
//
// GRANDFATHERING: existing classes/exams/students keep working; these guards
// only block NEW creation once a teacher is at/over their cap. A missing plan
// resolves to "free". Admins are never limited.
//
// EXPIRY: a paid plan past `planExpiresAt` reverts to FREE-tier limits for
// ENFORCEMENT (their existing content is untouched, but new classes/students
// beyond the free caps and new exams are blocked until they renew).

const User = require("../models/userModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const { httpError } = require("../utils/appError");
const { normalizePlan, limitsFor } = require("../config/plans");

const LIMIT_MSG = {
  classes: "Paketinizin sinif limitinə çatdınız. Daha çox sinif üçün paketi yüksəldin.",
  students: "Bu sinif şagird limitinə çatıb. Zəhmət olmasa müəlliminizlə əlaqə saxlayın.",
  exams: "Paketinizin imtahan yaratma limitinə çatdınız. Daha çox imtahan üçün paketi yüksəldin.",
};
const EXPIRED_MSG =
  "Paketinizin müddəti bitib. Davam etmək üçün «Planım» səhifəsindən paketi yeniləyin.";

// 402 Payment Required — carries a structured code + details so the client can
// render an upgrade / renew CTA (see errorMiddleware serialization).
function planLimitError(resource, limit, current, plan, expired = false) {
  return httpError(402, "plan_limit", expired ? EXPIRED_MSG : LIMIT_MSG[resource] || "Paket limiti", {
    reason: expired ? "plan_expired" : "plan_limit",
    resource,
    limit: Number.isFinite(limit) ? limit : null,
    current,
    plan: plan || "free",
    expired: !!expired,
  });
}

const isAdmin = (user) => user && user.role === "admin";
const storedPlan = (user) => normalizePlan(user && user.plan);

// True once a paid plan is past its expiry date.
function isExpired(user) {
  const p = storedPlan(user);
  if (p === "free") return false;
  const exp = user && user.planExpiresAt;
  return !!exp && new Date(exp).getTime() < Date.now();
}

// The plan used for ENFORCEMENT — free if the paid plan has lapsed.
function effectivePlan(user) {
  return isExpired(user) ? "free" : storedPlan(user);
}

// ── counts (reused by the DTO usage block too) ───────────────────────────────
async function classCount(userId) {
  return Class.countDocuments({ owner: userId, deletedAt: null });
}

// Students parked on the waitlist by a plan change (not by the teacher).
async function frozenStudentCount(ownerId) {
  const classIds = await Class.find({ owner: ownerId, deletedAt: null }).distinct("_id");
  if (!classIds.length) return 0;
  const ids = await Enrollment.find({
    class: { $in: classIds },
    status: "pending",
    frozenByPlan: true,
  }).distinct("student");
  return ids.length;
}

async function studentCount(ownerId) {
  const classIds = await Class.find({ owner: ownerId, deletedAt: null }).distinct("_id");
  if (!classIds.length) return 0;
  const ids = await Enrollment.find({
    class: { $in: classIds },
    status: "approved",
  }).distinct("student");
  return ids.length;
}

// ── guards (throw 402 when at/over cap) ──────────────────────────────────────
async function assertUnderClassCap(user) {
  if (isAdmin(user)) return;
  const cap = limitsFor(effectivePlan(user)).classes;
  if (!Number.isFinite(cap)) return; // unlimited
  const used = await classCount(user._id);
  if (used >= cap) throw planLimitError("classes", cap, used, storedPlan(user), isExpired(user));
}

// The cap belongs to the class OWNER (for a student join, that is cls.owner).
// `joiningStudentId` (optional) lets an ALREADY-counted student join another of
// the owner's classes without hitting the cap — the distinct-student total does
// not change, so blocking them would be wrong.
async function assertUnderStudentCap(ownerId, joiningStudentId) {
  const owner = await User.findById(ownerId).select("plan planExpiresAt role").lean();
  if (!owner || owner.role === "admin") return;
  const cap = limitsFor(effectivePlan(owner)).students;
  if (!Number.isFinite(cap)) return; // unlimited
  const classIds = await Class.find({ owner: ownerId, deletedAt: null }).distinct("_id");
  const ids = classIds.length
    ? await Enrollment.find({ class: { $in: classIds }, status: "approved" }).distinct("student")
    : [];
  if (joiningStudentId && ids.some((id) => String(id) === String(joiningStudentId))) return;
  if (ids.length >= cap) throw planLimitError("students", cap, ids.length, storedPlan(owner), isExpired(owner));
}

// Boolean form of the student cap (does the owner have room for this student?).
// An already-counted student always has room. Used to decide approved vs
// waitlisted on join, and to gate approving a waitlisted student.
async function hasStudentRoom(ownerId, joiningStudentId) {
  const owner = await User.findById(ownerId).select("plan planExpiresAt role").lean();
  if (!owner || owner.role === "admin") return true;
  const cap = limitsFor(effectivePlan(owner)).students;
  if (!Number.isFinite(cap)) return true;
  const classIds = await Class.find({ owner: ownerId, deletedAt: null }).distinct("_id");
  const ids = classIds.length
    ? await Enrollment.find({ class: { $in: classIds }, status: "approved" }).distinct("student")
    : [];
  if (joiningStudentId && ids.some((id) => String(id) === String(joiningStudentId))) return true;
  return ids.length < cap;
}

/*
 * Bring an OVER-CAP roster back down to the cap.
 *
 * The gap this closes: every cap was checked only at the moment of adding, and
 * nothing ever re-checked. So a teacher could buy Premium for one month, enrol two
 * hundred students, drop to Pro, and keep running a two-hundred-student business on
 * the forty-student price for ever — the comment above this file called that
 * "grandfathering", but it was really a one-off payment for a permanent allowance.
 *
 * Nothing is deleted. Students over the cap go back to the SAME waitlist the system
 * already uses when a teacher has no room, so their enrollments, history and results
 * are untouched, and `promoteWaitlisted` restores them automatically the moment the
 * cap rises again. Access stops because 62 call sites gate on status "approved".
 *
 * Newest first, so the students a teacher had BEFORE upgrading keep their places and
 * the ones added under the bigger plan are the ones that wait. This is the exact
 * mirror of promoteWaitlisted, which lets the oldest back in first.
 *
 * Returns the number of distinct students frozen.
 */
async function enforceStudentCap(ownerId) {
  const owner = await User.findById(ownerId).select("plan planExpiresAt role").lean();
  if (!owner || owner.role === "admin") return 0;
  const cap = limitsFor(effectivePlan(owner)).students;
  if (!Number.isFinite(cap)) return 0; // unlimited: nothing to enforce

  const classIds = await Class.find({ owner: ownerId, deletedAt: null }).distinct("_id");
  if (!classIds.length) return 0;

  // Distinct students, ordered by their EARLIEST approved enrollment with this
  // teacher — a student in three classes is one student against the cap.
  const rows = await Enrollment.find({ class: { $in: classIds }, status: "approved" })
    .sort({ createdAt: 1 })
    .select("student")
    .lean();
  const seen = [];
  const known = new Set();
  for (const r of rows) {
    const sid = String(r.student);
    if (!known.has(sid)) { known.add(sid); seen.push(r.student); }
  }
  if (seen.length <= cap) return 0;

  const freeze = seen.slice(cap);
  // EVERY enrollment of those students under this teacher, or the distinct count
  // would not actually fall.
  await Enrollment.updateMany(
    { class: { $in: classIds }, student: { $in: freeze }, status: "approved" },
    { $set: { status: "pending", frozenByPlan: true } }
  );
  return freeze.length;
}

/*
 * Bring an OVER-CAP set of exams down to the plan's allowance.
 *
 * The allowance was only ever spent at CREATE time, so exams made before a plan
 * shrank — or before the caps existed at all — kept working for ever. Existing
 * exams now count too: the ones beyond the allowance are blocked, newest first, so
 * a teacher keeps the exams they built up before the limit applied and loses the
 * most recent ones.
 *
 * Nothing is deleted. The exam, its questions and every result stay exactly as they
 * are; students cannot see or sit it, and it returns intact when the plan does.
 *
 * Returns the number of exams blocked (negative is impossible; unblocking is
 * reported separately by releaseExamCap).
 */
async function enforceExamCap(ownerId) {
  const owner = await User.findById(ownerId).select("plan planExpiresAt role").lean();
  if (!owner || owner.role === "admin") return 0;
  const cap = limitsFor(effectivePlan(owner)).examCreations;
  if (!Number.isFinite(cap)) return 0; // unlimited tier

  const Exam = require("../models/examModel");
  const live = await Exam.find({ owner: ownerId, deletedAt: null })
    .sort({ createdAt: 1, _id: 1 })
    .select("_id blockedByPlan")
    .lean();

  const keep = live.slice(0, cap).map((e) => e._id);
  const block = live.slice(cap).map((e) => e._id);

  // Idempotent both ways: a re-run with the same cap changes nothing, and a cap
  // that has risen releases exactly the exams that fit again.
  if (keep.length) {
    await Exam.updateMany(
      { _id: { $in: keep }, blockedByPlan: true },
      { $unset: { blockedByPlan: "" } }
    );
  }
  if (block.length) {
    await Exam.updateMany(
      { _id: { $in: block }, blockedByPlan: { $ne: true } },
      { $set: { blockedByPlan: true } }
    );
  }
  return block.length;
}

// An unlimited tier must actively RELEASE what a smaller one blocked, since
// enforceExamCap returns early before it can unblock anything.
async function releaseExamCap(ownerId) {
  const Exam = require("../models/examModel");
  const res = await Exam.updateMany(
    { owner: ownerId, blockedByPlan: true },
    { $unset: { blockedByPlan: "" } }
  );
  return res.modifiedCount || 0;
}

/*
 * Run after ANY change to a teacher's plan. The two halves are complementary and
 * both are no-ops when they do not apply, so calling both is always correct: a
 * downgrade freezes the excess and promotes nobody, an upgrade frees room and
 * promotes the waitlist.
 */
async function reconcileStudentCap(ownerId) {
  const frozen = await enforceStudentCap(ownerId);
  const promoted = await promoteWaitlisted(ownerId);

  // Exams: an unlimited tier releases everything, a finite one blocks the excess.
  const owner = await User.findById(ownerId).select("plan planExpiresAt role").lean();
  const cap = owner ? limitsFor(effectivePlan(owner)).examCreations : 0;
  let examsBlocked = 0;
  let examsReleased = 0;
  if (owner && owner.role !== "admin") {
    if (Number.isFinite(cap)) examsBlocked = await enforceExamCap(ownerId);
    else examsReleased = await releaseExamCap(ownerId);
  }
  return { frozen, promoted, examsBlocked, examsReleased };
}

// After a plan upgrade/renewal raises the cap, promote waitlisted ("pending")
// students to approved — oldest first — until the room is used up. Distinct
// students already approved elsewhere don't consume room. Returns count promoted.
async function promoteWaitlisted(ownerId) {
  const owner = await User.findById(ownerId).select("plan planExpiresAt role").lean();
  if (!owner) return 0;
  const cap = limitsFor(effectivePlan(owner)).students;
  const classIds = await Class.find({ owner: ownerId, deletedAt: null }).distinct("_id");
  if (!classIds.length) return 0;
  const approvedIds = (
    await Enrollment.find({ class: { $in: classIds }, status: "approved" }).distinct("student")
  ).map(String);
  const approvedSet = new Set(approvedIds);
  let room = Number.isFinite(cap) ? Math.max(0, cap - approvedSet.size) : Infinity;
  if (room <= 0) return 0;
  // Students frozen by a plan change were approved once already, so they come back
  // before someone who has never been let in — then oldest request first.
  const pending = await Enrollment.find({ class: { $in: classIds }, status: "pending" }).sort({
    frozenByPlan: -1,
    createdAt: 1,
  });
  let promoted = 0;
  for (const e of pending) {
    const sid = String(e.student);
    const alreadyCounted = approvedSet.has(sid);
    if (!alreadyCounted && room <= 0) continue; // no room for a NEW distinct student
    e.status = "approved";
    e.frozenByPlan = undefined;
    await e.save();
    promoted += 1;
    if (!alreadyCounted) {
      approvedSet.add(sid);
      if (Number.isFinite(room)) room -= 1;
    }
  }
  return promoted;
}

// Exam creation. Expired paid plans are hard-blocked (renew to continue). A
// genuine free tier consumes its decrementing lifetime allowance. Unlimited
// tiers/admins are a no-op. Runs inside the exam-create transaction.
async function consumeExamCreate(user, session) {
  if (isAdmin(user)) return;
  if (isExpired(user)) {
    throw planLimitError("exams", 0, 0, storedPlan(user), true);
  }
  const cap = limitsFor(effectivePlan(user)).examCreations;
  if (!Number.isFinite(cap)) return; // unlimited tier
  const opts = session ? { session } : {};
  await User.updateOne({ _id: user._id, examCreatesLeft: null }, { $set: { examCreatesLeft: cap } }, opts);
  const res = await User.updateOne(
    { _id: user._id, examCreatesLeft: { $gt: 0 } },
    { $inc: { examCreatesLeft: -1 } },
    opts
  );
  if (res.modifiedCount !== 1) {
    throw planLimitError("exams", cap, 0, storedPlan(user), false);
  }
}

// Usage snapshot for the getUser DTO — reflects EFFECTIVE limits (free if
// lapsed), plus the exam allowance left and an `expired` flag.
async function usageFor(user) {
  const expired = isExpired(user);
  const limits = limitsFor(effectivePlan(user));
  const [classes, students, frozen] = await Promise.all([
    classCount(user._id),
    studentCount(user._id),
    frozenStudentCount(user._id),
  ]);
  const examCap = limits.examCreations;
  return {
    expired,
    classes: { used: classes, limit: Number.isFinite(limits.classes) ? limits.classes : null },
    students: {
      used: students,
      limit: Number.isFinite(limits.students) ? limits.students : null,
      // Waiting because the PLAN does not cover them, not because the teacher
      // has not approved them. The UI must say which.
      frozen,
    },
    examCreates: {
      left: expired
        ? 0
        : Number.isFinite(examCap)
          ? user.examCreatesLeft == null
            ? examCap
            : Math.max(0, user.examCreatesLeft)
          : null, // null = unlimited
      limit: Number.isFinite(examCap) ? examCap : null,
    },
  };
}

module.exports = {
  planLimitError,
  isExpired,
  effectivePlan,
  classCount,
  studentCount,
  assertUnderClassCap,
  assertUnderStudentCap,
  hasStudentRoom,
  promoteWaitlisted,
  enforceStudentCap,
  enforceExamCap,
  releaseExamCap,
  reconcileStudentCap,
  frozenStudentCount,
  consumeExamCreate,
  usageFor,
};
