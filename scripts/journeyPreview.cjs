/*
 * Teacher Success Journey — SAFE interactive local preview (`npm run journey:preview`).
 *
 * Starts a RUN-OWNED in-memory MongoDB, enables the Journey flag ONLY for the
 * child processes, applies + strictly verifies the Journey migration with a
 * run-owned batch, seeds an admin + pending-Spark + approved-Momentum + Impact
 * teacher with representative activity / referrals / AI balances, then boots the
 * backend + frontend and prints the local URL + credentials. Interactive until
 * Ctrl+C, then it stops both servers and deletes ONLY the run-owned temp state.
 *
 * HARD SAFETY:
 *  - It NEVER reads or mutates the Mongo URI from Backend/.env — it uses ONLY the
 *    ephemeral MongoMemoryServer URI and passes it explicitly to children (the
 *    backend's dotenv.config() does NOT override an already-set MONGO_URI).
 *  - It refuses any non-loopback / non-throwaway Mongo URI (defense in depth).
 *  - The production flag is untouched; nothing is deployed.
 */
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const net = require("net");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const BACKEND_DIR = path.join(__dirname, "..");
const FRONTEND_DIR = path.join(__dirname, "..", "..", "Frontend");
const API_PORT = Number(process.env.JOURNEY_PREVIEW_API_PORT || 5211);
const WEB_PORT = Number(process.env.JOURNEY_PREVIEW_WEB_PORT || 5212);
const isPrivateLanIpv4 = (host) => {
  if (net.isIP(host) !== 4) return false;
  const [a, b] = host.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};
function resolvePreviewHost(rawHost) {
  const host = String(rawHost || "").trim();
  if (!host || host === "localhost" || host === "127.0.0.1") return "localhost";
  if (!isPrivateLanIpv4(host)) {
    throw new Error(
      `REFUSED: JOURNEY_PREVIEW_PUBLIC_HOST must be a private Wi-Fi IPv4 address, received "${host}".`
    );
  }
  return host;
}
const PREVIEW_HOST = resolvePreviewHost(process.env.JOURNEY_PREVIEW_PUBLIC_HOST);
const IS_LAN_PREVIEW = PREVIEW_HOST !== "localhost";
const API_URL = `http://${PREVIEW_HOST}:${API_PORT}`;
const WEB_URL = `http://${PREVIEW_HOST}:${WEB_PORT}`;
const INTERNAL_API_URL = `http://localhost:${API_PORT}`;
const INTERNAL_WEB_URL = `http://localhost:${WEB_PORT}`;
const PASSWORD = "PreviewPass1"; // letter + digit, >= 8 (passes validatePassword)

const isLoopback = (host) => host === "127.0.0.1" || host === "localhost" || host === "::1";
const isThrowaway = (n) => /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral|smoke|preview)($|[_-])/i.test(n);
function assertSafeUri(uri) {
  const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://"));
  const dbName = decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || "";
  if (!isLoopback(u.hostname)) throw new Error(`REFUSED: preview Mongo host "${u.hostname}" is not loopback.`);
  if (!isThrowaway(dbName)) throw new Error(`REFUSED: preview Mongo db "${dbName}" is not a recognizably throwaway name.`);
  return dbName;
}

const children = [];
let mem = null;
let shuttingDown = false;

// Kill a child's ENTIRE process tree. On Windows, Vite is launched through the
// npx.cmd shim which spawns node/esbuild grandchildren; a plain SIGTERM on the shim
// leaves them (and the dev server port) orphaned — taskkill /T reaps the whole tree.
function killTreeSync(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
}
// The MongoMemoryServer's mongod pid (best-effort across versions) so a hard exit can
// reap it even if mem.stop() never runs.
function mongodPid() {
  try {
    const i = mem && (mem.instanceInfo || (mem.instanceInfoSync && mem.instanceInfoSync()));
    return (i && (i.pid || (i.instance && i.instance.pid))) || null;
  } catch { return null; }
}

function spawnChild(label, cmd, args, cwd, env) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd) });
  child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  child.on("error", (e) => { console.error(`[${label}] spawn error:`, e && e.message); shutdown(1); });
  // A server child dying unexpectedly (failed startup, crash) is fatal — tear the rest down.
  child.on("exit", (code) => { if (!shuttingDown) { console.error(`[${label}] exited unexpectedly (code ${code}) — shutting down.`); shutdown(1); } });
  children.push({ label, child });
  return child;
}
// Windows npm/npx are .cmd shims — spawn them by their .cmd name (with a shell).
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

