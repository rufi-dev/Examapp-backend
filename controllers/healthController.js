// ---------------------------------------------------------------------------
// Admin System Health ("Sistem sağlamlığı") — aggregates every signal the
// dashboard shows: process/host resources, Mongo health, public-site and API
// reachability, SSL expiry, business-level counters, background-job
// heartbeats, request metrics and the grouped error log.
//
// Principles:
//   - READ-ONLY against real data (the only writes are a tiny self-test doc
//     in a dedicated `healthchecks` collection and a temp file in uploads/).
//   - Every external probe has a hard timeout — this endpoint must never hang.
//   - Sub-checks are cached with individual TTLs; the whole payload is cached
//     ~20s so an auto-refreshing dashboard adds no real load.
//   - No secrets: env var VALUES never leave this API (only derived booleans
//     like "configured: yes/no" and non-secret numbers like rate limits).
// ---------------------------------------------------------------------------

const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const tls = require("tls");
const path = require("path");
const { execFile } = require("child_process");
const mongoose = require("mongoose");
const asyncHandler = require("express-async-handler");

const { getMetrics } = require("../middleware/requestMetrics");
const { getJobs } = require("../utils/heartbeat");
const HealthSnapshot = require("../models/healthSnapshotModel");
const Exam = require("../models/examModel");
const Attempt = require("../models/attemptModel");
const Result = require("../models/resultModel");
const User = require("../models/userModel");
const Video = require("../models/videoModel");
const ClassModel = require("../models/classModel");
const DebugLog = require("../models/debugLogModel");
const AiUsage = require("../models/aiUsageModel");
const pkg = require("../package.json");

const SITE_URL = process.env.SITE_URL || "https://bunkermath.az";
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || "https://api.bunkermath.az";
const PORT = process.env.PORT || 5000;

// --------------------------------- utils ----------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Race a probe against a timeout so one dead dependency can't stall the page.
// The probe keeps running if it loses; its eventual rejection is swallowed so
// a late failure can't become an unhandled rejection (fatal in Node 18).
const withTimeout = (promise, ms, fallback) => {
  const p = Promise.resolve(promise);
  p.catch(() => {});
  return Promise.race([
    p,
    sleep(ms).then(() => (typeof fallback === "function" ? fallback() : fallback)),
  ]);
};

// Tiny TTL cache. Serves the cached value while fresh; recomputes otherwise.
const cacheStore = new Map();
const cached = async (key, ttlMs, fn) => {
  const hit = cacheStore.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value;
  if (hit?.pending) return hit.value !== undefined ? hit.value : hit.pending;
  const pending = Promise.resolve()
    .then(fn)
    .then((value) => {
      cacheStore.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((e) => {
      // Keep a stale value if we have one; otherwise surface the error object.
      const stale = cacheStore.get(key);
      if (stale && stale.value !== undefined) {
        cacheStore.set(key, { at: Date.now(), value: stale.value });
        return stale.value;
      }
      const err = { error: String(e?.message || e) };
      cacheStore.set(key, { at: Date.now(), value: err });
      return err;
    });
  cacheStore.set(key, { at: hit?.at || 0, value: hit?.value, pending });
  return pending;
};

const timedFetch = async (url, { timeoutMs = 10000, method = "GET" } = {}) => {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "BunkerMath-HealthCheck/1.0" },
    });
    // Drain (small) bodies so sockets are released; HEAD/failed bodies skipped.
    let bytes = 0;
    try {
      if (method === "GET") bytes = (await res.arrayBuffer()).byteLength;
    } catch { /* body read is best-effort */ }
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      bytes,
      headers: {
        server: res.headers.get("server") || undefined,
        hsts: !!res.headers.get("strict-transport-security"),
        contentType: res.headers.get("content-type") || undefined,
      },
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(e?.cause?.message || e?.message || e) };
  }
};

const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) : null);
const GB = 1024 * 1024 * 1024;

// ----------------------------- server resources ---------------------------

const cpuSnapshot = () => {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
};

const cpuUsagePct = async (windowMs = 500) => {
  const a = cpuSnapshot();
  await sleep(windowMs);
  const b = cpuSnapshot();
  const dt = b.total - a.total;
  return dt > 0 ? Math.round((1 - (b.idle - a.idle) / dt) * 100) : 0;
};

// Host memory the way `free`/monitoring tools report it. os.freemem() is
// MemFree (excludes reclaimable page cache), which on any Linux box makes RAM
// look ~90% used and would fire false alarms — use MemAvailable instead.
const hostMem = () => {
  try {
    const txt = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (k) => Number((txt.match(new RegExp(`^${k}:\\s+(\\d+) kB`, "m")) || [])[1]);
    const total = kb("MemTotal") * 1024;
    const avail = kb("MemAvailable") * 1024;
    if (total > 0 && avail >= 0) return { total, used: total - avail };
  } catch { /* not Linux */ }
  const total = os.totalmem();
  return { total, used: total - os.freemem() };
};

