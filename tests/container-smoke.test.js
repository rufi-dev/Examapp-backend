/*
 * CR-113/CR-115 — prove the container smoke gate is NOT a false positive AND that the
 * application lifecycle is genuinely graceful. Every fault is DETECTED and every
 * assertion prints the captured server logs on failure. Boots use RUN-OWNED free ports.
 *   POSITIVE:  two SEQUENTIAL full smokes on independent ports/dirs both pass.
 *   NEG:       wrong health path, worker flag off, server never listens, migration
 *              apply/verify != 0, non-throwaway refusal, shutdown timeout.
 *   POSIX:     real SIGTERM → one worker stop, HTTP listener CLOSES, exit 0 in deadline,
 *              no leftover child, a SECOND signal does not double-clean.
 *   Any OS:    partial startup (unprepared DB) cleans up and NEVER listens.
 */
process.env.NODE_ENV = "production";
const path = require("path");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const smoke = require("../scripts/containerSmoke.cjs");

let passed = 0, failed = 0;
const ok = (n, c, logs) => {
  if (c) { passed++; console.log("  ✓", n); }
  else { failed++; console.log("  ✗ FAIL:", n); if (logs && logs.text) console.log("      ── server logs ──\n" + logs.text.split("\n").map((l) => "      " + l).join("\n")); }
};
const SMOKE = path.join(__dirname, "..", "scripts", "containerSmoke.cjs");
const kill = (c) => { try { c.kill("SIGKILL"); } catch (_) {} };
const dbUri = (base, name) => base.replace(/\/?$/, "/") + name;

// Run a subprocess ASYNChronously (NOT spawnSync). Critical here: this test process
// HOSTS the in-memory Mongo, and mongodb-memory-server pipes mongod's stdout to us.
// spawnSync would BLOCK our event loop, stop draining that pipe, fill mongod's log
// buffer and FREEZE mongod — hanging every query the spawned smoke makes. Async spawn
// keeps our loop alive so mongod never blocks. (In the real container/CI mongod is a
// separate service, so this is purely a local-harness concern.)
function runAsync(file, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", done = false;
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => { if (!done) { done = true; kill(c); resolve({ status: null, stdout, stderr, timedOut: true }); } }, timeoutMs);
    c.on("exit", (code) => { if (!done) { done = true; clearTimeout(t); resolve({ status: code, stdout, stderr, timedOut: false }); } });
  });
}

