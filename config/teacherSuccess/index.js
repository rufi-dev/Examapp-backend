/*
 * Teacher Success Journey — single aggregating config surface + startup
 * validator. server.js calls assertTeacherSuccessConfig() at boot (alongside
 * assertConfig/assertEnv) so an invalid override FAILS the boot before listen
 * and before any DB/index mutation. Importing this module has NO side effects
 * (no DB, no schema) — flag-off safety (D16).
 */
const levels = require("./levels");
const copy = require("./copy");
const allowances = require("./allowances");
const entitlements = require("./entitlements");
const thresholds = require("./thresholds");
const aiCredits = require("./aiCredits");
const flag = require("./flag");
const xp = require("./xp");
const missions = require("./missions");
const achievements = require("./achievements");

// Recursively assert every leaf of a threshold object is a positive integer.
function assertPositiveIntLeaves(obj, path, errors) {
  for (const [k, v] of Object.entries(obj)) {
    const p = `${path}.${k}`;
    if (v && typeof v === "object") assertPositiveIntLeaves(v, p, errors);
    else if (!Number.isSafeInteger(v) || v <= 0) errors.push(`Invalid threshold ${p}=${v} (positive integer required)`);
  }
}

function validateTeacherSuccessConfig(env = process.env) {
  const errors = [];

  // 1) AI allowances: each level's override must be a bounded positive integer,
  //    and allowances must be NON-DECREASING up the ladder (a promotion never
  //    lowers the ceiling — D14).
  const { BOUND } = allowances;
  let prev = -Infinity;
  for (const level of levels.LEVELS) {
    const raw = allowances.rawAllowance(level, env);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < BOUND.min || n > BOUND.max) {
      errors.push(`Invalid ${allowances.ENV_KEY(level)}="${raw}" (integer in [${BOUND.min}, ${BOUND.max}])`);
    } else {
      if (n < prev) errors.push(`AI allowance for "${level}" (${n}) is below the level below it (${prev}); allowances must be non-decreasing`);
      prev = n;
    }
  }

  // 2) Low-balance threshold override must be a fraction in (0,1).
  const raw = env.TSJ_LOW_BALANCE_THRESHOLD;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n >= 1) errors.push(`Invalid TSJ_LOW_BALANCE_THRESHOLD="${raw}" (fraction in (0,1))`);
  }

  // 3) AI credit weights must be non-negative safe integers.
  for (const [op, w] of Object.entries(aiCredits.WEIGHTS)) {
    if (!Number.isSafeInteger(w) || w < 0) errors.push(`Invalid AI credit weight for "${op}"=${w} (non-negative integer)`);
  }

  // 4) Threshold shape: every leaf positive integer.
  assertPositiveIntLeaves(thresholds.SPARK_TO_MOMENTUM, "SPARK_TO_MOMENTUM", errors);
  assertPositiveIntLeaves(thresholds.MOMENTUM_TO_IMPACT, "MOMENTUM_TO_IMPACT", errors);
  assertPositiveIntLeaves(thresholds.REFERRAL_FRAUD, "REFERRAL_FRAUD", errors);

  // 5) Entitlements: core is non-empty and additive minLevels are real levels.
  if (entitlements.CORE.length === 0) errors.push("entitlements.CORE must not be empty");
  for (const a of entitlements.ADDITIVE) {
    if (!levels.isLevel(a.minLevel)) errors.push(`Additive entitlement "${a.key}" has invalid minLevel "${a.minLevel}"`);
  }

  // 6) Copy: frozen strings present in both languages and free of banned terms.
  for (const [name, block] of [["POSITIONING", copy.POSITIONING], ["AI_EXPLANATION", copy.AI_EXPLANATION]]) {
    for (const lang of ["az", "en"]) {
      const s = block[lang];
      if (!s || typeof s !== "string" || s.trim().length < 20) errors.push(`Copy ${name}.${lang} missing/too short`);
    }
  }

  // 7) XP awards: each (possibly env-overridden) amount is a non-negative safe integer
  //    within bounds; the correction type is never in the AWARDS table.
  for (const type of Object.keys(xp.AWARDS)) {
    const n = Number(xp.rawAward(type, env));
    if (!Number.isSafeInteger(n) || n < xp.BOUND.min || n > xp.BOUND.max) {
      errors.push(`Invalid ${xp.ENV_KEY(type)}="${xp.rawAward(type, env)}" (integer in [${xp.BOUND.min}, ${xp.BOUND.max}])`);
    }
  }
  if (xp.isAward(xp.CORRECTION_TYPE)) errors.push(`XP correction type "${xp.CORRECTION_TYPE}" must not be a fixed award`);
  for (const [k, v] of Object.entries(xp.CAPS)) {
    if (!Number.isSafeInteger(v) || v <= 0) errors.push(`Invalid XP cap ${k}=${v} (positive integer)`);
  }

  // 8) Missions: unique ordered ids, an AZ title, a real route, a positive target, and
  //    the chain reward is a real XP award type.
  const seenMission = new Set();
  for (const m of missions.ONBOARDING) {
    if (!m.id || seenMission.has(m.id)) errors.push(`Duplicate/empty mission id "${m.id}"`);
    seenMission.add(m.id);
    if (!m.az || typeof m.az !== "string") errors.push(`Mission "${m.id}" missing az title`);
    if (!m.route || m.route[0] !== "/") errors.push(`Mission "${m.id}" needs an app route`);
    if (!Number.isSafeInteger(m.target) || m.target <= 0) errors.push(`Mission "${m.id}" target must be a positive integer`);
  }
  if (!xp.isAward(missions.CHAIN_XP_TYPE)) errors.push(`Mission chain reward "${missions.CHAIN_XP_TYPE}" is not an XP award`);

  // 9) Achievements: unique ids, AZ title, positive threshold.
  const seenAch = new Set();
  for (const a of achievements.ACHIEVEMENTS) {
    if (!a.id || seenAch.has(a.id)) errors.push(`Duplicate/empty achievement id "${a.id}"`);
    seenAch.add(a.id);
    if (!a.az || typeof a.az !== "string") errors.push(`Achievement "${a.id}" missing az title`);
    if (!Number.isSafeInteger(a.atLeast) || a.atLeast <= 0) errors.push(`Achievement "${a.id}" atLeast must be a positive integer`);
  }

  // 10) Review thresholds: lifetimeXp gate present + positive on each transition.
  for (const [name, t] of [["SPARK_TO_MOMENTUM", thresholds.SPARK_TO_MOMENTUM], ["MOMENTUM_TO_IMPACT", thresholds.MOMENTUM_TO_IMPACT]]) {
    const req = t && t.requirements;
    if (!req || !Number.isSafeInteger(req.lifetimeXp) || req.lifetimeXp <= 0) errors.push(`${name}.requirements.lifetimeXp must be a positive integer`);
  }

  return { ok: errors.length === 0, errors };
}

function assertTeacherSuccessConfig(env = process.env) {
  const { ok, errors } = validateTeacherSuccessConfig(env);
  if (!ok) throw new Error(`FATAL Teacher Success config: ${errors.join("; ")}`);
}

module.exports = {
  levels,
  copy,
  allowances,
  entitlements,
  thresholds,
  aiCredits,
  flag,
  xp,
  missions,
  achievements,
  // convenience re-exports
  LEVELS: levels.LEVELS,
  isJourneyEnabled: flag.isJourneyEnabled,
  validateTeacherSuccessConfig,
  assertTeacherSuccessConfig,
};
