/*
 * Teacher Success Journey — manual promotion + correction (ADR §9).
 *
 * Only an admin promotes (enforced at the route). A normal promotion advances
 * EXACTLY ONE level via an advance-only compare-and-set on (teacherLevel,
 * levelVersion), so concurrent/retried clicks promote at most once. Every change
 * writes an IMMUTABLE TeacherLevelHistory row (from/to/source/reason/actor +
 * before/after version). A correction/reversal may move to any level (kind
 * "correction") but NEVER removes core creation access — level is not access.
 *
 * Growth level is recognition only; this service never touches capabilities.
 */
const mongoose = require("mongoose");
const User = require("../models/userModel");
const TeacherLevelHistory = require("../models/teacherLevelHistoryModel");
const { nextLevel, isLevel, levelIndex } = require("../config/teacherSuccess/levels");

const isDup = (e) => e && (e.code === 11000 || e.code === 11001);

/*
 * CR-126: write the immutable history row keyed by the DETERMINISTIC operation id
 * (teacherId + levelVersionAfter). Idempotent — a duplicate (retry after a
 * crash) is a no-op, and a missing row (crash after the level CAS, before the
 * history write) is REPAIRED by re-calling this with the same version. Returns
 * true if it created the row, false if it already existed.
 */
async function ensureHistory(row) {
  try { await TeacherLevelHistory.create(row); return true; }
  catch (e) { if (isDup(e)) return false; throw e; }
}

// Promote one step from (fromLevel@fromVersion). Recoverable + idempotent.
async function promote({ teacherId, actorId, reason, fromLevel, fromVersion, source = "admin", now = new Date() }) {
  if (!reason || !String(reason).trim()) return { ok: false, code: "reason_required" };
  if (!isLevel(fromLevel)) return { ok: false, code: "bad_from_level" };
  const toLevel = nextLevel(fromLevel);
  if (!toLevel) return { ok: false, code: "already_at_top" };
  const historyRow = {
    teacherId, fromLevel, toLevel, source, kind: "promotion", reason: String(reason).trim(),
    actor: actorId, levelVersionBefore: fromVersion, levelVersionAfter: fromVersion + 1,
  };

  // Advance-only CAS: only the caller who sees the exact current (level,version) wins.
  const updated = await User.findOneAndUpdate(
    { _id: teacherId, teacherLevel: fromLevel, levelVersion: fromVersion, role: "teacher" },
    { $set: { teacherLevel: toLevel, levelSince: now, levelSource: source }, $inc: { levelVersion: 1 } },
    { new: true }
  );

  if (!updated) {
    const u = await User.findById(teacherId).lean();
    if (!u) return { ok: false, code: "not_found" };
    // Retried click OR a crash between the level CAS and the history write:
    // the level already advanced — REPAIR the (possibly missing) history row.
    if (u.teacherLevel === toLevel && u.levelVersion === fromVersion + 1) {
      const created = await ensureHistory(historyRow);
      return { ok: true, idempotent: true, repairedHistory: created, level: u.teacherLevel, levelVersion: u.levelVersion };
    }
    return { ok: false, code: "stale_version", currentLevel: u.teacherLevel, currentVersion: u.levelVersion };
  }

  await ensureHistory(historyRow);
  return { ok: true, idempotent: false, level: toLevel, levelVersion: fromVersion + 1 };
}

// Exceptional admin correction/reversal to any level (stronger confirmation is a
// route concern). CAS on (fromLevel, fromVersion) so it too applies once.
async function correct({ teacherId, actorId, toLevel, reason, fromLevel, fromVersion, now = new Date() }) {
  if (!reason || !String(reason).trim()) return { ok: false, code: "reason_required" };
  if (!isLevel(fromLevel) || !isLevel(toLevel)) return { ok: false, code: "bad_level" };
  if (levelIndex(toLevel) === levelIndex(fromLevel)) return { ok: false, code: "no_change" };

  const updated = await User.findOneAndUpdate(
    { _id: teacherId, teacherLevel: fromLevel, levelVersion: fromVersion, role: "teacher" },
    { $set: { teacherLevel: toLevel, levelSince: now, levelSource: "admin" }, $inc: { levelVersion: 1 } },
    { new: true }
  );
  const historyRow = {
    teacherId, fromLevel, toLevel, source: "admin", kind: "correction", reason: String(reason).trim(),
    actor: actorId, levelVersionBefore: fromVersion, levelVersionAfter: fromVersion + 1,
  };
  if (!updated) {
    const u = await User.findById(teacherId).lean();
    if (!u) return { ok: false, code: "not_found" };
    if (u.teacherLevel === toLevel && u.levelVersion === fromVersion + 1) {
      const created = await ensureHistory(historyRow);
      return { ok: true, idempotent: true, repairedHistory: created, level: u.teacherLevel, levelVersion: u.levelVersion };
    }
    return { ok: false, code: "stale_version", currentLevel: u.teacherLevel, currentVersion: u.levelVersion };
  }
  await ensureHistory(historyRow);
  return { ok: true, idempotent: false, level: toLevel, levelVersion: fromVersion + 1 };
}

async function history(teacherId) {
  return TeacherLevelHistory.find({ teacherId }).sort({ createdAt: -1 }).lean();
}

module.exports = { promote, correct, history };
