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
const mongoose = require("mongoose");
const Board = require("../models/boardModel");
const { resolveSessionUser } = require("../middleware/authMiddleware");
const { accessLevel, canHostLive } = require("../services/boardAccessService");
const { isAllowedOrigin } = require("../config/corsOptions");
const journal = require("./boardJournal");

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
  MAX_MSGS_PER_SEC: 120, // per-connection ABUSE backstop; per-op buckets below are the real limits
  MAX_SCENE_UPDATES_PER_SEC: 30, // stateful-scene bucket (separate from pointers)
  MAX_POINTERS_PER_SEC: 20,
  MAX_BUFFERED_BYTES: 1_048_576, // 1 MiB backlog → slow client
  MAX_PENDING_ACKS: 1000, // per seat: stop accepting edits if durability lags this far
});

const CLOSE = { POLICY: 1008, GOING_AWAY: 1001, RESTART: 1012, MSG_TOO_BIG: 1009 };

// A fully-EMPTY room (nobody connected at all) is KEPT so the host can reconnect
// and continue the same session — no transient network/navigation event ends a
// session. Only a long idle window with zero members reaps it; that is a memory
// safeguard, NOT a grace/timeout that ends live lessons.
const EMPTY_ROOM_REAP_MS = 2 * 60 * 60 * 1000; // 2 hours (memory eviction only — session stays active)
// HARD cap: a live session auto-ends 4h after it STARTED, no matter what. This is the
// only automatic end besides the explicit End button — disconnects/idle never end it.
const MAX_SESSION_MS = 4 * 60 * 60 * 1000;

// Stable, privacy-safe close reasons for connection telemetry. Each tag maps to a
// ws close code; the TAG is logged (never scene content or user identifiers), so
// production can tell WHY a socket closed: network, payload_limit, auth_revoked,
// explicit_end, server_shutdown, protocol_error, etc.
const CLOSE_REASONS = Object.freeze({
  explicit_end: CLOSE.GOING_AWAY,
  no_live: CLOSE.GOING_AWAY,
  recovering: CLOSE.GOING_AWAY,
  network: CLOSE.GOING_AWAY,
  server_shutdown: CLOSE.RESTART,
  // A lapsed auth LEASE (the client's periodic re-auth didn't fire in time, e.g. a
  // backgrounded tab) is RECONNECTABLE (code 4001, not in the terminal set) — the
  // client reconnects and re-verifies, resuming the session instead of dying on idle.
  auth_expired: 4001,
  auth_revoked: CLOSE.POLICY, // genuine revocation/forbidden → terminal
  forbidden: CLOSE.POLICY,
  unauthorized: CLOSE.POLICY,
  not_found: CLOSE.POLICY,
  protocol_error: CLOSE.POLICY,
  payload_limit: CLOSE.MSG_TOO_BIG,
});
function closeWs(ws, reason) {
  const tag = CLOSE_REASONS[reason] !== undefined ? reason : "protocol_error";
  const code = CLOSE_REASONS[tag];
  try {
    console.log("[LIVE][CONN] close code=" + code + " reason=" + tag);
    ws.close(code, tag);
  } catch {
    /* already gone */
  }
}

// Excalidraw element types we accept over the wire. Anything else is rejected.
const ELEMENT_TYPES = new Set([
  "rectangle", "diamond", "ellipse", "arrow", "line", "freedraw",
  "text", "image", "frame", "magicframe", "embeddable", "iframe", "selection",
]);
// Types only the HOST may add (external content). A modified student client cannot
// inject an embed/iframe or a link over the socket.
const HOST_ONLY_TYPES = new Set(["embeddable", "iframe"]);

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
  if (typeof el.type !== "string" || !ELEMENT_TYPES.has(el.type)) return false;
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
let replayDone = false; // WS connections are refused until boot recovery finishes
const unresolvedRecovery = new Set(); // boards whose journal could not be proven — locked
const rooms = new Map(); // boardId(String) -> room

const DISPOSABLE = new Set(["pointer", "presence"]);
const send = (ws, obj) => {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > LIMITS.MAX_BUFFERED_BYTES) {
    // Slow client. Disposable frames (cursors/presence) are dropped; anything
    // stateful (scene, page, grants) means the client is diverging — disconnect
    // so it reconnects and resyncs from a fresh snapshot instead of silently
    // losing mutations.
    if (DISPOSABLE.has(obj.type)) return;
    try {
      ws.close(1013, "too-slow");
    } catch {
      /* gone */
    }
    return;
  }
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
    photo: s.photo,
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

// The single, server-authoritative persistence state for a room. Derived from the
// real durability counters + last error — NEVER assumed by the client. A brand-new
// room has accepted===persisted===0 and no error, so it is "saved" immediately (a
// client must not paint "saving" just because a socket opened — CR-BOARD-008).
function saveStateOf(room) {
  if (room.lastPersistError) return "failed";
  return room.persistedRevision >= room.acceptedRevision ? "saved" : "saving";
}

function broadcastSaveState(room) {
  broadcast(room, { v: 1, type: "save-state", state: saveStateOf(room), acceptedRevision: room.acceptedRevision, persistedRevision: room.persistedRevision });
}

// ---- persistence (server-authoritative, revision CAS) -----------------------
function scheduleCheckpoint(room, delay = LIMITS.CHECKPOINT_DEBOUNCE_MS) {
  if (room.status === "ending" || room.checkpointTimer) return; // finalizeRoom drives ending
  room.checkpointTimer = setTimeout(() => {
    room.checkpointTimer = null;
    persistRoom(room).catch(() => {});
  }, delay);
}

// ---- durable write-ahead journal (survives a hard kill) ---------------------
function scheduleJournal(room, delay = 300) {
  if (room.status === "ending" || room.journalTimer) return;
  room.journalTimer = setTimeout(() => {
    room.journalTimer = null;
    journalFlush(room).catch(() => {});
  }, delay);
}

