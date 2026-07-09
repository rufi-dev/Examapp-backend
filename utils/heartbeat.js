// ---------------------------------------------------------------------------
// Background-job heartbeat registry for the admin Health page. Each scheduled
// tick in server.js is wrapped with beat(name, intervalMs, fn) so the health
// API can answer: did every job run recently, and did its last run succeed?
// In-memory (single container) — resets on deploy like the process itself.
// ---------------------------------------------------------------------------

const jobs = new Map(); // name -> state

const ensure = (name, intervalMs) => {
  let j = jobs.get(name);
  if (!j) {
    j = {
      name,
      intervalMs,
      runs: 0,
      fails: 0,
      lastRunAt: null,
      lastOkAt: null,
      lastFailAt: null,
      lastError: null,
      lastDurationMs: null,
    };
    jobs.set(name, j);
  }
  return j;
};

// Wrap an async job fn: records timing + success/failure, never rethrows
// (schedulers must keep ticking even if one run explodes).
const beat = (name, intervalMs, fn) => {
  ensure(name, intervalMs);
  return async (...args) => {
    const j = jobs.get(name);
    const t0 = Date.now();
    j.lastRunAt = t0;
    j.runs += 1;
    try {
      await fn(...args);
      j.lastOkAt = Date.now();
      j.lastDurationMs = j.lastOkAt - t0;
    } catch (e) {
      j.fails += 1;
      j.lastFailAt = Date.now();
      j.lastDurationMs = j.lastFailAt - t0;
      j.lastError = String(e?.message || e).slice(0, 300);
      console.error(`[${name.toUpperCase()}] tick failed:`, e?.message);
    }
  };
};

// Status per job: ok | overdue | failing | pending (never ran yet).
const getJobs = () => {
  const now = Date.now();
  return [...jobs.values()].map((j) => {
    let status = "ok";
    if (!j.lastRunAt) status = "pending";
    else if (now - j.lastRunAt > j.intervalMs * 2.5) status = "overdue";
    else if (j.lastFailAt && (!j.lastOkAt || j.lastFailAt > j.lastOkAt)) status = "failing";
    return { ...j, status };
  });
};

module.exports = { beat, getJobs };
