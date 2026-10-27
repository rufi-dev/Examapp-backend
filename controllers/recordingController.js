const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const SessionRecording = require("../models/sessionRecordingModel");
const VisitorSession = require("../models/visitorSessionModel");
const store = require("../services/recordingStore");
const { stuckStateForOwners } = require("../helper/stuckTeachers");

/*
 * Session recordings, so an admin can watch what people actually did on the
 * site: every page, every click, every error and failed request.
 *
 * Since 2026-10-27 (owner: "every single one visiting") that is every visitor,
 * signed in or not, and every teacher however long they have been here; it used
 * to be only teachers in their first 14 days. Not recorded: admins, and students
 * and parents (the privacy page promises it for children; SESSION_RECORDING_STUDENTS
 * =on changes that). A visitor's recording becomes their account's when they
 * sign up or log in during the visit (claim); if that account is a student's or
 * a parent's, the recording is deleted there and then.
 *
 * Guards for recording strangers: known bots are not recorded, one IP address
 * gets at most MAX_VISITOR_PER_DAY recordings a day, and once the volume is full
 * (RECORDINGS_MAX_MB) nothing new is kept until the sweep makes room.
 */

const ENABLED = () => process.env.SESSION_RECORDING !== "off";
const MAX_PER_DAY = 40;
const MAX_VISITOR_PER_DAY = 30;
const MAX_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_RECORDING_BYTES = 150 * 1024 * 1024;

const eligible = (user, now = Date.now()) => {
  if (!user || user.role === "admin") return false;
  if (store.RECORDED_ROLES().includes(user.role)) return true;
  // A fresh account is a "student" until its role is picked (a Google sign-up),
  // so it is kept for now; the sweep removes it if it stays a student or parent.
  return now - new Date(user.createdAt || 0).getTime() <= 2 * 3600000 && user.role !== "parent";
};

// Crawlers, link previews, headless browsers and speed tests are not visitors.
// (People inside WhatsApp's, TikTok's or Instagram's own browser are: those
// identify as an ordinary phone browser; only the preview fetchers match here.)
const BOT = /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pagespeed|facebookexternalhit|whatsapp\/|python|curl\/|wget|axios\/|node-fetch|go-http|java\//i;
const isBot = (ua) => !ua || BOT.test(String(ua));
const hashIp = (ip) => crypto.createHash("sha256").update(`rec-ip.${process.env.JWT_SECRET || ""}.${ip || ""}`).digest("hex").slice(0, 24);
const cleanVisit = (v) => (/^[A-Za-z0-9_-]{6,64}$/.test(String(v || "")) ? String(v) : null);

// POST /api/rec/start — a browser asks to keep this visit (signed in or not).
const startRecording = asyncHandler(async (req, res) => {
  if (!ENABLED()) return res.status(204).end();
  const since = new Date(Date.now() - 86400000);
  let ipHash = null;
  if (req.user) {
    if (!eligible(req.user)) return res.status(204).end();
    if ((await SessionRecording.countDocuments({ user: req.user._id, startedAt: { $gte: since } })) >= MAX_PER_DAY) return res.status(204).end();
  } else {
    if (isBot(req.headers["user-agent"])) return res.status(204).end();
    ipHash = hashIp(req.ip);
    if ((await SessionRecording.countDocuments({ ipHash, startedAt: { $gte: since } })) >= MAX_VISITOR_PER_DAY) return res.status(204).end();
  }
  if (await store.isFull()) {
    store.maybeSweep();
    return res.status(204).end();
  }
  const b = req.body || {};
  const rid = store.newId();
  await SessionRecording.create({
    _id: rid,
    user: req.user?._id || null,
    visit: cleanVisit(b.visit),
    ipHash,
    startedAt: new Date(),
    firstEventAt: Number.isFinite(Number(b.t0)) ? Number(b.t0) : null,
    registeredInSession: !!b.registered,
    entry: String(b.entry || "").slice(0, 200),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 400),
    screen: String(b.screen || "").slice(0, 20),
  });
  store.maybeSweep();
  res.status(201).json({ rid, token: store.issueToken(rid) });
});

/*
 * POST /api/rec/:rid/claim — the visitor whose visit this is has just signed up
 * or logged in: the visit becomes their account's (the part before is kept), or,
 * if that account is not recorded (a student, a parent, an admin), the recording
 * is deleted now. Proven by the recording's upload token, plus the login.
 */
const claimRecording = asyncHandler(async (req, res) => {
  const { rid } = req.params;
  const b = req.body || {};
  if (!store.isId(rid) || !store.checkToken(rid, b.token)) return res.status(403).end();
  const rec = await SessionRecording.findById(rid).select("user").lean();
  if (!rec) return res.status(404).end();
  if (rec.user && String(rec.user) !== String(req.user._id)) return res.status(409).json({ kept: false });
  if (!eligible(req.user)) {
    await store.removeRecording(rid);
    return res.json({ kept: false });
  }
  await SessionRecording.updateOne({ _id: rid }, { $set: { user: req.user._id, ...(b.registered ? { registeredInSession: true } : {}) } });
  res.json({ kept: true });
});

