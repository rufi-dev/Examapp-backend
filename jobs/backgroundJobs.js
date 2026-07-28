const { beat } = require("../utils/heartbeat");
const { runDueExamReports } = require("./examReports");
const {
  finalizeExpiredAttempts,
  purgeExpiredArchived,
  purgeOrphanPdfs,
  purgeStagedUploads,
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
