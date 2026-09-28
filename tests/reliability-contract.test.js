const { startBackgroundJobs, positiveMs } = require("../jobs/backgroundJobs");
const { SPECS, shapeReason } = require("../helper/reliabilityIndexes");
const Attempt = require("../models/attemptModel");
const Exam = require("../models/examModel");

let passed = 0, failed = 0;
const ok = (name, condition) => {
  if (condition) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗ FAIL:", name); }
};
const attemptSpec = SPECS.find((x) => x.name === "due_attempt_finalizer");
// due_exam_report went with the Telegram report worker: nothing queries exams
// by report lease any more, so a spec for it would describe an index no code
// uses. The existing one stays in Mongo as an orphan, which is harmless.
const createSpec = SPECS.find((x) => x.name === "uniq_exam_creation");
ok("contract includes both reliability indexes", !!attemptSpec && !!createSpec);
const modelHas = (schema, spec) => schema.indexes().some(([key, options]) =>
  JSON.stringify(key) === JSON.stringify(spec.key) &&
  options.name === spec.name &&
  shapeReason(spec, { key, ...options }) === null);
ok("Attempt model matches finalizer contract", modelHas(Attempt.schema, attemptSpec));
ok("Exam model matches creation contract", modelHas(Exam.schema, createSpec));
ok("partial drift rejected", shapeReason(attemptSpec, {
  key: attemptSpec.key, partialFilterExpression: { submitted: true },
}) === "partial");
ok("uniqueness drift rejected", shapeReason(createSpec, {
  key: createSpec.key, unique: false,
  partialFilterExpression: createSpec.options.partialFilterExpression,
}) === "unique");

const timeouts = [], intervals = [], clearedTimeouts = [], clearedIntervals = [];
/*
 * Every job the scheduler owns. This list had fallen two behind the code — it
 * still named five when plan-lapse-sweep had made it six — so the four
 * assertions below had been failing for as long as that: a contract test that
 * fails constantly stops being read, and stops protecting anything.
 *
 * It went the other way when Telegram was retired: runDueExamReports existed
 * only to deliver the end-of-exam report over the bot, so the job and its name
 * left together. The count is the point of this file — change both or neither.
 */
const jobs = Object.fromEntries([
  "sweepExpiredPlans", "finalizeExpiredAttempts", "purgeExpiredArchived",
  "purgeOrphanPdfs", "purgeStagedUploads", "rollUpAndPruneVisitors", "purgeAbandonedExams",
].map((name) => [name, async () => name]));
const JOB_COUNT = 7;
const stop = startBackgroundJobs({
  env: {
    FINALIZE_INTERVAL_MS: "102", FINALIZE_FIRST_MS: "0",
    TRASH_INTERVAL_MS: "103", TRASH_FIRST_MS: "0",
    PDF_SWEEP_INTERVAL_MS: "104", PDF_SWEEP_FIRST_MS: "0",
    PLAN_SWEEP_INTERVAL_MS: "100", PLAN_SWEEP_FIRST_MS: "0",
    ABANDONED_EXAM_INTERVAL_MS: "105", ABANDONED_EXAM_FIRST_MS: "0",
    VISITOR_ROLLUP_INTERVAL_MS: "106", VISITOR_ROLLUP_FIRST_MS: "0",
  },
  jobs,
  wrap: (_name, _ms, fn) => fn,
  setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return `t${timeouts.length}`; },
  setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return `i${intervals.length}`; },
  clearTimeoutFn: (h) => clearedTimeouts.push(h),
  clearIntervalFn: (h) => clearedIntervals.push(h),
});
ok(`scheduler owns exactly ${JOB_COUNT} jobs`, timeouts.length === JOB_COUNT && intervals.length === JOB_COUNT);
ok("zero first-run delays are honored", timeouts.every((x) => x.ms === 0));
ok("configured intervals are honored",
  JSON.stringify(intervals.map((x) => x.ms)) === JSON.stringify([100, 102, 103, 104, 104, 106, 105]));
stop(); stop();
ok("stop is idempotent", clearedTimeouts.length === JOB_COUNT && clearedIntervals.length === JOB_COUNT);
ok("invalid durations fall back", positiveMs("NaN", 77) === 77 && positiveMs("-1", 77) === 77);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
