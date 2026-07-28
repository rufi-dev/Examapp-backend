/*
 * Teacher Success Journey — activity & referral eligibility thresholds
 * (ADR §6). ONE validated source. Meeting a threshold marks a teacher
 * "Ready for review"; it NEVER auto-promotes (D8).
 *
 * Count meaningful SERVER-AUTHORITATIVE outcomes only — never page views,
 * clicks, drafts, repeated edits, or duplicated events. Idempotent daily
 * aggregates + domain-event keys enforce that upstream (see services).
 */

// spark -> momentum. ALL `requirements` (non-referral) must be met to become "ready
// for review". `referralBonus` is a BONUS indicator, never mandatory (game spec).
const SPARK_TO_MOMENTUM = {
  requirements: {
    lifetimeXp: 500,
    publishedExams: 3,
    publishedQuestions: 60,      // unique questions in published immutable versions
    uniqueStudents: 10,          // unique verified students who completed an exam
    completedAttempts: 20,
    distinctActiveDays: 5,
  },
  referralBonus: { qualifiedReferrals: 1 },
};

// momentum -> impact.
const MOMENTUM_TO_IMPACT = {
  requirements: {
    lifetimeXp: 2000,
    publishedExams: 10,
    publishedQuestions: 250,
    uniqueStudents: 50,
    completedAttempts: 150,
    distinctActiveWeeks: 6,      // active across 6 distinct weeks ...
    usefulMaterials: 5,          // 5 materials used by students
  },
  referralBonus: { qualifiedReferrals: 3 },
  window: { rollingWindowDays: 60 }, // ... in a rolling 60-day window (weeks calc)
};

// Referral qualification defaults (ADR §7.3).
const REFERRAL_QUALIFICATION = {
  minAccountAgeDays: 7,
  minPublishedExams: 1,
  minCompletedAttempts: 2, // from genuine student accounts
  requireVerifiedEmailOrOAuth: true,
};

// Fraud / rate-limit knobs (ADR §7.4). Soft-signal counts here; identity-collision
// rules live in the fraud service.
const REFERRAL_FRAUD = {
  maxClaimsPerWindow: 20, // rate-limit referral claims
  claimWindowMs: 24 * 60 * 60 * 1000,
  maxRewardedPerPeriod: 10, // cap referral-derived eligibility per configured period
  heldSoftSignalThreshold: 2, // >= this many soft signals -> reward held (not rejected)
};

// Every leaf threshold must be a positive integer (shape asserted in config).
module.exports = { SPARK_TO_MOMENTUM, MOMENTUM_TO_IMPACT, REFERRAL_QUALIFICATION, REFERRAL_FRAUD };
