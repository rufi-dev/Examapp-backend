/*
 * Teacher Journey — the server-owned XP (points) rulebook. ONE validated source.
 * Points are activity-based recognition, NEVER paid and NEVER a security signal.
 *
 * The client can never submit or choose points: every award is derived from a real
 * COMMITTED business event, keyed idempotently, capped, and written to an immutable
 * ledger (see services/teacherXpService.js). Values here are configurable — an env
 * override that is not a non-negative safe integer FAILS boot (config/index.js).
 *
 * Importing this module has NO side effects (flag-off safe).
 */

// Award amounts (XP) per event type. Keys are the ledger `type` enum (plus the admin
// correction type, which carries a signed amount and is not in this table).
const AWARDS = {
  "exam.publish.first": 40,        // first successfully published exam (once per teacher)
  "exam.publish": 25,              // every additional distinct published exam
  "question.published": 1,         // per unique question in a published immutable version
  "student.first_completion": 10,  // first valid completion by a unique verified student
  "attempt.completed": 2,          // each additional legitimate completed attempt
  "active.day": 5,                 // one meaningful active teaching day
  "material.uploaded": 5,          // one valid uploaded learning material
  "material.qualified_use": 15,    // a material used by >= MATERIAL_QUALIFIED_USES students
  "student.referred_join_complete": 10, // verified student joins via a shared link + completes
  "referral.qualified": 100,       // a qualified teacher referral
  "mission.onboarding_chain": 50,  // completing the whole onboarding mission chain
};

// The admin-correction ledger type carries a SIGNED amount and is audited; it is a
// valid ledger `type` but never appears in AWARDS (its amount is supplied, not fixed).
const CORRECTION_TYPE = "admin.correction";

// Every legal ledger event type (AWARDS keys + the correction type).
const EVENT_TYPES = [...Object.keys(AWARDS), CORRECTION_TYPE];
const EVENT_TYPE_SET = new Set(EVENT_TYPES);

// Anti-abuse CAPS. Enforced atomically inside the award transaction (services), so a
// retry/duplicate/concurrent burst can never exceed them.
const CAPS = {
  // question.published: bounded per exam AND per calendar month.
  questionPerExam: 60,
  questionPerMonth: 400,
  // attempt.completed: bounded per calendar month.
  attemptPerMonth: 200,
};

// A material counts as "useful" (earns material.qualified_use) once it has been used by
// at least this many DISTINCT verified students.
const MATERIAL_QUALIFIED_USES = 3;

// Env override key for an award value, e.g. TSJ_XP_EXAM_PUBLISH.
const ENV_KEY = (type) => `TSJ_XP_${type.toUpperCase().replace(/[.\-]/g, "_")}`;
const BOUND = { min: 0, max: 1_000_000 };

// Raw (possibly env-overridden) amount for an award type, unparsed. index validates it.
function rawAward(type, env = process.env) {
  const v = env[ENV_KEY(type)];
  return v === undefined || v === "" ? String(AWARDS[type]) : v;
}

// Resolved integer XP for an award type. Startup validation guarantees overrides are
// valid before serving; this falls back to the frozen default if validation was skipped.
function xpFor(type, env = process.env) {
  const n = Number(rawAward(type, env));
  return Number.isSafeInteger(n) && n >= BOUND.min && n <= BOUND.max ? n : AWARDS[type];
}

const isEventType = (t) => EVENT_TYPE_SET.has(t);
const isAward = (t) => Object.prototype.hasOwnProperty.call(AWARDS, t);

module.exports = {
  AWARDS,
  CORRECTION_TYPE,
  EVENT_TYPES,
  EVENT_TYPE_SET,
  CAPS,
  MATERIAL_QUALIFIED_USES,
  ENV_KEY,
  BOUND,
  rawAward,
  xpFor,
  isEventType,
  isAward,
};
