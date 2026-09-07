/*
 * Summarise a day of visits, then delete the visits.
 *
 * ORDER IS THE WHOLE DESIGN. The summary is written and verified BEFORE a single
 * row is removed, and the delete is scoped to the exact day that was just
 * summarised. A crash between the two leaves duplicate raw rows, which the next
 * run simply re-summarises — the upsert is idempotent because it recomputes the
 * day from scratch rather than adding to what is there. A crash the other way
 * around would lose the day permanently, which is why it cannot happen in that
 * order.
 *
 * Only days that are OVER are touched: today is still being written to, so
 * summarising it would produce a number that is wrong by definition, and there
 * is no version of this job that should delete a row from the current day.
 */
const VisitorSession = require("../models/visitorSessionModel");
const VisitorDay = require("../models/visitorDayModel");

const AZ_TZ = "+04:00";
const DAY_MS = 24 * 60 * 60 * 1000;
const TOP = 12;

// Local-only traffic is excluded from the charts already; it must be excluded
// here too or the summary would disagree with the live numbers it replaces.
const LOCAL_IP_RE = /^(::1$|::ffff:127\.|127\.|localhost$|0\.0\.0\.0$)/i;

const dayKeyOf = (date) =>
  new Date(new Date(date).getTime() + 4 * 3600 * 1000).toISOString().slice(0, 10);

const bounds = (dayKey) => ({
  from: new Date(`${dayKey}T00:00:00.000${AZ_TZ}`),
  to: new Date(`${dayKey}T23:59:59.999${AZ_TZ}`),
});

const topOf = (map) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([key, n]) => ({ key: String(key).slice(0, 120), n }));

/*
 * Build one day's summary from the rows themselves. Read in a stream rather than
 * with an aggregation pipeline because the same pass has to produce the hour
 * histogram, the unique-per-hour histogram, four top-N tables and the funnel —
 * one walk over a few hundred small documents beats six round trips.
 */
async function summarizeDay(dayKey) {
  const { from, to } = bounds(dayKey);
  const cursor = VisitorSession.find({
    lastActivity: { $gte: from, $lte: to },
    ip: { $not: LOCAL_IP_RE },
  })
    .select("ip country affiliate device landing pageViews durationSeconds opened rendered renderMs userId lastActivity")
    .lean()
    .cursor();

  const doc = {
    day: dayKey,
    visits: 0,
    signedIn: 0,
    pageViews: 0,
    durationSeconds: 0,
    opened: 0,
    rendered: 0,
    renderMsTotal: 0,
    renderMsCount: 0,
    hours: Array(24).fill(0),
    hoursUnique: Array(24).fill(0),
    rolledUpAt: new Date(),
  };
  const ips = new Set();
  const perHourIps = Array.from({ length: 24 }, () => new Set());
  const countries = new Map();
  const sources = new Map();
  const devices = new Map();
  const landings = new Map();
  const bump = (map, key) => {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + 1);
  };

  for await (const v of cursor) {
    doc.visits += 1;
    if (v.userId) doc.signedIn += 1;
    doc.pageViews += Number(v.pageViews) || 0;
    doc.durationSeconds += Number(v.durationSeconds) || 0;
    if (v.opened) doc.opened += 1;
    if (v.rendered) doc.rendered += 1;
    if (Number.isFinite(v.renderMs)) {
      doc.renderMsTotal += v.renderMs;
      doc.renderMsCount += 1;
    }
    const hour = Number(
      new Date(new Date(v.lastActivity).getTime() + 4 * 3600 * 1000).toISOString().slice(11, 13)
    );
    if (hour >= 0 && hour < 24) {
      doc.hours[hour] += 1;
      perHourIps[hour].add(v.ip || "—");
    }
    if (v.ip) ips.add(v.ip);
    bump(countries, v.country);
    bump(sources, v.affiliate);
    bump(devices, v.device);
    bump(landings, v.landing);
  }

  doc.uniqueIps = ips.size;
  doc.hoursUnique = perHourIps.map((s) => s.size);
  doc.countries = topOf(countries);
  doc.sources = topOf(sources);
  doc.devices = topOf(devices);
  doc.landings = topOf(landings);
  return doc;
}

/*
 * Roll up every finished day that still has rows, then delete the rows for days
 * older than the retention window. Returns what it did, so the job log says
 * something useful rather than "ok".
 */
async function rollUpAndPruneVisitors(now = Date.now(), opts = {}) {
  const keepDays = Number.isFinite(opts.keepDays) ? opts.keepDays : 7;
  const cutoff = new Date(now - keepDays * DAY_MS);
  const today = dayKeyOf(now);

  // The days that still have rows and are already over. Nothing is assumed about
  // which days exist: a gap in traffic is a day with no rows and no summary.
  const days = await VisitorSession.distinct("lastActivity", {
    lastActivity: { $lt: new Date(new Date(`${today}T00:00:00.000${AZ_TZ}`).getTime()) },
  }).then((dates) => [...new Set(dates.map(dayKeyOf))].sort());

  let summarised = 0;
  for (const day of days) {
    // eslint-disable-next-line no-await-in-loop
    const summary = await summarizeDay(day);
    /*
     * Written even when the count is zero. A day whose only rows were localhost
     * or excluded traffic summarises to nothing, and skipping it would leave a
     * day that has rows and no summary — which the delete pass below correctly
     * refuses to touch, so those rows would live forever. "That day had no
     * counted visits" is a true statement and a few dozen bytes.
     */
    // Replaced, not merged: recomputing the whole day from the rows is what makes
    // a re-run after a crash produce the same number instead of double-counting.
    // eslint-disable-next-line no-await-in-loop
    await VisitorDay.updateOne({ day }, { $set: summary }, { upsert: true });
    summarised += 1;
  }

  /*
   * Only now, and only for days whose summary is on disk. The predicate is the
   * retention window, but the guarantee comes from the loop above having already
   * written every day that is about to be deleted.
   */
  const prunable = days.filter((d) => new Date(`${d}T23:59:59.999${AZ_TZ}`) < cutoff);
  let removed = 0;
  if (prunable.length) {
    const have = new Set(
      (await VisitorDay.find({ day: { $in: prunable } }).select("day").lean()).map((r) => r.day)
    );
    // A day with rows but no summary is a day the summariser skipped or failed
    // on. It keeps its rows: losing visits is worse than keeping them a week
    // longer, and the next run gets another go at it.
    const safe = prunable.filter((d) => have.has(d));
    for (const day of safe) {
      const { from, to } = bounds(day);
      // eslint-disable-next-line no-await-in-loop
      const r = await VisitorSession.deleteMany({ lastActivity: { $gte: from, $lte: to } });
      removed += r.deletedCount || 0;
    }
    const skipped = prunable.length - safe.length;
    if (skipped) console.warn(`[VISITORS] ${skipped} day(s) had no summary; their rows were kept`);
  }

  if (summarised || removed) {
    console.log(`[VISITORS] summarised ${summarised} day(s), removed ${removed} visit row(s)`);
  }
  return { summarised, removed };
}

module.exports = { rollUpAndPruneVisitors, summarizeDay, dayKeyOf };
