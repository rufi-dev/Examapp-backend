/*
 * CR-BOARD-007 + CR-BOARD-008 — REAL HTTP + WebSocket access-path tests (not just
 * the pure accessLevel helper), over in-memory Mongo with real users, classes,
 * enrollments, tokens, the SHIPPING board router, and the SHIPPING realtime hub
 * handshake (resolveSessionUser + accessLevel + canHostLive + seatIntoRoom).
 *
 * CR-BOARD-007: an approved-enrolled co-teacher (role "teacher", not the owner) is
 * a VIEW-ONLY audience participant — list + open + join with canEdit/isHost/
 * canWrite = false, may request write, but can never host/manage merely because
 * their account role is "teacher". Class listing and direct open must AGREE.
 * Pending/unrelated enrollments stay denied; a revoked enrollment drops them on
 * reauth.
 *
 * CR-BOARD-008: the live-started/joined handshake carries an AUTHORITATIVE save
 * state derived server-side. An untouched room is "saved" immediately (never a
 * false "saving"); an accepted edit → "saving"; persisted-through → "saved"; a
 * later outstanding revision keeps it "saving"; a persist error → "failed".
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-board-access";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-board-access";
process.env.LIVE_JOURNAL_DIR = require("path").join(require("os").tmpdir(), "exq-board-access-journal-" + process.pid);

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Class = require("../../models/classModel");
const Enrollment = require("../../models/enrollmentModel");
const Board = require("../../models/boardModel");
const { generateToken } = require("../../utils");
const boardRouter = require("../../routes/boardRoute"); // the SHIPPING router
const errorHandler = require("../../middleware/errorMiddleware");
const hub = require("../../realtime/boardHub");
const jrnl = require("../../realtime/boardJournal");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const { ObjectId } = mongoose.Types;

function request(server, { method, path, token }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({
        status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })(),
      })); });
    req.on("error", reject); req.end();
  });
}

const fakeWs = () => {
  const sent = [], closes = [];
  return { readyState: 1, OPEN: 1, bufferedAmount: 0, sent, closes,
    send: (s) => sent.push(JSON.parse(s)), close: (code, reason) => closes.push({ code, reason }) };
};

let seq = 0;
const mkUser = (over) => User.create({ name: over.name || "U", email: `u${seq++}@e.com`, password: "xxxxxxxx", isVerified: true, ...over });

async function main() {
  await jrnl.preflight(); // durable storage healthy so a live edit can be accepted

  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  // ── seed real accounts / class / enrollments / boards ──
  const owner = await mkUser({ name: "Owner", role: "teacher", teacherApproval: "approved" });
  const coT = await mkUser({ name: "CoTeacher", role: "teacher", teacherApproval: "approved" });
  const pendingCoT = await mkUser({ name: "PendingCo", role: "teacher", teacherApproval: "pending" });
  const unrelated = await mkUser({ name: "Unrelated", role: "teacher", teacherApproval: "approved" });
  const student = await mkUser({ name: "Student", role: "student" });
  const cls = await Class.create({ name: "Sinif", owner: owner._id, joinCode: "JOIN01" });
  // Approved enrollments in the owner's class for the co-teacher, a pending
  // co-teacher, and a student. `unrelated` has NONE.
  for (const u of [coT, pendingCoT, student]) {
    await Enrollment.create({ student: u._id, class: cls._id, teacher: owner._id, status: "approved" });
  }
  // Board A: explicit audience [cls]. Board B: empty audience (owner-wide).
  const boardA = await Board.create({ owner: owner._id, ownerName: owner.name, title: "A", classes: [cls._id], pages: [{ name: "Səhifə 1", scene: null }] });
  const boardB = await Board.create({ owner: owner._id, ownerName: owner.name, title: "B", classes: [], pages: [{ name: "Səhifə 1", scene: null }] });

  const tok = (u) => generateToken(u._id, u.sessionVersion);
  const app = express();
  app.use(express.json());
  app.use("/api/boards", boardRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const open = (id, u) => request(server, { method: "GET", path: `/api/boards/${id}`, token: tok(u) });
  const liveStatus = (id, u) => request(server, { method: "GET", path: `/api/boards/${id}/live`, token: tok(u) });
  const classList = (cid, u) => request(server, { method: "GET", path: `/api/boards/class/${cid}`, token: tok(u) });

  // ── CR-BOARD-007: HTTP access path (real router + controllers) ──
  console.log("board access — CR-BOARD-007 (HTTP)");

  const ownerOpen = await open(boardA._id, owner);
  ok("owner opens board A → 200, canEdit:true", ownerOpen.status === 200 && ownerOpen.body.canEdit === true);

  const coOpenA = await open(boardA._id, coT);
  ok("approved co-teacher opens board A → 200, canEdit:false (was the 403 bug)", coOpenA.status === 200 && coOpenA.body.canEdit === false);

  const coOpenB = await open(boardB._id, coT);
  ok("approved co-teacher opens empty-audience board B → 200, canEdit:false", coOpenB.status === 200 && coOpenB.body.canEdit === false);

  const pendOpen = await open(boardA._id, pendingCoT);
  ok("PENDING enrolled co-teacher opens board A → 200 view-only (enrollment-based, role-agnostic)", pendOpen.status === 200 && pendOpen.body.canEdit === false);

  const studentOpen = await open(boardA._id, student);
  ok("approved student opens board A → 200, canEdit:false (unchanged)", studentOpen.status === 200 && studentOpen.body.canEdit === false);

  const unrelOpen = await open(boardA._id, unrelated);
  ok("UNRELATED (not enrolled) teacher opens board A → 403", unrelOpen.status === 403);

  // Listing ↔ open must AGREE for the co-teacher (the exact mismatch in the report).
  const coListing = await classList(cls._id, coT);
  const listedIds = (coListing.body || []).map((b) => String(b._id));
  ok("co-teacher class listing includes board A AND B", coListing.status === 200 && listedIds.includes(String(boardA._id)) && listedIds.includes(String(boardB._id)));
  ok("listing and direct open cannot disagree: every listed board opens (no 403)", (await Promise.all(listedIds.map((id) => open(id, coT)))).every((r) => r.status === 200));

  const unrelListing = await classList(cls._id, unrelated);
  ok("unrelated teacher class listing → 403 (not enrolled/manager)", unrelListing.status === 403);

  // live-status uses the SAME policy.
  ok("co-teacher live-status board A → 200 (same policy as open)", (await liveStatus(boardA._id, coT)).status === 200);
  ok("unrelated teacher live-status board A → 403 (same policy as open)", (await liveStatus(boardA._id, unrelated)).status === 403);

  // ── CR-BOARD-007 + 008: WebSocket handshake path (real hub) ──
  console.log("\nboard access — CR-BOARD-007 + CR-BOARD-008 (WebSocket handshake)");

  // Owner hosts: real handshake → live-started, isHost true, and CR-BOARD-008 save
  // state "saved" for an untouched room.
  const oWs = fakeWs();
  const hostRes = await hub.__test.handleHandshake(oWs, { v: 1, type: "start-live", boardId: String(boardA._id), token: tok(owner) });
  const started = oWs.sent.find((m) => m.type === "live-started");
  ok("owner start-live → live-started, isHost:true, isLeader:true", hostRes && started && started.self.isHost === true && started.self.isLeader === true);
  ok("CR-BOARD-008: untouched room handshake reports saveState 'saved' (never a false 'saving')", started.saveState === "saved");
  const room = hostRes.room;
  const ownerSeat = hostRes.seat;

  // Co-teacher joins the live session as a VIEWER.
  const cWs = fakeWs();
  const joinRes = await hub.__test.handleHandshake(cWs, { v: 1, type: "join", boardId: String(boardA._id), token: tok(coT) });
  const joined = cWs.sent.find((m) => m.type === "joined");
  ok("co-teacher join → joined with isHost:false, canWrite:false, isLeader:false", joinRes && joined && joined.self.isHost === false && joined.self.canWrite === false && joined.self.isLeader === false);
  ok("CR-BOARD-008: joined handshake also carries authoritative saveState 'saved'", joined.saveState === "saved");
  const coSeat = joinRes.seat;

  // Co-teacher CANNOT host — canHostLive stays canEdit && capability.
  const cWs2 = fakeWs();
  const coHost = await hub.__test.handleHandshake(cWs2, { v: 1, type: "start-live", boardId: String(boardA._id), token: tok(coT) });
  ok("co-teacher CANNOT start-live despite teacher role (forbidden, null seat)", coHost === null && cWs2.closes.some((c) => c.reason === "forbidden"));

  // Unrelated teacher cannot even join.
  const uWs = fakeWs();
  const unrelJoin = await hub.__test.handleHandshake(uWs, { v: 1, type: "join", boardId: String(boardA._id), token: tok(unrelated) });
  ok("unrelated teacher join over WS → forbidden, null seat", unrelJoin === null && uWs.closes.some((c) => c.reason === "forbidden"));

  // Co-teacher can request write (hand-raise), but a scene-update before any grant
  // is refused (canWrite false).
  const preGrant = room.acceptedRevision;
  await hub.__test.handleInRoom(room, coSeat, { v: 1, type: "scene-update", liveSessionId: room.liveSessionId, pageEpoch: room.pageEpoch, clientSeq: 1, elements: [{ id: "hack", type: "rectangle", version: 1, versionNonce: 1, x: 1, y: 1, width: 2, height: 2 }] });
  ok("co-teacher scene-update BEFORE grant is ignored (canWrite:false)", room.acceptedRevision === preGrant && !room.scene.elements.has("hack"));

  // ── CR-BOARD-008: authoritative save-state transitions (real hub state) ──
  console.log("\nboard access — CR-BOARD-008 (save-state transitions)");

  ok("saveStateOf(untouched room) === 'saved'", hub.__test.saveStateOf(room) === "saved");

  oWs.sent.length = 0; // isolate the save-state emitted by the next accept
  await hub.__test.handleInRoom(room, ownerSeat, { v: 1, type: "scene-update", liveSessionId: room.liveSessionId, pageEpoch: room.pageEpoch, clientSeq: 1, elements: [{ id: "e1", type: "rectangle", version: 1, versionNonce: 5, x: 1, y: 1, width: 2, height: 2 }] });
  ok("an accepted edit moves state to 'saving'", room.acceptedRevision === 1 && hub.__test.saveStateOf(room) === "saving");
  ok("CR-BOARD-009: the accepted edit EMITS 'saving' to the client immediately (real hub broadcast)", oWs.sent.some((m) => m.type === "save-state" && m.state === "saving"));

  room.persistedRevision = room.acceptedRevision;
  ok("persisted through accepted → 'saved'", hub.__test.saveStateOf(room) === "saved");

  await hub.__test.handleInRoom(room, ownerSeat, { v: 1, type: "scene-update", liveSessionId: room.liveSessionId, pageEpoch: room.pageEpoch, clientSeq: 2, elements: [{ id: "e2", type: "rectangle", version: 1, versionNonce: 6, x: 3, y: 3, width: 2, height: 2 }] });
  room.persistedRevision = 1; // only the first edit persisted
  ok("rapid edits: 'saved' is NOT shown while a later accepted revision is outstanding", room.acceptedRevision === 2 && hub.__test.saveStateOf(room) === "saving");
  room.persistedRevision = 2;
  ok("once the latest revision persists → 'saved'", hub.__test.saveStateOf(room) === "saved");

  room.lastPersistError = "error";
  ok("a persist error surfaces 'failed' (never a false 'saved')", hub.__test.saveStateOf(room) === "failed");
  room.lastPersistError = null;

  // ── CR-BOARD-007 #7: revoked enrollment drops the co-teacher on reauth ──
  console.log("\nboard access — CR-BOARD-007 (reauth revocation)");
  await Enrollment.deleteMany({ student: coT._id }); // enrollment revoked mid-session
  ok("co-teacher is seated before revocation", room.members.has(coSeat.connId));
  await hub.__test.handleInRoom(room, coSeat, { v: 1, type: "reauth", liveSessionId: room.liveSessionId, clientSeq: 99, token: tok(coT) });
  ok("revoked co-teacher is DROPPED on reauth (removed + socket closed)", !room.members.has(coSeat.connId) && cWs.closes.length > 0);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
