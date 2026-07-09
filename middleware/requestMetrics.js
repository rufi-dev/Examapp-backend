// ---------------------------------------------------------------------------
// In-memory request metrics for the admin Health page. Single-container app,
// so process-local state is authoritative; everything resets on deploy, which
// is fine (the Health page also shows persisted uptime history from Mongo).
//
// Collected per request (on response finish):
//   - per-minute buckets (last 60 min): count, 4xx, 5xx, total/max duration
//   - per-route aggregates (last-hour window, coarse): count, avg/max ms, errors
//   - grouped error log (status+route+message) so one repeating error is a
//     single row with a count, not hundreds of rows
//
// Route keys are normalized (Mongo ids / numbers → :id) so /exam/abc and
// /exam/def aggregate to one row and the maps stay tiny.
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000;
const WINDOW_MINUTES = 60; // per-minute buckets kept
const MAX_ROUTES = 300; // per-route map cap (overflow lumps into "(digər)")
const MAX_ERROR_GROUPS = 200;

const startedAt = Date.now();

// minuteEpoch -> { count, err4, err5, totalMs, maxMs }
const buckets = new Map();
// "GET /api/quiz/exam/:id" -> { count, totalMs, maxMs, err4, err5, lastAt }
const routes = new Map();
// "status|route|message" -> { status, route, message, count, firstAt, lastAt }
const errorGroups = new Map();

let totalRequests = 0;

// /api/quiz/exam/64fa.../restore -> /api/quiz/exam/:id/restore
const normalizePath = (url) => {
  const path = String(url || "").split("?")[0];
  return (
    path
      .split("/")
      .map((seg) =>
        /^[a-f0-9]{24}$/i.test(seg) || /^\d+$/.test(seg) || seg.length > 40
          ? ":id"
          : seg
      )
      .join("/") || "/"
  );
};

const bucketFor = (now) => {
  const key = Math.floor(now / MINUTE);
  let b = buckets.get(key);
  if (!b) {
    b = { count: 0, err4: 0, err5: 0, totalMs: 0, maxMs: 0 };
    buckets.set(key, b);
    // prune anything older than the window (map stays ≤ ~61 entries)
    for (const k of buckets.keys()) if (k < key - WINDOW_MINUTES) buckets.delete(k);
  }
  return b;
};

// Recorded by errorMiddleware so the health page can show the actual error
// message (res 'finish' only sees the status code).
const recordErrorEvent = (req, statusCode, message) => {
  try {
    // Same exclusion as the timing middleware: the health page's own traffic
    // (e.g. a 401 from an expired admin session) shouldn't pollute the log.
    if (req.originalUrl.startsWith("/api/health")) return;
    const route = `${req.method} ${normalizePath(req.originalUrl)}`;
    const msg = String(message || "").slice(0, 300);
    const key = `${statusCode}|${route}|${msg}`;
    const now = Date.now();
    let g = errorGroups.get(key);
    if (!g) {
      if (errorGroups.size >= MAX_ERROR_GROUPS) {
        // drop the oldest group to make room
        let oldestKey, oldestAt = Infinity;
        for (const [k, v] of errorGroups)
          if (v.lastAt < oldestAt) { oldestAt = v.lastAt; oldestKey = k; }
        if (oldestKey) errorGroups.delete(oldestKey);
      }
      g = { status: statusCode, route, message: msg, count: 0, firstAt: now, lastAt: now };
      errorGroups.set(key, g);
    }
    g.count += 1;
    g.lastAt = now;
  } catch {
    /* metrics must never break a request */
  }
};

