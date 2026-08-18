// Live whiteboard hub — pure-logic regression guards. The reconciliation winner
// and the epoch/session rejection are the parts most likely to silently break;
// CR-WB-002 specifically requires the LOWER versionNonce to win on a version tie
// (matching Excalidraw's reconcileElements) — a wrong direction makes elements
// oscillate or vanish.
const assert = require("assert");
// Journal writes go to an isolated temp dir (set BEFORE the hub/journal load).
process.env.LIVE_JOURNAL_DIR = require("path").join(require("os").tmpdir(), "exq-live-journal-test-" + process.pid);
const hub = require("../realtime/boardHub");
const jrnl = require("../realtime/boardJournal");

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log("  ✓ " + name);
    pass += 1;
  } catch (e) {
    console.log("  ✗ " + name + " — " + e.message);
    fail += 1;
  }
};

console.log("board-live hub — reconciliation + envelope");

t("higher version wins", () => assert.strictEqual(hub.shouldAcceptElement({ version: 2, versionNonce: 99 }, { version: 1, versionNonce: 1 }), true));
t("lower version loses", () => assert.strictEqual(hub.shouldAcceptElement({ version: 1, versionNonce: 1 }, { version: 2, versionNonce: 99 }), false));
t("tie: LOWER versionNonce wins (matches Excalidraw)", () => assert.strictEqual(hub.shouldAcceptElement({ version: 5, versionNonce: 10 }, { version: 5, versionNonce: 20 }), true));
t("tie: higher versionNonce loses", () => assert.strictEqual(hub.shouldAcceptElement({ version: 5, versionNonce: 30 }, { version: 5, versionNonce: 20 }), false));
t("new element (no current) accepted", () => assert.strictEqual(hub.shouldAcceptElement({ version: 1, versionNonce: 1 }, undefined), true));

const room = { liveSessionId: "S", pageEpoch: 3 };
const seat = { lastClientSeq: 0 };
t("stale page epoch rejected", () => assert.strictEqual(hub.validateInRoom({ v: 1, type: "scene-update", liveSessionId: "S", pageEpoch: 2, clientSeq: 1 }, room, seat).ok, false));
t("matching epoch accepted", () => assert.strictEqual(hub.validateInRoom({ v: 1, type: "scene-update", liveSessionId: "S", pageEpoch: 3, clientSeq: 1 }, room, seat).ok, true));
t("wrong session rejected", () => assert.strictEqual(hub.validateInRoom({ v: 1, type: "pointer", liveSessionId: "X", clientSeq: 2 }, room, seat).ok, false));
t("duplicate clientSeq rejected", () => assert.strictEqual(hub.validateInRoom({ v: 1, type: "pointer", liveSessionId: "S", clientSeq: 0 }, room, seat).ok, false));

t("handshake start-live valid", () => assert.strictEqual(hub.validateHandshake({ v: 1, type: "start-live", boardId: "b" }).ok, true));
t("handshake unknown type rejected", () => assert.strictEqual(hub.validateHandshake({ v: 1, type: "evil", boardId: "b" }).ok, false));
t("handshake wrong version rejected", () => assert.strictEqual(hub.validateHandshake({ v: 2, type: "join", boardId: "b" }).ok, false));

t("element with out-of-range coord rejected", () => assert.strictEqual(hub.isValidElement({ id: "a", type: "rectangle", x: 1e9 }), false));
t("element with no id rejected", () => assert.strictEqual(hub.isValidElement({ type: "rectangle" }), false));
t("valid element accepted", () => assert.strictEqual(hub.isValidElement({ id: "a", type: "rectangle", x: 10, y: 10, width: 5, height: 5 }), true));
t("unknown element type rejected (allow-list)", () => assert.strictEqual(hub.isValidElement({ id: "a", type: "evil-script" }), false));
t("embeddable is a known type (host-gate is separate)", () => assert.strictEqual(hub.isValidElement({ id: "a", type: "embeddable" }), true));
t("over-long text rejected", () => assert.strictEqual(hub.isValidElement({ id: "a", type: "text", text: "x".repeat(20001) }), false));