// Durably record the accepted scene, then release the acks that were deferred
// until this point — so "acked" always means "survives a hard kill". Serialized:
// a concurrent call JOINS the active flush, and the run LOOPS until the journal
// has caught up to the latest acceptedRevision (a revision that lands mid-write is
// never stranded).
function journalFlush(room) {
  if (!room.pageId) return Promise.resolve();
  if (room.journalFlushing) return room.journalTail || Promise.resolve();
  room.journalFlushing = true;
  room.journalTail = (async () => {
    try {
      while (room.journaledRevision < room.acceptedRevision) {
        const target = room.acceptedRevision;
        const { journalId } = await journal.writeEntry({
          boardId: room.boardId,
          pageId: room.pageId,
          liveSessionId: room.liveSessionId,
          acceptedRevision: target,
          boardRevision: room.boardRevision,
          scene: { elements: [...room.scene.elements.values()], files: mapToObj(room.scene.files) },
        });
        room.journaledRevision = target;
        room.journalId = journalId;
      }
      room.journalUnhealthy = false;
      for (const seat of room.members.values()) flushSeatAcks(seat, room);
    } catch {
      // Durable storage is failing — do NOT release acks (they stay pending, so
      // nothing is falsely called durable), tell clients, and retry.
      room.journalUnhealthy = true;
      broadcast(room, { v: 1, type: "storage-degraded" });
      scheduleJournal(room, 1000);
    } finally {
      room.journalFlushing = false;
    }
  })();
  return room.journalTail;
}

function flushSeatAcks(seat, room) {
  if (!seat.pendingAcks || !seat.pendingAcks.length) return;
  const keep = [];
  for (const a of seat.pendingAcks) {
    if (a.revision <= room.journaledRevision) {
      send(seat.ws, { v: 1, type: "ack", clientSeq: a.clientSeq, acceptedRevision: a.revision, durable: true });
    } else {
      keep.push(a);
    }
  }
  seat.pendingAcks = keep;
}

// Once Mongo has durably caught up to the journaled revision, the journal file is
// redundant — delete it (a newer accepted revision writes a fresh one).
function maybeDropJournal(room) {
  if (!room.lastPersistError && room.journalId && room.journaledRevision > 0 && room.journaledRevision <= room.persistedRevision) {
    // Delete only the journal we know Mongo persisted — deleteEntry no-ops if a
    // newer journal (different id) has since replaced the file.
    journal.deleteEntry(room.boardId, room.journalId).catch(() => {});
  }
}

// One CAS write of the current scene. Returns true on durable success.
async function writeCheckpoint(room) {
  const elements = [...room.scene.elements.values()];
  const files = mapToObj(room.scene.files);
  // Persist ONLY the page background from appState (allow-list), never arbitrary UI.
  const pageScene = { elements, appState: { viewBackgroundColor: "transparent" }, files };
  try {
    const res = await Board.findOneAndUpdate(
      { _id: room.boardId, deletedAt: null, "pages._id": room.pageId, revision: { $in: [room.boardRevision, null] } },
      {
        // Persist the scene AND the applied-journal marker atomically, so boot
        // replay can prove this journal's scene is already in Mongo.
        $set: { "pages.$.scene": pageScene, elementCount: elements.length, lastLiveJournalId: room.journalId || null },
        $inc: { revision: 1 },
      },
      { new: true }
    ).lean();
    if (!res) {
      const fresh = await Board.findById(room.boardId).select("revision").lean();
      room.boardRevision = fresh ? fresh.revision || 0 : room.boardRevision;
      room.lastPersistError = "conflict";
      return false;
    }
    room.boardRevision = res.revision;
    return true;
  } catch {
    room.lastPersistError = "error";
    return false;
  }
}

// SERIALIZED per-room persistence. Only one write runs at a time; the run LOOPS
// until persistedRevision catches up to the latest acceptedRevision. A concurrent
// caller joins the in-flight run's promise (never treated as an instant success).
function persistRoom(room) {
  room.dirty = true;
  if (!room.pageId) return Promise.resolve();
  if (room.persisting) return room.persistTail || Promise.resolve();
  room.persisting = true;
  room.persistTail = (async () => {
    try {
      while (room.persistedRevision < room.acceptedRevision) {
        const target = room.acceptedRevision; // captured BEFORE the write
        const ok = await writeCheckpoint(room);
        if (!ok) {
          room.lastPersistError = room.lastPersistError || "error";
          break;
        }
        room.persistedRevision = target;
        room.lastPersistError = null;
      }
    } finally {
      room.persisting = false;
      broadcastSaveState(room);
      maybeDropJournal(room);
      if (room.lastPersistError) scheduleCheckpoint(room, 3000); // keep retrying while live
    }
  })();
  return room.persistTail;
}

// Await durability THROUGH a specific accepted revision. Loops so that a caller
// whose mutation landed just after an in-flight run's last check still gets its
// own fresh run. Returns true only once persistedRevision >= target.
async function persistThrough(room, target) {
  for (let i = 0; i < 50; i += 1) {
    if (room.persistedRevision >= target) return true;
    await persistRoom(room).catch(() => {});
    if (room.persistedRevision >= target) return true;
    if (room.lastPersistError) return false;
  }
  return room.persistedRevision >= target;
}

// ---- room / seat lifecycle --------------------------------------------------
function makeSeat(ws, user, isHost) {
  return {
    ws,
    connId: crypto.randomUUID(),
    socketId: crypto.randomUUID(),
    user,
    username: user.name || "İstifadəçi",
    photo: user.photo || "",
    color: colorFor(user._id),
    isHost,
    canWrite: isHost, // students start view-only (teacher grants write)
    handRaised: false,
    authExpiresAt: Date.now() + LIMITS.AUTH_LEASE_MS,
    authTimer: null,
    lastClientSeq: 0,
    msgTimes: [],
    sceneTimes: [], // stateful-scene rate bucket (separate from pointers)
    ptrTimes: [],
    pendingAcks: [], // acks deferred until the change is durably journaled
    alive: true,
  };
}

