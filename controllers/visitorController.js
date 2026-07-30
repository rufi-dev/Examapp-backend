const asyncHandler = require("express-async-handler");
const VisitorSession = require("../models/visitorSessionModel");
const User = require("../models/userModel");

// Keep a visit's journey and payload bounded so one abusive client can't bloat a
// document. Older journey entries are dropped (we keep the most recent 60).
const MAX_JOURNEY = 60;
const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);

// IPs whose visits are NOT recorded (the owner's own address, office, etc.) so
// the analytics reflect real visitors, not us. Built-in default plus anything in
// TRACK_EXCLUDE_IPS (comma-separated) in the env.
const EXCLUDED_IPS = new Set(
  ["188.92.22.147", "84.15.216.173", ...String(process.env.TRACK_EXCLUDE_IPS || "").split(",")]
    .map((s) => s.trim())
    .filter(Boolean)
);

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
  // Silently drop our own traffic (matched on the client-reported IP or the
  // server-observed one) so we never track ourselves.
  if (EXCLUDED_IPS.has(clientIp) || EXCLUDED_IPS.has(req.ip)) return res.sendStatus(204);
  const path = clip(d.path, 300);

  const set = { lastActivity: now };
  // Refresh the IP only when the CLIENT supplies one (from /cdn-cgi/trace); a
  // later event that carries no IP must NOT clobber a good one with req.ip.
  if (clientIp) set.ip = clientIp;
  if (d.country) set.country = clip(d.country, 80);
  if (d.device) set.device = clip(d.device, 120);
  if (d.ua) set.userAgent = clip(d.ua, 400);
  if (d.event === "page_view" && path) set.lastPage = path;

  // Render-timing funnel. "open" = HTML loaded (early script, before the bundle);
  // "page_view" = the app painted. The gap between them is the pre-render bounce.
  if (d.event === "open") set.opened = true;
  if (d.event === "page_view") {
    set.rendered = true;
    const rm = Number(d.render_ms);
    if (Number.isFinite(rm) && rm >= 0) set.renderMs = Math.min(Math.round(rm), 600000);
  }
  // Reliable visit↔account link: the browser sends the logged-in user's id/name.
  // Set (not setOnInsert) so an anonymous visit that later logs in gets stamped.
  const uid = clip(d.uid, 40);
  if (uid && /^[a-f0-9]{24}$/i.test(uid)) {
    set.userId = uid;
    if (d.uname) set.userName = clip(d.uname, 120);
  }

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

// Map a source category to a filter on the stored affiliate/referrer/campaign.
// Aligns with the badge classifier so "Instagram" catches ig / instagram.com /
// l.instagram.com etc. "direct" = no meaningful source.
const SOURCE_PATTERNS = {
  instagram: "instagram|igsh|(^|[^a-z])ig([^a-z]|$)",
  facebook: "facebook|fbclid|(^|[^a-z])fb([^a-z]|$)",
  google: "google|gclid",
  tiktok: "tiktok",
  youtube: "youtube|youtu\\.be",
};
function sourceFilter(cat) {
  if (!cat) return null;
  if (cat === "direct") {
    return { $or: [{ affiliate: { $in: [null, "", "(direct)"] } }, { affiliate: { $exists: false } }] };
  }
  const p = SOURCE_PATTERNS[cat];
  const rx = p ? { $regex: p, $options: "i" } : { $regex: String(cat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  return { $or: [{ affiliate: rx }, { referrer: rx }, { campaign: rx }] };
}

/*
 * Admin list. Newest activity first, paginated, with optional filters:
 *   ?source=instagram|facebook|google|tiktok|youtube|direct
 *   ?unique=1   collapse to ONE row per IP (the latest) — hides the same device
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   date range on last activity
 * Returns the rows plus totals so the page can show "showing X of N".
 */
const listVisitors = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const skip = (page - 1) * limit;
  // Latest visit first by default; ?order=asc flips to oldest first.
  const order = req.query.order === "asc" ? 1 : -1;

  // Build the filter: date range + source category.
  const filter = {};
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(new Date(req.query.to).setHours(23, 59, 59, 999)) : null;
  if ((from && !isNaN(from)) || (to && !isNaN(to))) {
    filter.lastActivity = {};
    if (from && !isNaN(from)) filter.lastActivity.$gte = from;
    if (to && !isNaN(to)) filter.lastActivity.$lte = to;
  }
  const srcF = sourceFilter(req.query.source);
  if (srcF) Object.assign(filter, srcF);

  const unique = req.query.unique === "1" || req.query.unique === "true";

  let rows, total;
  if (unique) {
    // One row per IP: the most recent visit for each. Rows without an IP collapse
    // under a single null bucket.
    const base = [
      { $match: filter },
      { $sort: { lastActivity: -1 } },
      { $group: { _id: "$ip", doc: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$doc" } },
    ];
    const [countAgg, pageRows] = await Promise.all([
      VisitorSession.aggregate([...base, { $count: "n" }]),
      VisitorSession.aggregate([...base, { $sort: { lastActivity: order } }, { $skip: skip }, { $limit: limit }]),
    ]);
    total = countAgg[0]?.n || 0;
    rows = pageRows;
  } else {
    [rows, total] = await Promise.all([
      VisitorSession.find(filter).sort({ lastActivity: order }).skip(skip).limit(limit).lean(),
      VisitorSession.countDocuments(filter),
    ]);
  }

  // Detect which visits belong to a REGISTERED user by matching the visit IP
  // against users' signup/last IP. One query for the whole page; a shared IP can
  // map to several accounts, so we attach the list. `registered` = a real user.
  const ips = [...new Set(rows.map((r) => r.ip).filter(Boolean))];
  const byIp = {};
  if (ips.length) {
    const users = await User.find({ $or: [{ lastIp: { $in: ips } }, { signupIp: { $in: ips } }] })
      .select("name lastIp signupIp")
      .lean();
    for (const u of users) {
      for (const ip of [u.lastIp, u.signupIp]) {
        if (!ip) continue;
        if (!byIp[ip]) byIp[ip] = new Set();
        byIp[ip].add(u.name);
      }
    }
  }
  const withUsers = rows.map((r) => {
    const names = new Set();
    if (r.userName) names.add(r.userName); // explicit (logged-in) — most reliable
    if (r.ip && byIp[r.ip]) byIp[r.ip].forEach((n) => names.add(n)); // IP match
    return { ...r, registeredUsers: [...names] };
  });

  res.status(200).json({ page, limit, total, order: order === 1 ? "asc" : "desc", rows: withUsers });
});

module.exports = { track, listVisitors };
