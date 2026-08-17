/*
 * Board access policy — the SINGLE source of truth for "who may open / edit /
 * host" a whiteboard, shared by the HTTP controllers (boardController) and the
 * live realtime hub (boardHub). Extracted from boardController so both paths
 * enforce identical rules. Behavior is byte-identical to the previous inline
 * helpers; only their location changed.
 */
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const { hasTeacherCapability } = require("../middleware/authMiddleware");

// A student's approved classes + the owners of those classes.
async function studentScope(studentId) {
  const classIds = await Enrollment.find({ student: studentId, status: "approved" }).distinct("class");
  const ownerIds = classIds.length
    ? await Class.find({ _id: { $in: classIds } }).distinct("owner")
    : [];
  return { classIds: classIds.map(String), ownerIds: ownerIds.map(String) };
}

// Keep only the classes this user may publish to (their own; admins: any).
async function ownedClassIds(user, raw) {
  let ids = raw;
  if (typeof ids === "string") {
    try {
      ids = JSON.parse(ids);
    } catch {
      ids = ids ? [ids] : [];
    }
  }
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  ids = ids.filter(Boolean).map(String);
  if (!ids.length) return [];
  const found = await Class.find({ _id: { $in: ids } }).select("owner").lean();
  return found
    .filter((c) => user.role === "admin" || String(c.owner) === String(user._id))
    .map((c) => String(c._id));
}

const audienceOf = (b) => (b.classes?.length ? b.classes.map(String) : []);

// Owner/admin may EDIT; a student in the audience may only VIEW. Returns
// { ok, canEdit } so the caller can gate reading vs writing.
async function accessLevel(user, board) {
  if (!board) return { ok: false, canEdit: false };
  if (user.role === "admin") return { ok: true, canEdit: true };
  if (String(board.owner) === String(user._id)) return { ok: true, canEdit: true };
  if (user.role === "teacher") return { ok: false, canEdit: false };
  const { classIds, ownerIds } = await studentScope(user._id);
  const audience = audienceOf(board);
  if (!audience.length) {
    // Empty audience = "all of the board owner's students": the student must be
    // enrolled in a class owned by the board's owner.
    return { ok: ownerIds.includes(String(board.owner)), canEdit: false };
  }
  // Explicit classes: a student in any listed class may view it — even if the
  // board was shared by an admin who doesn't own that class.
  return { ok: audience.some((c) => classIds.includes(c)), canEdit: false };
}

// Migrate a legacy single-scene board to a one-page shape on read; guarantee at
// least one page so the editor always has something to show.
const pagesOf = (board) => {
  if (board.pages && board.pages.length) return board.pages;
  if (board.scene) return [{ name: "Səhifə 1", scene: board.scene }];
  return [{ name: "Səhifə 1", scene: null }];
};

// Hosting a LIVE session requires BOTH board-edit rights (owner/admin) AND an
// approved teacher/admin — mirrors the `teacherOnly` HTTP gate so a PENDING
// teacher (who may momentarily hold own-scope capabilities when the Journey flag
// is on) can never host though the write API refuses their edits.
async function canHostLive(user, board) {
  const { canEdit } = await accessLevel(user, board);
  return canEdit && hasTeacherCapability(user);
}

module.exports = { studentScope, ownedClassIds, audienceOf, accessLevel, pagesOf, canHostLive };