function colorFor(id) {
  const h = parseInt(crypto.createHash("md5").update(String(id)).digest("hex").slice(0, 6), 16) % 360;
  return { background: `hsl(${h} 70% 92%)`, stroke: `hsl(${h} 65% 42%)` };
}

function armAuthTimer(room, seat) {
  clearTimeout(seat.authTimer);
  seat.authTimer = setTimeout(() => dropSeat(room, seat, "auth_expired"), Math.max(0, seat.authExpiresAt - Date.now()));
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
  const had = room.members.has(seat.connId);
  room.members.delete(seat.connId);
  closeWs(seat.ws, reason || "network");
  if (room.status === "ending" || !had) return;
  if (seat.connId === room.leaderSocketId) onLeaderGone(room);
  const hostPresent = [...room.members.values()].some((s) => s.isHost);
  if (!hostPresent && room.status === "ready") {
    // Host/leader gone: freeze every student's write (a student must never keep
    // edit access once the teacher leaves) and enter AWAITING-HOST. The room is
    // NOT ended and viewers are NOT disconnected — they stay in view-only mode and
    // the host can reconnect to the same session. Only an explicit end-live ends it.
    for (const s of room.members.values()) {
      if (s.canWrite && !s.isHost) {
        s.canWrite = false;
        send(s.ws, { v: 1, type: "write-changed", canWrite: false });
      }
    }
    room.status = "awaiting-host";
    broadcast(room, { v: 1, type: "host-away" });
  }
  if (!room.members.size) {
    // Nobody is connected. Keep the room + scene so the host (or a viewer) can
    // reconnect and continue; only a LONG idle window with zero members reaps it.
    enterAwaitingHost(room);
    scheduleEmptyReap(room);
  } else {
    broadcastPresence(room);
  }
}

// End the session for everyone: tell clients, close sockets, then durably persist
// the final scene — and DON'T drop the room until that persist succeeds. This is
// reached ONLY by an explicit end-live (leader), the idle-empty reaper, or graceful
// shutdown — never by a transient disconnect.
async function endRoom(room, reason, opts) {
  if (room.status === "ending") return;
  // FAIL-CLOSED end (CR-BOARD-011): for an EXPLICIT end, durably flip the session
  // inactive FIRST (exact-id CAS). If Mongo cannot confirm, do NOT delete the room or
  // confirm End — otherwise a reconnect could resurrect a session the host ended.
  // Tell the leader it failed so they can retry; the room stays live meanwhile.
  if (opts && opts.markEnded) {
    const ended = await endSession(room.boardId, room.liveSessionId).catch((e) => {
      console.error("[LIVE] session end persist failed", room.boardId, e && e.message);
      return false;
    });
    if (!ended) {
      const leader = room.leaderSocketId && room.members.get(room.leaderSocketId);
      if (leader) send(leader.ws, { v: 1, type: "end-failed" });
      return;
    }
  }
  room.status = "ending";
  const gen = room.generation;
  clearTimeout(room.graceTimer);
  clearTimeout(room.reapTimer);
  clearTimeout(room.capTimer);
  broadcast(room, { v: 1, type: "host-left" });
  for (const seat of room.members.values()) {
    clearTimeout(seat.authTimer);
    closeWs(seat.ws, reason || "explicit_end");
  }
  room.members.clear();
  await finalizeRoom(room, gen, 0);
}

// Persist the final scene, then drop the room — but ONLY if this finalizer is
// still current (generation match), the room is still ending, nobody resumed or
// joined, and every accepted revision is durably saved. A finalizer whose
// generation is stale (the host resumed the room) no-ops and never deletes.
async function finalizeRoom(room, gen, attempt) {
  if (room.generation !== gen || room.status !== "ending") return;
  clearTimeout(room.checkpointTimer);
  const target = room.acceptedRevision;
  const ok = await persistThrough(room, target).catch(() => false);
  if (room.generation !== gen || room.status !== "ending") return; // resumed during the await
  if (room.members.size) return; // someone joined — keep the room
  if (!ok || room.persistedRevision < room.acceptedRevision) {
    if (attempt % 10 === 0) {
      console.error("[LIVE] board", room.boardId, "final checkpoint failing — retrying, scene retained in memory");
    }
    room.finalizeTimer = setTimeout(() => finalizeRoom(room, gen, attempt + 1), Math.min(3000 * (attempt + 1), 30000));
    return;
  }
  clearTimeout(room.finalizeTimer);
  clearTimeout(room.journalTimer);
  clearTimeout(room.capTimer);
  rooms.delete(room.boardId);
}

// The host/leader is gone but the session is NOT ended — mark it awaiting-host so
// a reconnecting host resumes the SAME session. No timer ends the room here.
function enterAwaitingHost(room) {
  if (room.status === "ending") return;
  if (room.status !== "awaiting-host") room.status = "awaiting-host";
}

// The room has ZERO connected members. Persist the scene now and, after a long idle
// window, reap it to bound memory. ANY reconnect (host or viewer) cancels this via
// seatIntoRoom. This is a resource safeguard, never a lesson-ending grace timeout.
function scheduleEmptyReap(room) {
  if (room.status === "ending") return;
  clearTimeout(room.reapTimer);
  scheduleCheckpoint(room, 0); // flush the latest scene while nobody is editing
  room.reapTimer = setTimeout(() => reapEmptyRoom(room).catch(() => {}), EMPTY_ROOM_REAP_MS);
}

