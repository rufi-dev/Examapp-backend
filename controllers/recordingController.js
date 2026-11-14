const asyncHandler = require("express-async-handler");
const SessionRecording = require("../models/sessionRecordingModel");
const VisitorSession = require("../models/visitorSessionModel");
const store = require("../services/recordingStore");

/*
 * Session recordings of teachers and students, so an admin can watch what
 * someone actually did on the site: every page, every click, every error and
 * failed request.
 *
 * Who is recorded is decided twice. The browser buffers a visitor's visit in
 * memory and throws it away unless they sign up or log in; once signed in, it
 * asks here before sending anything. Every teacher since 2026-10-27; students
 * too since 2026-11-11 (owner: "enable sessions for students as well, in a
 * different tab, not blended with teachers"), listed apart (?who=students).
 * Never admins or parents: the sweep removes any recording whose account did
 * not end up a teacher or a student. Recordings are kept 3 days
 * (recordingStore.KEEP_DAYS).
 */

const ENABLED = () => process.env.SESSION_RECORDING !== "off";
const MAX_PER_DAY = 40;
const MAX_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_RECORDING_BYTES = 150 * 1024 * 1024;

// Teachers and students; a fresh Google sign-up is a "student" until it picks its
// role, so it is recorded either way and lands in the right tab once it has.
const eligible = (user) => !!user && (user.role === "teacher" || user.role === "student");

// The visitor tracker's id for this visit: where the teacher came from.
const cleanVisit = (v) => (/^[A-Za-z0-9_-]{6,64}$/.test(String(v || "")) ? String(v) : null);

// POST /api/rec/start — a signed-in teacher's browser asks to keep this visit.
const startRecording = asyncHandler(async (req, res) => {
  if (!ENABLED() || !eligible(req.user)) return res.status(204).end();
  const since = new Date(Date.now() - 86400000);
  if ((await SessionRecording.countDocuments({ user: req.user._id, startedAt: { $gte: since } })) >= MAX_PER_DAY) {
    return res.status(204).end();
  }
  if (await store.isFull()) {
    store.maybeSweep();
    return res.status(204).end();
  }
  const b = req.body || {};
  const rid = store.newId();
  await SessionRecording.create({
    _id: rid,
    user: req.user._id,
    visit: cleanVisit(b.visit),
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
      games: n(m.g), // waiting-room games opened (exam builder)
      pages: (Array.isArray(m.p) ? m.p : []).map((p) => String(p).slice(0, 200)).slice(0, 50),
      t1: Number.isFinite(Number(m.t1)) ? Number(m.t1) : null,
    };
  } catch {
    return { clicks: 0, errors: 0, apiErrors: 0, toasts: 0, games: 0, pages: [], t1: null };
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
    $inc: { chunks: 1, bytes: stored, clicks: meta.clicks, jsErrors: meta.errors, apiErrors: meta.apiErrors, toasts: meta.toasts, games: meta.games },
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
  // Where the visit came from (ad, campaign, country), per the visitor tracker.
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
  games: r.games || 0,
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

/*
 * A student's class(es) and teacher(s), so the students tab says whose they are:
 * { studentId -> [{ className, teacherName }] } from their approved enrolments.
 */
async function classesFor(rows) {
  const ids = [...new Set(rows.filter((r) => r.user && r.user.role === "student").map((r) => String(r.user._id)))];
  if (!ids.length) return new Map();
  const Enrollment = require("../models/enrollmentModel");
  const Class = require("../models/classModel");
  const User = require("../models/userModel");
  const enr = await Enrollment.find({ student: { $in: ids }, status: "approved" }).select("student class").lean();
  const classes = await Class.find({ _id: { $in: [...new Set(enr.map((e) => String(e.class)))] }, deletedAt: null }).select("name owner").lean();
  const owners = new Map((await User.find({ _id: { $in: [...new Set(classes.map((c) => String(c.owner)))] } }).select("name").lean()).map((u) => [String(u._id), u.name || ""]));
  const byClass = new Map(classes.map((c) => [String(c._id), { className: c.name || "", teacherName: owners.get(String(c.owner)) || "" }]));
  const out = new Map();
  for (const e of enr) {
    const c = byClass.get(String(e.class));
    if (!c) continue;
    const key = String(e.student);
    if (!out.has(key)) out.set(key, []);
    if (out.get(key).length < 3) out.get(key).push(c);
  }
  return out;
}

// The two tabs of the list: whose visits (by the account's role now).
const WHO = { teachers: "teacher", students: "student" };

// GET /api/rec?who=teachers|students&user= — admin: the recordings, newest first.
const listRecordings = asyncHandler(async (req, res) => {
  store.maybeSweep();
  const q = req.query || {};
  const filter = { chunks: { $gt: 0 } };
  if (q.user) filter.user = q.user;
  else {
    // Teachers and students never share a list: the default stays the teachers'.
    const role = WHO[q.who] || "teacher";
    const User = require("../models/userModel");
    const ids = await SessionRecording.distinct("user", filter);
    filter.user = { $in: await User.find({ _id: { $in: ids }, role }).distinct("_id") };
  }
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
  const rows = await SessionRecording.find(filter)
    .sort({ startedAt: -1 })
    .limit(limit)
    .populate("user", "name email role createdAt")
    .lean();
  const [sources, classes] = await Promise.all([sourcesFor(rows), classesFor(rows)]);
  res.json({
    recordings: rows.map((r) => ({
      ...listDto(r, r.visit ? sources.get(r.visit) : null),
      ...(r.user && r.user.role === "student" ? { classes: classes.get(String(r.user._id)) || [] } : {}),
    })),
  });
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
  // The same person: their account (a deleted account's visits are not linked).
  const same = userId ? { user: userId } : null;
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

module.exports = { startRecording, addChunk, listRecordings, getRecording, liveEvents, deleteRecording, eligible, isLive };
