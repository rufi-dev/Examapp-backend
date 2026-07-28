/*
 * Teacher Success Journey — single-source validated config (ADR §2/§3/§5/§6/§8).
 * Levels, allowances, entitlements, thresholds, AI credit weights, copy, flag.
 * Pure (no DB). Proves the frozen policy values and the startup validator.
 */
const cfg = require("../config/teacherSuccess");
const { levels, allowances, entitlements, aiCredits, thresholds, copy, flag } = cfg;

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

// ── Levels (D2/D3) ──
ok("levels are spark<momentum<impact in order", JSON.stringify(levels.LEVELS) === JSON.stringify(["spark", "momentum", "impact"]));
ok("default level is spark", levels.DEFAULT_LEVEL === "spark");
ok("nextLevel(spark)=momentum", levels.nextLevel("spark") === "momentum");
ok("nextLevel(momentum)=impact", levels.nextLevel("momentum") === "impact");
ok("nextLevel(impact)=null (top)", levels.nextLevel("impact") === null);
ok("isSingleStepUp(spark,momentum)", levels.isSingleStepUp("spark", "momentum") === true);
ok("isSingleStepUp(spark,impact) is false (two steps)", levels.isSingleStepUp("spark", "impact") === false);
ok("isSingleStepUp(momentum,spark) is false (downgrade)", levels.isSingleStepUp("momentum", "spark") === false);
ok("az labels frozen", levels.LABELS.spark.az === "Başlanğıc" && levels.LABELS.momentum.az === "İrəliləyiş" && levels.LABELS.impact.az === "Təsir");

// ── Allowances (D7) ──
ok("default allowances 100/300/750", allowances.allowanceFor("spark") === 100 && allowances.allowanceFor("momentum") === 300 && allowances.allowanceFor("impact") === 750);
ok("allowanceMap resolves all levels", JSON.stringify(allowances.allowanceMap()) === JSON.stringify({ spark: 100, momentum: 300, impact: 750 }));

// ── Entitlements (D5/D6/§5) ──
ok("core tools present at EVERY level (D5)", levels.LEVELS.every((l) => entitlements.enforcedEntitlements(l).includes("manual_pdf_exam") && entitlements.enforcedEntitlements(l).includes("ai_tools")));
ok("additive is momentum⊇spark", entitlements.levelHasAdditive("momentum", "reusable_ai_template_presets") && !entitlements.levelHasAdditive("spark", "reusable_ai_template_presets"));
ok("additive is impact⊇momentum", entitlements.levelHasAdditive("impact", "batch_productivity_workflows") && !entitlements.levelHasAdditive("momentum", "batch_productivity_workflows"));
ok("impact has everything momentum has (additive-only, no removal)", (() => {
  const m = new Set(entitlements.displayEntitlements("momentum").additive.map((a) => a.key));
  const i = new Set(entitlements.displayEntitlements("impact").additive.map((a) => a.key));
  return [...m].every((k) => i.has(k));
})());
ok("unimplemented additive NOT enforced/advertised as live", entitlements.ADDITIVE.every((a) => a.implemented || !entitlements.enforcedEntitlements(a.minLevel).includes(a.key)));
ok("core never removed from spark to make differentiation", (() => {
  const s = new Set(entitlements.enforcedEntitlements("spark"));
  return entitlements.CORE.every((c) => s.has(c));
})());

// ── AI credit weights (§8.1 / Appendix B) ──
ok("stable operation names mapped", aiCredits.isOperation("ai.extract.questions") && aiCredits.isOperation("ai.generate.questions") && aiCredits.isOperation("ai.regenerate.question"));
ok("weights are non-negative integers", aiCredits.OPERATIONS.every((op) => Number.isSafeInteger(aiCredits.weightFor(op)) && aiCredits.weightFor(op) >= 0));
ok("models.list is free (no provider call)", aiCredits.weightFor("ai.models.list") === 0 && aiCredits.isChargeable("ai.models.list") === false);
ok("chargeable ops have positive weight", aiCredits.isChargeable("ai.extract.questions") && aiCredits.isChargeable("ai.chat.message"));
ok("unknown/forged operation throws (never silently 0-charge)", (() => { try { aiCredits.weightFor("ai.free.money"); return false; } catch { return true; } })());
ok("confirm-before set covers large actions", aiCredits.CONFIRM_BEFORE.has("ai.extract.questions") && aiCredits.CONFIRM_BEFORE.has("ai.generate.questions"));

// ── Thresholds (game review-eligibility requirements) ──
{
  const sm = thresholds.SPARK_TO_MOMENTUM.requirements;
  ok("spark→momentum requirements frozen", sm.lifetimeXp === 500 && sm.publishedExams === 3 && sm.publishedQuestions === 60 && sm.uniqueStudents === 10 && sm.completedAttempts === 20 && sm.distinctActiveDays === 5);
  ok("spark→momentum referral is a BONUS (1)", thresholds.SPARK_TO_MOMENTUM.referralBonus.qualifiedReferrals === 1);
  const mi = thresholds.MOMENTUM_TO_IMPACT.requirements;
  ok("momentum→impact requirements frozen", mi.lifetimeXp === 2000 && mi.publishedExams === 10 && mi.publishedQuestions === 250 && mi.uniqueStudents === 50 && mi.completedAttempts === 150 && mi.distinctActiveWeeks === 6 && mi.usefulMaterials === 5);
  ok("momentum→impact referral is a BONUS (3) + 60-day window", thresholds.MOMENTUM_TO_IMPACT.referralBonus.qualifiedReferrals === 3 && thresholds.MOMENTUM_TO_IMPACT.window.rollingWindowDays === 60);
}
ok("referral qualification: 7-day age + 1 exam + 2 attempts", thresholds.REFERRAL_QUALIFICATION.minAccountAgeDays === 7 && thresholds.REFERRAL_QUALIFICATION.minPublishedExams === 1 && thresholds.REFERRAL_QUALIFICATION.minCompletedAttempts === 2);