// Evict an idle-empty room from MEMORY ONLY. The durable session stays active, so a
// later reconnect rehydrates the SAME session from the saved scene. Never ends the
// session; never drops unsaved work (retries if the final checkpoint fails).
async function reapEmptyRoom(room) {
  if (room.status === "ending" || room.members.size) return; // someone reconnected
  const gen = room.generation;
  const ok = await persistThrough(room, room.acceptedRevision).catch(() => false);
  if (room.members.size || room.generation !== gen || room.status === "ending") return; // resumed mid-persist
  if (!ok || room.persistedRevision < room.acceptedRevision) {
    room.reapTimer = setTimeout(() => reapEmptyRoom(room).catch(() => {}), 60000); // retry; keep scene in memory
    return;
  }
  clearTimeout(room.checkpointTimer);
  clearTimeout(room.journalTimer);
  clearTimeout(room.capTimer); // the 4h cap is re-derived from startedAt on rehydration
  rooms.delete(room.boardId); // memory only — liveSession stays active for rehydration
  console.log("[LIVE] evicted idle-empty room", room.boardId, "from memory (session stays active)");
}

function onLeaderGone(room) {
  // Promote another host writer if present; else leave leaderless (grace handles).
  const nextHost = [...room.members.values()].find((s) => s.isHost);
  room.leaderSocketId = nextHost ? nextHost.connId : null;
}

// ---- startup recovery -------------------------------------------------------
// Replay any journaled scenes a previous process left behind (accepted but not
// yet checkpointed when it died). Apply ONLY when Mongo has not advanced past the
// journal's base revision; delete a journal only once Mongo has proven it (or the
// journal is stale / the board is gone). On a Mongo error, keep the file for the
// next boot rather than dropping it unverified.
async function replayJournals() {
  // Throws if the journal directory can't be enumerated — the caller keeps the hub
  // NOT ready rather than falsely reporting recovery complete.
  const entries = await journal.listEntries();
  for (const rec of entries) {
    const bid = String(rec.boardId);
    // A corrupt/checksum-invalid journal was quarantined but its recoverable work
    // is lost — lock the board and raise a stable alert; never silently continue.
    if (rec.corrupt) {
      unresolvedRecovery.add(bid);
      console.error("[LIVE][SECURITY] corrupt-journal board=" + bid + " quarantined; board LOCKED pending review");
      continue;
    }
    const entry = rec.entry;
    try {
      const board = await Board.findOne({ _id: entry.boardId, deletedAt: null })
        .select("revision pages._id lastLiveJournalId")
        .lean();
      // Board gone → nothing to recover into.
      if (!board) {
        await journal.deleteEntry(bid, entry.journalId);
        continue;
      }
      // This exact journal's scene is already persisted (idempotent proof).
      if (board.lastLiveJournalId === entry.journalId) {
        await journal.deleteEntry(bid, entry.journalId);
        continue;
      }
      const cur = board.revision || 0;
      const pageOk = board.pages.some((p) => String(p._id) === String(entry.pageId));
      // Apply only if Mongo has NOT advanced past the journal's base revision.
      if (pageOk && cur <= (entry.boardRevision || 0)) {
        const pageScene = {
          elements: entry.scene.elements,
          appState: { viewBackgroundColor: "transparent" },
          files: entry.scene.files,
        };
        const res = await Board.findOneAndUpdate(
          { _id: entry.boardId, deletedAt: null, "pages._id": entry.pageId, revision: { $in: cur === 0 ? [0, null] : [cur] } },
          { $set: { "pages.$.scene": pageScene, elementCount: entry.scene.elements.length, lastLiveJournalId: entry.journalId }, $inc: { revision: 1 } },
          { new: true }
        ).lean();
        if (res) {
          console.log("[LIVE] recovered board", bid, "→ rev", res.revision);
          await journal.deleteEntry(bid, entry.journalId);
          continue;
        }
      }
      // CAS missed / Mongo advanced. Re-read and delete ONLY if the marker now
      // proves this exact journal was applied. Otherwise RETAIN + lock + alert —
      // never delete a journal whose scene we cannot prove is persisted.
      const fresh = await Board.findOne({ _id: entry.boardId, deletedAt: null }).select("lastLiveJournalId").lean();
      if (fresh && fresh.lastLiveJournalId === entry.journalId) {
        await journal.deleteEntry(bid, entry.journalId);
      } else {
        unresolvedRecovery.add(bid);
        console.error("[LIVE] UNRESOLVED recovery — board", bid, "locked, journal retained for manual review");
      }
    } catch (e) {
      unresolvedRecovery.add(bid);
      console.error("[LIVE] journal replay error", bid, e && e.message);
    }
  }
}

// ---- connection handling ----------------------------------------------------
function attach(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.MAX_PAYLOAD });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/ws/board")) return; // let other upgraders handle
    // Refuse connections until boot recovery has finished (and only if durable
    // storage passed preflight) — no live edit may race an unfinished replay.
    if (!acceptingJoins || !replayDone) return socket.destroy();
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  // Prove durable storage, then replay journals, THEN start accepting connections.
  // If preflight fails, replayDone stays false → the live board is disabled (safe).
  (async () => {
    try {
      await journal.preflight();
      await replayJournals(); // throws if journals can't be enumerated → stay not-ready
    } catch (e) {
      console.error("[LIVE] recovery FAILED — live board disabled (WS refused):", e && e.message);
      return; // replayDone stays false
    }
    replayDone = true;
    console.log("[LIVE] recovery complete — live board ready");
  })();

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
    if (seat && room) dropSeat(room, seat, "network");
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
    closeWs(ws, "protocol_error");
    return null;
  }
  const { user, error } = await resolveSessionUser(msg.token);
  if (error || !user) {
    closeWs(ws, "unauthorized");
    return null;
  }
  const board = await Board.findOne({ _id: msg.boardId, deletedAt: null });
  if (!board) {
    closeWs(ws, "not_found");
    return null;
  }
  // A board whose crash-recovery could not be proven is locked until reviewed.
  if (unresolvedRecovery.has(String(board._id))) {
    closeWs(ws, "recovering");
    return null;
  }

  if (msg.type === "start-live") {
    if (!(await canHostLive(user, board))) {
      closeWs(ws, "forbidden");
      return null;
    }
    return startOrHostRoom(ws, user, board);
  }

  // join
  const { ok } = await accessLevel(user, board);
  if (!ok) {
    closeWs(ws, "forbidden");
    return null;
  }
  let room = rooms.get(String(board._id));
  // No in-memory room, but a DURABLE session is still active (evicted or survived a
  // restart) → rehydrate it from the saved scene so the viewer joins the SAME session.
  if (!room && hasDurableSession(board)) {
    room = buildRoom(board, board.liveSession.id, startedAtMs(board));
    console.log("[LIVE] rehydrated session", board.liveSession.id, "(viewer) board", String(board._id));
  }
  // A viewer may join a live room OR one that is awaiting its host's return — both
  // are active sessions. Only a truly absent/ended room is "no-live".
  if (!room || (room.status !== "ready" && room.status !== "awaiting-host")) {
    send(ws, { v: 1, type: "no-live" });
    closeWs(ws, "no_live");
    return null;
  }
  return seatIntoRoom(ws, user, room, false);
}

