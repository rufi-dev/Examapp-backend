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
process.env.BOARD_FILES_DIR = require("path").join(require("os").tmpdir(), "exq-board-files-" + process.pid);

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

// Multipart POST of a raw buffer under field "file" (+ optional fileId field first).
function uploadFile(server, path, token, buf, fileId) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const B = "----exqBoundary" + Math.random().toString(16).slice(2);
    const idPart = fileId
      ? Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="fileId"\r\n\r\n${fileId}\r\n`)
      : Buffer.alloc(0);
    const head = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="img"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${B}--\r\n`);
    const body = Buffer.concat([idPart, head, buf, tail]);
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${B}`, "Content-Length": body.length } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })() })); }
    );
    req.on("error", reject); req.write(body); req.end();
  });
}

// Multipart PATCH of a board save: the "pages" file (plain or gzip) + text fields.
function saveRequest(server, id, token, pagesBuf, fields = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const B = "----exqSave" + Math.random().toString(16).slice(2);
    const parts = Object.entries(fields).map(([k, v]) =>
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    );
    const head = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="pages"; filename="pages.json"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const body = Buffer.concat([...parts, head, pagesBuf, Buffer.from(`\r\n--${B}--\r\n`)]);
    const req = http.request(
      { host: "127.0.0.1", port, method: "PATCH", path: `/api/boards/${id}`, headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${B}`, "Content-Length": body.length } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })() })); }
    );
    req.on("error", reject); req.write(body); req.end();
  });
}

// Binary GET → { status, contentType, bytes }.
function getBinary(server, path, token) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path, headers: { Authorization: `Bearer ${token}` } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"], bytes: Buffer.concat(c).length })); }
    );
    req.on("error", reject); req.end();
  });
}