// ── XP / missions / achievements (game config) ──
ok("XP awards frozen (publish 25 / first-publish 40 / question 1 / referral 100)", cfg.xp.xpFor("exam.publish") === 25 && cfg.xp.xpFor("exam.publish.first") === 40 && cfg.xp.xpFor("question.published") === 1 && cfg.xp.xpFor("referral.qualified") === 100);
ok("XP caps frozen (question 60/exam, 400/month; attempt 200/month)", cfg.xp.CAPS.questionPerExam === 60 && cfg.xp.CAPS.questionPerMonth === 400 && cfg.xp.CAPS.attemptPerMonth === 200);
ok("XP env override validated (non-negative int)", cfg.validateTeacherSuccessConfig({ TSJ_XP_EXAM_PUBLISH: "-5" }).ok === false && cfg.validateTeacherSuccessConfig({ TSJ_XP_EXAM_PUBLISH: "30" }).ok === true);
ok("correction type is not a fixed award", cfg.xp.CORRECTION_TYPE === "admin.correction" && !cfg.xp.isAward(cfg.xp.CORRECTION_TYPE));
ok("8 onboarding missions with routes + targets", cfg.missions.ONBOARDING.length === 8 && cfg.missions.ONBOARDING.every((m) => m.route[0] === "/" && m.target >= 1));
ok("mission chain reward is a real XP award (50)", cfg.xp.isAward(cfg.missions.CHAIN_XP_TYPE) && cfg.xp.xpFor(cfg.missions.CHAIN_XP_TYPE) === 50);
ok("8 achievements with az titles + thresholds", cfg.achievements.ACHIEVEMENTS.length === 8 && cfg.achievements.ACHIEVEMENTS.every((a) => a.az && a.atLeast >= 1));

// ── Copy (§3) ──
ok("positioning copy present az+en", copy.POSITIONING.az.includes("ödənişlə deyil") && copy.POSITIONING.en.includes("not a paid plan"));
ok("AI copy present az+en", copy.AI_EXPLANATION.az.includes("AI") && copy.AI_EXPLANATION.en.includes("Manual exam creation never requires AI credits"));
ok("no banned payment terms in frozen copy", (() => {
  const blob = (copy.POSITIONING.az + copy.POSITIONING.en + copy.AI_EXPLANATION.az + copy.AI_EXPLANATION.en).toLowerCase();
  return copy.BANNED_TERMS.every((t) => !blob.includes(t));
})());

// ── Flag (D16) ──
ok("flag default OFF", flag.isJourneyEnabled({}) === false);
ok("flag reads truthy env", flag.isJourneyEnabled({ TEACHER_SUCCESS_JOURNEY_ENABLED: "true" }) === true && flag.isJourneyEnabled({ TEACHER_SUCCESS_JOURNEY_ENABLED: "1" }) === true);
ok("low-balance threshold default 0.2", flag.lowBalanceThreshold({}) === 0.2);
ok("low-balance threshold override honored", flag.lowBalanceThreshold({ TSJ_LOW_BALANCE_THRESHOLD: "0.1" }) === 0.1);
ok("low-balance invalid override falls back to 0.2", flag.lowBalanceThreshold({ TSJ_LOW_BALANCE_THRESHOLD: "5" }) === 0.2);

// ── Startup validator ──
ok("default config validates OK", cfg.validateTeacherSuccessConfig({}).ok === true);
ok("invalid allowance override rejected", cfg.validateTeacherSuccessConfig({ TSJ_AI_ALLOWANCE_SPARK: "not-a-number" }).ok === false);
ok("zero allowance rejected (no silent disable)", cfg.validateTeacherSuccessConfig({ TSJ_AI_ALLOWANCE_SPARK: "0" }).ok === false);
ok("fractional allowance rejected", cfg.validateTeacherSuccessConfig({ TSJ_AI_ALLOWANCE_MOMENTUM: "1.5" }).ok === false);
ok("non-decreasing allowance invariant enforced (spark>momentum rejected)", cfg.validateTeacherSuccessConfig({ TSJ_AI_ALLOWANCE_SPARK: "500", TSJ_AI_ALLOWANCE_MOMENTUM: "300" }).ok === false);
ok("valid non-decreasing overrides accepted", cfg.validateTeacherSuccessConfig({ TSJ_AI_ALLOWANCE_SPARK: "150", TSJ_AI_ALLOWANCE_MOMENTUM: "400", TSJ_AI_ALLOWANCE_IMPACT: "900" }).ok === true);
ok("invalid low-balance threshold rejected by validator", cfg.validateTeacherSuccessConfig({ TSJ_LOW_BALANCE_THRESHOLD: "2" }).ok === false);
ok("assertTeacherSuccessConfig throws on bad env", (() => { try { cfg.assertTeacherSuccessConfig({ TSJ_AI_ALLOWANCE_SPARK: "-1" }); return false; } catch { return true; } })());
ok("assertTeacherSuccessConfig passes on default env", (() => { try { cfg.assertTeacherSuccessConfig({}); return true; } catch { return false; } })());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
