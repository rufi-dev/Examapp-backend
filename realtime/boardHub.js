/*
 * Live whiteboard hub ("Canlı Lövhə") — in-process WebSocket relay for real-time
 * collaboration on a board. ONE backend instance only (rooms are in-memory).
 *
 * Authorization reuses the exact HTTP policy: resolveSessionUser (JWT + session
 * revocation + suspension), accessLevel (open/edit), canHostLive (approved
 * teacher/admin, mirrors teacherOnly). Persistence is server-authoritative with
 * an optimistic revision CAS. See plan quizzical-puzzling-meteor.md (v3).
 */
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const Board = require("../models/boardModel");
const { resolveSessionUser } = require("../middleware/authMiddleware");
const { accessLevel, canHostLive } = require("../services/boardAccessService");
const { isAllowedOrigin } = require("../config/corsOptions");

// ---- limits (explicit contract, not "cap it") -------------------------------
const LIMITS = Object.freeze({
  MAX_PAYLOAD: 262144, // 256 KiB — overrides ws' 100 MiB default
  JOIN_TIMEOUT_MS: 10000,
  HEARTBEAT_MS: 30000,
  AUTH_LEASE_MS: 90000, // socket must reauth within this window
  GRACE_MS: 20000, // host reconnect grace
  CHECKPOINT_DEBOUNCE_MS: 1500,
  MAX_MEMBERS_PER_ROOM: 60,
  MAX_SOCKETS_PER_USER: 3,
  MAX_ELEMENTS: 5000,
  MAX_ELEMENTS_PER_MSG: 500,
  MAX_TEXT_LEN: 20000,
  MAX_COORD: 1e7,
  MAX_MSGS_PER_SEC: 40,
  MAX_POINTERS_PER_SEC: 20,
  MAX_BUFFERED_BYTES: 1_048_576, // 1 MiB backlog → slow client
});

const CLOSE = { POLICY: 1008, GOING_AWAY: 1001, RESTART: 1012, MSG_TOO_BIG: 1009 };

// ---- pure, unit-tested logic ------------------------------------------------

// Excalidraw reconciliation winner: a higher version wins; on a version TIE the
// LOWER versionNonce wins (deterministic, matches @excalidraw reconcileElements).
function shouldAcceptElement(incoming, current) {
  if (!current) return true;
  const iv = incoming.version || 0;
  const cv = current.version || 0;
  if (iv > cv) return true;
  if (iv < cv) return false;
  return (incoming.versionNonce || 0) < (current.versionNonce || 0);
}

// A single element is structurally safe to accept from the wire.
function isValidElement(el) {
  if (!el || typeof el !== "object" || typeof el.id !== "string" || !el.id) return false;
  if (typeof el.type !== "string") return false;
  for (const k of ["x", "y", "width", "height"]) {
    if (el[k] != null && (typeof el[k] !== "number" || !Number.isFinite(el[k]) || Math.abs(el[k]) > LIMITS.MAX_COORD)) {
      return false;
    }
  }
  if (typeof el.text === "string" && el.text.length > LIMITS.MAX_TEXT_LEN) return false;
  return true;
}

// Handshake envelope: { v, type, requestId, boardId, payload } — no session yet.
function validateHandshake(msg) {
  if (!msg || msg.v !== 1) return { ok: false };
  if (!["start-live", "join", "reauth"].includes(msg.type)) return { ok: false };
  if (msg.type !== "reauth" && typeof msg.boardId !== "string") return { ok: false };
  return { ok: true };
}

// In-room envelope: must match the socket's live session and current page epoch;
// a stale epoch (a delayed message from the previous page) is rejected.
function validateInRoom(msg, room, seat) {
  if (!msg || msg.v !== 1 || typeof msg.type !== "string") return { ok: false, reason: "shape" };
  if (msg.liveSessionId !== room.liveSessionId) return { ok: false, reason: "session" };
  if (msg.type === "scene-update" || msg.type === "page") {
    if (msg.pageEpoch !== room.pageEpoch) return { ok: false, reason: "epoch" };
  }
  if (typeof msg.clientSeq === "number" && msg.clientSeq <= (seat.lastClientSeq || 0)) {
    return { ok: false, reason: "duplicate" };
  }
  return { ok: true };
}

// ---- module state -----------------------------------------------------------
let wss = null;
let heartbeat = null;
let acceptingJoins = true;
const rooms = new Map(); // boardId(String) -> room