function ensurePageId(board) {
  const page = board.pages && board.pages[0];
  return page ? String(page._id) : null;
}

// DURABLE session identity — FAIL-CLOSED, exact liveSession.id CAS (CR-BOARD-011).
//
// activateSession: durably flips the board to active under THIS session id. The CAS
// only matches when no OTHER session is active (idempotent for our own id), so two
// racing activations can never both win. Returns true ONLY when Mongo confirmed it —
// the caller must NOT admit anyone (send live-started) unless this returned true.
async function activateSession(boardId, sessionId, pageId) {
  const res = await Board.findOneAndUpdate(
    { _id: boardId, $or: [{ "liveSession.active": { $ne: true } }, { "liveSession.id": sessionId }] },
    { $set: { liveSession: { id: sessionId, active: true, pageId: pageId || null, startedAt: new Date() } } },
    { new: true }
  );
  return !!(res && res.liveSession && res.liveSession.active && res.liveSession.id === sessionId);
}
// endSession: durably flips THIS exact session inactive. Returns true when Mongo
// confirms it is inactive (either we flipped it, or it was already inactive/replaced —
// both mean this session is durably not-active). The caller must NOT tear the room
// down / confirm End unless this returned true (else a reconnect could resurrect it).
async function endSession(boardId, sessionId) {
  const res = await Board.findOneAndUpdate(
    { _id: boardId, "liveSession.id": sessionId },
    { $set: { "liveSession.active": false } },
    { new: true }
  );
  if (res) return !res.liveSession || res.liveSession.active === false;
  // No doc matched our id — re-read: if the board is gone or a DIFFERENT/inactive
  // session is recorded, THIS session is durably not active. Only a confirmed still
  // -active OUR-id record (or a read failure) is a failure to end.
  const fresh = await Board.findById(boardId).select("liveSession").lean();
  if (!fresh) return true; // board gone → session cannot be resurrected
  return !(fresh.liveSession && fresh.liveSession.active && fresh.liveSession.id === sessionId);
}

// A session is "fresh" while active AND within the 4h hard cap from its start. Past
// the cap it must not rehydrate or show as live — it gets ended on the next touch.
const startedAtMs = (board) => (board.liveSession && board.liveSession.startedAt ? new Date(board.liveSession.startedAt).getTime() : 0);
const isSessionFresh = (board) => {
  const s = board && board.liveSession;
  if (!s || !s.active || !s.id) return false;
  const started = startedAtMs(board);
  return started > 0 && Date.now() - started < MAX_SESSION_MS;
};

// The 4h HARD cap: end the session (clears the durable flag) once it has run 4h. This
// and the explicit End button are the ONLY automatic ends — never a disconnect/idle.
async function capSession(room) {
  if (room.status === "ending") return;
  console.log("[LIVE] 4h session cap reached — ending", room.boardId);
  await endRoom(room, "explicit_end", { markEnded: true }).catch(() => {});
}
function scheduleSessionCap(room) {
  clearTimeout(room.capTimer);
  const remaining = room.startedAt + MAX_SESSION_MS - Date.now();
  if (remaining <= 0) {
    capSession(room).catch(() => {});
    return;
  }
  room.capTimer = setTimeout(() => capSession(room).catch(() => {}), remaining);
  room.capTimer.unref?.();
}

// Build the in-memory room from a board's SAVED scene, under a given session id
// (a fresh id for a new session, or the persisted id when rehydrating). Registered
// in `rooms`. Starts awaiting-host; the caller sets it ready if a host is seating.
function buildRoom(board, sessionId, startedAt) {
  const key = String(board._id);
  const pageId = ensurePageId(board);
  const first = (board.pages && board.pages[0] && board.pages[0].scene) || {};
  const elements = new Map((first.elements || []).map((e) => [e.id, e]));
  const files = new Map(Object.entries(first.files || {}));
  const room = {
    boardId: key,
    liveSessionId: sessionId,
    hostUserId: null,
    leaderSocketId: null,
    status: "awaiting-host",
    generation: 0,
    pageId,
    pageEpoch: 0,
    startedAt: startedAt || Date.now(), // anchors the 4h cap; preserved across rehydration
    acceptedRevision: 0,
    persistedRevision: 0,
    journaledRevision: 0,
    journalId: null,
    journalUnhealthy: false,
    boardRevision: board.revision || 0,
    scene: { elements, files },
    members: new Map(),
    dirty: false,
    persisting: false,
    persistTail: null,
    journalFlushing: false,
    journalTail: null,
    lastPersistError: null,
    checkpointTimer: null,
    journalTimer: null,
    graceTimer: null,
    finalizeTimer: null,
    reapTimer: null,
    capTimer: null,
  };
  rooms.set(key, room);
  scheduleSessionCap(room);
  return room;
}

const hasDurableSession = (board) => isSessionFresh(board) && !!(board.pages && board.pages.length);

