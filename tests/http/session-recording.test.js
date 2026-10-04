/*
 * Session recordings of new teachers, over the real router and a real
 * (in-memory) database: who may be recorded, how slices are authorised and
 * stored, that only an admin can watch, and that the sweep keeps it temporary.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-recording";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-recording";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.RECORDINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rec-test-"));

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log("  ✓", label);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", label, extra ? `- ${extra}` : "");
  }
};

async function main() {
  console.log("session recordings");
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "recordings" });

  const User = require("../../models/userModel");
  const SessionRecording = require("../../models/sessionRecordingModel");
  const store = require("../../services/recordingStore");
  const { generateToken } = require("../../utils");
  const errorHandler = require("../../middleware/errorMiddleware");

  const days = (n) => new Date(Date.now() - n * 86400000);
  const mk = (o) => User.create({ password: "Baslangic1", isVerified: true, ...o });
  const fresh = await mk({ name: "Yeni", email: "new@rec.test", role: "teacher", teacherApproval: "approved" });
  const veteran = await mk({ name: "Köhnə", email: "old@rec.test", role: "teacher", teacherApproval: "approved" });
  // Straight to the collection: Mongoose treats createdAt as immutable.
  const users = mongoose.connection.db.collection("users");
  await users.updateOne({ _id: veteran._id }, { $set: { createdAt: days(40) } });
  const pupil = await mk({ name: "Şagird", email: "s@rec.test", role: "student", grade: "9" });
  await users.updateOne({ _id: pupil._id }, { $set: { createdAt: days(10) } });
  const admin = await mk({ name: "Admin", email: "a@rec.test", role: "admin" });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/rec", require("../../routes/recordingRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/api/rec`;
  const auth = (u) => ({ Authorization: `Bearer ${generateToken(u._id, u.sessionVersion)}` });
  const start = (u, body = {}) =>
    fetch(`${base}/start`, { method: "POST", headers: { "Content-Type": "application/json", ...auth(u) }, body: JSON.stringify(body) });
  const meta = (m) => Buffer.from(JSON.stringify(m)).toString("base64url");
  const chunk = (rid, token, seq, events, { gzip = true, m = {}, final = false } = {}) => {
    const raw = Buffer.from(JSON.stringify(events));
    return fetch(`${base}/${rid}/chunk?seq=${seq}&t=${encodeURIComponent(token)}&z=${gzip ? 1 : 0}&m=${meta(m)}${final ? "&final=1" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: gzip ? zlib.gzipSync(raw) : raw,
    });
  };

  // ── who may be recorded ──
  const s1 = await start(fresh, { t0: 1000, registered: true, entry: "/register", screen: "1440x900" });
  const { rid, token } = await s1.json();
  ok("a teacher in their first days is recorded", s1.status === 201 && store.isId(rid) && !!token, `status ${s1.status}`);
  ok("a teacher of 40 days is not", (await start(veteran)).status === 204);
  ok("a student is not", (await start(pupil)).status === 204);
  ok("nobody signed out can start one", (await fetch(`${base}/start`, { method: "POST" })).status === 401);

  // ── slices: authorised by the token, stored compressed, counted ──
  ok("a slice without the token is refused", (await chunk(rid, "1.bad", 0, [{ type: 4, timestamp: 1000 }])).status === 403);
  const c0 = await chunk(rid, token, 0, [{ type: 4, timestamp: 1000 }, { type: 2, timestamp: 1001 }], { m: { c: 2, p: ["/register"], t1: 1001 } });
  ok("a compressed slice is stored", c0.status === 204, `status ${c0.status}`);
  const c1 = await chunk(rid, token, 1, [{ type: 3, timestamp: 5000 }, { type: 5, timestamp: 9000, data: { tag: "api", payload: { status: 500 } } }], {
    gzip: false,
    m: { c: 3, e: 1, a: 1, o: 1, p: ["/guided/class", "/exam/new/build"], t1: 9000 },
    final: true,
  });
  ok("so is a plain one (compressed on arrival)", c1.status === 204, `status ${c1.status}`);
  const files = fs.readdirSync(path.join(process.env.RECORDINGS_DIR, rid)).sort();
  ok("each slice is a gzip file of its own", files.join(",") === "00000.json.gz,00001.json.gz", files.join(","));
  ok("and every file really is gzip", files.every((f) => { const b = fs.readFileSync(path.join(process.env.RECORDINGS_DIR, rid, f)); return b[0] === 0x1f && b[1] === 0x8b; }));
  const rec = await SessionRecording.findById(rid).lean();
  ok("clicks, errors, failed requests and messages add up", rec.clicks === 5 && rec.jsErrors === 1 && rec.apiErrors === 1 && rec.toasts === 1, JSON.stringify(rec));
  ok("the way through is kept, and where they left", rec.pages.join(">") === "/register>/guided/class>/exam/new/build" && rec.exit === "/exam/new/build");
  ok("leaving closes it", !!rec.endedAt && rec.lastEventAt === 9000 && rec.registeredInSession === true);

  // ── only an admin watches ──
  const asTeacher = await fetch(base, { headers: auth(fresh) });
  ok("a teacher cannot list recordings", asTeacher.status === 401 || asTeacher.status === 403, `status ${asTeacher.status}`);
  const list = await (await fetch(base, { headers: auth(admin) })).json();
  const row = list.recordings?.find((r) => r._id === rid);
  ok("an admin sees it, with who and how long", row && row.user?.email === "new@rec.test" && row.durationMs === 8000 && row.pages === 3, JSON.stringify(row));
  const problems = await (await fetch(`${base}?problems=1`, { headers: auth(admin) })).json();
  ok("and can ask for only the ones with problems", problems.recordings?.some((r) => r._id === rid));
  const one = await (await fetch(`${base}/${rid}`, { headers: auth(admin) })).json();
  ok("watching returns every event in order", one.events?.map((e) => e.timestamp).join(",") === "1000,1001,5000,9000", JSON.stringify(one.events?.map((e) => e.timestamp)));
  ok("a teacher cannot watch", (await fetch(`${base}/${rid}`, { headers: auth(fresh) })).status !== 200);
  ok("the closed visit is not live", one.recording?.live === false && one.lastSeq === 1, JSON.stringify({ live: one.recording?.live, lastSeq: one.lastSeq }));

  // ── watching a visit live ──
  const sl = await (await start(fresh, { t0: 100 })).json();
  await chunk(sl.rid, sl.token, 0, [{ type: 4, timestamp: 100 }, { type: 2, timestamp: 101 }]);
  const first = await (await fetch(`${base}/${sl.rid}`, { headers: auth(admin) })).json();
  ok("a visit still sending is live", first.recording?.live === true && first.lastSeq === 0, JSON.stringify(first.recording));
  await chunk(sl.rid, sl.token, 1, [{ type: 3, timestamp: 200 }]);
  await chunk(sl.rid, sl.token, 2, [{ type: 3, timestamp: 300 }]);
  const more = await (await fetch(`${base}/${sl.rid}/live?after=0`, { headers: auth(admin) })).json();
  ok("asking for what is new returns only what arrived since", more.events?.map((e) => e.timestamp).join(",") === "200,300" && more.lastSeq === 2 && more.live === true, JSON.stringify(more));
  const none = await (await fetch(`${base}/${sl.rid}/live?after=2`, { headers: auth(admin) })).json();
  ok("and nothing when nothing is new", none.events?.length === 0 && none.lastSeq === 2, JSON.stringify(none));
  await chunk(sl.rid, sl.token, 3, [{ type: 3, timestamp: 400 }], { final: true });
  const ended = await (await fetch(`${base}/${sl.rid}/live?after=2`, { headers: auth(admin) })).json();
  ok("when they leave, it stops being live", ended.live === false && !!ended.endedAt && ended.events?.length === 1, JSON.stringify(ended));
  ok("a teacher cannot watch live either", (await fetch(`${base}/${sl.rid}/live`, { headers: auth(fresh) })).status !== 200);
  await SessionRecording.updateOne({ _id: sl.rid }, { $set: { endedAt: null, lastChunkAt: new Date(Date.now() - 5 * 60000) } });
  const quiet = await (await fetch(`${base}/${sl.rid}/live?after=3`, { headers: auth(admin) })).json();
  ok("a visit silent for minutes is not live (the tab was simply closed)", quiet.live === false);
  await store.removeRecording(sl.rid);

  // ── temporary ──
  const s2 = await (await start(fresh)).json();
  await chunk(s2.rid, s2.token, 0, [{ type: 4, timestamp: 1 }]);
  await SessionRecording.updateOne({ _id: s2.rid }, { $set: { startedAt: days(31) } });
  const s3 = await (await start(fresh)).json();
  await chunk(s3.rid, s3.token, 0, [{ type: 4, timestamp: 1 }]);
  await SessionRecording.updateOne({ _id: s3.rid }, { $set: { user: pupil._id, startedAt: new Date(Date.now() - 4 * 3600000) } });
  const orphan = path.join(process.env.RECORDINGS_DIR, "ab".repeat(12));
  fs.mkdirSync(orphan);
  const old = (Date.now() - 2 * 86400000) / 1000;
  fs.utimesSync(orphan, old, old);
  await store.sweep();
  ok("a recording older than 30 days is removed, files and all", !(await SessionRecording.exists({ _id: s2.rid })) && !fs.existsSync(path.join(process.env.RECORDINGS_DIR, s2.rid)));
  ok("so is one whose account ended up a student", !(await SessionRecording.exists({ _id: s3.rid })));
  ok("and a folder nothing points to", !fs.existsSync(orphan));
  ok("the teacher's recent one stays", !!(await SessionRecording.exists({ _id: rid })) && fs.existsSync(path.join(process.env.RECORDINGS_DIR, rid)));

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  fs.rmSync(process.env.RECORDINGS_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
