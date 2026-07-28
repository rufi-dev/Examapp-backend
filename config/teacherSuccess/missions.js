/*
 * Teacher Journey — the onboarding mission chain (server-owned definitions). ONE
 * source. Missions are DERIVED from real committed server data (published exams,
 * question counts, results, materials, profile completeness) — never a clickable
 * "complete" button and never client-asserted. Completing the whole chain awards
 * xp `mission.onboarding_chain` exactly once (see services/teacherMissionService).
 *
 * Each definition:
 *   id       — stable mission id (also the progress-row key).
 *   az       — Azerbaijani title shown to the teacher.
 *   route    — the REAL application page the mission links to.
 *   metric   — the activity-metric field the mission reads (server-authoritative).
 *   target   — completion target for that metric (partial progress = current/target).
 *   order    — display + unlock order (a mission activates when the prior completes).
 *
 * Importing this module has NO side effects (flag-off safe).
 */

// The onboarding chain, in order. `metric` names map to fields the mission service
// computes from real data (see teacherMissionService.progressFor).
// `xpType` (optional) = the XP award the underlying real action grants, so the UI can
// honestly explain the reward. Missions themselves grant no points — the committed
// event does. Completing the WHOLE chain grants CHAIN_XP_TYPE once (a bonus).
const ONBOARDING = [
  { id: "profile.complete", order: 1, az: "Profilini tamamla", route: "/profile", metric: "profileComplete", target: 1, xpType: null },
  { id: "class.create", order: 2, az: "İlk sinfini yarat", route: "/classAdd", metric: "classes", target: 1, xpType: null },
  { id: "exam.create", order: 3, az: "İlk imtahanını yarat", route: "/classAdd", metric: "exams", target: 1, xpType: null },
  { id: "questions.ten", order: 4, az: "Ən azı 10 sual əlavə et", route: "/classAdd", metric: "questions", target: 10, xpType: "question.published" },
  { id: "exam.publish", order: 5, az: "İmtahanı yayımla", route: "/classAdd", metric: "publishedExams", target: 1, xpType: "exam.publish.first" },
  { id: "students.invite", order: 6, az: "Şagirdlərini dəvət et", route: "/classes", metric: "invitedStudents", target: 1, xpType: null },
  { id: "result.first", order: 7, az: "İlk tamamlanmış nəticəni əldə et", route: "/myExams", metric: "completedAttempts", target: 1, xpType: "student.first_completion" },
  { id: "material.share", order: 8, az: "İlk materialını paylaş", route: "/materials", metric: "materials", target: 1, xpType: "material.uploaded" },
];

const ONBOARDING_IDS = ONBOARDING.map((m) => m.id);
const ONBOARDING_ID_SET = new Set(ONBOARDING_IDS);
const CHAIN_XP_TYPE = "mission.onboarding_chain"; // awarded once when every onboarding mission is complete
const byId = (id) => ONBOARDING.find((m) => m.id === id) || null;
const isMission = (id) => ONBOARDING_ID_SET.has(id);

module.exports = { ONBOARDING, ONBOARDING_IDS, ONBOARDING_ID_SET, CHAIN_XP_TYPE, byId, isMission };
