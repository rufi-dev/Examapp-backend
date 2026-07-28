/*
 * Teacher Journey — PURE eligibility boundaries. No DB. In the game model, review
 * readiness = EVERY non-referral requirement met (lifetime XP + activity); a qualified
 * referral is a BONUS indicator, never mandatory. Meeting a target never auto-promotes.
 */
const el = require("../services/teacherEligibility");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

// Full spark→momentum requirement set (all met).
const sparkFull = { lifetimeXp: 500, publishedExams: 3, publishedQuestions: 60, uniqueStudents: 10, completedAttempts: 20, distinctActiveDays: 5 };

// ── all requirements met → ready ──
ok("spark: exactly at every requirement → ready", el.evaluate({ currentLevel: "spark", metrics: sparkFull }).readyForReview === true);
ok("spark: recommends momentum when ready", el.evaluate({ currentLevel: "spark", metrics: sparkFull }).recommendedNextLevel === "momentum");

// ── each requirement is a hard gate ──
ok("spark: below XP → not ready", el.evaluate({ currentLevel: "spark", metrics: { ...sparkFull, lifetimeXp: 499 } }).readyForReview === false);
ok("spark: below publishedExams → not ready", el.evaluate({ currentLevel: "spark", metrics: { ...sparkFull, publishedExams: 2 } }).readyForReview === false);
ok("spark: below publishedQuestions → not ready", el.evaluate({ currentLevel: "spark", metrics: { ...sparkFull, publishedQuestions: 59 } }).readyForReview === false);
ok("spark: below uniqueStudents → not ready", el.evaluate({ currentLevel: "spark", metrics: { ...sparkFull, uniqueStudents: 9 } }).readyForReview === false);
ok("spark: below completedAttempts → not ready", el.evaluate({ currentLevel: "spark", metrics: { ...sparkFull, completedAttempts: 19 } }).readyForReview === false);
ok("spark: below distinctActiveDays → not ready", el.evaluate({ currentLevel: "spark", metrics: { ...sparkFull, distinctActiveDays: 4 } }).readyForReview === false);

// ── referral is a BONUS, never required ──
ok("spark: ready WITHOUT any referral (referral is bonus)", el.evaluate({ currentLevel: "spark", metrics: { ...sparkFull, qualifiedReferrals: 0 } }).readyForReview === true);
ok("spark: a referral does NOT bypass unmet requirements", el.evaluate({ currentLevel: "spark", metrics: { qualifiedReferrals: 5 } }).readyForReview === false);
{
  const e = el.evaluate({ currentLevel: "spark", metrics: { ...sparkFull, qualifiedReferrals: 1 } });
  ok("spark: referral bonus is reported met", e.referralBonus.met === true && e.referralBonus.need === 1);
}

// ── requirement report lists exact have/need and which block ──
{
  const e = el.evaluate({ currentLevel: "spark", metrics: { lifetimeXp: 100, publishedExams: 1, publishedQuestions: 20, uniqueStudents: 3, completedAttempts: 5, distinctActiveDays: 2 } });
  ok("spark: reports one entry per requirement", e.requirements.length === 6);
  ok("spark: reports have/need + met per requirement", e.requirements.every((r) => typeof r.have === "number" && typeof r.need === "number" && typeof r.met === "boolean"));
  ok("spark: none met here → not ready", e.readyForReview === false && e.requirements.filter((r) => r.met).length === 0);
}

// ── momentum → impact ──
const momFull = { lifetimeXp: 2000, publishedExams: 10, publishedQuestions: 250, uniqueStudents: 50, completedAttempts: 150, distinctActiveWeeks: 6, usefulMaterials: 5 };
ok("momentum: exactly at every requirement → ready → impact", el.evaluate({ currentLevel: "momentum", metrics: momFull }).recommendedNextLevel === "impact");
ok("momentum: below usefulMaterials → not ready", el.evaluate({ currentLevel: "momentum", metrics: { ...momFull, usefulMaterials: 4 } }).readyForReview === false);
ok("momentum: below active weeks → not ready", el.evaluate({ currentLevel: "momentum", metrics: { ...momFull, distinctActiveWeeks: 5 } }).readyForReview === false);
ok("momentum: referral bonus need is 3", el.evaluate({ currentLevel: "momentum", metrics: momFull }).referralBonus.need === 3);

// ── impact is the top of the ladder ──
{
  const e = el.evaluate({ currentLevel: "impact", metrics: momFull });
  ok("impact: no target (top of ladder), never ready", e.target === null && e.readyForReview === false && e.recommendedNextLevel === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