// Container memory limit/usage (cgroup v2 then v1); null → not containerized
// or no limit set (fall back to host numbers).
const containerMem = () => {
  try {
    const max = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    const used = Number(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim());
    if (max !== "max" && Number(max) > 0) return { limit: Number(max), used };
  } catch { /* not cgroup v2 */ }
  try {
    const limit = Number(fs.readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8").trim());
    const used = Number(fs.readFileSync("/sys/fs/cgroup/memory/memory.usage_in_bytes", "utf8").trim());
    if (limit > 0 && limit < 2 ** 60) return { limit, used };
  } catch { /* not cgroup v1 */ }
  return null;
};

const diskUsage = async (target = "/") => {
  // Node ≥18.15 has fs.statfs; fall back to busybox `df -kP` otherwise.
  try {
    if (fsp.statfs) {
      const s = await fsp.statfs(target);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      return { total, free, used: total - free, pct: pct(total - free, total), source: "statfs" };
    }
  } catch { /* fall through to df */ }
  return new Promise((resolve) => {
    execFile("df", ["-kP", target], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ error: "disk info unavailable" });
      const line = String(stdout).trim().split("\n").pop() || "";
      const parts = line.split(/\s+/);
      const total = Number(parts[1]) * 1024;
      const used = Number(parts[2]) * 1024;
      const free = Number(parts[3]) * 1024;
      resolve({ total, free, used, pct: pct(used, total), source: "df" });
    });
  });
};

// Sizes of the app's top-level directories (uploads, WhatsApp session data,
// node_modules …) — the usual suspects when disk fills up. Cached 30 min.
const dirSizes = () =>
  cached("dirSizes", 30 * 60 * 1000, async () => {
    const cwd = process.cwd();
    let entries;
    try {
      entries = (await fsp.readdir(cwd, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    const duOne = (dir) =>
      new Promise((resolve) => {
        execFile("du", ["-sk", path.join(cwd, dir)], { timeout: 15000 }, (err, stdout) => {
          if (err) return resolve(null);
          const kb = Number(String(stdout).trim().split(/\s+/)[0]);
          resolve(Number.isFinite(kb) ? { dir, bytes: kb * 1024 } : null);
        });
      });
    const sizes = (await Promise.all(entries.map(duOne))).filter(Boolean);
    return sizes.sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  });

const checkServer = async () => {
  // Measure CPU ALONE first. Running it concurrently with the du-heavy
  // dirSizes()/diskUsage() made the 250ms sample catch the health check's OWN
  // snapshot spike → a false ~92% even when the server was idle. Sample CPU in
  // isolation, THEN do the disk/folder scans.
  const cpuPct = await cpuUsagePct();
  const [disk, dirs] = await Promise.all([diskUsage("/"), dirSizes()]);
  const cMem = containerMem();
  const host = hostMem();
  const memUsed = cMem ? cMem.used : host.used;
  const memTotal = cMem ? cMem.limit : host.total;
  const mem = process.memoryUsage();
  return {
    cpu: {
      pct: cpuPct,
      cores: os.cpus().length,
      loadAvg: os.loadavg().map((n) => +n.toFixed(2)),
    },
    memory: {
      pct: pct(memUsed, memTotal),
      used: memUsed,
      total: memTotal,
      source: cMem ? "container" : "host",
      host: { used: host.used, total: host.total, pct: pct(host.used, host.total) },
      process: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    },
    disk: { ...disk },
    dirs: Array.isArray(dirs) ? dirs : [],
    osUptimeSec: Math.round(os.uptime()),
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
  };
};

// -------------------------------- database --------------------------------

const dbPing = async () => {
  const t0 = Date.now();
  try {
    await mongoose.connection.db.admin().ping();
    return { up: true, ms: Date.now() - t0 };
  } catch (e) {
    return { up: false, ms: Date.now() - t0, error: String(e?.message || e) };
  }
};

const checkDatabase = async () => {
  const ping = await withTimeout(dbPing(), 6000, { up: false, ms: 6000, error: "timeout" });
  const readyState = mongoose.connection.readyState; // 1 = connected

  const stats = await cached("dbStats", 5 * 60 * 1000, async () => {
    const s = await mongoose.connection.db.stats();
    return {
      dataSize: s.dataSize,
      storageSize: s.storageSize,
      indexSize: s.indexSize,
      collections: s.collections,
      objects: s.objects,
    };
  });

  // Atlas shared tiers may deny serverStatus — degrade to "unavailable".
  const connections = await cached("dbConn", 2 * 60 * 1000, async () => {
    try {
      const s = await mongoose.connection.db.admin().serverStatus();
      return {
        current: s.connections?.current,
        available: s.connections?.available,
        version: s.version,
      };
    } catch {
      return { unavailable: true };
    }
  });

  const topCollections = await cached("dbTopColl", 10 * 60 * 1000, async () => {
    const names = (await mongoose.connection.db.listCollections().toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith("system."))
      .slice(0, 25);
    const rows = [];
    for (const name of names) {
      try {
        const [st] = await mongoose.connection.db
          .collection(name)
          .aggregate([{ $collStats: { storageStats: {} } }])
          .toArray();
        rows.push({
          name,
          size: st?.storageStats?.size || 0,
          storageSize: st?.storageStats?.storageSize || 0,
          count: st?.storageStats?.count || 0,
        });
      } catch { /* per-collection stats can fail on views */ }
    }
    return rows.sort((a, b) => b.size - a.size).slice(0, 8);
  });

  // Safe write test in its own scratch collection (insert + delete).
  const writeTest = await cached("dbWrite", 5 * 60 * 1000, async () => {
    const t0 = Date.now();
    const coll = mongoose.connection.db.collection("healthchecks");
    const { insertedId } = await coll.insertOne({ at: new Date(), probe: true });
    await coll.deleteOne({ _id: insertedId });
    return { ok: true, ms: Date.now() - t0 };
  });

  return {
    ping,
    readyState,
    stats,
    connections,
    // cached() degrades to an { error } object — keep array fields arrays so
    // neither buildAlertsAndScore nor the frontend has to special-case it.
    topCollections: Array.isArray(topCollections) ? topCollections : [],
    writeTest,
  };
};

// ----------------------------- site / api probes --------------------------

// The frontend is a Cloudflare-served SPA: every route returns the same shell,
// but each probe still proves DNS + TLS + Cloudflare + asset serving work.
const SITE_PAGES = [
  { name: "Ana səhifə", path: "/" },
  { name: "Giriş", path: "/login" },
  { name: "Şagird paneli", path: "/dashboard" },
  { name: "Siniflər", path: "/classes" },
];

const checkSite = () =>
  cached("site", 60 * 1000, async () => {
    const pages = await Promise.all(
      SITE_PAGES.map(async (p) => ({ ...p, ...(await timedFetch(`${SITE_URL}${p.path}`)) }))
    );
    return { url: SITE_URL, pages, checkedAt: Date.now() };
  });

// Reachability of the API itself: internally (is Express alive?) and through
// the full public path (DNS → Caddy → TLS → Express), plus key public routes.
const checkApi = () =>
  cached("api", 60 * 1000, async () => {
    const targets = [
      { name: "API (daxili)", url: `http://127.0.0.1:${PORT}/` },
      { name: "Server vaxtı (imtahan taymerləri)", url: `http://127.0.0.1:${PORT}/api/quiz/server-time` },
      { name: "API (xarici, Caddy + SSL)", url: `${PUBLIC_API_URL}/api/quiz/server-time` },
    ];
    const endpoints = await Promise.all(
      targets.map(async (t) => ({ name: t.name, url: t.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ""), ...(await timedFetch(t.url, { timeoutMs: 8000 })) }))
    );
    return { endpoints, checkedAt: Date.now() };
  });

// ------------------------------------ ssl ---------------------------------

const sslCertInfo = (host) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const sock = tls.connect(
        { host, port: 443, servername: host, rejectUnauthorized: false },
        () => {
          const cert = sock.getPeerCertificate();
          const authorized = sock.authorized;
          sock.end();
          const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
          done({
            host,
            authorized,
            issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
            validTo: validTo ? validTo.toISOString() : null,
            daysLeft: validTo ? Math.floor((validTo.getTime() - Date.now()) / 86400000) : null,
          });
        }
      );
      sock.setTimeout(8000, () => { sock.destroy(); done({ host, error: "timeout" }); });
      sock.on("error", (e) => done({ host, error: String(e?.message || e) }));
    } catch (e) {
      done({ host, error: String(e?.message || e) });
    }
  });

