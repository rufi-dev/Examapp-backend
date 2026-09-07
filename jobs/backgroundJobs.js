const { beat } = require("../utils/heartbeat");
const { runDueExamReports } = require("./examReports");
const { sweepExpiredPlans } = require("./planExpiry");
const { rollUpAndPruneVisitors } = require("./visitorRollup");
const {
  finalizeExpiredAttempts,
  purgeExpiredArchived,
  purgeOrphanPdfs,
  purgeStagedUploads,
  purgeAbandonedExams,
} = require("../controllers/quizController");

function positiveMs(raw, fallback, { allowZero = false } = {}) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && (allowZero ? n >= 0 : n > 0) ? n : fallback;
}

function startBackgroundJobs({
  env = process.env,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
  clearTimeoutFn = clearTimeout,
  clearIntervalFn = clearInterval,
  jobs = {},
  wrap = beat,
} = {}) {
  const handles = [];
  let stopped = false;
  const schedule = (name, intervalMs, firstMs, fn) => {
    const tick = wrap(name, intervalMs, fn);
    handles.push({ kind: "timeout", value: setTimeoutFn(tick, firstMs) });
    handles.push({ kind: "interval", value: setIntervalFn(tick, intervalMs) });
  };

  // A lapsed plan must stop covering an over-cap roster promptly, and nothing else
  // in the system notices expiry — enforcement is otherwise lazy, per request.
  schedule("plan-lapse-sweep",
    positiveMs(env.PLAN_SWEEP_INTERVAL_MS, 15 * 60 * 1000),
    positiveMs(env.PLAN_SWEEP_FIRST_MS, 45 * 1000, { allowZero: true }),
    jobs.sweepExpiredPlans || sweepExpiredPlans);

  schedule("telegram-reports",
    positiveMs(env.REPORT_INTERVAL_MS, 10 * 60 * 1000),
    positiveMs(env.REPORT_FIRST_MS, 30 * 1000, { allowZero: true }),
    jobs.runDueExamReports || runDueExamReports);
  schedule("attempt-finalizer",
    positiveMs(env.FINALIZE_INTERVAL_MS, 60 * 1000),
    positiveMs(env.FINALIZE_FIRST_MS, 20 * 1000, { allowZero: true }),
    jobs.finalizeExpiredAttempts || finalizeExpiredAttempts);
  schedule("trash-purge",
    positiveMs(env.TRASH_INTERVAL_MS, 6 * 60 * 60 * 1000),
    positiveMs(env.TRASH_FIRST_MS, 60 * 1000, { allowZero: true }),
    jobs.purgeExpiredArchived || purgeExpiredArchived);
  schedule("orphan-pdf",
    positiveMs(env.PDF_SWEEP_INTERVAL_MS, 6 * 60 * 60 * 1000),
    positiveMs(env.PDF_SWEEP_FIRST_MS, 5 * 60 * 1000, { allowZero: true }),
    jobs.purgeOrphanPdfs || purgeOrphanPdfs);
  schedule("staged-pdf-purge",
    positiveMs(env.PDF_SWEEP_INTERVAL_MS, 6 * 60 * 60 * 1000),
    positiveMs(env.PDF_SWEEP_FIRST_MS, 5 * 60 * 1000, { allowZero: true }),
    jobs.purgeStagedUploads || purgeStagedUploads);
  /*
   * Visits older than a week become numbers. visitorsessions was the only
   * collection here with no retention at all — 93% of it was over a week old —
   * and a visit row carries an IP, a user agent and a journey of up to sixty
   * paths. The summary keeps none of those, so this is a privacy improvement as
   * much as a storage one.
   */
  schedule("visitor-rollup",
    positiveMs(env.VISITOR_ROLLUP_INTERVAL_MS, 24 * 60 * 60 * 1000),
    positiveMs(env.VISITOR_ROLLUP_FIRST_MS, 15 * 60 * 1000, { allowZero: true }),
    jobs.rollUpAndPruneVisitors || rollUpAndPruneVisitors);

  // Exams that were described and never written. Daily is often enough for a
  // week-old cutoff, and the first run waits out the boot rush.
  schedule("abandoned-exam-purge",
    positiveMs(env.ABANDONED_EXAM_INTERVAL_MS, 24 * 60 * 60 * 1000),
    positiveMs(env.ABANDONED_EXAM_FIRST_MS, 10 * 60 * 1000, { allowZero: true }),
    jobs.purgeAbandonedExams || purgeAbandonedExams);

  return function stopBackgroundJobs() {
    if (stopped) return;
    stopped = true;
    for (const handle of handles) {
      if (handle.kind === "timeout") clearTimeoutFn(handle.value);
      else clearIntervalFn(handle.value);
    }
    handles.length = 0;
  };
}

module.exports = { startBackgroundJobs, positiveMs };
