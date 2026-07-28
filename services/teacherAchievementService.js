/*
 * Teacher Journey — achievement badges. DERIVED from server-authoritative metrics —
 * never claimed by the client. evaluate() grants any newly-earned achievement
 * idempotently (unique index) and returns the full earned/locked collection for the UI.
 */
const TeacherAchievement = require("../models/teacherAchievementModel");
const { ACHIEVEMENTS } = require("../config/teacherSuccess/achievements");

const isDup = (e) => e && (e.code === 11000 || e.code === 11001);

/*
 * metrics: the unified server-authoritative metrics (activitySvc.metricsFor) with
 * publishedExams, publishedQuestions, uniqueStudents, distinctActiveWeeks,
 * usefulMaterials, qualifiedReferrals, aiGenerations.
 * Returns [{ id, az, earned, earnedAt }] for every defined achievement.
 */
async function evaluate(teacherId, metrics, { persist = true } = {}) {
  const already = persist ? await TeacherAchievement.find({ teacherId }).lean() : [];
  const earnedMap = new Map(already.map((a) => [a.achievementId, a.earnedAt]));

  const out = [];
  for (const def of ACHIEVEMENTS) {
    const have = Number((metrics && metrics[def.metric]) || 0);
    const qualifies = have >= def.atLeast;
    let earnedAt = earnedMap.get(def.id) || null;
    if (qualifies && !earnedAt && persist) {
      try {
        const doc = await TeacherAchievement.create([{ teacherId, achievementId: def.id }]);
        earnedAt = doc[0].earnedAt;
      } catch (e) {
        if (!isDup(e)) throw e; // concurrent grant ⇒ already earned
        const row = await TeacherAchievement.findOne({ teacherId, achievementId: def.id }).lean();
        earnedAt = row ? row.earnedAt : new Date();
      }
    } else if (qualifies && !earnedAt) {
      earnedAt = new Date(); // non-persist preview
    }
    out.push({
      id: def.id,
      az: def.az,
      earned: !!earnedAt,
      earnedAt: earnedAt ? new Date(earnedAt).toISOString() : null,
    });
  }
  return out;
}

module.exports = { evaluate };