const checkSsl = () =>
  cached("ssl", 6 * 60 * 60 * 1000, async () => {
    const hosts = [new URL(SITE_URL).hostname, new URL(PUBLIC_API_URL).hostname];
    return Promise.all(hosts.map(sslCertInfo));
  });

// ------------------------------ business checks ---------------------------

const DAY = 24 * 60 * 60 * 1000;

const checkBusiness = () =>
  cached("business", 60 * 1000, async () => {
    const since24h = new Date(Date.now() - DAY);
    const since7d = new Date(Date.now() - 7 * DAY);
    const [
      examsActive,
      examsArchived,
      examsHidden,
      classes,
      usersTotal,
      usersNew7d,
      attemptsActive,
      attempts24h,
      results24h,
      lastResult,
      terminated24h,
      videos,
    ] = await Promise.all([
      Exam.countDocuments({ deletedAt: null }),
      Exam.countDocuments({ deletedAt: { $ne: null } }),
      Exam.countDocuments({ deletedAt: null, hidden: true }),
      ClassModel.countDocuments({}),
      User.countDocuments({}),
      User.countDocuments({ createdAt: { $gte: since7d } }),
      Attempt.countDocuments({ submitted: false, unscorable: { $ne: true } }),
      Attempt.countDocuments({ createdAt: { $gte: since24h }, unscorable: { $ne: true } }),
      Result.countDocuments({ createdAt: { $gte: since24h } }),
      Result.findOne({}).sort({ createdAt: -1 }).select("createdAt").lean(),
      Result.countDocuments({ terminated: true, createdAt: { $gte: since24h } }),
      Video.countDocuments({}),
    ]);

    // Media check: is Cloudinary actually serving files? Probe the most
    // recently updated exam cover (read-only HEAD). SSRF guard: coverImage is
    // teacher-supplied, so ONLY https Cloudinary URLs are ever fetched —
    // anything else (internal IPs, other hosts) is skipped, never probed.
    let media = { skipped: true };
    try {
      const isCloudinaryUrl = (u) => {
        try {
          const { protocol, hostname } = new URL(u);
          return protocol === "https:" &&
            (hostname === "res.cloudinary.com" || hostname.endsWith(".cloudinary.com"));
        } catch {
          return false;
        }
      };
      const withCover = await Exam.findOne({ coverImage: { $regex: /^https:\/\/res\.cloudinary\.com\// } })
        .sort({ updatedAt: -1 })
        .select("coverImage")
        .lean();
      if (withCover?.coverImage && isCloudinaryUrl(withCover.coverImage)) {
        const r = await timedFetch(withCover.coverImage, { timeoutMs: 8000, method: "HEAD" });
        media = { ok: r.ok, status: r.status, ms: r.ms, error: r.error };
      }
    } catch (e) {
      media = { ok: false, error: String(e?.message || e) };
    }

    return {
      examsActive,
      examsArchived,
      examsHidden,
      classes,
      usersTotal,
      usersNew7d,
      attemptsActive,
      attempts24h,
      results24h,
      lastResultAt: lastResult?.createdAt || null,
      terminated24h,
      videos,
      media,
      checkedAt: Date.now(),
    };
  });

// ------------------------------ file storage ------------------------------

// uploads/ holds the ONLY copy of every exam PDF (Mongo stores just the URL),
// persisted by the `uploads` Docker volume — so its health matters most.
const checkStorage = () =>
  cached("storage", 5 * 60 * 1000, async () => {
    const dir = path.join(process.cwd(), "uploads");
    const probe = path.join(dir, ".health-write-test");
    let write = { ok: false };
    const t0 = Date.now();
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(probe, String(Date.now()));
      await fsp.readFile(probe, "utf8");
      await fsp.unlink(probe);
      write = { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      write = { ok: false, ms: Date.now() - t0, error: String(e?.message || e) };
    }

    // Inventory of uploaded PDFs (count, size, biggest files). Capped so a
    // pathological directory can't stall the health page.
    let files = { count: 0, bytes: 0, largest: [] };
    try {
      const names = (await fsp.readdir(dir)).slice(0, 3000);
      const stats = [];
      for (const name of names) {
        try {
          const st = await fsp.stat(path.join(dir, name));
          if (st.isFile()) stats.push({ name, bytes: st.size, mtime: st.mtimeMs });
        } catch { /* file may vanish mid-scan */ }
      }
      files = {
        count: stats.length,
        bytes: stats.reduce((a, s) => a + s.bytes, 0),
        largest: stats.sort((a, b) => b.bytes - a.bytes).slice(0, 5)
          .map((s) => ({ name: s.name, bytes: s.bytes })),
      };
    } catch { /* uploads dir unreadable — the write test above already flags it */ }

    // WhatsApp Chromium session data (.wwebjs_auth) — the other disk consumer.
    let waSessions = 0;
    try {
      waSessions = (await fsp.readdir(path.join(process.cwd(), ".wwebjs_auth")))
        .filter((n) => n.startsWith("session-")).length;
    } catch { /* absent unless WhatsApp used */ }

    return { uploadsDir: dir, write, files, waSessions, checkedAt: Date.now() };
  });

// ----------------------------- errors / security --------------------------

const checkDebugLogs = () =>
  cached("debuglogs", 60 * 1000, async () => {
    const since24h = new Date(Date.now() - DAY);
    const since7d = new Date(Date.now() - 7 * DAY);
    const [byKind24h, byKind7d, recent] = await Promise.all([
      DebugLog.aggregate([
        { $match: { createdAt: { $gte: since24h } } },
        { $group: { _id: "$kind", n: { $sum: 1 } } },
      ]),
      DebugLog.aggregate([
        { $match: { createdAt: { $gte: since7d } } },
        { $group: { _id: "$kind", n: { $sum: 1 } } },
      ]),
      DebugLog.find({ kind: { $ne: "login_ok" } })
        .sort({ createdAt: -1 })
        .limit(20)
        .select("kind message path method createdAt")
        .lean(),
    ]);
    const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id || "?", r.n]));
    return { last24h: toMap(byKind24h), last7d: toMap(byKind7d), recent, checkedAt: Date.now() };
  });

