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
  const pending = await Enrollment.find({ class: { $in: classIds }, status: "pending" }).sort({ createdAt: 1 });
  let promoted = 0;
  for (const e of pending) {
    const sid = String(e.student);
    const alreadyCounted = approvedSet.has(sid);
    if (!alreadyCounted && room <= 0) continue; // no room for a NEW distinct student
    e.status = "approved";
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
  const [classes, students] = await Promise.all([classCount(user._id), studentCount(user._id)]);
  const examCap = limits.examCreations;
  return {
    expired,
    classes: { used: classes, limit: Number.isFinite(limits.classes) ? limits.classes : null },
    students: { used: students, limit: Number.isFinite(limits.students) ? limits.students : null },
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
  consumeExamCreate,
  usageFor,
};
