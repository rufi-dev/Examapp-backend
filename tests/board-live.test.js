// Live whiteboard hub — pure-logic regression guards. The reconciliation winner
// and the epoch/session rejection are the parts most likely to silently break;
// CR-WB-002 specifically requires the LOWER versionNonce to win on a version tie
// (matching Excalidraw's reconcileElements) — a wrong direction makes elements
// oscillate or vanish.
const assert = require("assert");
const hub = require("../realtime/boardHub");

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

const { rooms, endRoom, finalizeRoom, persistThrough, handleInRoom } = hub.__test;
const tick = () => new Promise((r) => setTimeout(r, 5));
const fakeRoom = (id, over = {}) => ({
  boardId: id, generation: 0, status: "ending", pageId: "p1",
  acceptedRevision: 0, persistedRevision: 0, boardRevision: 0,
  scene: { elements: new Map(), files: new Map() }, members: new Map(),
  dirty: false, persisting: false, persistTail: null, lastPersistError: null,
  checkpointTimer: null, graceTimer: null, finalizeTimer: null, ...over,
});
const at = async (name, fn) => {
  try { await fn(); console.log("  ✓ " + name); pass += 1; }
  catch (e) { console.log("  ✗ " + name + " — " + (e && e.message)); fail += 1; }
};

(async () => {
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

  await at("CR-BOARD-004: a page request that resumes after end-live does not mutate the dead room", async () => {
    stubWrite(() => Promise.resolve({ revision: 1 })); // checkpoints succeed
    const room = fakeRoom("brace", {
      status: "ready", liveSessionId: "S", pageEpoch: 0, acceptedRevision: 1, leaderSocketId: "L",
    });
    rooms.set("brace", room);
    // Simulate end-live finalizing + deleting the room WHILE the page handler
    // awaits this board read (concurrent WS messages).
    Board.findOne = () => ({
      select: () => ({
        lean: async () => {
          await endRoom(room);
          return { pages: [{ _id: "p1" }, { _id: "p2" }] };
        },
      }),
    });
    const seat = {
      connId: "L", socketId: "L", isHost: true, canWrite: true, ws: fakeWs(),
      lastClientSeq: 0, authExpiresAt: Date.now() + 1e6, user: { _id: "u" },
    };
    const epochBefore = room.pageEpoch;
    await handleInRoom(room, seat, {
      v: 1, type: "page", liveSessionId: "S", pageEpoch: 0, clientSeq: 1, pageId: "p2", scene: { elements: [] },
    });
    Board.findOne = origFO;
    assert.strictEqual(room.pageEpoch, epochBefore, "page must NOT mutate a room that ended during its await");
    assert.ok(!rooms.has("brace"), "the room ended by end-live must stay gone");
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

  Board.findOneAndUpdate = origFOU;
  Board.findById = origFBI;
  Board.findOne = origFO;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
