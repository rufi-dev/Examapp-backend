const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const SessionRecording = require("../models/sessionRecordingModel");
const User = require("../models/userModel");

/*
 * Where session recordings live: one folder per recording on the recordings
 * volume, one gzip file per chunk the browser sent (NNNNN.json.gz, each a JSON
 * array of rrweb events). Kept out of MongoDB on purpose: they are big,
 * temporary, and do not belong in the nightly database backup.
 */

const DIR = () => process.env.RECORDINGS_DIR || path.join(process.cwd(), "recordings");
const RID = /^[a-f0-9]{24}$/;
const KEEP_DAYS = 30;
const MAX_UNPACKED = 200 * 1024 * 1024; // a recording larger than this is cut off when read

const newId = () => crypto.randomBytes(12).toString("hex");
const isId = (rid) => RID.test(String(rid || ""));
const folder = (rid) => {
  if (!isId(rid)) throw new Error("bad recording id");
  return path.join(DIR(), rid);
};

// The upload token: the recording id and an expiry, signed with the server
// secret. It lets the browser send the last chunk with sendBeacon as it leaves
// (no Authorization header possible there) without opening the route to anyone.
const secret = () => process.env.JWT_SECRET || "dev-recording-secret";
const sign = (rid, exp) => crypto.createHmac("sha256", secret()).update(`rec.${rid}.${exp}`).digest("base64url");
const issueToken = (rid, ttlMs = 12 * 3600 * 1000) => {
  const exp = Date.now() + ttlMs;
  return `${exp}.${sign(rid, exp)}`;
};
const checkToken = (rid, token) => {
  const [expRaw, sig] = String(token || "").split(".");
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const want = Buffer.from(sign(rid, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
};

const isGzip = (buf) => buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;

/* Store one chunk. Accepts gzip as sent, or plain JSON (gzipped here). */
async function writeChunk(rid, seq, body) {
  const dir = folder(rid);
  await fsp.mkdir(dir, { recursive: true });
  const data = isGzip(body) ? body : zlib.gzipSync(body);
  const file = path.join(dir, `${String(seq).padStart(5, "0")}.json.gz`);
  await fsp.writeFile(file, data);
  return data.length;
}

const seqOf = (name) => Number(String(name).split(".")[0]);

/*
 * The same event twice: a slice whose request reached the server while the
 * page was closing, so the browser never saw the reply and sent it again on
 * its way out. Two genuine events never match in time, type and content, so an
 * exact repeat is dropped. (A full snapshot is keyed by its moment alone: it
 * is large, and there is one at a time.)
 */
function dedupe(events) {
  const seen = new Set();
  return events.filter((e) => {
    const key = e?.type === 2 ? `${e.timestamp}|2` : `${e?.timestamp}|${e?.type}|${JSON.stringify(e?.data)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* The chunk numbers stored so far, ascending. */
async function chunkNames(rid) {
  try {
    return (await fsp.readdir(folder(rid))).filter((n) => n.endsWith(".json.gz")).sort();
  } catch {
    return [];
  }
}

/*
 * Every event of a recording, in order, and the last chunk number read. With
 * `after`, only chunks numbered above it: what arrived since the last look,
 * for watching a visit live.
 */
async function readEventsAfter(rid, after = -1) {
  const dir = folder(rid);
  const names = (await chunkNames(rid)).filter((n) => seqOf(n) > after);
  const events = [];
  let unpacked = 0;
  for (const name of names) {
    let text;
    try {
      const raw = zlib.gunzipSync(await fsp.readFile(path.join(dir, name)));
      unpacked += raw.length;
      if (unpacked > MAX_UNPACKED) break;
      text = raw.toString("utf8");
    } catch {
      continue; // a torn chunk (browser closed mid-send) is skipped, not fatal
    }
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) for (const e of arr) events.push(e);
    } catch {
      /* skip */
    }
  }
  events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const lastSeq = names.length ? seqOf(names[names.length - 1]) : after;
  return { events: dedupe(events), lastSeq };
}

async function readEvents(rid) {
  return (await readEventsAfter(rid, -1)).events;
}

async function removeRecording(rid) {
  if (!isId(rid)) return;
  await fsp.rm(folder(rid), { recursive: true, force: true });
  await SessionRecording.deleteOne({ _id: rid });
}

/*
 * Keep it temporary: drop recordings older than KEEP_DAYS, recordings whose
 * account did not end up a teacher (a visitor who registered as a student or
 * parent), and folders nothing points to.
 */
async function sweep(now = Date.now()) {
  const cutoff = new Date(now - KEEP_DAYS * 86400000);
  const old = await SessionRecording.find({ startedAt: { $lt: cutoff } }).select("_id").lean();
  for (const r of old) await removeRecording(r._id);

  const settled = new Date(now - 3 * 3600000); // give a fresh sign-up time to pick their role
  const recent = await SessionRecording.find({ startedAt: { $lt: settled } }).select("_id user").lean();
  if (recent.length) {
    const teachers = new Set(
      (await User.find({ _id: { $in: [...new Set(recent.map((r) => String(r.user)))] }, role: "teacher" }).select("_id").lean()).map((u) => String(u._id))
    );
    for (const r of recent) if (!teachers.has(String(r.user))) await removeRecording(r._id);
  }

  let names = [];
  try {
    names = await fsp.readdir(DIR());
  } catch {
    return;
  }
  const known = new Set((await SessionRecording.find({ _id: { $in: names.filter(isId) } }).select("_id").lean()).map((r) => r._id));
  for (const name of names) {
    if (!isId(name) || known.has(name)) continue;
    try {
      const st = fs.statSync(path.join(DIR(), name));
      if (now - st.mtimeMs > 86400000) await fsp.rm(path.join(DIR(), name), { recursive: true, force: true });
    } catch {
      /* gone already */
    }
  }
}

let lastSweep = 0;
/* Sweep at most once an hour, in the background. */
function maybeSweep() {
  if (Date.now() - lastSweep < 3600000) return;
  lastSweep = Date.now();
  sweep().catch(() => {});
}

module.exports = { newId, isId, issueToken, checkToken, writeChunk, readEvents, readEventsAfter, removeRecording, sweep, maybeSweep, KEEP_DAYS };