// What the browser says the chunk held: counts and the pages passed through.
const readMeta = (raw) => {
  try {
    const m = JSON.parse(Buffer.from(String(raw || ""), "base64url").toString("utf8"));
    const n = (v) => Math.max(0, Math.min(100000, Math.trunc(Number(v) || 0)));
    return {
      clicks: n(m.c),
      errors: n(m.e),
      apiErrors: n(m.a),
      toasts: n(m.o),
      pages: (Array.isArray(m.p) ? m.p : []).map((p) => String(p).slice(0, 200)).slice(0, 50),
      t1: Number.isFinite(Number(m.t1)) ? Number(m.t1) : null,
    };
  } catch {
    return { clicks: 0, errors: 0, apiErrors: 0, toasts: 0, pages: [], t1: null };
  }
};

// POST /api/rec/:rid/chunk?seq=&t=&z=&m=&final= — one slice of the recording.
// Authorised by the signed token, not a login, so the last slice can be sent
// with sendBeacon while the page is closing.
const addChunk = asyncHandler(async (req, res) => {
  const { rid } = req.params;
  if (!store.isId(rid) || !store.checkToken(rid, req.query.t)) return res.status(403).end();
  const seq = Number(req.query.seq);
  if (!Number.isInteger(seq) || seq < 0 || seq > 50000) return res.status(400).end();
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : "");
  if (!body.length) return res.status(400).end();
  if (body.length > MAX_CHUNK_BYTES) return res.status(413).end();

  const rec = await SessionRecording.findById(rid).select("bytes").lean();
  if (!rec) return res.status(404).end();
  if (rec.bytes + body.length > MAX_RECORDING_BYTES) return res.status(413).end();

  const stored = await store.writeChunk(rid, seq, body);
  const meta = readMeta(req.query.m);
  const update = {
    $inc: { chunks: 1, bytes: stored, clicks: meta.clicks, jsErrors: meta.errors, apiErrors: meta.apiErrors, toasts: meta.toasts },
    $set: { lastChunkAt: new Date(), ...(meta.t1 ? { lastEventAt: meta.t1 } : {}), ...(req.query.final === "1" ? { endedAt: new Date() } : {}) },
  };
  if (meta.pages.length) {
    update.$push = { pages: { $each: meta.pages, $slice: -200 } };
    update.$set.exit = meta.pages[meta.pages.length - 1];
  }
  await SessionRecording.updateOne({ _id: rid }, update);
  res.status(204).end();
});

// Still going: not closed by the browser, and a slice arrived in the last
// 90 seconds (the browser sends one every few seconds while anything happens).
const LIVE_MS = 90 * 1000;
const isLive = (r, now = Date.now()) => !r.endedAt && !!r.lastChunkAt && now - new Date(r.lastChunkAt).getTime() < LIVE_MS;

const listDto = (r, source = null) => ({
  _id: r._id,
  user: r.user && typeof r.user === "object" ? { _id: r.user._id, name: r.user.name, email: r.user.email, role: r.user.role, createdAt: r.user.createdAt } : r.user,
  // A visitor (no account): where the visit came from, per the visitor tracker.
  source: source ? { affiliate: source.affiliate || null, campaign: source.campaign || null, country: source.country || null, referrer: source.referrer || null } : null,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  lastChunkAt: r.lastChunkAt,
  durationMs: r.firstEventAt && r.lastEventAt ? Math.max(0, r.lastEventAt - r.firstEventAt) : null,
  registeredInSession: r.registeredInSession,
  clicks: r.clicks,
  errors: r.jsErrors,
  apiErrors: r.apiErrors,
  toasts: r.toasts,
  pages: (r.pages || []).length,
  entry: r.entry,
  exit: r.exit,
  bytes: r.bytes,
  userAgent: r.userAgent,
  screen: r.screen,
  live: isLive(r),
});

// Where each visit came from (ad, campaign, country), from the visitor tracker.
async function sourcesFor(rows) {
  const visits = [...new Set(rows.map((r) => r.visit).filter(Boolean))];
  if (!visits.length) return new Map();
  const found = await VisitorSession.find({ sessionId: { $in: visits } }).select("sessionId affiliate campaign country referrer").lean();
  return new Map(found.map((v) => [v.sessionId, v]));
}

