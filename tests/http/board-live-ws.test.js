/*
 * CR-BOARD-010 — REAL WebSocket + real Mongo integration test. Exercises the actual
 * `ws` transport (upgrade, framing, first-message auth) end-to-end against the hub
 * attached to a real http server, over localhost sockets — not fake sockets.
 *
 * Covered: host start-live over a real socket; a drawn element reaches a viewer that
 * joins later; a live scene-update propagates to the viewer; and after the in-memory
 * room is evicted (simulating the 2h reaper / a backend restart), a viewer RECONNECTS
 * and rehydrates the SAME durable session id + the exact saved scene.
 *
 * NOT covered here (honest gap): the 3-browser Playwright matrix and a real
 * process-level redeploy — those need real browsers / a second process and cannot run
 * in this environment.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-board-ws";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-board-ws";
process.env.LIVE_JOURNAL_DIR = require("path").join(require("os").tmpdir(), "exq-board-ws-journal-" + process.pid);

const http = require("http");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const Class = require("../../models/classModel");
const Enrollment = require("../../models/enrollmentModel");
const Board = require("../../models/boardModel");
const { generateToken } = require("../../utils");
const hub = require("../../realtime/boardHub");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny real-ws client that buffers messages and lets tests await them by type
// (each awaited message is consumed once).
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/board`);
  const buf = [];
  const waiters = [];
  ws.on("message", (d) => {
    let m;
    try { m = JSON.parse(d.toString()); } catch { return; }
    const wi = waiters.findIndex((w) => w.type === m.type);
    if (wi >= 0) { const [w] = waiters.splice(wi, 1); w.resolve(m); }
    else buf.push(m);
  });
  let seq = 0;
  const api = {
    ws,
    open: () => new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); }),
    send: (obj) => ws.send(JSON.stringify(obj)),
    nextSeq: () => (seq += 1),
    waitFor: (type, ms = 4000) => {
      const i = buf.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(buf.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { type, resolve };
        waiters.push(w);
        setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); reject(new Error("timeout: " + type)); } }, ms);
      });
    },
    close: () => { try { ws.close(); } catch { /* noop */ } },
  };
  return api;
}

async function waitElementInDb(boardId, elId, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const b = await Board.findById(boardId).lean();
    const els = (b && b.pages && b.pages[0] && b.pages[0].scene && b.pages[0].scene.elements) || [];
    if (els.some((e) => e.id === elId)) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const owner = await User.create({ name: "Owner", email: "o@ws.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true });
  const student = await User.create({ name: "Stu", email: "s@ws.com", password: "xxxxxxxx", role: "student", isVerified: true });
  const cls = await Class.create({ name: "C", owner: owner._id, joinCode: "WSJOIN" });
  await Enrollment.create({ student: student._id, class: cls._id, teacher: owner._id, status: "approved" });
  const board = await Board.create({ owner: owner._id, ownerName: owner.name, title: "WS", classes: [], pages: [{ name: "Səhifə 1", scene: null }] });
  const tok = (u) => generateToken(u._id, u.sessionVersion);
  const bid = String(board._id);

  const server = http.createServer((req, res) => res.end("ok"));
  hub.attach(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  for (let i = 0; i < 60 && !hub.__test.isReady(); i += 1) await sleep(50); // wait for boot recovery
  ok("hub reports ready (boot recovery complete)", hub.__test.isReady());

  console.log("board-live REAL ws — session over the wire");

  // Host starts live over a real socket.
  const host = client(port);
  await host.open();
  host.send({ v: 1, type: "start-live", requestId: "r1", boardId: bid, token: tok(owner) });
  const started = await host.waitFor("live-started");
  ok("host receives live-started over a real socket", !!started && !!started.liveSessionId);
  const liveId = started.liveSessionId;
  const env = () => ({ liveSessionId: liveId, pageId: started.pageId, pageEpoch: started.pageEpoch });

  // Host draws an element BEFORE the viewer joins.
  host.send({ v: 1, type: "scene-update", ...env(), clientSeq: host.nextSeq(), elements: [{ id: "c1", type: "rectangle", version: 1, versionNonce: 2, x: 1, y: 1, width: 5, height: 5 }] });
  await host.waitFor("save-state"); // accepted (server processed it)

  // Viewer joins later — must receive the already-drawn element in the snapshot.
  const viewer = client(port);
  await viewer.open();
  viewer.send({ v: 1, type: "join", requestId: "r2", boardId: bid, token: tok(student) });
  const joined = await viewer.waitFor("joined");
  ok("a late viewer receives the already-drawn element in the join snapshot", joined.scene.elements.some((e) => e.id === "c1"));

  // A subsequent live edit propagates to the viewer.
  host.send({ v: 1, type: "scene-update", ...env(), clientSeq: host.nextSeq(), elements: [{ id: "c2", type: "ellipse", version: 1, versionNonce: 3, x: 9, y: 9, width: 7, height: 7 }] });
  const relayed = await viewer.waitFor("scene-update");
  ok("a live scene-update propagates to the viewer over the wire", relayed.elements.some((e) => e.id === "c2"));

  // Make it durable, then simulate eviction/restart (drop the in-memory room).
  ok("scene is checkpointed to Mongo", await waitElementInDb(bid, "c2"));
  host.close();
  viewer.close();
  await sleep(150);
  hub.__test.rooms.clear(); // simulate the 2h reaper / a backend restart losing memory
  const db = await Board.findById(bid).lean();
  ok("durable session stays active after eviction", db.liveSession && db.liveSession.active === true && db.liveSession.id === liveId);

  // A viewer RECONNECTS and rehydrates the SAME session + exact scene.
  const back = client(port);
  await back.open();
  back.send({ v: 1, type: "join", requestId: "r3", boardId: bid, token: tok(student) });
  const rejoined = await back.waitFor("joined");
  ok("viewer reconnect rehydrates the SAME session id", rejoined.liveSessionId === liveId);
  ok("rehydrated snapshot has BOTH drawn elements (exact scene)", ["c1", "c2"].every((id) => rejoined.scene.elements.some((e) => e.id === id)));
  back.close();

  await hub.closeAll();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