// A minimal valid 1x1 PNG (real signature so magic-byte validation passes).
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
  "01f15c4890000000d49444154789c6360000002000100050001" +
  "0d0a2db40000000049454e44ae426082",
  "hex"
);

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

  // ── private board images: upload (owner, magic-byte) + serve (audience) ──
  console.log("\nboard access — private board images");
  const up = await uploadFile(server, `/api/boards/${boardB._id}/files`, tok(owner), PNG_1X1);
  ok("owner uploads a valid PNG → 200 with {fileId,hash,mime,size}", up.status === 200 && up.body.mime === "image/png" && typeof up.body.fileId === "string" && up.body.size === PNG_1X1.length);
  const notImg = await uploadFile(server, `/api/boards/${boardB._id}/files`, tok(owner), Buffer.from("this is not an image at all"));
  ok("a non-image upload is rejected by magic bytes → 415", notImg.status === 415);
  const foreignUp = await uploadFile(server, `/api/boards/${boardB._id}/files`, tok(unrelated), PNG_1X1);
  ok("a non-owner teacher cannot upload to the board → 404", foreignUp.status === 404);
  const dl = await getBinary(server, `/api/boards/${boardB._id}/files/${up.body.fileId}`, tok(student));
  ok("an enrolled student can fetch the image → 200 image/png bytes", dl.status === 200 && dl.contentType === "image/png" && dl.bytes === PNG_1X1.length);
  // The scene references Excalidraw's fileId — storing/fetching must use THAT id.
  const withId = await uploadFile(server, `/api/boards/${boardB._id}/files`, tok(owner), PNG_1X1, "excalidrawFileId123");
  ok("upload stores under the provided (Excalidraw) fileId", withId.status === 200 && withId.body.fileId === "excalidrawFileId123");
  const dlById = await getBinary(server, `/api/boards/${boardB._id}/files/excalidrawFileId123`, tok(student));
  ok("the image is fetchable by that same fileId (the id viewers use)", dlById.status === 200 && dlById.bytes === PNG_1X1.length);
  const dlForbidden = await getBinary(server, `/api/boards/${boardB._id}/files/${up.body.fileId}`, tok(unrelated));
  ok("a non-audience user cannot fetch the image → 403", dlForbidden.status === 403);

  /*
   * ── what a save costs (2026-09-16) ─────────────────────────────────────────
   * An 8-page board took 16.5 s per save: every page as plain JSON after every
   * stroke, pasted images inside as base64, and the whole document read back from
   * the database just to answer with five fields.
   */
  console.log("\nboard save — compressed, images out of the document, no read-back");
  const zlib = require("zlib");
  const fsx = require("fs");
  const pathx = require("path");
  const boardS = await Board.create({ owner: owner._id, ownerName: owner.name, title: "Save", classes: [], pages: [{ name: "Səhifə 1", scene: null }] });
  const strokes = Array.from({ length: 400 }, (_, i) => ({ id: `s${i}`, type: "freedraw", version: 1, points: Array.from({ length: 30 }, (_, j) => [j * 1.37, i * 2.11]) }));
  const pagesOf1 = (files = {}) => [{ name: "Səhifə 1", scene: { elements: strokes, appState: {}, files } }];
  let rev = 0;

  const plainJson = Buffer.from(JSON.stringify(pagesOf1()));
  const plain = await saveRequest(server, boardS._id, tok(owner), plainJson, { expectedRevision: rev });
  ok("a plain JSON save still works (older tabs keep saving)", plain.status === 200 && plain.body.revision === 1);
  rev = plain.body.revision;
  ok("the reply carries no pages — the document is not read back", plain.status === 200 && !("pages" in plain.body) && !("scene" in plain.body));

  const gz = zlib.gzipSync(plainJson);
  const packed = await saveRequest(server, boardS._id, tok(owner), gz, { expectedRevision: rev });
  ok("a gzip save is accepted", packed.status === 200 && packed.body.revision === rev + 1);
  rev = packed.body.revision;
  ok("and really is smaller on the wire", gz.length * 3 < plainJson.length);
  const afterGz = await Board.findById(boardS._id).lean();
  ok("the gzip save stored the same strokes", afterGz.pages[0].scene.elements.length === 400 && afterGz.pages[0].scene.elements[7].points[3][0] === 3 * 1.37);
  ok("sizeBytes stays the size of the board as JSON, not of the upload", packed.body.sizeBytes === plainJson.length);

  const broken = await saveRequest(server, boardS._id, tok(owner), Buffer.concat([gz.subarray(0, 40), Buffer.from("garbage")]), { expectedRevision: rev });
  ok("a corrupt gzip is a 400, not a crash", broken.status === 400);

  // Images: moved into the private store, the scene keeps only the reference.
  const pngUrl = `data:image/png;base64,${PNG_1X1.toString("base64")}`;
  const textUrl = `data:image/png;base64,${Buffer.from("not really a png at all").toString("base64")}`;
  const withImages = pagesOf1({
    imgGood1: { id: "imgGood1", mimeType: "image/png", dataURL: pngUrl, created: 1 },
    notAnImage: { id: "notAnImage", mimeType: "image/png", dataURL: textUrl, created: 1 },
    "bad/key": { id: "bad/key", mimeType: "image/png", dataURL: pngUrl, created: 1 },
  });
  const imgSave = await saveRequest(server, boardS._id, tok(owner), zlib.gzipSync(Buffer.from(JSON.stringify(withImages))), { expectedRevision: rev });
  ok("a save with images succeeds", imgSave.status === 200);
  rev = imgSave.body.revision;
  const stored = (await Board.findById(boardS._id).lean()).pages[0].scene.files;
  ok("a real image is stored as a reference, not base64", stored.imgGood1 && !stored.imgGood1.dataURL && stored.imgGood1.mime === "image/png" && stored.imgGood1.size === PNG_1X1.length && stored.imgGood1.fileId === "imgGood1");
  ok("its bytes are on disk under the id the element uses", fsx.readFileSync(pathx.join(process.env.BOARD_FILES_DIR, String(boardS._id), "imgGood1")).equals(PNG_1X1));
  ok("and the audience fetches it by that id", (await getBinary(server, `/api/boards/${boardS._id}/files/imgGood1`, tok(student))).bytes === PNG_1X1.length);
  ok("the reply tells the editor which images it now holds", imgSave.body.files && imgSave.body.files.imgGood1 && !imgSave.body.files.notAnImage);
  ok("NEVER loses an image: bytes that are not a real image stay inline", stored.notAnImage && stored.notAnImage.dataURL === textUrl);
  ok("NEVER loses an image: a key unsafe as a file name stays inline", stored["bad/key"] && stored["bad/key"].dataURL === pngUrl);

  // The next save sends the reference; nothing is lost and nothing is re-written.
  const refOnly = pagesOf1({ imgGood1: imgSave.body.files.imgGood1 });
  const again = await saveRequest(server, boardS._id, tok(owner), Buffer.from(JSON.stringify(refOnly)), { expectedRevision: rev });
  const kept = (await Board.findById(boardS._id).lean()).pages[0].scene.files.imgGood1;
  ok("a save that sends only the reference keeps it intact", again.status === 200 && kept && kept.size === PNG_1X1.length && !kept.dataURL);

  const stale = await saveRequest(server, boardS._id, tok(owner), plainJson, { expectedRevision: 0 });
  ok("the revision fence still refuses a stale save", stale.status === 409 && stale.body.code === "board_conflict");

  /*
   * ── the save must not freeze the server (2026-09-17) ──────────────────────
   * Mongoose's findOneAndUpdate held the event loop 1.3–2 s per save of a real
   * 5.3 MB handwriting board, so every request and live board on the server
   * waited. Saves write through the driver (Board.writeScene), which casts by
   * hand what Mongoose used to — so check exactly those.
   */
  console.log("\nboard save — through the driver, typed as Mongoose would store it");
  const before = (await Board.findById(boardS._id).select("updatedAt revision").lean());
  let mongooseWrites = 0;
  const realFOU = Board.findOneAndUpdate;
  Board.findOneAndUpdate = function (...a) { mongooseWrites++; return realFOU.apply(this, a); };
  await new Promise((r) => setTimeout(r, 15));
  const typed = await saveRequest(server, boardS._id, tok(owner), plainJson, { expectedRevision: before.revision, classIds: JSON.stringify([String(cls._id)]), title: "  Typed  " });
  Board.findOneAndUpdate = realFOU;
  ok("the save succeeds", typed.status === 200 && typed.body.revision === before.revision + 1 && typed.body.title === "Typed");
  ok("without Mongoose's findOneAndUpdate", mongooseWrites === 0, `called ${mongooseWrites}x`);
  const raw = await Board.collection.findOne({ _id: boardS._id });
  ok("class links are stored as ObjectIds, not strings", raw.classes.length === 1 && raw.classes[0] instanceof mongoose.Types.ObjectId && raw.classes[0].equals(cls._id));
  ok("page ids are ObjectIds (the live hub targets pages by them)", raw.pages[0]._id instanceof mongoose.Types.ObjectId);
  ok("updatedAt still moves (the board list sorts by it)", raw.updatedAt instanceof Date && raw.updatedAt > before.updatedAt);
  ok("the audience filter still finds the board by class", (await Board.countDocuments({ classes: cls._id, _id: boardS._id })) === 1);
  const staleTyped = await saveRequest(server, boardS._id, tok(owner), plainJson, { expectedRevision: before.revision });
  ok("and the revision fence holds on the driver path", staleTyped.status === 409 && staleTyped.body.code === "board_conflict");

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
