/*
 * Teacher Success Journey — the shared index contract cannot drift from the
 * model declarations, and its exact-shape verifier rejects every drift kind.
 * Pure (no DB). Also asserts autoIndex/autoCreate are OFF so importing a model
 * builds nothing (flag-off safety, D16).
 */
const { INDEXES, MODEL_COLLECTIONS, contractMatchesModel, shapeReason, specsFor } = require("../helper/teacherSuccessIndexes");
const models = {
  teacher_level_history: require("../models/teacherLevelHistoryModel"),
  teacher_activity_daily: require("../models/teacherActivityDailyModel"),
  teacher_referral: require("../models/teacherReferralModel"),
  teacher_upgrade_request: require("../models/teacherUpgradeRequestModel"),
  ai_credit_period: require("../models/aiCreditPeriodModel"),
  ai_credit_ledger: require("../models/aiCreditLedgerModel"),
  teacher_xp_event: require("../models/teacherXpEventModel"),
  teacher_xp_state: require("../models/teacherXpStateModel"),
  teacher_mission_progress: require("../models/teacherMissionProgressModel"),
  teacher_achievement: require("../models/teacherAchievementModel"),
  tsj_xp_outbox: require("../models/teacherXpOutboxModel"),
};

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

// ── 1) Each new-collection model schema.indexes() == contract (no drift). ──
for (const coll of MODEL_COLLECTIONS) {
  const model = models[coll];
  ok(`${coll}: model collection name matches contract`, model.collection.name === coll);
  const r = contractMatchesModel(model.schema.indexes(), coll);
  ok(`${coll}: schema.indexes() == contract`, r.ok || (console.log("    reasons:", r.reasons), false));
  ok(`${coll}: autoIndex OFF (import builds nothing)`, model.schema.options.autoIndex === false);
  ok(`${coll}: autoCreate OFF`, model.schema.options.autoCreate === false);
}

// ── 2) Contract completeness sanity ──
ok("contract has the referral idempotent-reward unique index", INDEXES.some((i) => i.collection === "teacher_referral" && i.name === "uniq_reward_key" && i.unique && i.partialFilterExpression));
ok("contract has the ledger unique idempotency index", INDEXES.some((i) => i.collection === "ai_credit_ledger" && i.name === "uniq_idem" && i.unique));
ok("contract has one-open-upgrade-request partial unique", INDEXES.some((i) => i.collection === "teacher_upgrade_request" && i.name === "uniq_open_request" && i.unique && JSON.stringify(i.partialFilterExpression) === JSON.stringify({ status: "open" })));
ok("contract has users referralCode unique-partial", INDEXES.some((i) => i.collection === "users" && i.name === "uniq_referral_code" && i.unique));

// ── 3) Drift in a model declaration is DETECTED (both directions). ──
ok("missing an index → drift detected", contractMatchesModel([], "ai_credit_period").ok === false);
ok("wrong uniqueness → drift detected", contractMatchesModel([[{ teacherId: 1, periodMonthUtc: 1 }, { name: "uniq_teacher_period", unique: false }]], "ai_credit_period").ok === false);
ok("extra undeclared index → drift detected", contractMatchesModel([
  [{ teacherId: 1, periodMonthUtc: 1 }, { name: "uniq_teacher_period", unique: true }],
  [{ foo: 1 }, { name: "foo_1" }],
], "ai_credit_period").ok === false);
ok("hidden model-option drift → detected", contractMatchesModel([[{ teacherId: 1, periodMonthUtc: 1 }, { name: "uniq_teacher_period", unique: true, hidden: true }]], "ai_credit_period").ok === false);

// ── 4) shapeReason rejects every drift kind (pure). ──
const spec = specsFor("teacher_referral").find((s) => s.name === "uniq_reward_key");
ok("exact match → null", shapeReason(spec, { key: { rewardKey: 1 }, unique: true, partialFilterExpression: { rewardKey: { $type: "string" } } }) === null);
ok("absent → 'absent'", shapeReason(spec, null) === "absent");
ok("wrong key → 'key'", shapeReason(spec, { key: { rewardKey: -1 }, unique: true, partialFilterExpression: { rewardKey: { $type: "string" } } }) === "key");
ok("missing unique → 'unique'", shapeReason(spec, { key: { rewardKey: 1 }, unique: false, partialFilterExpression: { rewardKey: { $type: "string" } } }) === "unique");
ok("wrong partial → 'partial'", shapeReason(spec, { key: { rewardKey: 1 }, unique: true, partialFilterExpression: null }) === "partial");
ok("sparse drift → 'sparse_drift'", shapeReason(spec, { key: { rewardKey: 1 }, unique: true, partialFilterExpression: { rewardKey: { $type: "string" } }, sparse: true }) === "sparse_drift");
ok("TTL drift → 'ttl_drift'", shapeReason(spec, { key: { rewardKey: 1 }, unique: true, partialFilterExpression: { rewardKey: { $type: "string" } }, expireAfterSeconds: 60 }) === "ttl_drift");
ok("hidden drift → 'hidden_drift'", shapeReason(spec, { key: { rewardKey: 1 }, unique: true, partialFilterExpression: { rewardKey: { $type: "string" } }, hidden: true }) === "hidden_drift");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
