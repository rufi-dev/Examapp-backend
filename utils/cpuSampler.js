const os = require("os");

// ---------------------------------------------------------------------------
// Background CPU sampler for the Health page.
//
// Why not sample on demand? os.cpus() gives cumulative times; the usual trick
// is to diff two snapshots a moment apart. But if that "moment" is measured
// INSIDE the /api/health handler, the window coincides with the health check's
// own burst (12 concurrent probes, `du` children, JSON parsing) and reports a
// bogus ~90%+ while the box is actually idle (load avg ~0.2 on 2 cores).
//
// So we sample continuously in the background over a fixed 10s window,
// completely decoupled from any request. A 10s window dwarfs the health
// check's own ~300-700ms burst, so the reading reflects real steady-state
// utilization. The interval is unref()'d so it never keeps the process alive.
// ---------------------------------------------------------------------------

const SAMPLE_MS = 10 * 1000;

const snapshot = () => {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
};

let prev = snapshot();
let latest = null; // null until the first interval delta lands (~10s)

const tick = () => {
  const cur = snapshot();
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt > 0) latest = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
  prev = cur;
};

const timer = setInterval(tick, SAMPLE_MS);
if (timer.unref) timer.unref();

// Bootstrap value for the first ~10s before a real sample exists: derive from
// the 1-minute load average (per core). On platforms where loadavg is 0
// (Windows dev) this reads 0, which is fine — production is Linux.
const loadEstimate = () => {
  const cores = os.cpus().length || 1;
  return Math.max(0, Math.min(100, Math.round((os.loadavg()[0] / cores) * 100)));
};

// Steady-state CPU utilization %, immune to the health check's own burst.
const getCpuPct = () => (latest == null ? loadEstimate() : latest);

module.exports = { getCpuPct };
