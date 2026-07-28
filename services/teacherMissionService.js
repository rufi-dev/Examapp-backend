/*
 * Teacher Journey — onboarding mission progress. Missions are DERIVED from real
 * committed server data (classes, exams, question docs, published exams, student
 * attempts, materials, profile completeness) — never a client "complete" action and
 * never client-asserted. progressFor() computes each mission's current/target, stamps
 * completedAt once (stable), and — when the WHOLE chain is complete — awards the chain
 * bonus XP exactly once (idempotent, via the durable outbox on failure).
 *
 * Flag-gating is the caller's responsibility (routes are requireJourney-guarded).
 */
const Exam = require("../models/examModel");
const ClassModel = require("../models/classModel");
const Question = require("../models/questionModel");
const Result = require("../models/resultModel");
const TeacherMissionProgress = require("../models/teacherMissionProgressModel");
const activitySvc = require("./teacherActivityService");
const { ONBOARDING, CHAIN_XP_TYPE } = require("../config/teacherSuccess/missions");
const xpCfg = require("../config/teacherSuccess/xp");

// The real, server-authoritative signals each mission reads.
async function missionMetrics(teacherId, user, activity) {
  const examIds = await Exam.find({ owner: teacherId }).distinct("_id");
  const [classes, exams, questions, invited] = await Promise.all([
    ClassModel.countDocuments({ owner: teacherId }),
    Exam.countDocuments({ owner: teacherId }),
    examIds.length ? Question.countDocuments({ exam: { $in: examIds } }) : 0,
    examIds.length ? Result.distinct("userId", { examId: { $in: examIds }, userId: { $ne: teacherId } }) : [],
  ]);
  const profileComplete = user && user.name && user.phone ? 1 : 0;
  return {
    profileComplete,
    classes,
    exams,
    questions,
    publishedExams: activity.publishedExams,
    invitedStudents: invited.length,
    completedAttempts: activity.completedAttempts,
    materials: activity.materialsUploaded,
  };
}

/*
 * Returns { missions:[{id,az,route,xpType,xpReward,status,progressCurrent,
 * progressTarget,completedAt}], allComplete }. When persist=true it upserts the
 * TeacherMissionProgress cache and (on full-chain completion) awards the chain bonus.
 */
async function progressFor(teacherId, user, { persist = true, activity } = {}) {
  const act = activity || (await activitySvc.computeActivityMetrics(teacherId));
  const metrics = await missionMetrics(teacherId, user, act);
  const existing = persist ? await TeacherMissionProgress.find({ teacherId }).lean() : [];
  const byId = new Map(existing.map((r) => [r.missionId, r]));

  const missions = [];
  let priorComplete = true;
  let allComplete = true;
  for (const m of ONBOARDING) {
    const current = Math.min(Number(metrics[m.metric] || 0), m.target);
    const complete = current >= m.target;
    const status = complete ? "complete" : priorComplete ? "active" : "locked";
    const prev = byId.get(m.id);
    const completedAt = complete ? (prev && prev.completedAt) || new Date() : null;
    if (persist) {
      await TeacherMissionProgress.updateOne(
        { teacherId, missionId: m.id },
        { $set: { status, progressCurrent: current, progressTarget: m.target, completedAt } },
        { upsert: true }
      );
    }
    missions.push({
      id: m.id, az: m.az, route: m.route, xpType: m.xpType || null,
      xpReward: m.xpType ? xpCfg.xpFor(m.xpType) : 0,
      status, progressCurrent: current, progressTarget: m.target,
      completedAt: completedAt ? new Date(completedAt).toISOString() : null,
    });
    if (!complete) allComplete = false;
    priorComplete = complete;
  }

  if (allComplete && persist) {
    // Chain bonus awarded ONCE (idempotent on sourceId; outbox-safe).
    const xpSvc = require("./teacherXpService");
    await xpSvc.awardOrEnqueue({ teacherId, type: CHAIN_XP_TYPE, sourceId: "onboarding_chain" });
  }
  return { missions, allComplete, chainXp: xpCfg.xpFor(CHAIN_XP_TYPE) };
}

module.exports = { progressFor, missionMetrics };
