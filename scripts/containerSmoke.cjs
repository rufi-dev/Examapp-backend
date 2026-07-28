/*
 * CR-110/CR-113/CR-115 — disposable container/CI smoke gate. It never contacts a
 * configured non-throwaway database and never treats an ambiguous result as success:
 *   1. the running Node satisfies package.json "engines";
 *   2. a migration against a NON-throwaway db NAME (over a deliberately UNREACHABLE
 *      host) refuses with the EXACT code 3 + "Refusing" BEFORE connecting (proven by
 *      returning fast instead of hanging on the unreachable host);
 *   3. (only with SMOKE_MONGO_URI at a THROWAWAY db) deployment-FAITHFUL preparation
 *      runs the REAL session/token/email/attempt-result migrations + a read-only shape
 *      verifier (prepareSmokeDb.cjs) with EXACT exit codes; the server boots with
 *      SESSION_MODEL_ENABLED=true on a RUN-OWNED port; /healthz returns EXACTLY
 *      200 {status:"ok"} (404/401 is never health); the outbox worker logs exactly one
 *      start; then SIGTERM performs a GENUINE graceful shutdown — one worker stop, the
 *      HTTP listener CLOSES (/healthz stops answering), Mongoose disconnects, and the
 *      process exits 0 within the bounded deadline leaving no child.
 * Run-owned PDF/staging temp dirs are removed in `finally`; child logs are printed on
 * every failed assertion.
 */
const path = require("path");
const http = require("http");
const net = require("net");
const os = require("os");
const fs = require("fs");
const { spawnSync, spawn } = require("child_process");

const BE = path.join(__dirname, "..");
// Absolute, RUN-OWNED, writable PDF dirs (unique per process — two sequential smokes
// never collide). Production preflight REFUSES a relative EXAM_PDF_DIR (ephemeral
// container layer); a real deploy mounts a persistent volume.
const SMOKE_PDF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-exampdf-"));
const SMOKE_STAGING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-staging-"));
const PRICE_MIG = path.join(BE, "migrations", "2026-07-27-free-all-exams.js");
const SESSION_MIG = path.join(BE, "migrations", "2026-07-25-session-collection.js");

function cleanupDirs() {
  for (const d of [SMOKE_PDF_DIR, SMOKE_STAGING_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
}

// Allocate a free, RUN-OWNED TCP port (no fixed-port flakiness under parallel/sequential load).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function enginesSatisfied() {
  const eng = (require(path.join(BE, "package.json")).engines || {}).node || "";
  const m = eng.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return true;
  const need = [Number(m[1]), Number(m[2]), Number(m[3])];
  const cur = process.versions.node.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (cur[i] > need[i]) return true; if (cur[i] < need[i]) return false; }
  return true;
}
function dbNameFromUri(uri) { try { const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://")); return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || ""; } catch { return ""; } }

// Exact liveness detector: ONLY a 200 with body {status:"ok"} at the given path is
// healthy. Returns {ok, status}. A 404/401/500, wrong body, or closed port is never ok.
function probe(port, p, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port, path: p, timeout: timeoutMs }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => {
        let body = {}; try { body = JSON.parse(Buffer.concat(c).toString()); } catch { /* */ }
        resolve({ ok: res.statusCode === 200 && body && body.status === "ok", status: res.statusCode });
      });
    });
    r.on("error", () => resolve({ ok: false, status: 0 }));
    r.on("timeout", () => { r.destroy(); resolve({ ok: false, status: 0 }); });
  });
}
async function waitHealthy(port, p, tries = 80) {
  for (let i = 0; i < tries; i++) { const r = await probe(port, p); if (r.ok) return r; await new Promise((s) => setTimeout(s, 500)); }
  return { ok: false, status: 0 };
}
// Race-free port discovery: boot with PORT=0 (OS-assigned) and read the ACTUAL port the
// server logs once it is listening. Returns the port, or null if it never listens.
async function waitListening(logs, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const m = logs.text.match(/listening on port:\s*(\d+)/);
    if (m) return Number(m[1]);
    await new Promise((s) => setTimeout(s, 500));
  }
  return null;
}
function bootServer(uri, port, extra = {}) {
  const child = spawn(process.execPath, [path.join(BE, "server.js")], {
    env: { ...process.env, MONGO_URI: uri, PORT: String(port), NODE_ENV: "production", EMAIL_ENABLED: "false", WHATSAPP_WEB_ENABLED: "false", MIGRATION_TS: "2026-07-10T12:00:00Z", FRONTEND_URL: "https://example.test", JWT_SECRET: "smoke", CRYPTR_KEY: "smoke", SESSION_MODEL_ENABLED: "true", EXAM_PDF_DIR: SMOKE_PDF_DIR, PDF_STAGING_DIR: SMOKE_STAGING_DIR, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = { text: "" };
  child.stdout.on("data", (d) => (logs.text += d));
  child.stderr.on("data", (d) => (logs.text += d));
  return { child, logs };
}
function waitExit(child, ms) {
  return new Promise((resolve) => {
    // The child may have ALREADY exited (e.g. it self-terminated during a prior
    // waitHealthy). A listener attached now would never fire, so check first.
    if (child.exitCode !== null || child.signalCode !== null) {
      return resolve({ timedOut: false, code: child.exitCode, signal: child.signalCode });
    }
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true, code: null }); } }, ms);
    child.on("exit", (code, signal) => { if (!done) { done = true; clearTimeout(t); resolve({ timedOut: false, code, signal }); } });
  });
}