const send = (ws, obj) => {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > LIMITS.MAX_BUFFERED_BYTES) return; // drop under backpressure
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* socket dying */
  }
};

const publicMembers = (room) =>
  [...room.members.values()].map((s) => ({
    socketId: s.socketId,
    username: s.username,
    color: s.color,
    canWrite: s.canWrite,
    isHost: s.isHost,
    handRaised: !!s.handRaised,
  }));

function broadcast(room, obj, exceptConnId) {
  for (const seat of room.members.values()) {
    if (seat.connId === exceptConnId) continue;
    if (Date.now() > seat.authExpiresAt) continue; // never send to a lapsed seat
    send(seat.ws, obj);
  }
}

const broadcastPresence = (room) => broadcast(room, { v: 1, type: "presence", members: publicMembers(room) });

function broadcastSaveState(room) {
  const state = room.lastPersistError
    ? "failed"
    : room.persistedRevision >= room.acceptedRevision
    ? "saved"
    : "saving";
  broadcast(room, { v: 1, type: "save-state", state, acceptedRevision: room.acceptedRevision, persistedRevision: room.persistedRevision });
}

// ---- persistence (server-authoritative, revision CAS) -----------------------
function scheduleCheckpoint(room, delay = LIMITS.CHECKPOINT_DEBOUNCE_MS) {
  if (room.checkpointTimer) return;
  room.checkpointTimer = setTimeout(() => {
    room.checkpointTimer = null;
    persistRoom(room).catch(() => {});
  }, delay);
}

async function persistRoom(room) {
  if (room.persisting || !room.pageId) return;
  if (room.persistedRevision >= room.acceptedRevision && !room.lastPersistError) return;
  room.persisting = true;
  const checkpointRev = room.acceptedRevision;
  const elements = [...room.scene.elements.values()];
  const files = {};
  for (const [id, ref] of room.scene.files) files[id] = ref;
  // Persist ONLY the page background from appState (allow-list), never arbitrary UI.
  const pageScene = { elements, appState: { viewBackgroundColor: "transparent" }, files };
  try {
    const res = await Board.findOneAndUpdate(
      {
        _id: room.boardId,
        deletedAt: null,
        "pages._id": room.pageId,
        revision: { $in: [room.boardRevision, null] }, // absent-safe for legacy docs
      },
      { $set: { "pages.$.scene": pageScene, elementCount: elements.length }, $inc: { revision: 1 } },
      { new: true }
    ).lean();
    if (!res) {
      // Conflict: another writer/tab advanced the revision. Reload and retry;
      // NEVER blind-overwrite with a stale full-page write.
      const fresh = await Board.findById(room.boardId).select("revision").lean();
      room.boardRevision = fresh ? fresh.revision || 0 : room.boardRevision;
      room.lastPersistError = "conflict";
      scheduleCheckpoint(room, 2000);
    } else {
      room.boardRevision = res.revision;
      room.persistedRevision = checkpointRev;
      room.lastPersistError = null;
    }
  } catch {
    room.lastPersistError = "error";
    scheduleCheckpoint(room, 3000);
  } finally {
    room.persisting = false;
    broadcastSaveState(room);
  }
}

// ---- room / seat lifecycle --------------------------------------------------
function makeSeat(ws, user, isHost) {
  return {
    ws,
    connId: crypto.randomUUID(),
    socketId: crypto.randomUUID(),
    user,
    username: user.name || "İstifadəçi",
    color: colorFor(user._id),
    isHost,
    canWrite: isHost, // students start view-only (teacher grants write)
    handRaised: false,
    authExpiresAt: Date.now() + LIMITS.AUTH_LEASE_MS,
    authTimer: null,
    lastClientSeq: 0,
    msgTimes: [],
    ptrTimes: [],
    alive: true,
  };
}

function colorFor(id) {
  const h = parseInt(crypto.createHash("md5").update(String(id)).digest("hex").slice(0, 6), 16) % 360;
  return { background: `hsl(${h} 70% 92%)`, stroke: `hsl(${h} 65% 42%)` };
}

function armAuthTimer(room, seat) {
  clearTimeout(seat.authTimer);
  seat.authTimer = setTimeout(() => dropSeat(room, seat, "auth-expired"), Math.max(0, seat.authExpiresAt - Date.now()));
}

function rateOk(times, max) {
  const now = Date.now();
  while (times.length && now - times[0] > 1000) times.shift();
  if (times.length >= max) return false;
  times.push(now);
  return true;
}

