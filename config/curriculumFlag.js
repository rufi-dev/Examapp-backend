/*
 * Curriculum / MSO / lesson-plan feature flag.
 *
 * Default OFF, and flag-off must be a TRUE no-op: no routes (the route middleware
 * answers 404, not 401, so the surface looks absent), no collection or index
 * created or asserted at boot, no background job scheduled. Mirrors
 * config/teacherSuccess/flag.js, including the injectable `env` so it is testable.
 */
const TRUE_SET = new Set(["1", "true", "yes", "on"]);

function isCurriculumEnabled(env = process.env) {
  return TRUE_SET.has(String(env.CURRICULUM_ENABLED || "").trim().toLowerCase());
}

module.exports = { isCurriculumEnabled };
