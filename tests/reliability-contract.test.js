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
const reportSpec = SPECS.find((x) => x.name === "due_exam_report");
const createSpec = SPECS.find((x) => x.name === "uniq_exam_creation");
ok("contract includes all three reliability indexes", !!attemptSpec && !!reportSpec && !!createSpec);
const modelHas = (schema, spec) => schema.indexes().some(([key, options]) =>
  JSON.stringify(key) === JSON.stringify(spec.key) &&
  options.name === spec.name &&
  shapeReason(spec, { key, ...options }) === null);
ok("Attempt model matches finalizer contract", modelHas(Attempt.schema, attemptSpec));
ok("Exam model matches report contract", modelHas(Exam.schema, reportSpec));
ok("Exam model matches creation contract", modelHas(Exam.schema, createSpec));
ok("partial drift rejected", shapeReason(attemptSpec, {
  key: attemptSpec.key, partialFilterExpression: { submitted: true },
}) === "partial");
ok("uniqueness drift rejected", shapeReason(createSpec, {
  key: createSpec.key, unique: false,
  partialFilterExpression: createSpec.options.partialFilterExpression,
}) === "unique");

const timeouts = [], intervals = [], clearedTimeouts = [], clearedIntervals = [];
const jobs = Object.fromEntries([
  "runDueExamReports", "finalizeExpiredAttempts", "purgeExpiredArchived",
  "purgeOrphanPdfs", "purgeStagedUploads",
].map((name) => [name, async () => name]));
const stop = startBackgroundJobs({
  env: {
    REPORT_INTERVAL_MS: "101", REPORT_FIRST_MS: "0",
    FINALIZE_INTERVAL_MS: "102", FINALIZE_FIRST_MS: "0",
    TRASH_INTERVAL_MS: "103", TRASH_FIRST_MS: "0",
    PDF_SWEEP_INTERVAL_MS: "104", PDF_SWEEP_FIRST_MS: "0",
  },
  jobs,
  wrap: (_name, _ms, fn) => fn,
  setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return `t${timeouts.length}`; },
  setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return `i${intervals.length}`; },
  clearTimeoutFn: (h) => clearedTimeouts.push(h),
  clearIntervalFn: (h) => clearedIntervals.push(h),
});
ok("scheduler owns exactly five jobs", timeouts.length === 5 && intervals.length === 5);
ok("zero first-run delays are honored", timeouts.every((x) => x.ms === 0));
ok("configured intervals are honored",
  JSON.stringify(intervals.map((x) => x.ms)) === JSON.stringify([101, 102, 103, 104, 104]));
stop(); stop();
ok("stop is idempotent", clearedTimeouts.length === 5 && clearedIntervals.length === 5);
ok("invalid durations fall back", positiveMs("NaN", 77) === 77 && positiveMs("-1", 77) === 77);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
