/*
 * Teacher Success Journey — teacher-initiated upgrade requests (ADR §10).
 *
 * At most ONE open request per {teacher, target} (partial unique index), so a
 * retried submission is idempotent (returns the existing open request). A
 * request NEVER grants a level or any security capability — it is admin
 * review / product-demand signal only.
 */
const TeacherUpgradeRequest = require("../models/teacherUpgradeRequestModel");
const { isLevel, isSingleStepUp } = require("../config/teacherSuccess/levels");

async function submit({ teacherId, currentLevel, targetLevel, classStudentSize = null, intendedUse = "", requestedBenefit = "", reason = "", contactPreference = "", evidenceSnapshot = undefined, now = new Date() }) {
  if (!isLevel(currentLevel) || !isLevel(targetLevel)) return { ok: false, code: "bad_level" };
  if (!isSingleStepUp(currentLevel, targetLevel)) return { ok: false, code: "not_one_step" };
  try {
    const doc = await TeacherUpgradeRequest.create({
      teacherId, currentLevel, targetLevel, status: "open",
      classStudentSize, intendedUse, requestedBenefit, reason, contactPreference, evidenceSnapshot,
    });
    return { ok: true, request: doc, idempotent: false };
  } catch (e) {
    if (e && (e.code === 11000 || e.code === 11001)) {
      const existing = await TeacherUpgradeRequest.findOne({ teacherId, targetLevel, status: "open" });
      return { ok: true, request: existing, idempotent: true };
    }
    throw e;
  }
}

// Admin decision — records status + audit. Never changes level/capability.
async function decide({ requestId, reviewer, status, decisionReason, now = new Date() }) {
  if (!["approved", "denied", "info_requested"].includes(status)) return { ok: false, code: "bad_status" };
  if (!decisionReason || !String(decisionReason).trim()) return { ok: false, code: "reason_required" };
  // Only an OPEN request may be decided; the transition frees the partial-unique
  // slot so the teacher could open a fresh request later.
  const updated = await TeacherUpgradeRequest.findOneAndUpdate(
    { _id: requestId, status: "open" },
    { $set: { status, reviewer, decisionReason: String(decisionReason).trim(), decidedAt: now } },
    { new: true }
  );
  if (!updated) {
    const r = await TeacherUpgradeRequest.findById(requestId).lean();
    if (!r) return { ok: false, code: "not_found" };
    return { ok: false, code: "already_decided", status: r.status };
  }
  return { ok: true, request: updated };
}

const listForTeacher = (teacherId) => TeacherUpgradeRequest.find({ teacherId }).sort({ createdAt: -1 }).lean();
const listInbox = ({ status = "open" } = {}) => TeacherUpgradeRequest.find({ status }).sort({ createdAt: -1 }).lean();

module.exports = { submit, decide, listForTeacher, listInbox };
