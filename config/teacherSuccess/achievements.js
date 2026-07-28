/*
 * Teacher Journey — achievement badge definitions (server-owned). ONE source.
 * Achievements are DERIVED from real committed events / server-authoritative activity
 * metrics — never claimed manually and never client-asserted. Each is earned at most
 * once (unique index) and stamped `earnedAt` (see teacherAchievementService).
 *
 * Each definition:
 *   id      — stable achievement id (also the earned-row key).
 *   az      — Azerbaijani title shown to the teacher.
 *   metric  — the server-authoritative metric field the predicate reads.
 *   atLeast — the metric must be >= this value to earn it.
 *
 * Importing this module has NO side effects (flag-off safe).
 */

const ACHIEVEMENTS = [
  { id: "first_step", az: "İlk addım", metric: "publishedExams", atLeast: 1 },
  { id: "exam_author", az: "İmtahan müəllifi", metric: "publishedExams", atLeast: 3 },
  { id: "hundred_questions", az: "100 sual", metric: "publishedQuestions", atLeast: 100 },
  { id: "first_ten_students", az: "İlk 10 şagird", metric: "uniqueStudents", atLeast: 10 },
  { id: "active_week", az: "Aktiv həftə", metric: "distinctActiveWeeks", atLeast: 1 },
  { id: "useful_material", az: "Faydalı material", metric: "usefulMaterials", atLeast: 1 },
  { id: "referrer", az: "Tövsiyəçi", metric: "qualifiedReferrals", atLeast: 1 },
  { id: "ai_explorer", az: "AI kəşfiyyatçısı", metric: "aiGenerations", atLeast: 1 },
];

const ACHIEVEMENT_IDS = ACHIEVEMENTS.map((a) => a.id);
const ACHIEVEMENT_ID_SET = new Set(ACHIEVEMENT_IDS);
const byId = (id) => ACHIEVEMENTS.find((a) => a.id === id) || null;
const isAchievement = (id) => ACHIEVEMENT_ID_SET.has(id);

module.exports = { ACHIEVEMENTS, ACHIEVEMENT_IDS, ACHIEVEMENT_ID_SET, byId, isAchievement };