// ------------------------------- integrations -----------------------------

// One row per external dependency: { name, configured, ok, detail }.
// ok: true/false = actively probed; null = configured but not probed
// (probing would cost money or isn't meaningful). Nothing here throws.
const checkIntegrations = () =>
  cached("integrations", 15 * 60 * 1000, async () => {
    const list = [];

    // --- Email (SMTP) — same env config as utils/sendEmail.js; verify() opens
    // a real connection to the provider without sending anything.
    const emailEnabled = process.env.EMAIL_ENABLED === "true";
    if (!emailEnabled) {
      list.push({ name: "E-poçt (SMTP)", configured: false, ok: null, detail: "EMAIL_ENABLED deaktivdir — sistem e-poçt göndərmir" });
    } else {
      try {
        const nodemailer = require("nodemailer");
        const transporter = nodemailer.createTransport({
          host: process.env.EMAIL_HOST,
          port: Number(process.env.EMAIL_PORT || 587),
          secure: Number(process.env.EMAIL_PORT) === 465,
          auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
          connectionTimeout: 8000,
        });
        const t0 = Date.now();
        await withTimeout(transporter.verify(), 9000, () => Promise.reject(new Error("timeout")));
        list.push({ name: "E-poçt (SMTP)", configured: true, ok: true, detail: `Qoşulma OK · ${Date.now() - t0}ms` });
      } catch (e) {
        list.push({ name: "E-poçt (SMTP)", configured: true, ok: false, detail: `Qoşulma alınmadı: ${String(e?.message || e).slice(0, 120)}` });
      }
    }

    // --- Telegram bot — tgApi never throws (returns null on failure).
    try {
      const { isTelegramConfigured, tgApi } = require("../helper/telegram");
      if (!isTelegramConfigured()) {
        list.push({ name: "Telegram bot", configured: false, ok: null, detail: "TELEGRAM_BOT_TOKEN qurulmayıb" });
      } else {
        const t0 = Date.now();
        const me = await withTimeout(tgApi("getMe"), 8000, null);
        list.push({
          name: "Telegram bot",
          configured: true,
          ok: !!me,
          detail: me ? `@${me.username || "bot"} aktiv · ${Date.now() - t0}ms` : "getMe cavab vermədi",
        });
      }
    } catch (e) {
      list.push({ name: "Telegram bot", configured: false, ok: null, detail: String(e?.message || e).slice(0, 120) });
    }

    // --- WhatsApp Web (unofficial, per-teacher Chromium sessions).
    const waEnabled = process.env.WHATSAPP_WEB_ENABLED === "true";
    let waSessions = 0;
    try {
      waSessions = fs.readdirSync(path.join(process.cwd(), ".wwebjs_auth"))
        .filter((n) => n.startsWith("session-")).length;
    } catch { /* no sessions yet */ }
    list.push({
      name: "WhatsApp Web",
      configured: waEnabled,
      ok: null,
      detail: waEnabled
        ? `${waSessions} qoşulmuş müəllim sessiyası (maks ${process.env.WHATSAPP_MAX_SESSIONS || 5})`
        : "WHATSAPP_WEB_ENABLED deaktivdir",
    });

    // --- Stripe — read-only balance ping (null-guarded like quizController).
    if (!process.env.STRIPE_KEY) {
      list.push({ name: "Stripe (ödənişlər)", configured: false, ok: null, detail: "STRIPE_KEY qurulmayıb" });
    } else {
      try {
        const stripe = require("stripe")(process.env.STRIPE_KEY);
        const t0 = Date.now();
        await withTimeout(stripe.balance.retrieve(), 8000, () => Promise.reject(new Error("timeout")));
        list.push({ name: "Stripe (ödənişlər)", configured: true, ok: true, detail: `API OK · ${Date.now() - t0}ms` });
      } catch (e) {
        list.push({ name: "Stripe (ödənişlər)", configured: true, ok: false, detail: String(e?.message || e).slice(0, 120) });
      }
    }

    // --- AI providers: configured flags + today's spend from AiUsage.
    // No live probe — a real call would cost money every refresh.
    let spend = { usd: 0, calls: 0 };
    try {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const agg = await AiUsage.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: null, usd: { $sum: "$usd" }, calls: { $sum: 1 } } },
      ]);
      spend = { usd: agg[0]?.usd || 0, calls: agg[0]?.calls || 0 };
    } catch { /* spend unavailable */ }
    const aiProviders = [
      process.env.ANTHROPIC_API_KEY && "Anthropic",
      process.env.OPENAI_API_KEY && "OpenAI",
      process.env.GEMINI_API_KEY && "Gemini",
    ].filter(Boolean);
    list.push({
      name: "AI provayderlər",
      configured: aiProviders.length > 0,
      ok: null,
      detail: aiProviders.length
        ? `${aiProviders.join(", ")} · bu gün $${spend.usd.toFixed(2)} / ${spend.calls} sorğu · limit $${process.env.AI_DAILY_USD_CAP || 3}/gün/istifadəçi`
        : "Heç bir AI açarı qurulmayıb",
    });

    // --- Google OAuth login.
    list.push({
      name: "Google ilə giriş",
      configured: !!process.env.GOOGLE_CLIENT_ID,
      ok: null,
      detail: process.env.GOOGLE_CLIENT_ID ? "Qurulub" : "GOOGLE_CLIENT_ID yoxdur",
    });

    return { list, checkedAt: Date.now() };
  });