const requestMetrics = (req, res, next) => {
  // The health page itself polls every ~30s — keep it out of the numbers so
  // the dashboard doesn't mostly measure itself. CORS preflights are skipped
  // too: browsers send one OPTIONS per API call here (no Access-Control-Max-Age),
  // which would double request counts and dilute avg response times.
  if (req.method === "OPTIONS" || req.originalUrl.startsWith("/api/health")) return next();

  const t0 = process.hrtime.bigint();
  res.on("finish", () => {
    try {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const now = Date.now();
      totalRequests += 1;

      const b = bucketFor(now);
      b.count += 1;
      b.totalMs += ms;
      if (ms > b.maxMs) b.maxMs = ms;
      if (res.statusCode >= 500) b.err5 += 1;
      else if (res.statusCode >= 400) b.err4 += 1;

      let routeKey = `${req.method} ${normalizePath(req.originalUrl)}`;
      if (!routes.has(routeKey) && routes.size >= MAX_ROUTES) routeKey = "(digər)";
      let r = routes.get(routeKey);
      if (!r) {
        r = { count: 0, totalMs: 0, maxMs: 0, err4: 0, err5: 0, lastAt: 0 };
        routes.set(routeKey, r);
      }
      r.count += 1;
      r.totalMs += ms;
      if (ms > r.maxMs) r.maxMs = ms;
      if (res.statusCode >= 500) r.err5 += 1;
      else if (res.statusCode >= 400) r.err4 += 1;
      r.lastAt = now;
    } catch {
      /* never break a request over metrics */
    }
  });
  next();
};

// Aggregate snapshot for the health API.
const getMetrics = () => {
  const now = Date.now();
  const nowKey = Math.floor(now / MINUTE);

  const series = []; // oldest → newest, one point per minute
  let count = 0, err4 = 0, err5 = 0, totalMs = 0, maxMs = 0;
  let last15 = { count: 0, err4: 0, err5: 0, totalMs: 0 };
  for (let k = nowKey - WINDOW_MINUTES + 1; k <= nowKey; k += 1) {
    const b = buckets.get(k) || { count: 0, err4: 0, err5: 0, totalMs: 0, maxMs: 0 };
    series.push({
      t: k * MINUTE,
      count: b.count,
      err4: b.err4,
      err5: b.err5,
      avgMs: b.count ? Math.round(b.totalMs / b.count) : 0,
      maxMs: Math.round(b.maxMs),
    });
    count += b.count; err4 += b.err4; err5 += b.err5; totalMs += b.totalMs;
    if (b.maxMs > maxMs) maxMs = b.maxMs;
    if (k > nowKey - 15) {
      last15.count += b.count; last15.err4 += b.err4;
      last15.err5 += b.err5; last15.totalMs += b.totalMs;
    }
  }

  const routeRows = [...routes.entries()]
    .map(([route, r]) => ({
      route,
      count: r.count,
      avgMs: r.count ? Math.round(r.totalMs / r.count) : 0,
      maxMs: Math.round(r.maxMs),
      err4: r.err4,
      err5: r.err5,
      lastAt: r.lastAt,
    }))
    .sort((a, b) => b.avgMs - a.avgMs);

  const errors = [...errorGroups.values()].sort((a, b) => b.lastAt - a.lastAt);

  return {
    startedAt,
    totalRequests,
    lastHour: {
      count,
      err4,
      err5,
      avgMs: count ? Math.round(totalMs / count) : 0,
      maxMs: Math.round(maxMs),
      errorRatePct: count ? +(((err4 + err5) / count) * 100).toFixed(2) : 0,
      rate5xxPct: count ? +((err5 / count) * 100).toFixed(2) : 0,
    },
    last15min: {
      count: last15.count,
      err4: last15.err4,
      err5: last15.err5,
      avgMs: last15.count ? Math.round(last15.totalMs / last15.count) : 0,
      reqPerMin: +(last15.count / 15).toFixed(1),
    },
    perMinute: series,
    slowestRoutes: routeRows.slice(0, 12),
    busiestRoutes: [...routeRows].sort((a, b) => b.count - a.count).slice(0, 12),
    errorGroups: errors.slice(0, 60),
  };
};

module.exports = { requestMetrics, recordErrorEvent, getMetrics };