function dropSeat(room, seat, reason) {
  clearTimeout(seat.authTimer);
  room.members.delete(seat.connId);
  try {
    seat.ws.close(CLOSE.POLICY, reason && reason.length <= 60 ? reason : "closed");
  } catch {
    /* already gone */
  }
  if (seat.connId === room.leaderSocketId) onLeaderGone(room);
  if (!room.members.size) beginGrace(room);
  else broadcastPresence(room);
}

function beginGrace(room) {
  // Host/leader gone or room emptied — freeze and allow a reconnect window, then
  // checkpoint + close. A brief network blip must not end the lesson.
  if (room.status === "ending") return;
  room.status = "reconnecting";
  clearTimeout(room.graceTimer);
  room.graceTimer = setTimeout(async () => {
    room.status = "ending";
    await persistRoom(room).catch(() => {});
    broadcast(room, { v: 1, type: "host-left" });
    for (const seat of room.members.values()) {
      clearTimeout(seat.authTimer);
      try {
        seat.ws.close(CLOSE.GOING_AWAY, "session-ended");
      } catch {
        /* gone */
      }
    }
    clearTimeout(room.checkpointTimer);
    rooms.delete(room.boardId);
  }, LIMITS.GRACE_MS);
}

function onLeaderGone(room) {
  // Promote another host writer if present; else leave leaderless (grace handles).
  const nextHost = [...room.members.values()].find((s) => s.isHost);
  room.leaderSocketId = nextHost ? nextHost.connId : null;
}

// ---- connection handling ----------------------------------------------------
function attach(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.MAX_PAYLOAD });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/ws/board")) return; // let other upgraders handle
    if (!acceptingJoins) return socket.destroy();
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const seat of room.members.values()) {
        if (!seat.alive) {
          seat.ws.terminate();
          continue;
        }
        seat.alive = false;
        try {
          seat.ws.ping();
        } catch {
          /* gone */
        }
      }
    }
  }, LIMITS.HEARTBEAT_MS);
  heartbeat.unref?.();
}

function onConnection(ws) {
  ws.binaryType = "nodebuffer";
  let seat = null;
  let room = null;

  const joinTimer = setTimeout(() => {
    if (!seat) ws.close(CLOSE.POLICY, "join-timeout");
  }, LIMITS.JOIN_TIMEOUT_MS);

  ws.on("pong", () => {
    if (seat) seat.alive = true;
  });

  ws.on("message", async (data, isBinary) => {
    if (isBinary) return ws.close(CLOSE.POLICY, "binary-not-allowed");
    if (data.length > LIMITS.MAX_PAYLOAD) return ws.close(CLOSE.MSG_TOO_BIG, "too-big");
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return; // ignore malformed frame
    }

    if (!seat) {
      clearTimeout(joinTimer);
      const res = await handleHandshake(ws, msg);
      if (res) {
        seat = res.seat;
        room = res.room;
      }
      return;
    }

    if (!rateOk(seat.msgTimes, LIMITS.MAX_MSGS_PER_SEC)) return; // silent rate-limit
    await handleInRoom(room, seat, msg);
  });

  ws.on("close", () => {
    clearTimeout(joinTimer);
    if (seat && room) dropSeat(room, seat, "closed");
  });
  ws.on("error", () => {
    try {
      ws.terminate();
    } catch {
      /* noop */
    }
  });
}

async function handleHandshake(ws, msg) {
  if (!validateHandshake(msg).ok) {
    ws.close(CLOSE.POLICY, "bad-handshake");
    return null;
  }
  const { user, error } = await resolveSessionUser(msg.token);
  if (error || !user) {
    ws.close(CLOSE.POLICY, "unauthorized");
    return null;
  }
  const board = await Board.findOne({ _id: msg.boardId, deletedAt: null });
  if (!board) {
    ws.close(CLOSE.POLICY, "not-found");
    return null;
  }

  if (msg.type === "start-live") {
    if (!(await canHostLive(user, board))) {
      ws.close(CLOSE.POLICY, "forbidden");
      return null;
    }
    return startOrHostRoom(ws, user, board);
  }

  // join
  const { ok } = await accessLevel(user, board);
  if (!ok) {
    ws.close(CLOSE.POLICY, "forbidden");
    return null;
  }
  const room = rooms.get(String(board._id));
  if (!room || room.status !== "ready") {
    send(ws, { v: 1, type: "no-live" });
    ws.close(CLOSE.GOING_AWAY, "no-live");
    return null;
  }
  return seatIntoRoom(ws, user, room, false);
}