// ------------------------------ alerts & score ----------------------------

const T = {
  cpuWarn: 70, cpuCrit: 90,
  memWarn: 75, memCrit: 90,
  diskWarn: 75, diskCrit: 90, diskEmergency: 95,
  dbPingWarn: 300, dbPingCrit: 1000,
  siteMsWarn: 1500, siteMsCrit: 4000,
  err5Warn: 1, err5Crit: 5, // % of requests, last hour
  sslWarnDays: 30, sslCritDays: 7,
};

const sev = { info: 0, warning: 1, critical: 2, down: 3 };

const buildAlertsAndScore = (d) => {
  const alerts = [];
  const add = (severity, service, message, suggestedAction, value, threshold) =>
    alerts.push({ severity, service, message, suggestedAction, value, threshold, at: Date.now() });

  let score = 100;
  const dock = (n) => { score -= n; };

  // ---- site availability (weight ~20)
  const sitePages = d.site?.pages || [];
  const siteDown = sitePages.length > 0 && sitePages.every((p) => !p.ok);
  const someSiteSlow = sitePages.some((p) => p.ok && p.ms > T.siteMsWarn);
  if (siteDown) {
    add("down", "Sayt", "bunkermath.az serverdən açılmır", "Cloudflare statusunu və DNS-i yoxlayın", "offline", "online");
    dock(20);
  } else if (sitePages.some((p) => !p.ok)) {
    add("warning", "Sayt", "Bəzi səhifə yoxlamaları uğursuz oldu", "Cloudflare-də son deploy-u yoxlayın");
    dock(8);
  } else if (someSiteSlow) {
    add("warning", "Sayt", `Sayt cavabı yavaşdır (>${T.siteMsWarn}ms)`, "Cloudflare keşini və şəbəkəni yoxlayın");
    dock(4);
  }

  // ---- API public path
  const apiRows = d.api?.endpoints || [];
  const publicApi = apiRows.find((r) => r.name.includes("xarici"));
  if (publicApi && !publicApi.ok) {
    add("critical", "API", "api.bunkermath.az xaricdən açılmır (Caddy/DNS/SSL)", "Serverdə `docker compose ps` və Caddy loglarına baxın");
    dock(12);
  }
  const internalApi = apiRows.find((r) => r.name.includes("daxili"));
  if (internalApi && !internalApi.ok) {
    add("critical", "API", "Express daxili sorğuya cavab vermir", "Konteyneri yenidən başladın: docker compose restart backend");
    dock(8);
  }

  // ---- resources (weight ~20)
  const cpu = d.server?.cpu?.pct;
  if (cpu != null) {
    if (cpu >= T.cpuCrit) { add("critical", "Server", `CPU ${cpu}%`, "Ağır prosesləri yoxlayın və ya serveri böyüdün", `${cpu}%`, `${T.cpuCrit}%`); dock(7); }
    else if (cpu >= T.cpuWarn) { add("warning", "Server", `CPU ${cpu}%`, "Yük davam edərsə serveri izləyin", `${cpu}%`, `${T.cpuWarn}%`); dock(3); }
  }
  const mem = d.server?.memory?.pct;
  if (mem != null) {
    if (mem >= T.memCrit) { add("critical", "Server", `RAM ${mem}%`, "Konteyneri yenidən başladın və ya RAM artırın", `${mem}%`, `${T.memCrit}%`); dock(7); }
    else if (mem >= T.memWarn) { add("warning", "Server", `RAM ${mem}%`, "Yaddaş sızması ehtimalını izləyin", `${mem}%`, `${T.memWarn}%`); dock(3); }
  }
  const disk = d.server?.disk?.pct;
  if (disk != null) {
    const freeGb = d.server?.disk?.free != null ? (d.server.disk.free / GB).toFixed(1) : "?";
    if (disk >= T.diskEmergency) { add("critical", "Disk", `Disk ${disk}% dolu — boş yer cəmi ${freeGb} GB`, "Köhnə logları/temp faylları silin və ya diski böyüdün", `${disk}%`, `${T.diskEmergency}%`); dock(10); }
    else if (disk >= T.diskCrit) { add("critical", "Disk", `Disk ${disk}% dolu (${freeGb} GB boş)`, "Köhnə logları və lazımsız faylları təmizləyin", `${disk}%`, `${T.diskCrit}%`); dock(8); }
    else if (disk >= T.diskWarn) { add("warning", "Disk", `Disk ${disk}% dolu (${freeGb} GB boş)`, "Disk artımını izləyin", `${disk}%`, `${T.diskWarn}%`); dock(4); }
  }

  // ---- database (weight ~15)
  const dbUp = d.database?.ping?.up;
  const dbMs = d.database?.ping?.ms;
  if (!dbUp) {
    add("down", "Verilənlər bazası", "MongoDB-yə qoşulmaq mümkün olmadı", "Atlas statusunu və MONGO_URI-ni yoxlayın");
    dock(15);
  } else if (dbMs >= T.dbPingCrit) {
    add("critical", "Verilənlər bazası", `DB cavabı ${dbMs}ms`, "Atlas metriklərinə baxın; yavaş sorğuları yoxlayın", `${dbMs}ms`, `${T.dbPingCrit}ms`);
    dock(8);
  } else if (dbMs >= T.dbPingWarn) {
    add("warning", "Verilənlər bazası", `DB cavabı ${dbMs}ms`, "Davam edərsə Atlas tier-ini yoxlayın", `${dbMs}ms`, `${T.dbPingWarn}ms`);
    dock(4);
  }
  if (d.database?.writeTest && d.database.writeTest.ok === false) {
    add("critical", "Verilənlər bazası", "Yazma testi alınmadı", "Atlas disk kvotasını / icazələri yoxlayın");
    dock(5);
  }

  // ---- request errors (weight ~15)
  const p = d.performance?.lastHour;
  if (p?.count > 20) {
    if (p.rate5xxPct >= T.err5Crit) { add("critical", "API", `5xx nisbəti ${p.rate5xxPct}% (son 1 saat)`, "Xəta cədvəlinə baxın; son deploy-u nəzərdən keçirin", `${p.rate5xxPct}%`, `${T.err5Crit}%`); dock(10); }
    else if (p.rate5xxPct >= T.err5Warn) { add("warning", "API", `5xx nisbəti ${p.rate5xxPct}% (son 1 saat)`, "Xəta qruplarını nəzərdən keçirin", `${p.rate5xxPct}%`, `${T.err5Warn}%`); dock(5); }
    if (p.avgMs > 2000) { add("warning", "API", `Orta cavab müddəti ${p.avgMs}ms`, "Ən yavaş endpointləri optimallaşdırın"); dock(4); }
  }

  // ---- jobs (weight ~10)
  for (const j of d.jobs || []) {
    if (j.status === "overdue") { add("critical", "Fon işləri", `"${j.name}" vaxtında işləmir`, "Serveri yenidən başladın; loglara baxın"); dock(4); }
    else if (j.status === "failing") { add("warning", "Fon işləri", `"${j.name}" son işə düşmədə xəta verdi: ${j.lastError || ""}`, "Loglara baxın"); dock(2); }
  }

  // ---- ssl (weight ~5)
  for (const s of d.ssl || []) {
    if (s.error) { add("warning", "SSL", `${s.host}: sertifikat oxunmadı (${s.error})`, "Domenin SSL-ini yoxlayın"); dock(2); }
    else if (s.daysLeft != null && s.daysLeft <= T.sslCritDays) { add("critical", "SSL", `${s.host} sertifikatı ${s.daysLeft} günə bitir`, "Sertifikatı yeniləyin (Caddy/Cloudflare avtomatik etməlidir — yoxlayın)", `${s.daysLeft} gün`, `${T.sslCritDays} gün`); dock(4); }
    else if (s.daysLeft != null && s.daysLeft <= T.sslWarnDays) { add("warning", "SSL", `${s.host} sertifikatı ${s.daysLeft} günə bitir`, "Avtomatik yenilənməni izləyin", `${s.daysLeft} gün`, `${T.sslWarnDays} gün`); dock(1); }
  }

  // ---- storage / media (weight ~5)
  if (d.storage?.write && d.storage.write.ok === false) {
    add("critical", "Fayllar", "uploads qovluğuna yazmaq mümkün olmadı", "Disk dolub? İcazələri yoxlayın");
    dock(4);
  }
  if (d.business?.media && d.business.media.ok === false) {
    add("warning", "Fayllar", "Cloudinary şəkil yoxlaması uğursuz oldu", "Cloudinary statusunu yoxlayın");
    dock(2);
  }

  // ---- integrations (weight ~5): only actively-probed failures alert.
  for (const it of d.integrations?.list || []) {
    if (it.configured && it.ok === false) {
      add("warning", "İnteqrasiyalar", `${it.name}: ${it.detail}`, "Provayderin statusunu və açarları yoxlayın");
      dock(2);
    }
  }

  // ---- auth failures (security signal)
  const authFails24h = (d.errors?.debug?.last24h?.auth_invalid_token || 0);
  if (authFails24h > 200) {
    add("warning", "Təhlükəsizlik", `Son 24 saatda ${authFails24h} etibarsız token cəhdi`, "Qeyri-adi IP aktivliyini yoxlayın");
    dock(2);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Overall status: worst active severity wins; DB or site down ⇒ down.
  let status = "healthy";
  if (alerts.some((a) => a.severity === "down")) status = "down";
  else if (alerts.some((a) => a.severity === "critical")) status = "critical";
  else if (alerts.some((a) => a.severity === "warning")) status = "warning";

  alerts.sort((a, b) => sev[b.severity] - sev[a.severity]);
  return { alerts, score, status };
};

// ------------------------------ uptime history ----------------------------

const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

const uptimeWindow = async (ms) => {
  const since = new Date(Date.now() - ms);
  const [first, got, siteUpCount] = await Promise.all([
    // Count "expected" samples from when monitoring actually began inside the
    // window — otherwise a freshly-deployed sampler would read as 30 days of
    // downtime on the 30-day view.
    HealthSnapshot.findOne({ at: { $gte: since } }).sort({ at: 1 }).select("at").lean(),
    HealthSnapshot.countDocuments({ at: { $gte: since } }),
    HealthSnapshot.countDocuments({ at: { $gte: since }, siteUp: true }),
  ]);
  if (!first) return { expected: 0, got: 0, sitePct: null, apiPct: null };
  const expected = Math.max(1, Math.floor((Date.now() - new Date(first.at).getTime()) / SAMPLE_INTERVAL_MS) + 1);
  return {
    expected,
    got,
    sitePct: got > 0 ? +((siteUpCount / got) * 100).toFixed(2) : null,
    apiPct: +Math.min(100, (got / expected) * 100).toFixed(2),
  };
};

// Called by the scheduler in server.js every 5 minutes (wrapped in beat()).
const sampleHealth = async () => {
  const [site, ping, cpuPct, disk] = await Promise.all([
    timedFetch(`${SITE_URL}/`, { timeoutMs: 10000 }),
    withTimeout(dbPing(), 6000, { up: false, ms: 6000 }),
    cpuUsagePct(),
    diskUsage("/"),
  ]);
  const cMem = containerMem();
  const host = hostMem();
  const memTotal = cMem ? cMem.limit : host.total;
  const memUsed = cMem ? cMem.used : host.used;
  let status = "healthy";
  if (!ping.up) status = "down";
  else if (!site.ok) status = "down";
  else if ((disk.pct ?? 0) >= T.diskCrit || (cpuPct ?? 0) >= T.cpuCrit) status = "critical";
  else if ((disk.pct ?? 0) >= T.diskWarn || (cpuPct ?? 0) >= T.cpuWarn || site.ms > T.siteMsWarn) status = "warning";
  await HealthSnapshot.create({
    at: new Date(),
    siteUp: !!site.ok,
    siteMs: site.ms,
    siteStatus: site.status,
    dbUp: ping.up,
    dbMs: ping.ms,
    cpuPct,
    memPct: pct(memUsed, memTotal),
    diskPct: disk.pct ?? null,
    status,
  });
};

// --------------------------------- handlers -------------------------------

const getHealth = asyncHandler(async (req, res) => {
  const fresh = req.query.fresh === "1";
  if (fresh) cacheStore.delete("healthFull");
  const payload = await cached("healthFull", 20 * 1000, async () => {
    const t0 = Date.now();
    const [server, database, site, api, ssl, business, storage, debug, integrations, uptime24, uptime7d, uptime30d] =
      await Promise.all([
        withTimeout(checkServer(), 12000, { error: "timeout" }),
        withTimeout(checkDatabase(), 12000, { ping: { up: false, error: "timeout" } }),
        withTimeout(checkSite(), 15000, { pages: [], error: "timeout" }),
        withTimeout(checkApi(), 12000, { endpoints: [], error: "timeout" }),
        withTimeout(checkSsl(), 12000, []),
        withTimeout(checkBusiness(), 12000, { error: "timeout" }),
        withTimeout(checkStorage(), 8000, { error: "timeout" }),
        withTimeout(checkDebugLogs(), 8000, { error: "timeout" }),
        withTimeout(checkIntegrations(), 10000, { list: [] }),
        withTimeout(uptimeWindow(DAY), 6000, null),
        withTimeout(uptimeWindow(7 * DAY), 6000, null),
        withTimeout(uptimeWindow(30 * DAY), 6000, null),
      ]);

    const performance = getMetrics();
    const jobs = getJobs();
    const errors = { groups: performance.errorGroups, debug };
    const sslArr = Array.isArray(ssl) ? ssl : [];

    const d = { server, database, site, api, ssl: sslArr, business, storage, performance, jobs, errors, integrations };
    const { alerts, score, status } = buildAlertsAndScore(d);

    return {
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
      overall: { status, score },
      alerts,
      meta: {
        env: process.env.NODE_ENV || "production",
        version: pkg.version,
        commit: process.env.GIT_COMMIT || null,
        node: process.version,
        serverTime: new Date().toISOString(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        processStartedAt: new Date(performance.startedAt).toISOString(),
        processUptimeSec: Math.round(process.uptime()),
        hostname: server?.hostname,
      },
      uptime: { d1: uptime24, d7: uptime7d, d30: uptime30d, sampleIntervalMin: 5 },
      site,
      api,
      server,
      performance: {
        lastHour: performance.lastHour,
        last15min: performance.last15min,
        perMinute: performance.perMinute,
        slowestRoutes: performance.slowestRoutes,
        busiestRoutes: performance.busiestRoutes,
        totalRequests: performance.totalRequests,
      },
      database,
      business,
      storage,
      integrations,
      jobs,
      errors,
      ssl: sslArr,
      backups: {
        provider: "MongoDB Atlas",
        note: "Ehtiyat nüsxələr Atlas tərəfindən avtomatik idarə olunur (cloud.mongodb.com → Backup). Fayllar Cloudinary-də saxlanılır.",
      },
    };
  });
  res.json(payload);
});

// Snapshot series for charts: ?hours=24 (default) | 168 | 720
const getHealthHistory = asyncHandler(async (req, res) => {
  const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 24));
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const rows = await HealthSnapshot.find({ at: { $gte: since } })
    .sort({ at: 1 })
    .select("-_id at siteUp siteMs dbUp dbMs cpuPct memPct diskPct status")
    .lean();
  res.json({ hours, sampleIntervalMin: 5, rows });
});

module.exports = { getHealth, getHealthHistory, sampleHealth };