async function main() {
  const mem = await MongoMemoryServer.create();
  const base = mem.getUri().replace(/\/[^/]*$/, ""); // strip any default db
  const uri = dbUri(base, "smoke_test"); // throwaway NAME (prepared by the smoke)

  const POSIX = process.platform !== "win32";

  // ── POSITIVE ×2: two SEQUENTIAL full smokes. Each subprocess allocates its OWN free
  //    port + its OWN run-owned temp dirs, so both passing proves no fixed-port/dir
  //    collision under sequential load (the 7/8-under-load defect). ──
  const runOwned = [];
  let lastOut = "";
  for (const i of [1, 2]) {
    const pos = await runAsync(SMOKE, [], { SMOKE_MONGO_URI: uri }, 180000);
    const out = `${pos.stdout || ""}${pos.stderr || ""}`;
    lastOut = out;
    ok(`POSITIVE #${i}: full smoke passes (exit 0, 'SMOKE OK') on a run-owned port/dir`, pos.status === 0 && /SMOKE OK/.test(out), { text: out });
    const m = out.match(/run-owned: port=(\d+) pdfDir=(\S+)/);
    if (m) runOwned.push({ port: Number(m[1]), dir: m[2] });
  }
  // Each smoke process independently binds an OS-assigned port and its OWN mkdtemp
  // dirs; both passing above proves no fixed-port/dir collision under sequential load.
  // The run-owned PDF dirs are unique per process, so they must DIFFER (the OS may
  // legitimately re-assign the same freed port, so ports are not required to differ).
  ok("POSITIVE: both sequential smokes used independent run-owned resources (distinct PDF dirs, each bound a port)",
    runOwned.length === 2 && runOwned[0].dir !== runOwned[1].dir && runOwned[0].port > 0 && runOwned[1].port > 0);
  ok("POSITIVE: the smoke exercised engines + refusal + migration-faithful prep + /healthz + worker start",
    /satisfies engines/.test(lastOut) && /EXACT exit 3/.test(lastOut) && /migration-faithful preparation/.test(lastOut) && /healthz returns EXACTLY 200/.test(lastOut) && /worker started EXACTLY once/.test(lastOut), { text: lastOut });

  // ── NEGATIVE 1: a WRONG health path is never healthy (on a run-owned port). ──
  {
    const port = await smoke.freePort();
    const { child, logs } = smoke.bootServer(uri, port);
    const good = await smoke.waitHealthy(port, "/healthz", 80);
    const bad = await smoke.probe(port, "/nope");
    ok("NEG wrong-path: /healthz is healthy but /nope is NOT (404 ≠ health)", good.ok === true && bad.ok === false && bad.status === 404, logs);
    ok("NEG worker: SESSION_MODEL_ENABLED=true logged exactly one worker start", (logs.text.match(/outbox worker started/g) || []).length === 1, logs);
    kill(child); await smoke.waitExit(child, 8000);
  }

  // ── NEGATIVE 2: worker FLAG OFF → no worker start. ──
  {
    const port = await smoke.freePort();
    const { child, logs } = smoke.bootServer(uri, port, { SESSION_MODEL_ENABLED: "false" });
    await smoke.waitHealthy(port, "/healthz", 80);
    ok("NEG flag-off: with SESSION_MODEL_ENABLED=false NO worker start is logged", (logs.text.match(/outbox worker started/g) || []).length === 0, logs);
    kill(child); await smoke.waitExit(child, 8000);
  }

  // ── NEGATIVE 3: server NEVER LISTENS (unreachable DB) → /healthz never healthy. ──
  {
    const port = await smoke.freePort();
    const { child } = smoke.bootServer("mongodb://10.255.255.1:27017/smoke_test", port);
    const h = await smoke.waitHealthy(port, "/healthz", 6); // ~3s
    ok("NEG no-listen: an unreachable DB means /healthz never becomes healthy", h.ok === false);
    kill(child);
  }

  // ── NEGATIVE 4a: a migration --verify != exact 0 fails the check. ──
  {
    await mongoose.connect(uri);
    await mongoose.connection.db.collection("exams").insertOne({ name: "paid", price: 7 }); // price!=0 → verify blocks
    await mongoose.disconnect();
    const verify = await runAsync(smoke.PRICE_MIG, ["--verify"], { MONGO_URI: uri, EMAIL_ENABLED: "false" }, 30000);
    ok("NEG verify!=0: a failing migration --verify returns exit 1 (rejected by the EXACT-0 check)", verify.status === 1);
    await mongoose.connect(uri);
    await mongoose.connection.db.collection("exams").deleteMany({ name: "paid" });
    await mongoose.disconnect();
  }

  // ── NEGATIVE 4b: the attempt/result index migration --verify on an UNPREPARED db
  //    fails (exit 1), so prepareSmokeDb's exact-0 gate would reject it. ──
  {
    const unprepared = dbUri(base, "smoke_unprepared_test");
    const v = await runAsync(path.join(__dirname, "..", "migrations", "2026-07-27-attempt-result-indexes.js"), ["--verify", "--db=smoke_unprepared_test"], { MONGO_URI: unprepared, EMAIL_ENABLED: "false" }, 30000);
    ok("NEG index-verify: --verify on an unprepared db returns exit 1 (missing shapes)", v.status === 1, { text: `${v.stdout}${v.stderr}` });
  }

  // ── NEGATIVE 5: a non-throwaway URI refuses (exit 3) before connecting. ──
  {
    const r = await runAsync(smoke.PRICE_MIG, ["--dry-run"], { MONGO_URI: "mongodb://10.255.255.1:27017/examopia_live", EMAIL_ENABLED: "false" }, 15000);
    ok("NEG non-throwaway: refused with EXACT exit 3 before connecting", r.status === 3 && /Refusing/i.test(`${r.stdout}${r.stderr}`));
  }

  // ── ANY OS — PARTIAL STARTUP: an UNPREPARED db fails the boot invariant; the server
  //    must clean up (disconnect) and NEVER listen, then exit non-zero. ──
  {
    const port = await smoke.freePort();
    const { child, logs } = smoke.bootServer(dbUri(base, "smoke_unprepared_test"), port);
    const h = await smoke.waitHealthy(port, "/healthz", 8); // ~4s: it must NEVER become healthy
    const ex = await smoke.waitExit(child, 15000);
    ok("PARTIAL-START: an unprepared db NEVER opens /healthz", h.ok === false, logs);
    ok("PARTIAL-START: the boot invariant refuses and the process EXITS non-zero (no hang)", ex.timedOut === false && ex.code !== 0, logs);
    ok("PARTIAL-START: it took the lifecycle cleanup path (not a bare exit)", /invariant verification FAILED/.test(logs.text) && /shutting down \(startup-invariant-failed\)/.test(logs.text), logs);
    kill(child);
  }

  // ── POSIX — GENUINE GRACEFUL SHUTDOWN of the real server. ──
  if (POSIX) {
    const port = await smoke.freePort();
    const { child, logs } = smoke.bootServer(uri, port);
    const health = await smoke.waitHealthy(port, "/healthz", 80);
    ok("SHUTDOWN pre: /healthz is healthy before SIGTERM", health.ok === true, logs);
    child.kill("SIGTERM");
    child.kill("SIGTERM"); // a SECOND signal must NOT double-clean
    const ex = await smoke.waitExit(child, 15000);
    ok("SHUTDOWN: outbox worker stopped EXACTLY once (no double-clean on the 2nd signal)", (logs.text.match(/outbox worker stopped/g) || []).length === 1, logs);
    ok("SHUTDOWN: the HTTP listener CLOSED (lifecycle log)", /HTTP server closed/.test(logs.text), logs);
    ok("SHUTDOWN: /healthz no longer answers (server actually closed)", (await smoke.probe(port, "/healthz")).ok === false, logs);
    ok("SHUTDOWN: process exited 0 within the deadline, leaving no child", ex.timedOut === false && ex.code === 0, logs);
    ok("SHUTDOWN: cleanup ran to completion (lifecycle log)", /shutdown complete/.test(logs.text), logs);
    kill(child);

    // shutdown-timeout backstop: a process ignoring SIGTERM is flagged by the deadline.
    const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    stubborn.kill("SIGTERM");
    const sx = await smoke.waitExit(stubborn, 1500);
    ok("NEG shutdown-timeout: a process ignoring SIGTERM is flagged (timedOut=true)", sx.timedOut === true);
    kill(stubborn);
  } else {
    console.log("  · POSIX SIGTERM graceful-shutdown checks skipped on win32 (kill() hard-terminates; enforced in Linux CI).");
  }

  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