function runOnce(label, cmd, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${label} exited ${code}\n${out}`))));
  });
}

async function waitFor(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok || r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function seed(uri) {
  const { seedJourney } = require("./journeySeed.cjs");
  await mongoose.connect(uri);
  await seedJourney({ frontendUrl: WEB_URL });
  await mongoose.disconnect();
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[journey:preview] shutting down — stopping servers + deleting run-owned state…");
  const pid = mongodPid();
  // Kill each child's FULL tree (backend node + the Vite shim's node/esbuild grandkids).
  for (const { child } of children) killTreeSync(child.pid);
  try { if (mem) await mem.stop(); } catch { /* ignore */ }
  killTreeSync(pid); // reap mongod even if mem.stop() didn't
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  console.log("[journey:preview] done. No production state was touched.");
  process.exit(code);
}

// Last-resort SYNCHRONOUS cleanup on ANY process exit (can't await here) — guarantees no
// backend/Vite/mongod tree is left behind even on an unusual exit path.
function syncCleanup() {
  const pid = mongodPid();
  for (const { child } of children) killTreeSync(child.pid);
  killTreeSync(pid);
}

async function main() {
  console.log("[journey:preview] starting a run-owned in-memory MongoDB…");
  mem = await MongoMemoryServer.create();
  const uri = mem.getUri("tsj_preview_ephemeral"); // explicit throwaway db name in the URI
  const dbName = assertSafeUri(uri); // refuse non-loopback / non-throwaway
  console.log(`[journey:preview] ephemeral Mongo: ${uri} (db=${dbName})`);

  const batch = `preview-${crypto.randomBytes(4).toString("hex")}`;
  const migEnv = { MONGO_URI: uri };
  console.log("[journey:preview] applying + verifying the Journey migration…");
  await runOnce("migrate", process.execPath, ["migrations/2026-07-27-teacher-success.js", "--apply", `--db=${dbName}`, `--batch=${batch}`], BACKEND_DIR, migEnv);
  await runOnce("verify", process.execPath, ["migrations/2026-07-27-teacher-success.js", "--verify", `--db=${dbName}`], BACKEND_DIR, migEnv);

  console.log("[journey:preview] seeding admin + Spark/Momentum/Impact teachers…");
  await seed(uri);

  // Ephemeral secrets — NEVER from Backend/.env.
  const secret = crypto.randomBytes(24).toString("hex");
  const backendEnv = {
    MONGO_URI: uri, // wins over Backend/.env (dotenv does not override an existing var)
    TEACHER_SUCCESS_JOURNEY_ENABLED: "1", // ONLY for this child
    EXQ_JOURNEY_PREVIEW_HTTP: "1", // run-owned HTTP preview cookie; never set by production
    NODE_ENV: "development",
    PORT: String(API_PORT),
    JWT_SECRET: secret,
    CRYPTR_KEY: crypto.randomBytes(16).toString("hex"),
    FRONTEND_URL: WEB_URL,
    MIGRATION_TS: new Date().toISOString(),
  };
  console.log("[journey:preview] starting backend…");
  spawnChild("backend", process.execPath, ["server.js"], BACKEND_DIR, backendEnv);
  await waitFor(`${INTERNAL_API_URL}/healthz`);

  console.log("[journey:preview] starting frontend…");
  spawnChild("frontend", NPX, [
    "vite",
    "--port", String(WEB_PORT),
    "--strictPort",
    "--host", IS_LAN_PREVIEW ? "0.0.0.0" : "localhost",
  ], FRONTEND_DIR, {
    VITE_BACKEND_URL: API_URL,
    TEACHER_SUCCESS_JOURNEY_ENABLED: "1",
  });
  await waitFor(INTERNAL_WEB_URL);

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("  Teacher Success Journey — LOCAL PREVIEW (flag ON, ephemeral DB)");
  console.log(`  Open:  ${WEB_URL}`);
  if (IS_LAN_PREVIEW) {
    console.log(`  Phone: ${WEB_URL}  (same private Wi-Fi; allow Node.js on Private networks if Windows asks)`);
  }
  console.log("  Login credentials (password for all):  " + PASSWORD);
  console.log("    • Admin            admin@preview.local      → /teacher-success console");
  console.log("    • NEW teacher      newteacher@preview.local (onboarding NOT completed → lands on the intro)");
  console.log("    • Spark teacher    spark@preview.local      (approved, 72/100 AI, ready-for-review)");
  console.log("    • Momentum teacher momentum@preview.local   (approved, 250/300 AI, 1 qualified referral)");
  console.log("    • Impact teacher   impact@preview.local     (approved, 700/750 AI)");
  console.log("  Students: student1@preview.local, student2@preview.local");
  console.log("  Press Ctrl+C to stop everything and delete the run-owned state.");
  console.log("────────────────────────────────────────────────────────────\n");
}

// Exported for the safety unit test (guard must refuse cloud/non-loopback/non-throwaway).
module.exports = {
  assertSafeUri,
  isLoopback,
  isThrowaway,
  isPrivateLanIpv4,
  resolvePreviewHost,
};

if (require.main === module) {
  // Every exit path tears down the backend + Vite + MongoMemoryServer trees:
  process.on("SIGINT", () => shutdown(0));   // Ctrl+C
  process.on("SIGTERM", () => shutdown(0));  // kill / parent stop
  process.on("SIGHUP", () => shutdown(0));   // terminal closed
  process.on("uncaughtException", (e) => { console.error("[journey:preview] uncaught:", e && e.message); shutdown(1); });
  process.on("unhandledRejection", (e) => { console.error("[journey:preview] unhandled rejection:", (e && e.message) || e); shutdown(1); });
  process.on("exit", syncCleanup); // synchronous last resort (normal exit included)
  main().catch(async (e) => { console.error("[journey:preview] FAILED:", e && e.message); await shutdown(1); });
}