async function startOrHostRoom(ws, user, board) {
  const key = String(board._id);
  let room = rooms.get(key);
  if (room) {
    // Resume the in-memory room (ready, awaiting-host, OR finalizing) with its scene
    // intact. Bumping the generation makes any in-flight old finalizer stale, and
    // clearing the idle reaper keeps the same session alive.
    clearTimeout(room.graceTimer);
    clearTimeout(room.finalizeTimer);
    clearTimeout(room.reapTimer);
    const wasAwaiting = room.status !== "ready";
    room.generation += 1;
    room.status = "ready";
    if (wasAwaiting) broadcast(room, { v: 1, type: "host-back" }); // viewers: host returned
  } else if (hasDurableSession(board)) {
    // Rehydrate a durable session that outlived eviction/restart — SAME id + scene,
    // preserving its original start so the 4h cap still counts from the beginning.
    room = buildRoom(board, board.liveSession.id, startedAtMs(board));
    room.hostUserId = String(user._id);
    room.status = "ready";
    console.log("[LIVE] rehydrated session", board.liveSession.id, "(host) board", key);
  } else {
    // Brand-new session. Materialize a real first page for legacy single-scene
    // boards so the CAS can target a stable pageId.
    if (!board.pages || !board.pages.length) {
      board.pages = [{ name: "Səhifə 1", scene: board.scene || null }];
      board.scene = null;
      await board.save();
    }
    // A stale session (active but past the 4h cap) blocks the activation CAS — clear
    // it first so the host starts a clean new session.
    if (board.liveSession && board.liveSession.active && board.liveSession.id && !isSessionFresh(board)) {
      await endSession(key, board.liveSession.id).catch(() => {});
    }
    // FAIL-CLOSED: durably activate the session BEFORE admitting anyone. If Mongo
    // cannot confirm activation (write error or a concurrent session already active),
    // we do NOT build a room and do NOT send live-started — the client reconnects and
    // either rehydrates the winning session or retries.
    const sessionId = crypto.randomUUID();
    const activated = await activateSession(key, sessionId, ensurePageId(board)).catch((e) => {
      console.error("[LIVE] session activation failed", key, e && e.message);
      return false;
    });
    if (!activated) {
      closeWs(ws, "no_live"); // not durably started — never claim "live-started"
      return null;
    }
    room = buildRoom(board, sessionId);
    room.hostUserId = String(user._id);
    room.status = "ready";
  }
  return seatIntoRoom(ws, user, room, true);
}

function seatIntoRoom(ws, user, room, isHost) {
  if (room.members.size >= LIMITS.MAX_MEMBERS_PER_ROOM) {
    closeWs(ws, "protocol_error");
    return null;
  }
  const perUser = [...room.members.values()].filter((s) => String(s.user._id) === String(user._id)).length;
  if (perUser >= LIMITS.MAX_SOCKETS_PER_USER) {
    closeWs(ws, "protocol_error");
    return null;
  }
  // A member (re)connected — cancel any idle-empty reaper so the session persists.
  clearTimeout(room.reapTimer);
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
    // Authoritative initial/reconnect save state so the client never guesses — an
    // untouched room reports "saved", not "saving" (CR-BOARD-008).
    saveState: saveStateOf(room),
    self: { socketId: seat.socketId, canWrite: seat.canWrite, isHost: seat.isHost, isLeader: seat.connId === room.leaderSocketId },
    scene: { elements: [...room.scene.elements.values()], files: mapToObj(room.scene.files) },
    members: publicMembers(room),
  });
  broadcast(room, { v: 1, type: "peer-joined", member: publicMembers(room).find((m) => m.socketId === seat.socketId) }, seat.connId);
  broadcastPresence(room);
  return { seat, room };
}

// Point the live room at a DIFFERENT saved page (server-authoritative scene, loaded
// from Mongo — never the client message) and tell everyone. The target page is
// already durable, so there is no unpersisted state to journal before broadcasting
// (this is what CR-BOARD-006 required). Callers MUST persist the current page first.
function switchRoomToPage(room, board, page) {
  const scene = page.scene || {};
  room.pageId = String(page._id);
  room.pageEpoch += 1; // stale updates from the previous page are now rejected
  room.scene.elements = new Map((scene.elements || []).map((e) => [e.id, e]));
  room.scene.files = new Map(Object.entries(scene.files || {}));
  room.boardRevision = board.revision || room.boardRevision;
  room.dirty = false;
  room.lastPersistError = null;
  // The target is loaded-as-saved: nothing unpersisted, so mark it fully persisted
  // + journaled and drop any journal left for the previous page.
  room.persistedRevision = room.acceptedRevision;
  room.journaledRevision = room.acceptedRevision;
  maybeDropJournal(room);
  broadcast(room, {
    v: 1,
    type: "page-changed",
    pageId: room.pageId,
    name: page.name || "Səhifə",
    pageEpoch: room.pageEpoch,
    scene: { elements: [...room.scene.elements.values()], files: mapToObj(room.scene.files) },
  });
  broadcastSaveState(room);
}

const mapToObj = (m) => {
  const o = {};
  for (const [k, v] of m) o[k] = v;
  return o;
};

