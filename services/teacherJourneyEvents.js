/*
 * Teacher Journey — the ONLY bridge between committed business events and XP awards.
 * Every hook is:
 *   - flag-gated (a no-op when TEACHER_SUCCESS_JOURNEY_ENABLED is off),
 *   - called AFTER the business action commits,
 *   - best-effort (awardOrEnqueue never throws / never rolls back the caller),
 *   - server-authoritative + idempotent (the XP ledger's unique key does the dedup).
 *
 * The frontend never calls these. Points are derived here from real domain events.
 */
const crypto = require("crypto");
const TeacherXpEvent = require("../models/teacherXpEventModel");
const Material = require("../models/materialModel");
const xpSvc = require("./teacherXpService");
const { isJourneyEnabled } = require("../config/teacherSuccess/flag");
const { MATERIAL_QUALIFIED_USES } = require("../config/teacherSuccess/xp");

const on = () => isJourneyEnabled(process.env);
const dayKey = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
// A stable, content-derived question id so deleting+recreating equivalent content maps
// to the same award key (never re-awards).
const qHash = (q) => crypto.createHash("sha1").update(JSON.stringify(q || {})).digest("hex").slice(0, 16);

// Exam publish: first-ever publish = 40 XP, otherwise 25; plus 1 XP per unique published
// question (capped). Awarding a publish for the SAME exam more than once is a no-op.
async function onExamPublished(teacherId, examId, questions = [], at = new Date()) {
  if (!on() || !teacherId || !examId) return;
  try {
    const already = await TeacherXpEvent.exists({ teacherId, type: { $in: ["exam.publish.first", "exam.publish"] }, sourceId: String(examId) });
    if (!already) {
      const priorPublishes = await TeacherXpEvent.countDocuments({ teacherId, type: { $in: ["exam.publish.first", "exam.publish"] } });
      const type = priorPublishes === 0 ? "exam.publish.first" : "exam.publish";
      await xpSvc.awardOrEnqueue({ teacherId, type, sourceId: String(examId), at });
    }
    for (const q of Array.isArray(questions) ? questions : []) {
      await xpSvc.awardOrEnqueue({ teacherId, type: "question.published", sourceId: `${examId}:${qHash(q)}`, at });
    }
    await onActiveDay(teacherId, at);
  } catch (_) { /* best-effort; the XP outbox / reconcile recovers */ }
}

// A genuine completed attempt by a unique verified student on the teacher's exam. The
// per-student "first completion" award is idempotent (keyed by student), so it lands
// exactly once no matter how many attempts follow — no explicit "first" detection needed.
async function onAttemptCompleted(teacherId, { studentId, attemptId } = {}, at = new Date()) {
  if (!on() || !teacherId || !attemptId) return;
  try {
    await xpSvc.awardOrEnqueue({ teacherId, type: "attempt.completed", sourceId: `att:${attemptId}`, at });
    if (studentId) await xpSvc.awardOrEnqueue({ teacherId, type: "student.first_completion", sourceId: `stu:${studentId}`, at });
    await onActiveDay(teacherId, at);
  } catch (_) { /* best-effort */ }
}

// A verified student who joined via a shared referral link + completed an exam.
async function onReferredStudentCompleted(teacherId, studentId, at = new Date()) {
  if (!on() || !teacherId || !studentId) return;
  try { await xpSvc.awardOrEnqueue({ teacherId, type: "student.referred_join_complete", sourceId: `refstu:${studentId}`, at }); } catch (_) {}
}

// A valid learning material was uploaded (already passed secure upload validation).
async function onMaterialUploaded(teacherId, materialId, at = new Date()) {
  if (!on() || !teacherId || !materialId) return;
  try { await xpSvc.awardOrEnqueue({ teacherId, type: "material.uploaded", sourceId: `mat:${materialId}`, at }); await onActiveDay(teacherId, at); } catch (_) {}
}

// A verified student opened a material in the in-app viewer. Records a distinct viewer
// idempotently; when the material reaches MATERIAL_QUALIFIED_USES distinct students it
// earns the "useful material" XP once.
async function onMaterialViewed({ material, ownerId, studentId }, at = new Date()) {
  if (!on() || !material || !ownerId || !studentId) return;
  try {
    // $addToSet is idempotent — modifiedCount tells us this was a genuinely NEW viewer.
    const r = await Material.updateOne({ _id: material._id }, { $addToSet: { viewers: studentId } });
    if (!(r && r.modifiedCount)) return;
    const doc = await Material.findById(material._id).select("viewers").lean();
    if (doc && Array.isArray(doc.viewers) && doc.viewers.length >= MATERIAL_QUALIFIED_USES) {
      await xpSvc.awardOrEnqueue({ teacherId: ownerId, type: "material.qualified_use", sourceId: `matq:${material._id}`, at }); // once (idempotent)
    }
  } catch (_) {}
}

// A teacher referral became QUALIFIED (referred teacher verified + did real activity).
async function onReferralQualified(referrerId, refereeId, at = new Date()) {
  if (!on() || !referrerId || !refereeId) return;
  try { await xpSvc.awardOrEnqueue({ teacherId: referrerId, type: "referral.qualified", sourceId: `ref:${refereeId}`, at }); } catch (_) {}
}

// A meaningful active teaching day (once per UTC day).
async function onActiveDay(teacherId, at = new Date()) {
  if (!on() || !teacherId) return;
  try { await xpSvc.awardOrEnqueue({ teacherId, type: "active.day", sourceId: `day:${dayKey(at)}`, at }); } catch (_) {}
}

module.exports = {
  onExamPublished, onAttemptCompleted, onReferredStudentCompleted,
  onMaterialUploaded, onMaterialViewed, onReferralQualified, onActiveDay,
};