// GET /api/rec?user=&who=visitors|accounts&problems=1&stuck=1 — admin: the recordings, newest first.
const listRecordings = asyncHandler(async (req, res) => {
  store.maybeSweep();
  const q = req.query || {};
  const filter = { chunks: { $gt: 0 } };
  if (q.user) filter.user = q.user;
  else if (q.who === "visitors") filter.user = null;
  else if (q.who === "accounts") filter.user = { $ne: null };
  if (q.problems === "1") filter.$or = [{ jsErrors: { $gt: 0 } }, { apiErrors: { $gt: 0 } }, { toasts: { $gt: 0 } }];
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
  let rows = await SessionRecording.find(filter)
    .sort({ startedAt: -1 })
    .limit(q.stuck === "1" ? 600 : limit)
    .populate("user", "name email role createdAt")
    .lean();
  if (q.stuck === "1" && rows.length) {
    const ids = [...new Set(rows.filter((r) => r.user).map((r) => String(r.user._id)))];
    const state = await stuckStateForOwners(ids.map((id) => rows.find((r) => String(r.user?._id) === id).user._id));
    rows = rows.filter((r) => r.user && state.get(String(r.user._id))?.isStuck).slice(0, limit);
  }
  const sources = await sourcesFor(rows);
  res.json({ recordings: rows.map((r) => listDto(r, r.visit ? sources.get(r.visit) : null)) });
});

// GET /api/rec/:rid — admin: one recording, with every event to replay.
const getRecording = asyncHandler(async (req, res) => {
  const { rid } = req.params;
  if (!store.isId(rid)) return res.status(404).json({ message: "Tapılmadı" });
  const rec = await SessionRecording.findById(rid).populate("user", "name email role createdAt phone").lean();
  if (!rec) return res.status(404).json({ message: "Tapılmadı" });
  const { events, lastSeq } = await store.readEventsAfter(rid, -1);
  // The same person's visit right before or after this one: a page that
  // reloads (a new version of the site, say) ends one recording and starts the
  // next within seconds, and the admin should be able to step across.
  const end = rec.endedAt || rec.lastChunkAt || rec.startedAt;
  const userId = rec.user?._id || rec.user;
  // The same person: their account, or for a visitor the same visit (a reload
  // keeps the tab's visit id). A visitor without one is not linked to anybody.
  const same = userId ? { user: userId } : rec.visit ? { user: null, visit: rec.visit } : null;
  const [next, prev, sources] = await Promise.all([
    same
      ? SessionRecording.findOne({ ...same, _id: { $ne: rid }, startedAt: { $gte: new Date(new Date(rec.startedAt).getTime()), $lte: new Date(new Date(end).getTime() + 60 * 1000) } })
          .sort({ startedAt: 1 })
          .select("_id startedAt endedAt lastChunkAt")
          .lean()
      : null,
    same
      ? SessionRecording.findOne({ ...same, _id: { $ne: rid }, startedAt: { $lt: rec.startedAt }, $or: [{ endedAt: { $gte: new Date(new Date(rec.startedAt).getTime() - 60 * 1000) } }, { lastChunkAt: { $gte: new Date(new Date(rec.startedAt).getTime() - 60 * 1000) } }] })
          .sort({ startedAt: -1 })
          .select("_id startedAt")
          .lean()
      : null,
    sourcesFor([rec]),
  ]);
  res.json({
    recording: { ...listDto(rec, rec.visit ? sources.get(rec.visit) : null), pageList: rec.pages || [] },
    events,
    lastSeq,
    next: next && next.startedAt > rec.startedAt ? { _id: next._id, startedAt: next.startedAt, live: isLive(next) } : null,
    prev: prev ? { _id: prev._id, startedAt: prev.startedAt } : null,
  });
});

// GET /api/rec/:rid/live?after=N — admin: what arrived since chunk N, and
// whether the visit is still going, for watching it live without reloading.
const liveEvents = asyncHandler(async (req, res) => {
  const { rid } = req.params;
  if (!store.isId(rid)) return res.status(404).json({ message: "Tapılmadı" });
  const rec = await SessionRecording.findById(rid).select("endedAt lastChunkAt clicks jsErrors apiErrors toasts pages firstEventAt lastEventAt").lean();
  if (!rec) return res.status(404).json({ message: "Tapılmadı" });
  const after = Number.isInteger(Number(req.query.after)) ? Number(req.query.after) : -1;
  const { events, lastSeq } = await store.readEventsAfter(rid, after);
  res.json({ events, lastSeq, live: isLive(rec), endedAt: rec.endedAt || null });
});

// DELETE /api/rec/:rid — admin.
const deleteRecording = asyncHandler(async (req, res) => {
  await store.removeRecording(req.params.rid);
  res.status(204).end();
});

module.exports = { startRecording, claimRecording, addChunk, listRecordings, getRecording, liveEvents, deleteRecording, eligible, isLive, isBot };