async function handleInRoom(room, seat, msg) {
  if (Date.now() > seat.authExpiresAt && msg.type !== "reauth") {
    return dropSeat(room, seat, "auth_expired"); // lease lapsed → reconnect + re-verify
  }
  const check = validateInRoom(msg, room, seat);
  if (!check.ok) return; // stale epoch / dup / bad shape → drop silently
  if (typeof msg.clientSeq === "number") seat.lastClientSeq = msg.clientSeq;

  switch (msg.type) {
    case "reauth": {
      const { user, error } = await resolveSessionUser(msg.token);
      if (error || !user || String(user._id) !== String(seat.user._id)) {
        return dropSeat(room, seat, "auth_revoked");
      }
      // Re-run the FULL access check, not just token validity: a student removed
      // from the class, or a teacher whose approval was revoked mid-session, must
      // be dropped even if their token is still valid.
      const board = await Board.findOne({ _id: room.boardId, deletedAt: null }).select("owner classes").lean();
      if (!board) return dropSeat(room, seat, "not_found");
      const level = await accessLevel(user, board);
      if (!level.ok) return dropSeat(room, seat, "auth_revoked");
      if (seat.isHost && !(await canHostLive(user, board))) return dropSeat(room, seat, "auth_revoked");
      seat.user = user;
      seat.authExpiresAt = Date.now() + LIMITS.AUTH_LEASE_MS;
      armAuthTimer(room, seat);
      send(seat.ws, { v: 1, type: "reauth-ok", authExpiresAt: seat.authExpiresAt });
      return;
    }
    case "scene-update": {
      if (!seat.canWrite) return;
      // Stateful frames get their OWN rate bucket and a TYPED rejection when exceeded
      // — never a silent drop (the client can back off + retry). clientSeq is echoed
      // so the client knows exactly which send was refused (CR-BOARD-012).
      if (!seat.sceneTimes) seat.sceneTimes = [];
      if (!rateOk(seat.sceneTimes, LIMITS.MAX_SCENE_UPDATES_PER_SEC)) {
        send(seat.ws, { v: 1, type: "rate-limited", op: "scene-update", clientSeq: typeof msg.clientSeq === "number" ? msg.clientSeq : null });
        return;
      }
      // Durable storage is the contract for accepting edits. If journaling is
      // failing or the durability backlog is too deep, refuse new edits rather
      // than accept something we cannot promise to keep.
      if (room.journalUnhealthy || !journal.isHealthy() || seat.pendingAcks.length >= LIMITS.MAX_PENDING_ACKS) {
        send(seat.ws, { v: 1, type: "storage-degraded", clientSeq: typeof msg.clientSeq === "number" ? msg.clientSeq : null });
        return;
      }
      const incoming = Array.isArray(msg.elements) ? msg.elements : [];
      if (incoming.length > LIMITS.MAX_ELEMENTS_PER_MSG) return;
      const accepted = [];
      const rejected = []; // { id, reason } — reported so a drop is NEVER silent
      for (const el of incoming) {
        if (!isValidElement(el)) {
          if (el && typeof el.id === "string") rejected.push({ id: el.id, reason: "invalid" });
          continue;
        }
        if (!seat.isHost && (HOST_ONLY_TYPES.has(el.type) || el.link != null)) {
          rejected.push({ id: el.id, reason: "host-only" });
          continue;
        }
        if (el.fileId && !room.scene.files.has(el.fileId)) {
          rejected.push({ id: el.id, reason: "unknown-file" });
          continue;
        }
        const cur = room.scene.elements.get(el.id);
        if (shouldAcceptElement(el, cur)) {
          room.scene.elements.set(el.id, el);
          accepted.push(el);
        }
      }
      if (room.scene.elements.size > LIMITS.MAX_ELEMENTS) return dropSeat(room, seat, "protocol_error");
      // Tell the sender exactly which elements were NOT accepted, so the host and
      // viewers can never silently diverge (CR-BOARD-010 item 4).
      if (rejected.length) send(seat.ws, { v: 1, type: "scene-rejected", elements: rejected });
      if (!accepted.length) return;
      room.acceptedRevision += 1;
      room.dirty = true;
      // CR-BOARD-009: announce "saving" IMMEDIATELY on accepting the change —
      // persistedRevision now trails acceptedRevision, so this emits "saving" and
      // the UI can never keep showing "Saxlanıldı" during the checkpoint window.
      // The persist path emits the authoritative "saved"/"failed" when it finishes.
      broadcastSaveState(room);
      scheduleCheckpoint(room);
      broadcast(room, { v: 1, type: "scene-update", elements: accepted, from: seat.socketId }, seat.connId);
      // The ack is DEFERRED until the change is durably journaled (survives a hard
      // kill), so an acknowledged drawing is never lost.
      if (typeof msg.clientSeq === "number") seat.pendingAcks.push({ clientSeq: msg.clientSeq, revision: room.acceptedRevision });
      scheduleJournal(room);
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
    case "bg-change": {
      if (seat.connId !== room.leaderSocketId) return; // host controls the background
      const bg = ["dots", "grid", "lines", "blank"].includes(msg.background) ? msg.background : null;
      const rawColor = typeof msg.bgColor === "string" ? msg.bgColor.trim() : "";
      const color = rawColor === "" || /^[#a-zA-Z0-9(),.%\s]{1,32}$/.test(rawColor) ? rawColor : null;
      if (bg == null && color == null) return;
      broadcast(room, { v: 1, type: "bg-change", background: bg, bgColor: color }, seat.connId);
      // Persist the host-authoritative canvas background (scalar board fields — not the
      // page scene, so no revision CAS needed). Best-effort; survives after live ends.
      const set = {};
      if (bg != null) set.background = bg;
      if (color != null) set.bgColor = color;
      Board.updateOne({ _id: room.boardId }, { $set: set }).catch(() => {});
      return;
    }
    case "end-live": {
      if (seat.connId !== room.leaderSocketId) return; // leader (the driving host tab) only
      // The ONLY normal way a session ends: clears the durable session flag too.
      await endRoom(room, "explicit_end", { markEnded: true });
      return;
    }
    case "request-write": {
      seat.handRaised = true;
      broadcastPresence(room);
      // Nudge the host(s) directly so the request is impossible to miss.
      for (const s of room.members.values()) {
        if (s.isHost) send(s.ws, { v: 1, type: "hand-raised", socketId: seat.socketId, username: seat.username });
      }
      return;
    }
    case "grant-write": {
      if (seat.connId !== room.leaderSocketId) return; // leader only
      const target = [...room.members.values()].find((s) => s.socketId === msg.targetSocketId);
      if (!target || target.isHost) return;
      target.canWrite = !!msg.allow;
      if (target.canWrite) target.handRaised = false;
      send(target.ws, { v: 1, type: "write-changed", canWrite: target.canWrite });
      broadcastPresence(room);
      return;
    }
    case "page": {
      // Host switches everyone to another EXISTING page. Persist the current page
      // durably first, then load the target's SAVED scene from Mongo (authoritative).
      if (seat.connId !== room.leaderSocketId) return; // leader only
      const pageId = typeof msg.pageId === "string" ? msg.pageId : null;
      if (!pageId || pageId === room.pageId) return;
      const gen = room.generation;
      const stillCurrent = () =>
        rooms.get(room.boardId) === room && room.generation === gen && room.status === "ready" && seat.connId === room.leaderSocketId;
      const saved = await persistThrough(room, room.acceptedRevision);
      if (!stillCurrent()) return;
      if (!saved || room.persistedRevision < room.acceptedRevision) {
        send(seat.ws, { v: 1, type: "page-blocked", reason: "save-failed" });
        return;
      }
      const board = await Board.findOne({ _id: room.boardId, deletedAt: null }).select("pages revision").lean();
      if (!stillCurrent()) return;
      const page = board && (board.pages || []).find((p) => String(p._id) === pageId);
      if (!page) {
        send(seat.ws, { v: 1, type: "page-blocked", reason: "not-found" });
        return;
      }
      if (room.persistedRevision < room.acceptedRevision) {
        // An edit landed during the load — don't drop it; the host can retry the switch.
        send(seat.ws, { v: 1, type: "page-blocked", reason: "busy" });
        return;
      }
      switchRoomToPage(room, board, page);
      return;
    }
    case "add-page": {
      // Host adds a new page (appended durably) and switches everyone to it.
      if (seat.connId !== room.leaderSocketId) return; // leader only
      const gen = room.generation;
      const stillCurrent = () =>
        rooms.get(room.boardId) === room && room.generation === gen && room.status === "ready" && seat.connId === room.leaderSocketId;
      const saved = await persistThrough(room, room.acceptedRevision);
      if (!stillCurrent()) return;
      if (!saved || room.persistedRevision < room.acceptedRevision) {
        send(seat.ws, { v: 1, type: "page-blocked", reason: "save-failed" });
        return;
      }
      const newPage = {
        _id: new mongoose.Types.ObjectId(),
        name: typeof msg.name === "string" && msg.name.trim() ? msg.name.trim().slice(0, 60) : "Səhifə",
        scene: null,
      };
      const res = await Board.findOneAndUpdate(
        { _id: room.boardId, deletedAt: null },
        { $push: { pages: newPage } },
        { new: true }
      ).select("pages revision").lean();
      if (!stillCurrent()) return;
      const page = res && (res.pages || []).find((p) => String(p._id) === String(newPage._id));
      if (!page) {
        send(seat.ws, { v: 1, type: "page-blocked", reason: "add-failed" });
        return;
      }
      if (room.persistedRevision < room.acceptedRevision) {
        send(seat.ws, { v: 1, type: "page-blocked", reason: "busy" });
        return;
      }
      switchRoomToPage(room, res, page);
      return;
    }
    default:
      return;
  }
}

// ---- exports for server.js + tests -----------------------------------------
function isLive(boardId) {
  const room = rooms.get(String(boardId));
  // A session awaiting its host's return is still LIVE — viewers may (re)join and
  // the host sees a resume affordance. Only "ending" is not live.
  const active = room && (room.status === "ready" || room.status === "awaiting-host");
  return active ? { liveSessionId: room.liveSessionId, pageEpoch: room.pageEpoch, awaitingHost: room.status === "awaiting-host" } : null;
}

async function checkpointAll() {
  await Promise.all([...rooms.values()].map((r) => persistThrough(r, r.acceptedRevision).catch(() => false)));
}

async function closeAll(budgetMs) {
  acceptingJoins = false;
  clearInterval(heartbeat);
  for (const room of rooms.values()) broadcast(room, { v: 1, type: "server-restarting" });
  // Block shutdown, retrying, until every room is checkpointed OR the lifecycle
  // budget is exhausted. A room counts as unsaved until persistedRevision has
  // caught up to acceptedRevision — we do NOT declare a room safely closed on a
  // best-effort attempt. On a prolonged DB outage, changes since the last
  // successful checkpoint may still be lost (logged, not silently swallowed).
  // Bounded, fixed production budget (stays within the 10s process deadline).
  // A test-only override is accepted as an argument — there is NO env seam.
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 8000;
  const deadline = Date.now() + budget;
  const unsavedRooms = () => [...rooms.values()].filter((r) => r.persistedRevision < r.acceptedRevision);
  while (Date.now() < deadline) {
    await checkpointAll();
    if (!unsavedRooms().length) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const lost = unsavedRooms();
  if (lost.length) {
    console.error("[LIVE] SHUTDOWN DATA-LOSS RISK — rooms not fully checkpointed:", lost.map((r) => r.boardId));
  }
  for (const room of rooms.values()) {
    clearTimeout(room.checkpointTimer);
    clearTimeout(room.journalTimer);
    clearTimeout(room.graceTimer);
    clearTimeout(room.finalizeTimer);
    clearTimeout(room.reapTimer);
    clearTimeout(room.capTimer);
    for (const seat of room.members.values()) {
      clearTimeout(seat.authTimer);
      closeWs(seat.ws, "server_shutdown");
    }
  }
  // wss.close() under noServer does NOT close clients — hence the explicit loop above.
  await new Promise((res) => (wss ? wss.close(res) : res()));
  rooms.clear();
}

module.exports = {
  attach,
  isLive,
  isSessionFresh, // controllers: a durable session shows live only within the 4h cap
  checkpointAll,
  closeAll,
  // pure logic (unit-tested)
  shouldAcceptElement,
  isValidElement,
  validateHandshake,
  validateInRoom,
  LIMITS,
  // test-only hooks for the persistence/finalization/journal coordination
  __test: { rooms, endRoom, finalizeRoom, persistThrough, handleInRoom, journalFlush, replayJournals, unresolvedRecovery, handleHandshake, seatIntoRoom, makeSeat, saveStateOf, dropSeat, reapEmptyRoom, activateSession, endSession, isReady: () => replayDone },
};
