const asyncHandler = require("express-async-handler");
const VisitorSession = require("../models/visitorSessionModel");

// Keep a visit's journey and payload bounded so one abusive client can't bloat a
// document. Older journey entries are dropped (we keep the most recent 60).
const MAX_JOURNEY = 60;
const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);

/*
 * Public ingest. The site posts a small JSON payload (as text/plain, so no CORS
 * preflight) on every page view and periodically while the tab is open. We upsert
 * the visit row keyed by sessionId:
 *  - first-touch fields (landing/referrer/affiliate/campaign) are written ONCE,
 *  - IP/country/device refresh whenever supplied (client trace) with req.ip as a
 *    server-side fallback,
 *  - page_view extends the journey + bumps the counter,
 *  - duration is kept as the max reported (active seconds on site).
 * Always answers 204 fast; never trusts the body for anything but analytics.
 */
const track = asyncHandler(async (req, res) => {
  // The route parses text/plain into a string; tolerate a pre-parsed object too.
  let d = req.body;
  if (typeof d === "string") {
    try { d = JSON.parse(d); } catch { d = null; }
  }
  if (!d || typeof d !== "object") return res.sendStatus(204);

  const sessionId = clip(d.session_id, 80);
  if (!sessionId) return res.sendStatus(204);

  const now = new Date();
  const clientIp = clip(d.ip, 64);
  const path = clip(d.path, 300);

  const set = { lastActivity: now };
  // Refresh the IP only when the CLIENT supplies one (from /cdn-cgi/trace); a
  // later event that carries no IP must NOT clobber a good one with req.ip.
  if (clientIp) set.ip = clientIp;
  if (d.country) set.country = clip(d.country, 80);
  if (d.device) set.device = clip(d.device, 120);
  if (d.ua) set.userAgent = clip(d.ua, 400);
  if (d.event === "page_view" && path) set.lastPage = path;

  const setOnInsert = {
    firstSeen: now,
    landing: clip(d.landing, 300) || path || "",
    referrer: clip(d.referrer, 400) || "(direct)",
    affiliate: clip(d.affiliate, 200) || "(direct)",
    campaign: clip(d.utm && d.utm.utm_campaign, 200) || "",
  };
  // Server-observed IP as the first-touch fallback (the real client IP behind
  // Caddy, since trust proxy is on). Only applied on insert, and only when the
  // client hasn't already sent one — so it never overrides the client value.
  if (!clientIp && req.ip) setOnInsert.ip = req.ip;

  const update = { $set: set, $setOnInsert: setOnInsert };

  const dur = Number(d.duration);
  if (Number.isFinite(dur) && dur > 0) update.$max = { durationSeconds: Math.min(dur, 86400) };

  if (d.event === "page_view" && path) {
    update.$push = { pages: { $each: [path], $slice: -MAX_JOURNEY } };
    update.$inc = { pageViews: 1 };
  }

  try {
    await VisitorSession.updateOne({ sessionId }, update, { upsert: true });
  } catch {
    // A race can insert the same new sessionId twice → duplicate-key. Retry once
    // as a pure update (the row now exists); ignore anything else — analytics
    // must never surface an error to a visitor.
    try { await VisitorSession.updateOne({ sessionId }, { $set: set }); } catch { /* ignore */ }
  }
  return res.sendStatus(204);
});

/*
 * Admin list. Newest activity first, paginated. Returns the rows plus totals so
 * the page can show "showing X of N".
 */
const listVisitors = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const skip = (page - 1) * limit;
  // Latest visit first by default; ?order=asc flips to oldest first.
  const order = req.query.order === "asc" ? 1 : -1;

  const [rows, total] = await Promise.all([
    VisitorSession.find({}).sort({ lastActivity: order }).skip(skip).limit(limit).lean(),
    VisitorSession.estimatedDocumentCount(),
  ]);

  res.status(200).json({ page, limit, total, order: order === 1 ? "asc" : "desc", rows });
});

module.exports = { track, listVisitors };
