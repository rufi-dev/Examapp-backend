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

  // ── CR-BOARD-010: connection lifecycle over the REAL handshake ──
  console.log("\nboard access — CR-BOARD-010 lifecycle (real handshake)");
  const hWs = fakeWs();
  const hostB = await hub.__test.handleHandshake(hWs, { v: 1, type: "start-live", boardId: String(boardB._id), token: tok(owner) });
  ok("owner starts a live session on board B", hostB && hWs.sent.some((m) => m.type === "live-started"));
  const roomB = hostB.room;
  const liveIdB = roomB.liveSessionId;
  // A viewer (approved student) joins.
  const vWs = fakeWs();
  const viewerB = await hub.__test.handleHandshake(vWs, { v: 1, type: "join", boardId: String(boardB._id), token: tok(student) });
  ok("an approved student joins the live session", viewerB && vWs.sent.some((m) => m.type === "joined"));
  // Draw something so the scene is non-trivial, then the HOST transport-drops (NOT end-live).
  await hub.__test.handleInRoom(roomB, hostB.seat, { v: 1, type: "scene-update", liveSessionId: liveIdB, pageEpoch: roomB.pageEpoch, clientSeq: 1, elements: [{ id: "keep", type: "rectangle", version: 1, versionNonce: 3, x: 5, y: 5, width: 9, height: 9 }] });
  hub.__test.dropSeat(roomB, hostB.seat, "network");
  ok("host disconnect → room AWAITS host, is NOT ended", hub.__test.rooms.has(String(boardB._id)) && roomB.status === "awaiting-host");
  ok("the viewer stays connected after the host disconnects", roomB.members.has(viewerB.seat.connId));
  ok("isLive still reports the session (awaitingHost) so viewers can (re)join", !!hub.isLive(boardB._id) && hub.isLive(boardB._id).awaitingHost === true);
  ok("the drawn element is retained in the room scene", roomB.scene.elements.has("keep"));
  // Host reconnects → SAME session resumes, viewer told host is back.
  const hWs2 = fakeWs();
  const resumeB = await hub.__test.handleHandshake(hWs2, { v: 1, type: "start-live", boardId: String(boardB._id), token: tok(owner) });
  const resumedMsg = hWs2.sent.find((m) => m.type === "live-started");
  ok("host reconnect resumes the SAME live session id", resumeB && resumedMsg && resumedMsg.liveSessionId === liveIdB);
  ok("resumed session continues from the SAME scene (element still present)", resumedMsg.scene.elements.some((e) => e.id === "keep"));
  ok("resumed room is ready again", roomB.status === "ready");
  ok("the viewer was told the host is back", vWs.sent.some((m) => m.type === "host-back"));

  // ── CR-BOARD-010: durable session survives EVICTION/RESTART (rehydration) ──
  console.log("\nboard access — CR-BOARD-010 durable session (rehydration)");
  await hub.__test.persistThrough(roomB, roomB.acceptedRevision); // make the scene durable in Mongo
  hub.__test.rooms.delete(String(boardB._id)); // simulate the 2h reaper / a backend restart
  const dbBoard = await Board.findById(boardB._id).lean();
  ok("the session is persisted ACTIVE in Mongo (outlives eviction/restart)", !!dbBoard.liveSession && dbBoard.liveSession.active === true && dbBoard.liveSession.id === liveIdB);
  ok("controller reports the board live via the durable flag (no in-memory room)", !hub.isLive(boardB._id));
  const rejoinWs = fakeWs();
  const rejoinRes = await hub.__test.handleHandshake(rejoinWs, { v: 1, type: "join", boardId: String(boardB._id), token: tok(student) });
  const rejoined = rejoinWs.sent.find((m) => m.type === "joined");
  ok("a viewer REHYDRATES the SAME session id after eviction", rejoinRes && rejoined && rejoined.liveSessionId === liveIdB);
  ok("the rehydrated scene still contains the drawn element", rejoined && rejoined.scene && rejoined.scene.elements.some((e) => e.id === "keep"));

  // ── CR-BOARD-010: ONLY an explicit end-live ends the durable session ──
  const endHostWs = fakeWs();
  const endHost = await hub.__test.handleHandshake(endHostWs, { v: 1, type: "start-live", boardId: String(boardB._id), token: tok(owner) });
  await hub.__test.handleInRoom(endHost.room, endHost.seat, { v: 1, type: "end-live", liveSessionId: endHost.room.liveSessionId, clientSeq: 1 });
  const dbEnded = await Board.findById(boardB._id).lean();
  ok("explicit end-live clears the durable session (the ONLY normal end)", dbEnded.liveSession.active === false);
  ok("after end, isLive reports nothing", !hub.isLive(boardB._id));
  clearTimeout(endHost.room.reapTimer);
  clearTimeout(endHost.room.checkpointTimer);

  // ── CR-BOARD-011: fail-closed activation / end (exact liveSession.id CAS) ──
  console.log("\nboard access — CR-BOARD-011 fail-closed session transitions");

  const boardX = await Board.create({ owner: owner._id, ownerName: owner.name, title: "X", classes: [], pages: [{ name: "Səhifə 1", scene: null }] });
  const a1 = await hub.__test.activateSession(boardX._id, "sess-1", "p1");
  const a2 = await hub.__test.activateSession(boardX._id, "sess-2", "p1"); // concurrent worker
  ok("first activation wins (durably confirmed)", a1 === true);
  ok("a concurrent second activation is REFUSED — no double-activate", a2 === false);
  const aIdem = await hub.__test.activateSession(boardX._id, "sess-1", "p1");
  ok("re-activating our OWN id is idempotent (response-loss safe)", aIdem === true);

  const e1 = await hub.__test.endSession(boardX._id, "sess-1");
  ok("ending the active session is durably confirmed", e1 === true);
  ok("the durable flag is now inactive in Mongo", (await Board.findById(boardX._id).lean()).liveSession.active === false);
  ok("ending a stale/replaced session is a durable no-op success", (await hub.__test.endSession(boardX._id, "sess-old")) === true);

  // Activation DB failure → fail-closed: no live-started, socket closed, nothing active.
  const boardY = await Board.create({ owner: owner._id, ownerName: owner.name, title: "Y", classes: [], pages: [{ name: "Səhifə 1", scene: null }] });
  const origFOU = Board.findOneAndUpdate;
  Board.findOneAndUpdate = () => { throw new Error("mongo down"); };
  const yWs = fakeWs();
  const yRes = await hub.__test.handleHandshake(yWs, { v: 1, type: "start-live", boardId: String(boardY._id), token: tok(owner) });
  Board.findOneAndUpdate = origFOU;
  ok("activation failure → NO live-started + socket closed (fail-closed)", yRes === null && !yWs.sent.some((m) => m.type === "live-started") && yWs.closes.length > 0);
  ok("no active session persisted on activation failure", !((await Board.findById(boardY._id).lean()).liveSession || {}).active);

  // End DB failure → fail-closed: room NOT deleted, leader told, session stays active.
  const boardZ = await Board.create({ owner: owner._id, ownerName: owner.name, title: "Z", classes: [], pages: [{ name: "Səhifə 1", scene: null }] });
  const zWs = fakeWs();
  const zHost = await hub.__test.handleHandshake(zWs, { v: 1, type: "start-live", boardId: String(boardZ._id), token: tok(owner) });
  const origFBI = Board.findById;
  Board.findOneAndUpdate = () => { throw new Error("mongo down"); };
  Board.findById = () => ({ select: () => ({ lean: async () => { throw new Error("mongo down"); } }) }); // re-read also fails
  await hub.__test.handleInRoom(zHost.room, zHost.seat, { v: 1, type: "end-live", liveSessionId: zHost.room.liveSessionId, clientSeq: 1 });
  Board.findOneAndUpdate = origFOU;
  Board.findById = origFBI;
  ok("end failure → room is NOT deleted (no resurrection risk)", hub.__test.rooms.has(String(boardZ._id)));
  ok("the leader is told end-failed", zWs.sent.some((m) => m.type === "end-failed"));
  ok("the session stays active when End could not be confirmed", (await Board.findById(boardZ._id).lean()).liveSession.active === true);
  clearTimeout(zHost.room.reapTimer);
  clearTimeout(zHost.room.checkpointTimer);

  // ── 4-hour hard cap: a session past 4h is not live and is cleared on next start ──
  console.log("\nboard access — 4h session cap");
  const boardCap = await Board.create({
    owner: owner._id, ownerName: owner.name, title: "Cap", classes: [], pages: [{ name: "Səhifə 1", scene: null }],
    liveSession: { id: "old-session", active: true, pageId: "p", startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000) },
  });
  ok("a >4h session is NOT fresh (won't show live / rehydrate)", hub.isSessionFresh(await Board.findById(boardCap._id).lean()) === false);
  const capVws = fakeWs();
  const capV = await hub.__test.handleHandshake(capVws, { v: 1, type: "join", boardId: String(boardCap._id), token: tok(student) });
  ok("a viewer joining a >4h stale session gets no-live (not rehydrated)", capV === null && capVws.sent.some((m) => m.type === "no-live"));
  const capWs = fakeWs();
  const capHost = await hub.__test.handleHandshake(capWs, { v: 1, type: "start-live", boardId: String(boardCap._id), token: tok(owner) });
  const capStarted = capWs.sent.find((m) => m.type === "live-started");
  ok("host start-live past the cap clears the stale flag and begins a FRESH session", capHost && capStarted && capStarted.liveSessionId !== "old-session");
  const capDb = await Board.findById(boardCap._id).lean();
  ok("the durable flag now points at the new active session", capDb.liveSession.active === true && capDb.liveSession.id !== "old-session");
  clearTimeout(capHost.room.reapTimer);
  clearTimeout(capHost.room.checkpointTimer);
  clearTimeout(capHost.room.capTimer);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