t("maxPayload is 256 KiB (not ws' 100 MiB default)", () => assert.strictEqual(hub.LIMITS.MAX_PAYLOAD, 262144));

// ---- persistence / finalization coordination (CR-BOARD-001..003) ------------
// Stub the Mongoose model so we can drive the async coordination WITHOUT a live
// DB. Board is a cached module, so this is the same object the hub uses.
const Board = require("../models/boardModel");
const origFOU = Board.findOneAndUpdate;
const origFBI = Board.findById;
const origFO = Board.findOne;
const leanOf = (v) => ({ lean: () => (typeof v === "function" ? v() : Promise.resolve(v)) });
const stubWrite = (fn) => { Board.findOneAndUpdate = () => leanOf(fn); };
Board.findById = () => ({ select: () => leanOf({ revision: 0 }) });
const fakeWs = () => ({ readyState: 1, OPEN: 1, bufferedAmount: 0, send() {}, close() {} });

const { rooms, endRoom, finalizeRoom, persistThrough, handleInRoom, journalFlush, replayJournals, unresolvedRecovery } = hub.__test;
const tick = () => new Promise((r) => setTimeout(r, 5));
const fakeRoom = (id, over = {}) => ({
  boardId: id, generation: 0, status: "ending", pageId: "p1",
  acceptedRevision: 0, persistedRevision: 0, journaledRevision: 0, boardRevision: 0,
  scene: { elements: new Map(), files: new Map() }, members: new Map(),
  dirty: false, persisting: false, persistTail: null, journalFlushing: false, lastPersistError: null,
  checkpointTimer: null, journalTimer: null, graceTimer: null, finalizeTimer: null, ...over,
});
const at = async (name, fn) => {
  try { await fn(); console.log("  ✓ " + name); pass += 1; }
  catch (e) { console.log("  ✗ " + name + " — " + (e && e.message)); fail += 1; }
};

