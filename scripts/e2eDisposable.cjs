/*
 * AUD-002 Gate 4a — disposable-DB E2E launcher (FAIL CLOSED).
 *
 * The Playwright suite drives the REAL app, which writes rows. Rule 7/9: it must
 * NEVER touch production data. This launcher spins up an ephemeral in-memory Mongo,
 * proves it is disposable, and only then starts the API/web pointed at it. If it
 * cannot prove the target is throwaway, it aborts BEFORE any server boots — the
 * safe default is to run nothing, not to run against whatever `.env` happens to say.
 *
 *   node scripts/e2eDisposable.cjs            # start ephemeral Mongo, run Playwright
 *   node scripts/e2eDisposable.cjs --print    # just print a verified disposable URI
 *
 * The guard (assertDisposable / looksProduction / throwawayDbName) is pure and unit
 * tested in tests/e2e-disposable-guard.test.js.
 */
const path = require("path");
const fs = require("fs");

// Same throwaway-NAME rule the migration uses (CR-010): a loopback host is NOT
// proof of disposability, so safety is keyed on a recognizably throwaway db NAME.
function throwawayDbName(name) {
  return /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(String(name || ""));
}

function parseUri(uri) {
  try {
    const srv = /^mongodb\+srv:\/\//i.test(uri);
    const u = new URL(String(uri).replace(/^mongodb(\+srv)?:\/\//i, "https://"));
    return {
      srv,
      host: u.hostname,
      db: decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || "",
    };
  } catch (_) {
    return { srv: false, host: "", db: "" };
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

// A URI that "looks like production": an SRV/Atlas connection, or any non-loopback
// host. These are refused outright as an E2E target regardless of db name.
function looksProduction(uri) {
  const { srv, host } = parseUri(uri);
  if (!host) return true;                 // unparseable ⇒ treat as unsafe
  if (srv) return true;                   // mongodb+srv ⇒ managed/prod cluster
  if (/mongodb\.net$/i.test(host)) return true; // Atlas
  if (!LOOPBACK.has(host)) return true;   // remote host
  return false;
}

/*
 * Throws unless `uri` is a provably-disposable E2E target:
 *   - not production-looking (loopback, non-SRV, non-Atlas),
 *   - a recognizably throwaway db NAME,
 *   - and DISTINCT from the configured production URI (never the same host+db).
 * Returns the parsed target on success.
 */
function assertDisposable(uri, opts = {}) {
  const prodUri = opts.prodUri || "";
  if (!uri) throw new Error("E2E abort: no disposable MONGO_URI was provided.");
  if (looksProduction(uri)) {
    throw new Error(`E2E abort: target "${uri}" looks like production (SRV/Atlas/remote host); refusing to run E2E against it.`);
  }
  const t = parseUri(uri);
  if (!throwawayDbName(t.db)) {
    throw new Error(`E2E abort: db name "${t.db}" is not recognizably throwaway (need test/e2e/memory/scratch/ci/ephemeral).`);
  }
  if (prodUri) {
    const p = parseUri(prodUri);
    if (p.host && p.host === t.host && p.db && p.db === t.db) {
      throw new Error(`E2E abort: disposable target equals the configured production DB (${t.host}/${t.db}).`);
    }
  }
  return t;
}

// AUD-013 CR-067/CR-076: a disposable run must NEVER write PDFs into the
// workspace, and cleanup must prove RUN OWNERSHIP — not merely temp-root
// containment (an unrelated sibling under the same temp root must be refused).
// Each run gets an unpredictable id and an atomic OWNERSHIP MARKER written inside
// its exact root; cleanup only removes a directory that carries THIS run's marker
// token, has the expected name shape, and resolves (no symlink) under the temp
// root. `mkdir` is optional so the path logic is unit-testable without disk.
const MARKER_NAME = ".exq-e2e-owner";
function allocateE2EDirs(opts = {}) {
  const os = require("os");
  const fs = require("fs");
  const crypto = require("crypto");
  const tmpRoot = path.resolve(opts.tmpRoot || os.tmpdir());
  const mkdir = opts.mkdir !== false;
  const token = opts.token || crypto.randomBytes(24).toString("hex");
  const rand = opts.rand || `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const base = path.join(tmpRoot, `exq-e2e-${rand}`);
  const dirs = {
    root: base,
    staging: path.join(base, "staging"),
    private: path.join(base, "private"),
    journal: path.join(base, "journal", "exam-pdf.jsonl"),
    marker: path.join(base, MARKER_NAME),
    token,
    tmpRoot,
  };
  for (const key of ["root", "staging", "private"]) {
    if (!isUnderRoot(dirs[key], tmpRoot)) {
      throw new Error(`E2E abort: allocated dir "${dirs[key]}" is not under the temp root "${tmpRoot}".`);
    }
  }
  if (mkdir) {
    fs.mkdirSync(dirs.staging, { recursive: true });
    fs.mkdirSync(dirs.private, { recursive: true });
    fs.mkdirSync(path.dirname(dirs.journal), { recursive: true });
    // Atomic marker: write to a temp name in the same dir then rename into place.
    const tmp = `${dirs.marker}.${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, token, { mode: 0o600 });
    fs.renameSync(tmp, dirs.marker);
  }
  return dirs;
}

// True only when `p` is strictly inside `root` (defeats `..` escapes and prefix
// collisions like `/tmp/a` vs `/tmpfoo`).
function isUnderRoot(p, root) {
  const rp = path.resolve(p);
  const rr = path.resolve(root);
  if (rp === rr) return false; // must be a child, never the temp root itself
  const rel = path.relative(rr, rp);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Remove ONLY a directory this run OWNS. Requires the allocated run object (with
// its secret token), validates the name shape, the ownership marker contents, and
// that the real (symlink-resolved) path is a real directory strictly under the
// temp root. Any arbitrary path — even a sibling under the SAME temp root — is
// refused. Returns true if it removed something; false if already gone (idempotent).
function removeE2EDir(run, opts = {}) {
  const os = require("os");
  const fs = require("fs");
  const tmpRoot = path.resolve((run && run.tmpRoot) || opts.tmpRoot || os.tmpdir());
  if (!run || typeof run !== "object" || typeof run.root !== "string" || typeof run.token !== "string") {
    throw new Error("E2E abort: removeE2EDir requires the allocated run object (root + token).");
  }
  const root = path.resolve(run.root);
  if (!/^exq-e2e-/.test(path.basename(root))) throw new Error(`E2E abort: "${root}" is not an exq-e2e run dir.`);
  if (!isUnderRoot(root, tmpRoot)) throw new Error(`E2E abort: "${root}" is not under the temp root "${tmpRoot}".`);
  if (!fs.existsSync(root)) return false; // already removed — idempotent
  // Reject a symlinked/junctioned root, and a real path that escapes the temp root.
  const lst = fs.lstatSync(root);
  if (lst.isSymbolicLink() || !lst.isDirectory()) throw new Error(`E2E abort: "${root}" is not a real directory.`);
  const real = fs.realpathSync(root);
  if (!isUnderRoot(real, fs.realpathSync(tmpRoot))) throw new Error(`E2E abort: real path "${real}" escapes the temp root.`);
  // The ownership marker must exist and carry THIS run's exact token.
  const markerPath = path.join(root, MARKER_NAME);
  let marker;
  try { marker = fs.readFileSync(markerPath, "utf8"); } catch { throw new Error(`E2E abort: ownership marker missing in "${root}".`); }
  if (marker !== run.token) throw new Error(`E2E abort: ownership marker mismatch in "${root}".`);
  fs.rmSync(root, { recursive: true, force: true });
  return true;
}

module.exports = { throwawayDbName, parseUri, looksProduction, assertDisposable, LOOPBACK, allocateE2EDirs, isUnderRoot, removeE2EDir, MARKER_NAME };

// ---- launcher (only when run directly) ----
if (require.main === module) {
  const printOnly = process.argv.includes("--print");
  const { spawnSync, spawn } = require("child_process");
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  const BE_DIR = path.join(__dirname, "..");
  const DB_NAME = "exq_e2e_ephemeral";

  // CR-032: the disposable Mongo handle + idempotent cleanup live at MODULE scope so
  // EVERY exit path — signals, unhandledRejection, child spawn error, child exit, and
  // the outer rejected-promise handler — runs cleanup. Nothing calls process.exit
  // while bypassing it.
  let mem = null;
  // CR-067: run-owned filesystem paths (allocated below), removed on every exit.
  let runDirs = null;
  // CR-032: a SHARED cleanup promise so every concurrent exit path awaits the SAME
  // `mem.stop()` COMPLETION before exiting — a second overlapping stop can no longer
  // see a "stopped" boolean and call process.exit while the first cleanup is still
  // shutting Mongo down.
  let cleanupPromise = null;
  const cleanup = () => {
    if (!cleanupPromise) cleanupPromise = (async () => {
      try { if (mem) await mem.stop(); } catch (_) {}
      // CR-067/CR-076: remove ONLY this run's OWNED OS-temp dir (validated by its
      // ownership marker token + name shape + real non-symlink path under tmp).
      // Never a workspace/shared glob — this is the exact incident containment.
      try { if (runDirs) removeE2EDir(runDirs); } catch (e) { console.error(String(e.message || e)); }
    })();
    return cleanupPromise;
  };
  const stop = async (code) => { await cleanup(); process.exit(code); };
  process.on("SIGINT", () => stop(130));
  process.on("SIGTERM", () => stop(143));
  process.on("uncaughtException", (e) => { console.error(e); stop(1); });
  process.on("unhandledRejection", (e) => { console.error(e); stop(1); });

  (async () => {
    // CR-032: read the configured PRODUCTION uri from Backend/.env by ABSOLUTE path
    // (independent of the caller's cwd) ONLY to assert we are not about to use it.
    require("dotenv").config({ path: path.join(BE_DIR, ".env") });
    const prodUri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";

    // AUD-009 transaction boundaries are mandatory, so browser validation uses
    // a one-node replica set with real transaction support.
    mem = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
      instanceOpts: [{ dbName: DB_NAME }],
    });
    const uri = mem.getUri(DB_NAME);

    // CR-067: allocate run-owned OS-temp staging/private/journal dirs so NO PDF
    // is ever written into the workspace. Removed in cleanup on every exit path.
    runDirs = allocateE2EDirs();
    const selfsigned = require("selfsigned");
    const pems = await selfsigned.generate(
      [{ name: "commonName", value: "localhost" }],
      {
        days: 1,
        keySize: 2048,
        extensions: [{
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" },
          ],
        }],
      }
    );
    runDirs.tlsKey = path.join(runDirs.root, "localhost-key.pem");
    runDirs.tlsCert = path.join(runDirs.root, "localhost-cert.pem");
    fs.writeFileSync(runDirs.tlsKey, pems.private, { mode: 0o600 });
    fs.writeFileSync(runDirs.tlsCert, pems.cert, { mode: 0o600 });
    console.log(`E2E filesystem isolated under: ${runDirs.root}`);

    let target;
    try {
      target = assertDisposable(uri, { prodUri });
    } catch (err) {
      console.error(String(err.message || err));
      return stop(3);
    }
    console.log(`E2E disposable Mongo verified: ${target.host}/${target.db} (ephemeral, isolated).`);
    if (printOnly) { console.log(uri); return stop(0); }

    // CR-030: apply the REAL session migration to the throwaway DB, then verify the
    // collections + the four Session indexes (incl. the partial TTL) via the native
    // driver. Abort BEFORE Playwright if anything is missing.
    console.log("Applying session migration to the disposable database…");
    const mig = spawnSync("node", ["migrations/2026-07-25-session-collection.js", "--apply", `--db=${DB_NAME}`], {
      cwd: BE_DIR, env: { ...process.env, MONGO_URI: uri }, encoding: "utf8",
    });
    if (mig.status !== 0) { console.error("Session migration failed:\n" + (mig.stdout || "") + (mig.stderr || "")); return stop(4); }
    try {
      const mongoose = require("mongoose");
      await mongoose.connect(uri);
      const db = mongoose.connection.db;
      const names = (await db.listCollections().toArray()).map((c) => c.name);
      if (!names.includes("sessions") || !names.includes("pendingsecurityactions")) {
        throw new Error(`missing collections after migration: ${names.join(",")}`);
      }
      // CR-032: assert the EXACT four named Session indexes + their options.
      const sIdx = await db.collection("sessions").indexes();
      const byName = (arr, n) => arr.find((i) => i.name === n);
      const ttl = byName(sIdx, "absoluteExpiresAt_1");
      const partialOk = ttl && ttl.expireAfterSeconds === 0 && ttl.partialFilterExpression && ttl.partialFilterExpression.theftFenceTarget === null;
      const refreshUnique = byName(sIdx, "refreshHash_1");
      const userRevoked = byName(sIdx, "userId_1_revokedAt_1");
      const theftSparse = byName(sIdx, "theftFenceTarget_1");
      const sessionOk =
        refreshUnique && refreshUnique.unique === true &&
        partialOk &&
        userRevoked &&
        theftSparse && theftSparse.sparse === true;
      if (!sessionOk) {
        throw new Error(`session indexes not as expected: refreshHash_1(unique)=${!!(refreshUnique && refreshUnique.unique)} absoluteExpiresAt_1(partialTTL)=${!!partialOk} userId_1_revokedAt_1=${!!userRevoked} theftFenceTarget_1(sparse)=${!!(theftSparse && theftSparse.sparse)}`);
      }
      // CR-032: assert BOTH pendingsecurityactions indexes the migration establishes.
      const pIdx = await db.collection("pendingsecurityactions").indexes();
      const outboxOk = byName(pIdx, "deadLetter_1_nextAttemptAt_1") && byName(pIdx, "leaseUntil_1");
      if (!outboxOk) {
        throw new Error(`pendingsecurityactions indexes missing: deadLetter_1_nextAttemptAt_1=${!!byName(pIdx, "deadLetter_1_nextAttemptAt_1")} leaseUntil_1=${!!byName(pIdx, "leaseUntil_1")}`);
      }
      await mongoose.disconnect();
      console.log(`Session migration verified: 4 named Session indexes (incl. partial TTL) + 2 outbox indexes present.`);
    } catch (e) {
      console.error("Session migration VERIFICATION failed:", e && e.message);
      return stop(4);
    }

    // CR-030: run the browser matrix against the NEW session model — set the full
    // flag bundle EXPLICITLY (never inherit an ambiguous mix). Phase-2 intent for
    // REQUIRE_EXP_TOKENS is `true`; the default stays false (Phase 1) because a fresh
    // DB has no legacy tokens and ISSUE_NEW_MODEL already issues exp/typed tokens.
    // CR-033: --rollback runs the cookie-only bounded rollback posture
    // (SESSION_MODEL_ENABLED + ISSUE_NEW_MODEL=false ⇒ __Host-exq_sess, no rotating
    // refresh), which proves the rollback transport works without a bearer.
    const rollbackMode = process.argv.includes("--rollback");
    const WEB_ORIGIN = "https://localhost:5174";
    const sessionEnv = {
      SESSION_MODEL_ENABLED: "true",
      ISSUE_NEW_MODEL: rollbackMode ? "false" : "true",
      HONOR_EXISTING_REFRESH: "true",
      EMERGENCY_REAUTH: "false",
      // Phase 2 is an explicit disposable acceptance mode. It never changes the
      // production default and is enabled only by the caller for the exp-required
      // browser gate.
      REQUIRE_EXP_TOKENS:
        String(process.env.REQUIRE_EXP_TOKENS || "false").toLowerCase() === "true"
          ? "true"
          : "false",
      // CR-077: overridable so a viewer run can use a SHORT real-server access
      // TTL to trigger a genuine mid-view 401 (no route interception).
      ACCESS_TTL_MS: process.env.ACCESS_TTL_MS || String(15 * 60 * 1000),
      REFRESH_SLIDING_MS: String(30 * 24 * 60 * 60 * 1000),
      REFRESH_ABSOLUTE_MS: String(90 * 24 * 60 * 60 * 1000),
      RING_DEPTH: "10",
      GRACE_WINDOW_MS: "10000",
      ROLLBACK_COOKIE_TTL_MS: String(7 * 24 * 60 * 60 * 1000),
      ALLOWED_ORIGINS: WEB_ORIGIN,
      // CR-040: fast, deterministic deadline finalizer for the AUD-004 T1 E2E.
      FINALIZE_INTERVAL_MS: "2000",
      FINALIZE_FIRST_MS: "1000",
      FINALIZE_GRACE_MS: "1000",
      // CR-090: a small per-chunk PDF-stream delay so the viewer's multi-chunk
      // range download stays in flight long enough for the E2E to inject a stale
      // token mid-load and prove pdf.js's OWN range 401 recovers. Production never
      // sets this; overridable.
      EXAM_PDF_STREAM_DELAY_MS: process.env.EXAM_PDF_STREAM_DELAY_MS || "20",
    };

    const extra = process.argv.slice(2).filter((a) => a !== "--print" && a !== "--rollback");
    const projects = extra.length
      ? extra
      : rollbackMode
      ? ["--project=auth-rollback"]
      : ["--project=auth-chromium", "--project=auth-firefox", "--project=auth-webkit", "--project=autosave"];

    // Teacher Success Journey — when a journey-* project runs, apply the Journey
    // migration to the throwaway DB, seed the demo accounts, and enable the flag
    // for the disposable backend ONLY (never production, never Backend/.env).
    const journeyMode = projects.some((p) => /journey-/.test(p));
    if (journeyMode) {
      console.log("Applying Teacher Success migration + seeding the disposable database…");
      const jmig = spawnSync("node", ["migrations/2026-07-27-teacher-success.js", "--apply", `--db=${DB_NAME}`, "--batch=e2e-journey"], { cwd: BE_DIR, env: { ...process.env, MONGO_URI: uri }, encoding: "utf8" });
      if (jmig.status !== 0) { console.error("Journey migration failed:\n" + (jmig.stdout || "") + (jmig.stderr || "")); return stop(4); }
      try {
        const mongoose = require("mongoose");
        const { seedJourney } = require("./journeySeed.cjs");
        await mongoose.connect(uri);
        await seedJourney({ frontendUrl: WEB_ORIGIN });
        await mongoose.disconnect();
        console.log("Journey migration + seed complete (admin + Spark/Momentum/Impact teachers).");
      } catch (e) { console.error("Journey seed failed:", e && e.message); return stop(4); }
    }
    // CR-032: spawn the Node binary DIRECTLY on Playwright's CLI script with
    // shell:false — never a shell, never a .cmd (which Node blocks under shell:false),
    // and never concatenate forwarded args into a shell command (no DEP0190 vector).
    const FE_DIR = path.join(BE_DIR, "..", "Frontend");
    let pwCli;
    try { pwCli = require.resolve("@playwright/test/cli", { paths: [FE_DIR] }); }
    catch (_) { pwCli = require.resolve("playwright/cli", { paths: [FE_DIR] }); }
    const child = spawn(process.execPath, [pwCli, "test", ...projects], {
      cwd: FE_DIR,
      env: {
        ...process.env, ...sessionEnv, MONGO_URI: uri,
        EXQ_E2E_DISPOSABLE: "1", EXQ_E2E_SESSION_MODEL: "1",
        // Enable the Journey ONLY for a journey-* run (forwarded to the backend by
        // playwright.config's backendEnv). Every other disposable run stays flag-off.
        TEACHER_SUCCESS_JOURNEY_ENABLED: journeyMode ? "1" : "0",
        EXQ_E2E_HTTPS: "1",
        E2E_TLS_KEY: runDirs.tlsKey,
        E2E_TLS_CERT: runDirs.tlsCert,
        // CR-067: the disposable backend stages, stores and journals PDFs ONLY
        // under the run-owned temp dirs (forwarded to the webServer backend by
        // playwright.config.js). Nothing touches the workspace.
        EXAM_PDF_DIR: runDirs.private,
        PDF_STAGING_DIR: runDirs.staging,
        EXAM_PDF_JOURNAL: runDirs.journal,
      },
      stdio: "inherit",
      shell: false,
    });
    child.on("error", (err) => { console.error("Failed to launch Playwright:", err && err.message); stop(1); });
    child.on("exit", (code) => stop(code == null ? 1 : code));
  })().catch((e) => { console.error(e); stop(1); }); // CR-032: cleanup runs even here
}