function ensurePageId(board) {
  const page = board.pages && board.pages[0];
  return page ? String(page._id) : null;
}

async function startOrHostRoom(ws, user, board) {
  const key = String(board._id);
  let room = rooms.get(key);
  if (room && room.status === "ending") {
    rooms.delete(key);
    room = null;
  }
  if (!room) {
    // Materialize a real first page for legacy single-scene boards so the CAS can
    // target a stable pageId.
    if (!board.pages || !board.pages.length) {
      board.pages = [{ name: "Səhifə 1", scene: board.scene || null }];
      board.scene = null;
      await board.save();
    }
    const pageId = ensurePageId(board);
    const first = board.pages[0].scene || {};
    const elements = new Map((first.elements || []).map((e) => [e.id, e]));
    const files = new Map(Object.entries(first.files || {}));
    room = {
      boardId: key,
      liveSessionId: crypto.randomUUID(),
      hostUserId: String(user._id),
      leaderSocketId: null,
      status: "ready",
      pageId,
      pageEpoch: 0,
      acceptedRevision: 0,
      persistedRevision: 0,
      boardRevision: board.revision || 0,
      scene: { elements, files },
      members: new Map(),
      dirty: false,
      persisting: false,
      lastPersistError: null,
      checkpointTimer: null,
      graceTimer: null,
    };
    rooms.set(key, room);
  } else {
    clearTimeout(room.graceTimer);
    room.status = "ready";
  }
  return seatIntoRoom(ws, user, room, true);
}

function seatIntoRoom(ws, user, room, isHost) {
  if (room.members.size >= LIMITS.MAX_MEMBERS_PER_ROOM) {
    ws.close(CLOSE.POLICY, "room-full");
    return null;
  }
  const perUser = [...room.members.values()].filter((s) => String(s.user._id) === String(user._id)).length;
  if (perUser >= LIMITS.MAX_SOCKETS_PER_USER) {
    ws.close(CLOSE.POLICY, "too-many-sessions");
    return null;
  }
  const seat = makeSeat(ws, user, isHost);
  room.members.set(seat.connId, seat);
  armAuthTimer(room, seat);
  if (isHost && !room.leaderSocketId) room.leaderSocketId = seat.connId;

  send(ws, {
    v: 1,
    type: isHost ? "live-started" : "joined",
    liveSessionId: room.liveSessionId,
    pageId: room.pageId,
    pageEpoch: room.pageEpoch,
    revision: room.acceptedRevision,
    self: { socketId: seat.socketId, canWrite: seat.canWrite, isHost: seat.isHost, isLeader: seat.connId === room.leaderSocketId },
    scene: { elements: [...room.scene.elements.values()], files: mapToObj(room.scene.files) },
    members: publicMembers(room),
  });
  broadcast(room, { v: 1, type: "peer-joined", member: publicMembers(room).find((m) => m.socketId === seat.socketId) }, seat.connId);
  broadcastPresence(room);
  return { seat, room };
}

const mapToObj = (m) => {
  const o = {};
  for (const [k, v] of m) o[k] = v;
  return o;
};

