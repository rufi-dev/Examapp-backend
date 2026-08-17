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

t("maxPayload is 256 KiB (not ws' 100 MiB default)", () => assert.strictEqual(hub.LIMITS.MAX_PAYLOAD, 262144));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
