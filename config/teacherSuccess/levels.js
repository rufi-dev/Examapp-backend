/*
 * Teacher Success Journey — the three activity-based levels.
 *
 * ADR Backend/docs/adr/Teacher-Success-Journey.md §2 D2/D3, §9.
 * Order is significant: promotion is ADVANCE-ONLY and one step at a time
 * (spark -> momentum -> impact). There is no automatic demotion (D9).
 *
 * A level is RECOGNITION only. It is never a security role and never appears in
 * an authorization decision (D10). Keep this module free of any request/user
 * capability logic.
 */
const LEVELS = ["spark", "momentum", "impact"];
const LEVEL_SET = new Set(LEVELS);

// Frozen display labels (ADR §3). `az` is the localized concept name.
const LABELS = {
  spark: { en: "Spark", az: "Başlanğıc" },
  momentum: { en: "Momentum", az: "İrəliləyiş" },
  impact: { en: "Impact", az: "Təsir" },
};

const DEFAULT_LEVEL = "spark"; // every new teacher starts here (D3)

const isLevel = (l) => LEVEL_SET.has(l);
const levelIndex = (l) => LEVELS.indexOf(l);

// The single next level up, or null at the top. Used by promotion + eligibility.
function nextLevel(l) {
  const i = levelIndex(l);
  if (i < 0 || i === LEVELS.length - 1) return null;
  return LEVELS[i + 1];
}

// True iff `to` is exactly one step above `from` (the only legal normal promotion).
function isSingleStepUp(from, to) {
  return isLevel(from) && isLevel(to) && levelIndex(to) === levelIndex(from) + 1;
}

module.exports = { LEVELS, LEVEL_SET, LABELS, DEFAULT_LEVEL, isLevel, levelIndex, nextLevel, isSingleStepUp };