(async () => {
  await jrnl.preflight(); // durable storage must be proven before any journal write

  console.log("\nboard-live hub — persistence coordination");

  await at("CR-BOARD-002/003: persistThrough reports FAILURE when writes never succeed", async () => {
    stubWrite(() => Promise.resolve(null)); // every write is a conflict
    const room = fakeRoom("bfail", { acceptedRevision: 3 });
    const ok = await persistThrough(room, 3);
    assert.strictEqual(ok, false);
    assert.ok(room.persistedRevision < 3);
  });

  await at("persistThrough resolves TRUE once persisted through the target", async () => {
    stubWrite(() => Promise.resolve({ revision: 1 }));
    const room = fakeRoom("bok", { acceptedRevision: 2 });
    const ok = await persistThrough(room, 2);
    assert.strictEqual(ok, true);
    assert.ok(room.persistedRevision >= 2);
  });

  await at("CR-BOARD-003: finalizeRoom does NOT delete a room whose scene is unsaved", async () => {
    stubWrite(() => Promise.resolve(null)); // fail forever
    const room = fakeRoom("bunsaved", { acceptedRevision: 2 });
    rooms.set("bunsaved", room);
    await finalizeRoom(room, room.generation, 0);
    assert.ok(rooms.has("bunsaved"), "unsaved room must be retained");
    clearTimeout(room.finalizeTimer);
    rooms.delete("bunsaved");
  });

  await at("finalizeRoom DELETES a room once fully saved", async () => {
    stubWrite(() => Promise.resolve({ revision: 1 }));
    const room = fakeRoom("bdone", { acceptedRevision: 1 });
    rooms.set("bdone", room);
    await finalizeRoom(room, room.generation, 0);
    assert.ok(!rooms.has("bdone"), "fully-saved room should be deleted");
  });

  await at("CR-BOARD-001: a resumed room is NOT deleted by its stale finalizer", async () => {
    // Pause the write so we can simulate a resume mid-finalize.
    let release;
    stubWrite(() => new Promise((res) => { release = () => res({ revision: 1 }); }));
    const room = fakeRoom("bresume", { acceptedRevision: 1, status: "ending" });
    rooms.set("bresume", room);
    const gen = room.generation;
    const p = finalizeRoom(room, gen, 0); // awaits the paused write
    await tick();
    // Host resumes during the in-flight finalizer:
    room.generation += 1;
    room.status = "ready";
    release();
    await p;
    assert.ok(rooms.has("bresume"), "resumed room must survive the stale finalizer");
    rooms.delete("bresume");
  });

  await at("CR-BOARD-004: end-live deletes the room; a late page op cannot resurrect or mutate it", async () => {
    stubWrite(() => Promise.resolve({ revision: 1 })); // checkpoints succeed
    const room = fakeRoom("brace", {
      status: "ready", liveSessionId: "S", pageEpoch: 0, acceptedRevision: 1, leaderSocketId: "L",
    });
    rooms.set("brace", room);
    const seat = {
      connId: "L", socketId: "L", isHost: true, canWrite: true, ws: fakeWs(),
      lastClientSeq: 0, authExpiresAt: Date.now() + 1e6, user: { _id: "u" }, pendingAcks: [], msgTimes: [], ptrTimes: [],
    };
    room.members.set("L", seat);
    await endRoom(room); // end-live finalizes + removes the room
    assert.ok(!rooms.has("brace"), "end-live removed the room");
    // A page op arriving after end-live is refused (page switching is disabled for
    // the one-page MVP) and can never touch the removed room's scene.
    const epochBefore = room.pageEpoch;
    await handleInRoom(room, seat, {
      v: 1, type: "page", liveSessionId: "S", pageEpoch: 0, clientSeq: 1, pageId: "p2", scene: { elements: [] },
    });
    assert.strictEqual(room.pageEpoch, epochBefore, "a late page op does not mutate the removed room");
    assert.ok(!rooms.has("brace"), "the room ended by end-live stays gone");
  });

  await at("closeAll: a transient checkpoint failure is retried until it saves", async () => {
    let n = 0;
    stubWrite(() => { n += 1; return Promise.resolve(n < 2 ? null : { revision: 1 }); });
    const room = fakeRoom("bclose", { status: "ready", acceptedRevision: 1 });
    rooms.set("bclose", room);
    await hub.closeAll();
    assert.ok(room.persistedRevision >= 1, "closeAll should retry and persist the room");
  });

  await at("closeAll: persistent failure honours the (test-only) budget, stays unsaved, and LOGS the warning", async () => {
    stubWrite(() => Promise.resolve(null)); // always fails
    const room = fakeRoom("bfail2", { status: "ready", acceptedRevision: 2 });
    rooms.set("bfail2", room);
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => errs.push(a.map(String).join(" "));
    const start = Date.now();
    await hub.closeAll(300); // test-only budget parameter — no env seam
    const elapsed = Date.now() - start;
    console.error = origErr;
    assert.ok(elapsed < 3000, `closeAll must honour the budget (took ${elapsed}ms)`);
    assert.ok(room.persistedRevision < room.acceptedRevision, "the room really was unsaved");
    assert.ok(errs.some((m) => /SHUTDOWN DATA-LOSS RISK/.test(m)), "the data-loss warning must be logged");
  });

  // ---- durable journal (recovery) -------------------------------------------
  console.log("\nboard-live hub — durable journal");

  await at("journal: write → list roundtrip (checksum verified)", async () => {
    const id = "aaaaaaaaaaaaaaaaaaaaaaaa";
    await jrnl.writeEntry({ boardId: id, pageId: "p1", liveSessionId: "S", acceptedRevision: 3, boardRevision: 1, scene: { elements: [{ id: "e", type: "rectangle" }], files: {} } });
    const list = await jrnl.listEntries();
    const e = list.find((x) => x.entry && x.entry.boardId === id);
    assert.ok(e && e.entry.acceptedRevision === 3, "entry listed with data intact");
    await jrnl.deleteEntry(id);
    assert.ok(!(await jrnl.listEntries()).some((x) => x.entry && x.entry.boardId === id), "deleted entry gone");
  });

  await at("journal: a corrupted file is quarantined, never applied", async () => {
    const fs = require("fs");
    const id = "bbbbbbbbbbbbbbbbbbbbbbbb";
    await jrnl.writeEntry({ boardId: id, pageId: "p1", liveSessionId: "S", acceptedRevision: 1, boardRevision: 0, scene: { elements: [], files: {} } });
    fs.writeFileSync(jrnl.fileFor(id), '{"v":1,"sha256":"deadbeef","payload":"{}"}'); // wrong checksum
    const list = await jrnl.listEntries();
    assert.ok(!list.some((x) => x.entry && x.entry.boardId === id), "corrupt entry not applied as valid");
    assert.ok(list.some((x) => x.corrupt && x.boardId === id), "corrupt entry surfaced as a corrupt marker (never silently dropped)");
    assert.ok(fs.existsSync(jrnl.fileFor(id) + ".corrupt"), "corrupt file quarantined");
    fs.unlinkSync(jrnl.fileFor(id) + ".corrupt");
  });

  await at("scene-update ack is DEFERRED until the change is durably journaled", async () => {
    const room = fakeRoom("cccccccccccccccccccccccc", { status: "ready", liveSessionId: "S", pageEpoch: 0, pageId: "p1", leaderSocketId: "H" });
    rooms.set(room.boardId, room);
    const sent = [];
    const seat = {
      connId: "H", socketId: "H", isHost: true, canWrite: true, lastClientSeq: 0, authExpiresAt: Date.now() + 1e6,
      user: { _id: "u" }, pendingAcks: [], msgTimes: [], ptrTimes: [],
      ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close() {} },
    };
    room.members.set("H", seat);
    await handleInRoom(room, seat, {
      v: 1, type: "scene-update", liveSessionId: "S", pageEpoch: 0, clientSeq: 1,
      elements: [{ id: "e1", type: "rectangle", version: 1, versionNonce: 5, x: 1, y: 1, width: 2, height: 2 }],
    });
    assert.ok(!sent.some((m) => m.type === "ack"), "ack must be deferred until journaled");
    assert.strictEqual(seat.pendingAcks.length, 1);
    await journalFlush(room);
    assert.ok(sent.some((m) => m.type === "ack" && m.durable === true), "durable ack sent after journal flush");
    assert.strictEqual(seat.pendingAcks.length, 0);
    clearTimeout(room.journalTimer);
    clearTimeout(room.checkpointTimer);
    rooms.delete(room.boardId);
    await jrnl.deleteEntry(room.boardId);
  });

  await at("replayJournals applies a journal Mongo hasn't advanced past, then deletes it", async () => {
    const id = "dddddddddddddddddddddddd";
    await jrnl.writeEntry({ boardId: id, pageId: "p1", liveSessionId: "S", acceptedRevision: 2, boardRevision: 0, scene: { elements: [{ id: "x", type: "rectangle" }], files: {} } });
    let applied = null;
    Board.findOne = () => ({ select: () => ({ lean: async () => ({ revision: 0, pages: [{ _id: "p1" }] }) }) });
    Board.findOneAndUpdate = (q, u) => ({ lean: async () => { applied = u; return { revision: 1 }; } });
    await replayJournals();
    Board.findOne = origFO;
    Board.findOneAndUpdate = origFOU;
    assert.ok(applied && applied.$inc && applied.$inc.revision === 1, "replay CAS-writes + bumps revision");
    assert.ok(!(await jrnl.listEntries()).some((x) => x.entry && x.entry.boardId === id), "journal deleted after Mongo proved it");
  });

  // ---- CR-BOARD-005 durability hardening ------------------------------------
  console.log("\nboard-live hub — CR-BOARD-005");

  await at("overlapping flushes: a revision that lands mid-write is still journaled + acked", async () => {
    const room = fakeRoom("eeeeeeeeeeeeeeeeeeeeeeee", { status: "ready", pageId: "p1", acceptedRevision: 1, journaledRevision: 0 });
    const sent = [];
    const seat = { pendingAcks: [{ clientSeq: 1, revision: 1 }, { clientSeq: 2, revision: 2 }], ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close() {} } };
    room.members.set("s", seat);
    const p1 = journalFlush(room); // begins writing rev 1
    room.acceptedRevision = 2; // rev 2 arrives mid-flight
    const p2 = journalFlush(room); // must JOIN the active flush, not early-return
    await Promise.all([p1, p2]);
    assert.strictEqual(room.journaledRevision, 2, "journal caught up to the latest revision");
    assert.ok(sent.filter((m) => m.type === "ack" && m.durable).length === 2, "both deferred acks released as durable");
    await jrnl.deleteEntry(room.boardId);
  });

  await at("a stale delete for an OLD journalId cannot remove a NEWER journal", async () => {
    const id = "ffffffffffffffffffffffff";
    const w1 = await jrnl.writeEntry({ boardId: id, pageId: "p1", liveSessionId: "S", acceptedRevision: 1, boardRevision: 0, scene: { elements: [], files: {} } });
    await jrnl.writeEntry({ boardId: id, pageId: "p1", liveSessionId: "S", acceptedRevision: 2, boardRevision: 0, scene: { elements: [{ id: "n", type: "rectangle" }], files: {} } });
    const removed = await jrnl.deleteEntry(id, w1.journalId); // stale delete of the old id
    assert.strictEqual(removed, false, "stale delete is a no-op");
    const cur = await jrnl.readEntry(id);
    assert.ok(cur && cur.acceptedRevision === 2, "the newer journal survives");
    await jrnl.deleteEntry(id, cur.journalId);
  });

  await at("replay CAS-miss it cannot prove → RETAINS journal + locks the board", async () => {
    const id = "111111111111111111111111";
    await jrnl.writeEntry({ boardId: id, pageId: "p1", liveSessionId: "S", acceptedRevision: 2, boardRevision: 3, scene: { elements: [{ id: "z", type: "rectangle" }], files: {} } });
    unresolvedRecovery.delete(id);
    // Mongo advanced past the base (revision 9) with a DIFFERENT marker → cannot prove.
    Board.findOne = () => ({ select: () => ({ lean: async () => ({ revision: 9, pages: [{ _id: "p1" }], lastLiveJournalId: "some-other-id" }) }) });
    Board.findOneAndUpdate = () => ({ lean: async () => null }); // CAS never matches
    await replayJournals();
    Board.findOne = origFO;
    Board.findOneAndUpdate = origFOU;
    assert.ok(unresolvedRecovery.has(id), "board locked as unresolved");
    assert.ok((await jrnl.readEntry(id)) !== null, "journal retained (not deleted unproven)");
    unresolvedRecovery.delete(id);
    await jrnl.deleteEntry(id, (await jrnl.readEntry(id)).journalId);
  });

  await at("replay deletes when the marker PROVES this journal was already applied", async () => {
    const id = "222222222222222222222222";
    const w = await jrnl.writeEntry({ boardId: id, pageId: "p1", liveSessionId: "S", acceptedRevision: 2, boardRevision: 5, scene: { elements: [], files: {} } });
    unresolvedRecovery.delete(id);
    Board.findOne = () => ({ select: () => ({ lean: async () => ({ revision: 6, pages: [{ _id: "p1" }], lastLiveJournalId: w.journalId }) }) });
    await replayJournals();
    Board.findOne = origFO;
    assert.ok(!unresolvedRecovery.has(id), "not locked");
    assert.strictEqual(await jrnl.readEntry(id), null, "journal deleted (marker proved it persisted)");
  });

  await at("storage failing → edit is NOT acked (durability contract held)", async () => {
    const room = fakeRoom("333333333333333333333333", { status: "ready", pageId: "p1", acceptedRevision: 1, journaledRevision: 0 });
    const sent = [];
    const seat = { pendingAcks: [{ clientSeq: 1, revision: 1 }], ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close() {} } };
    room.members.set("s", seat);
    // Force a write failure: an oversized scene fails journal validation.
    room.scene.elements = new Map(Array.from({ length: 7000 }, (_v, i) => [String(i), { id: String(i), type: "rectangle" }]));
    await journalFlush(room);
    assert.ok(room.journalUnhealthy === true, "room flagged unhealthy");
    assert.ok(!sent.some((m) => m.type === "ack"), "NO ack sent when the change is not durable");
    assert.strictEqual(seat.pendingAcks.length, 1, "ack stays pending");
    clearTimeout(room.journalTimer);
  });

  // ---- CR-BOARD-010 connection lifecycle ------------------------------------
  // A transient disconnect must NEVER end the room; only an explicit end-live does.
  console.log("\nboard-live hub — CR-BOARD-010 lifecycle");

  const { dropSeat } = hub.__test;
  const capSeat = (connId, isHost, sent) => ({
    connId, socketId: connId, isHost, canWrite: isHost, authTimer: null, authExpiresAt: Date.now() + 1e6,
    user: { _id: "u" + connId }, ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close() {} },
  });

  await at("a host disconnect does NOT end the room — it awaits the host; viewers stay connected", async () => {
    const room = fakeRoom("a1a1a1a1a1a1a1a1a1a1a1a1", { status: "ready", liveSessionId: "S", leaderSocketId: "H" });
    rooms.set(room.boardId, room);
    const vSent = [];
    const host = capSeat("H", true, []);
    const viewer = capSeat("V", false, vSent);
    room.members.set("H", host);
    room.members.set("V", viewer);
    dropSeat(room, host, "network");
    assert.strictEqual(room.status, "awaiting-host", "room awaits the host (not ended)");
    assert.ok(rooms.has(room.boardId), "room retained");
    assert.ok(room.members.has("V"), "viewer stays connected");
    assert.ok(!room.graceTimer, "NO destructive grace timer is armed");
    assert.ok(vSent.some((m) => m.type === "host-away"), "viewer told the host is away");
    clearTimeout(room.reapTimer);
    clearTimeout(room.checkpointTimer);
    rooms.delete(room.boardId);
  });

  await at("an idle auth-lease lapse closes RECONNECTABLE (4001), not terminal — so it resumes", async () => {
    const room = fakeRoom("d4d4d4d4d4d4d4d4d4d4d4d4", { status: "ready", liveSessionId: "S", leaderSocketId: "H" });
    rooms.set(room.boardId, room);
    let closedCode = null;
    const seat = {
      connId: "H", socketId: "H", isHost: true, canWrite: true, authTimer: null, authExpiresAt: Date.now() + 1e6,
      user: { _id: "u" }, ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send() {}, close: (c) => { closedCode = c; } },
    };
    room.members.set("H", seat);
    dropSeat(room, seat, "auth_expired");
    assert.strictEqual(closedCode, 4001, "lease lapse uses 4001 (client reconnects + re-verifies) — not terminal 1008");
    clearTimeout(room.reapTimer);
    clearTimeout(room.capTimer);
    rooms.delete(room.boardId);
  });

  await at("the LAST member leaving keeps the room (idle reaper scheduled), never instant-ends", async () => {
    stubWrite(() => Promise.resolve({ revision: 1 }));
    const room = fakeRoom("b2b2b2b2b2b2b2b2b2b2b2b2", { status: "awaiting-host", liveSessionId: "S" });
    rooms.set(room.boardId, room);
    const viewer = capSeat("V", false, []);
    room.members.set("V", viewer);
    dropSeat(room, viewer, "network");
    assert.ok(rooms.has(room.boardId), "empty room retained (host can still reconnect)");
    assert.strictEqual(room.status, "awaiting-host");
    assert.ok(room.reapTimer, "a long idle reaper is scheduled (not a 20s grace)");
    clearTimeout(room.reapTimer);
    clearTimeout(room.checkpointTimer);
    rooms.delete(room.boardId);
  });

  await at("reapEmptyRoom EVICTS a still-empty room from memory only; a reconnect cancels it", async () => {
    stubWrite(() => Promise.resolve({ revision: 1 }));
    const room = fakeRoom("c3c3c3c3c3c3c3c3c3c3c3c3", { status: "awaiting-host", liveSessionId: "S", acceptedRevision: 0 });
    rooms.set(room.boardId, room);
    // A member reconnected before the reaper fired:
    room.members.set("H", capSeat("H", true, []));
    await hub.__test.reapEmptyRoom(room);
    assert.ok(rooms.has(room.boardId), "reaper is a no-op while a member is present");
    room.members.clear();
    await hub.__test.reapEmptyRoom(room);
    assert.ok(!rooms.has(room.boardId), "a still-empty room is evicted from memory");
    assert.notStrictEqual(room.status, "ending", "eviction is memory-only — the session is NOT logically ended");
  });

  // ---- CR-BOARD-009 authoritative save-state EMISSION -----------------------
  // Not just saveStateOf() math: prove the CLIENT actually RECEIVES the transition.
  console.log("\nboard-live hub — CR-BOARD-009");

  const saveSeat = (sent) => ({
    connId: "H", socketId: "H", isHost: true, canWrite: true, lastClientSeq: 0, authExpiresAt: Date.now() + 1e6,
    user: { _id: "u" }, pendingAcks: [], msgTimes: [], ptrTimes: [],
    ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close() {} },
  });
  const rectMsg = (clientSeq) => ({
    v: 1, type: "scene-update", liveSessionId: "S", pageEpoch: 0, clientSeq,
    elements: [{ id: "e" + clientSeq, type: "rectangle", version: 1, versionNonce: 5, x: 1, y: 1, width: 2, height: 2 }],
  });

  await at("an accepted edit EMITS 'saving' immediately; 'saved' only AFTER the write completes", async () => {
    let release;
    stubWrite(() => new Promise((res) => { release = () => res({ revision: 1 }); })); // pause the write
    const sent = [];
    const room = fakeRoom("999999999999999999999999", { status: "ready", liveSessionId: "S", pageEpoch: 0, pageId: "p1", leaderSocketId: "H" });
    rooms.set(room.boardId, room);
    const seat = saveSeat(sent);
    room.members.set("H", seat);
    const states = () => sent.filter((m) => m.type === "save-state").map((m) => m.state);

    await handleInRoom(room, seat, rectMsg(1));
    assert.ok(states().includes("saving"), "client IMMEDIATELY receives 'saving' on accept");
    assert.ok(!states().includes("saved"), "no premature 'saved' before the write");

    clearTimeout(room.checkpointTimer); // drive persistence now instead of the ~1.5s debounce
    const p = persistThrough(room, 1); // begins the paused write
    await tick();
    assert.ok(!states().includes("saved"), "a DELAYED database write must NOT emit 'saved'");
    release();
    await p;
    assert.strictEqual(states()[states().length - 1], "saved", "successful write emits 'saved' last");

    clearTimeout(room.journalTimer);
    rooms.delete(room.boardId);
    await jrnl.deleteEntry(room.boardId);
  });

  await at("a FAILED write emits 'failed' after 'saving' — never a false 'saved'", async () => {
    stubWrite(() => Promise.resolve(null)); // conflict forever
    const sent = [];
    const room = fakeRoom("888888888888888888888888", { status: "ready", liveSessionId: "S", pageEpoch: 0, pageId: "p1", leaderSocketId: "H" });
    rooms.set(room.boardId, room);
    const seat = saveSeat(sent);
    room.members.set("H", seat);
    const states = () => sent.filter((m) => m.type === "save-state").map((m) => m.state);

    await handleInRoom(room, seat, rectMsg(1));
    clearTimeout(room.checkpointTimer);
    await persistThrough(room, 1).catch(() => {});
    assert.ok(states().includes("saving"), "'saving' emitted on accept");
    assert.strictEqual(states()[states().length - 1], "failed", "failed write emits 'failed'");
    assert.ok(!states().includes("saved"), "never a false 'saved' on a failed write");

    clearTimeout(room.checkpointTimer);
    clearTimeout(room.journalTimer);
    rooms.delete(room.boardId);
    await jrnl.deleteEntry(room.boardId);
  });

  // ---- CR-BOARD-006 fail-closed recovery ------------------------------------
  console.log("\nboard-live hub — CR-BOARD-006");

  await at("a corrupt journal LOCKS the board and is never silently applied", async () => {
    const fs = require("fs");
    const id = "444444444444444444444444";
    await jrnl.writeEntry({ boardId: id, pageId: "p1", liveSessionId: "S", acceptedRevision: 1, boardRevision: 0, scene: { elements: [], files: {} } });
    fs.writeFileSync(jrnl.fileFor(id), '{"v":1,"sha256":"deadbeef","payload":"{}"}'); // checksum no longer matches
    unresolvedRecovery.delete(id);
    let wrote = false;
    Board.findOne = () => ({ select: () => ({ lean: async () => null }) }); // any stray valid journal → board-gone, harmless
    Board.findOneAndUpdate = () => ({ lean: async () => { wrote = true; return { revision: 1 }; } });
    await replayJournals();
    Board.findOne = origFO;
    Board.findOneAndUpdate = origFOU;
    assert.ok(unresolvedRecovery.has(id), "corrupt journal locks the board (start/join refused)");
    assert.ok(!wrote, "no scene was applied out of a corrupt journal");
    unresolvedRecovery.delete(id);
    if (fs.existsSync(jrnl.fileFor(id) + ".corrupt")) fs.unlinkSync(jrnl.fileFor(id) + ".corrupt");
  });

  await at("a directory-enumeration failure makes recovery THROW (hub stays not-ready)", async () => {
    const fsmod = require("fs");
    const origReaddir = fsmod.promises.readdir;
    fsmod.promises.readdir = () => Promise.reject(Object.assign(new Error("io"), { code: "EIO" }));
    let threw = false;
    try { await replayJournals(); } catch { threw = true; }
    fsmod.promises.readdir = origReaddir;
    assert.ok(threw, "replayJournals rejects when journals cannot be enumerated → replayDone stays false");
  });

  await at("a live page op is REFUSED so no mutation can bypass the WAL", async () => {
    const room = fakeRoom("555555555555555555555555", { status: "ready", liveSessionId: "S", pageEpoch: 0, pageId: "p1", acceptedRevision: 1, leaderSocketId: "L" });
    rooms.set(room.boardId, room);
    const sent = [];
    const seat = {
      connId: "L", socketId: "L", isHost: true, canWrite: true, lastClientSeq: 0, authExpiresAt: Date.now() + 1e6,
      user: { _id: "u" }, pendingAcks: [], msgTimes: [], ptrTimes: [],
      ws: { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close() {} },
    };
    room.members.set("L", seat);
    const epochBefore = room.pageEpoch;
    await handleInRoom(room, seat, {
      v: 1, type: "page", liveSessionId: "S", pageEpoch: 0, clientSeq: 1, pageId: "p2",
      scene: { elements: [{ id: "x", type: "rectangle", version: 1, versionNonce: 1, x: 1, y: 1, width: 2, height: 2 }] },
    });
    assert.strictEqual(room.pageEpoch, epochBefore, "page op did not advance the epoch");
    assert.strictEqual(room.scene.elements.size, 0, "page op did not mutate the scene (no WAL bypass)");
    assert.ok(sent.some((m) => m.type === "page-blocked" && m.reason === "not-supported"), "leader told page switching is unsupported");
    rooms.delete(room.boardId);
  });

  Board.findOneAndUpdate = origFOU;
  Board.findById = origFBI;
  Board.findOne = origFO;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