module.exports = { enginesSatisfied, dbNameFromUri, probe, waitHealthy, waitListening, bootServer, waitExit, freePort, cleanupDirs, PRICE_MIG, SESSION_MIG, SMOKE_PDF_DIR, SMOKE_STAGING_DIR };

async function main() {
  let failed = 0;
  // Print the captured server logs for EVERY failed assertion (CR-115 #2/#4).
  const ok = (n, c, logs) => {
    console.log(`${c ? "  ✓" : "  ✗ FAIL:"} ${n}`);
    if (!c) { failed++; if (logs && logs.text) console.log("      ── server logs ──\n" + logs.text.split("\n").map((l) => "      " + l).join("\n")); }
  };

  ok(`Node ${process.versions.node} satisfies engines`, enginesSatisfied());

  const t0 = Date.now();
  const refuse = spawnSync(process.execPath, [PRICE_MIG, "--dry-run"], { encoding: "utf8", timeout: 15000, env: { ...process.env, MONGO_URI: "mongodb://10.255.255.1:27017/examopia_live", EMAIL_ENABLED: "false" } });
  ok("migration refuses a non-throwaway db BEFORE connecting (EXACT exit 3 + 'Refusing', fast — no hang)", refuse.status === 3 && /Refusing/i.test(`${refuse.stdout}${refuse.stderr}`) && Date.now() - t0 < 10000);

  const uri = process.env.SMOKE_MONGO_URI;
  let child = null;
  try {
    if (!uri) {
      console.log("  · SMOKE_MONGO_URI not set → boot/health/worker checks skipped (engines + exact refusal still enforced).");
    } else {
      // Deployment-faithful preparation: the REAL migrations + read-only verifier, EXACT codes.
      const prep = spawnSync(process.execPath, [path.join(BE, "scripts", "prepareSmokeDb.cjs")], { encoding: "utf8", timeout: 120000, env: { ...process.env, MONGO_URI: uri } });
      ok("migration-faithful preparation (real session/token/email/attempt-result migrations + read-only verify) succeeds (EXACT exit 0)", prep.status === 0, { text: `${prep.stdout || ""}${prep.stderr || ""}` });

      // Boot with PORT=0 (OS-assigned) and read the ACTUAL listening port — no
      // pre-allocation race, no fixed-port collision.
      const boot = bootServer(uri, 0);
      child = boot.child;
      const logs = boot.logs;
      const port = await waitListening(logs, 80);
      // Emit the run-owned resources on the smoke's OWN stdout so a caller can prove
      // two sequential runs used independent ports/dirs (no fixed-resource collision).
      console.log(`  · run-owned: port=${port} pdfDir=${SMOKE_PDF_DIR}`);
      ok("server reaches the listening state on a run-owned OS-assigned port", port !== null, logs);
      const health = port !== null ? await waitHealthy(port, "/healthz", 80) : { ok: false };
      ok("liveness /healthz returns EXACTLY 200 {status:'ok'}", health.ok, logs);
      ok("a WRONG path (/nope) is NOT healthy (404 ≠ health)", (await probe(port, "/nope")).ok === false, logs);
      ok("outbox worker started EXACTLY once (SESSION_MODEL_ENABLED=true)", (logs.text.match(/outbox worker started/g) || []).length === 1, logs);

      child.kill("SIGTERM");
      const exit = await waitExit(child, 12000);
      // Genuine graceful shutdown requires POSIX signals. Windows kill() hard-terminates
      // (no catchable signal), so these are enforced only in the Linux container/CI.
      if (process.platform === "win32") {
        console.log("  · SIGTERM graceful-shutdown checks require POSIX signals — enforced in the Linux container (CI).");
      } else {
        ok("SIGTERM stops the outbox worker EXACTLY once", (logs.text.match(/outbox worker stopped/g) || []).length === 1, logs);
        ok("SIGTERM CLOSES the HTTP listener (lifecycle log)", /HTTP server closed/.test(logs.text), logs);
        ok("after shutdown /healthz no longer answers (server actually closed)", (await probe(port, "/healthz")).ok === false, logs);
        ok("process exits 0 within the bounded deadline (no timeout, clean code)", exit.timedOut === false && exit.code === 0, logs);
        ok("shutdown ran to completion (lifecycle log)", /shutdown complete/.test(logs.text), logs);
      }
      if (!exit || exit.timedOut) { try { child.kill("SIGKILL"); } catch (_) {} }
      child = null;
    }
  } finally {
    if (child) { try { child.kill("SIGKILL"); } catch (_) {} }
    cleanupDirs();
  }

  console.log(failed ? `\nSMOKE FAILED (${failed})` : "\nSMOKE OK");
  process.exit(failed ? 1 : 0);
}
if (require.main === module) main().catch((e) => { console.error("SMOKE CRASH:", e && e.message); cleanupDirs(); process.exit(2); });
