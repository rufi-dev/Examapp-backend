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

// A board's audience class ids as strings. `classes` may arrive as raw ObjectIds
// (WS/live-status paths) OR as populated {_id,name} objects (getBoard populates +
// leans them) — normalise both, else a populated ref stringifies to "[object
// Object]" and every explicit-audience member is wrongly denied on direct open.
const audienceOf = (b) => (b.classes?.length ? b.classes.map((c) => String(c && c._id ? c._id : c)) : []);

// Owner/admin may EDIT; a student in the audience may only VIEW. Returns
// { ok, canEdit } so the caller can gate reading vs writing.
async function accessLevel(user, board) {
  if (!board) return { ok: false, canEdit: false };
  if (user.role === "admin") return { ok: true, canEdit: true };
  if (String(board.owner) === String(user._id)) return { ok: true, canEdit: true };
  // Homework solve-board: bound to ONE student (the assignee). Only that student may
  // open it, and they may EDIT (write their solution). No class-audience applies.
  if (board.student) {
    const mine = String(board.student) === String(user._id);
    return { ok: mine, canEdit: mine };
  }
  // Everyone else — INCLUDING a teacher-role account who is not the owner — is at
  // most a read-only AUDIENCE member, and only if they hold an approved enrollment
  // that puts them in this board's audience. Authorization is derived from board
  // ownership/admin authority or approved class membership, NEVER from assuming a
  // non-owner "teacher" is forbidden (that mismatch used to reject an enrolled
  // co-teacher whom listClassBoards correctly showed the board — CR-BOARD-007).
  // canEdit stays false here, so canHostLive (canEdit && hasTeacherCapability) can
  // never let a co-teacher host, save, or manage merely because of their role.
  const { classIds, ownerIds } = await studentScope(user._id);
  const audience = audienceOf(board);
  if (!audience.length) {
    // Empty audience = "all approved students of the board owner": the viewer must
    // be enrolled (approved) in a class owned by the board's owner.
    return { ok: ownerIds.includes(String(board.owner)), canEdit: false };
  }
  // Explicit classes: an approved member of any listed class may view it — even if
  // the board was shared by an admin who doesn't own that class.
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