async function handleInRoom(room, seat, msg) {
  if (Date.now() > seat.authExpiresAt && msg.type !== "reauth") {
    return dropSeat(room, seat, "auth-expired");
  }
  const check = validateInRoom(msg, room, seat);
  if (!check.ok) return; // stale epoch / dup / bad shape → drop silently
  if (typeof msg.clientSeq === "number") seat.lastClientSeq = msg.clientSeq;

  switch (msg.type) {
    case "reauth": {
      const { user, error } = await resolveSessionUser(msg.token);
      if (error || !user || String(user._id) !== String(seat.user._id)) {
        return dropSeat(room, seat, "reauth-failed");
      }
      seat.authExpiresAt = Date.now() + LIMITS.AUTH_LEASE_MS;
      armAuthTimer(room, seat);
      send(seat.ws, { v: 1, type: "reauth-ok", authExpiresAt: seat.authExpiresAt });
      return;
    }
    case "scene-update": {
      if (!seat.canWrite) return;
      const incoming = Array.isArray(msg.elements) ? msg.elements : [];
      if (incoming.length > LIMITS.MAX_ELEMENTS_PER_MSG) return;
      const accepted = [];
      for (const el of incoming) {
        if (!isValidElement(el)) continue;
        if (el.fileId && !room.scene.files.has(el.fileId)) continue; // unknown file ref
        const cur = room.scene.elements.get(el.id);
        if (shouldAcceptElement(el, cur)) {
          room.scene.elements.set(el.id, el);
          accepted.push(el);
        }
      }
      if (room.scene.elements.size > LIMITS.MAX_ELEMENTS) return dropSeat(room, seat, "too-many-elements");
      if (!accepted.length) return;
      room.acceptedRevision += 1;
      room.dirty = true;
      scheduleCheckpoint(room);
      broadcast(room, { v: 1, type: "scene-update", elements: accepted, from: seat.socketId }, seat.connId);
      send(seat.ws, { v: 1, type: "ack", clientSeq: msg.clientSeq, acceptedRevision: room.acceptedRevision });
      return;
    }
    case "pointer": {
      if (!rateOk(seat.ptrTimes, LIMITS.MAX_POINTERS_PER_SEC)) return;
      broadcast(room, { v: 1, type: "pointer", socketId: seat.socketId, username: seat.username, color: seat.color, pointer: msg.pointer, button: msg.button, selectedElementIds: msg.selectedElementIds }, seat.connId);
      return;
    }
    case "files-add": {
      if (!seat.isHost) return; // MVP: only host adds files
      const f = msg.file;
      if (!f || typeof f.fileId !== "string" || typeof f.hash !== "string") return;
      room.scene.files.set(f.fileId, { fileId: f.fileId, hash: f.hash, mime: f.mime, size: f.size });
      broadcast(room, { v: 1, type: "files-add", file: room.scene.files.get(f.fileId), from: seat.socketId }, seat.connId);
      return;
    }
    case "request-write": {
      seat.handRaised = true;
      broadcastPresence(room);
      return;
    }
    case "grant-write": {
      if (seat.connId !== room.leaderSocketId && !seat.isHost) return; // host/leader only
      const target = [...room.members.values()].find((s) => s.socketId === msg.targetSocketId);
      if (!target || target.isHost) return;
      target.canWrite = !!msg.allow;
      if (target.canWrite) target.handRaised = false;
      send(target.ws, { v: 1, type: "write-changed", canWrite: target.canWrite });
      broadcastPresence(room);
      return;
    }
    case "page": {
      if (seat.connId !== room.leaderSocketId && !seat.isHost) return;
      await persistRoom(room); // checkpoint current page before switching
      const scene = msg.scene || {};
      room.pageId = typeof msg.pageId === "string" ? msg.pageId : room.pageId;
      room.pageEpoch += 1; // stale updates from the old page are now rejected
      room.scene.elements = new Map((scene.elements || []).map((e) => [e.id, e]));
      room.scene.files = new Map(Object.entries(scene.files || {}));
      room.dirty = true;
      scheduleCheckpoint(room);
      broadcast(room, { v: 1, type: "page-changed", pageId: room.pageId, pageEpoch: room.pageEpoch, scene: { elements: [...room.scene.elements.values()], files: mapToObj(room.scene.files) } });
      return;
    }
    default:
      return;
  }
}

// ---- exports for server.js + tests -----------------------------------------
function isLive(boardId) {
  const room = rooms.get(String(boardId));
  return room && room.status === "ready" ? { liveSessionId: room.liveSessionId, pageEpoch: room.pageEpoch } : null;
}

async function checkpointAll() {
  await Promise.all([...rooms.values()].map((r) => persistRoom(r).catch(() => {})));
}

async function closeAll() {
  acceptingJoins = false;
  clearInterval(heartbeat);
  for (const room of rooms.values()) broadcast(room, { v: 1, type: "server-restarting" });
  await checkpointAll();
  for (const room of rooms.values()) {
    clearTimeout(room.checkpointTimer);
    clearTimeout(room.graceTimer);
    for (const seat of room.members.values()) {
      clearTimeout(seat.authTimer);
      try {
        seat.ws.close(CLOSE.RESTART, "server-restarting");
      } catch {
        /* gone */
      }
    }
  }
  // wss.close() under noServer does NOT close clients — hence the explicit loop above.
  await new Promise((res) => (wss ? wss.close(res) : res()));
  rooms.clear();
}

module.exports = {
  attach,
  isLive,
  checkpointAll,
  closeAll,
  // pure logic (unit-tested)
  shouldAcceptElement,
  isValidElement,
  validateHandshake,
  validateInRoom,
  LIMITS,
};
