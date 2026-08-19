// PER-TEACHER WhatsApp integration via whatsapp-web.js (unofficial — drives
// WhatsApp Web with a headless Chromium session). Each TEACHER links their OWN
// number (own QR) and picks their OWN notify group; a new-exam alert is sent to
// the EXAM OWNER's group (with the class join code). One Chromium per linked
// teacher, so sessions are capped and started lazily / re-linked on boot.
//
// ⚠️ Automated/bulk sending is against WhatsApp's ToS and can get a number
// BANNED. Low-volume + opt-in only (we throttle and prefer a single group post).
//
// Gated by WHATSAPP_WEB_ENABLED ("true"); a no-op otherwise (safe locally).
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const Exam = require("../models/examModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const User = require("../models/userModel");

const ENABLED = process.env.WHATSAPP_WEB_ENABLED === "true";
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
const AUTH_ROOT = path.join(process.cwd(), ".wwebjs_auth");
// Cap concurrent headless Chromium sessions to protect a small server.
const MAX_SESSIONS = Number(process.env.WHATSAPP_MAX_SESSIONS || 5);
// Pin the WhatsApp Web build whatsapp-web.js loads. Left unpinned, the library
// follows WhatsApp's LATEST build, so WhatsApp can hot-swap the page version
// mid-session — which crashes getChats() ("Target closed" / "context
// destroyed") and breaks sends. Pinning to a FIXED, currently-valid build (from
// the wppconnect wa-version mirror) stops the mid-session reloads.
//
// Driven by env (no hardcoded default) on purpose: a hardcoded version would
// 404 once the mirror prunes it and then break WhatsApp entirely. Set
// WHATSAPP_WEB_VERSION to a version that exists at
// https://github.com/wppconnect-team/wa-version/tree/main/html ; clear it to
// fall back to the library default.
const WWEB_VERSION = (process.env.WHATSAPP_WEB_VERSION || "").trim();

// ownerId(string) -> { client, ready, lastQrDataUrl, starting, readyTimer, reconnectTimer }
const sessions = new Map();

// CR-117: once lifecycleShutdown runs, no session may schedule a NEW reconnect or
// start a NEW Chromium. shutdownWhatsapp() sets this, clears every per-session timer,
// and destroys clients WITHOUT logging users out (auth on disk is preserved for the
// next boot's initPersistedSessions).
let shuttingDown = false;

// Normalize a stored phone to bare international digits ("994501234567").
function toDigits(raw) {
  let s = String(raw || "").trim();
  const hadPlus = s.startsWith("+");
  s = s.replace(/\D/g, "");
  if (!s) return null;
  if (!hadPlus) {
    if (s.startsWith("00")) s = s.slice(2);
    else if (s.startsWith("0")) s = "994" + s.slice(1);
    else if (s.length === 9) s = "994" + s;
  }
  return s.length >= 8 ? s : null;
}

function getSession(ownerId) {
  const id = String(ownerId);
  let s = sessions.get(id);
  if (!s) {
    s = {
      client: null,
      ready: false,
      lastQrDataUrl: null,
      starting: false,
      readyTimer: null,
      reconnectTimer: null,
      // UX/resilience state: `connecting` = scanned, loading the account (not
      // ready yet); `loadingPct` from the WA loading screen; `startTimer` watches
      // for a hung start (no QR, no connect); `initRetries`/`lastError` bound the
      // auto-recovery from transient Chromium failures.
      connecting: false,
      loadingPct: 0,
      startTimer: null,
      initRetries: 0,
      lastError: null,
    };
    sessions.set(id, s);
  }
  return s;
}

// Number of sessions currently holding (or starting) a Chromium.
function liveCount() {
  let n = 0;
  for (const s of sessions.values()) if (s.client || s.starting) n += 1;
  return n;
}

// True once a teacher has a session profile on disk — i.e. they have actually
// been through the "Connect WhatsApp" flow (LocalAuth writes session-<ownerId>
// on first initialize). Used to keep the new-exam notifier from EVER creating a
// fresh Chromium profile for a teacher who never opted in: booting one on every
// exam creation wrote a ~100 MB dead profile per exam-owner and ballooned the
// wa_auth volume. The notifier now only re-wakes a profile that already exists.
function hasPersistedSession(ownerId) {
  try {
    return fs.existsSync(path.join(AUTH_ROOT, `session-${String(ownerId)}`));
  } catch {
    return false;
  }
}

// LocalAuth with clientId=ownerId persists to .wwebjs_auth/session-<ownerId>.
function clearStaleLocks(ownerId) {
  const dir = path.join(AUTH_ROOT, `session-${ownerId}`);
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      fs.rmSync(path.join(dir, f), { force: true, recursive: true });
    } catch {
      /* ignore */
    }
  }
}

// Auto-recover a transient start/init failure (WhatsApp 2.3000.x frequently
// destroys the execution context mid-inject on a session restore). Bounded so a
// genuinely broken session can't loop a headless browser forever — after the cap
// the session stops with `lastError` and the admin re-links / hits "refresh".
function scheduleInitRetry(s, id, reason) {
  if (shuttingDown) return;
  const MAX = Number(process.env.WHATSAPP_INIT_RETRIES || 4);
  if ((s.initRetries || 0) >= MAX) {
    // Self-heal against a stale version pin: a forced-but-outdated WhatsApp Web
    // build keeps failing init with "Execution context was destroyed". Before
    // giving up, drop the pin and retry with the LIVE version (always current),
    // so a drifted pin can never permanently dead-end the connection.
    if (WWEB_VERSION && !s.noPin) {
      s.noPin = true;
      s.initRetries = 0;
      s.lastError = null;
      console.warn(`[WHATSAPP] ${id} pinned start failed ${MAX}×; switching to LIVE WhatsApp Web version`);
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = setTimeout(() => { if (!shuttingDown) initFor(id); }, 3000);
      return;
    }
    s.lastError = reason || "start_failed";
    console.warn(`[WHATSAPP] ${id} giving up after ${s.initRetries} tries (${reason}) — refresh to retry`);
    return;
  }
  s.initRetries = (s.initRetries || 0) + 1;
  const delay = Math.min(30000, 4000 * s.initRetries);
  console.log(`[WHATSAPP] ${id} auto-retry ${s.initRetries}/${MAX} in ${Math.round(delay / 1000)}s (${reason})`);
  clearTimeout(s.reconnectTimer);
  s.reconnectTimer = setTimeout(() => { if (!shuttingDown) initFor(id); }, delay);
}

// Boot (or re-boot) a teacher's WhatsApp client. Safe to call repeatedly.
function initFor(ownerId) {
  if (!ENABLED || !ownerId || shuttingDown) return; // CR-117: never start a new client during shutdown
  const id = String(ownerId);
  const s = getSession(id);
  if (s.client || s.starting) return;
  if (liveCount() >= MAX_SESSIONS) {
    console.warn(`[WHATSAPP] session cap (${MAX_SESSIONS}) reached — not starting ${id}`);
    return;
  }
  s.starting = true;
  s.qrLogged = false; // log the next QR once
  clearStaleLocks(id);

  let Client, LocalAuth;
  try {
    ({ Client, LocalAuth } = require("whatsapp-web.js"));
  } catch (e) {
    console.error("[WHATSAPP] whatsapp-web.js unavailable:", e.message);
    s.starting = false;
    return;
  }

  // Force the pinned build UNLESS this session already fell back to live (the
  // pin drifted stale and kept destroying the execution context — see
  // scheduleInitRetry). noPin sessions load whatever WhatsApp Web serves today.
  const usePin = !!WWEB_VERSION && !s.noPin;
  console.log(`[WHATSAPP] ${id} starting (${usePin ? `pin=${WWEB_VERSION}` : "live version"})`);
  s.client = new Client({
    authStrategy: new LocalAuth({ clientId: id, dataPath: AUTH_ROOT }),
    // Stop endlessly re-issuing a QR for a session nobody scans (~10 × 20s ≈ 3
    // min); after that the client gives up (we won't auto-reconnect it below).
    qrMaxRetries: Number(process.env.WHATSAPP_QR_MAX_RETRIES || 10),
    // Pin a known-good WhatsApp Web build (see WWEB_VERSION above), unless we've
    // fallen back to the live version for this session.
    ...(usePin
      ? {
          webVersion: WWEB_VERSION,
          webVersionCache: {
            type: "remote",
            remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${WWEB_VERSION}.html`,
          },
        }
      : {}),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      // Give Chromium room on a small server: a session RESTORE after a restart
      // can exceed the default and fail with "Runtime.callFunctionOn timed out",
      // which left the QR stuck. A longer protocol timeout survives that.
      protocolTimeout: Number(process.env.WHATSAPP_PROTOCOL_TIMEOUT || 180000),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
      ],
    },
  });

  s.client.on("qr", async (qr) => {
    s.ready = false;
    s.connecting = false;
    s.lastError = null;
    clearTimeout(s.startTimer); // a QR appeared → the start didn't hang
    clearTimeout(s.readyTimer); // waiting for a human to scan
    try {
      s.lastQrDataUrl = await QRCode.toDataURL(qr);
    } catch {
      s.lastQrDataUrl = null;
    }
    // Log only the FIRST QR per session — whatsapp-web.js re-emits a fresh QR
    // every ~20s while waiting, which otherwise floods the logs.
    if (!s.qrLogged) {
      console.log(`[WHATSAPP] QR ready for teacher ${id} — scan it in the dashboard.`);
      s.qrLogged = true;
    }
  });
  s.client.on("authenticated", () => {
    s.everAuthed = true;
    s.qrLogged = false;
    // The QR was scanned — drop it (so the dashboard stops showing it) and flip
    // to the "connecting / loading account" state the UI renders as a loader.
    s.lastQrDataUrl = null;
    s.connecting = true;
    s.loadingPct = s.loadingPct || 5;
    s.lastError = null;
    clearTimeout(s.startTimer);
    console.log(`[WHATSAPP] ${id} authenticated`);
    clearTimeout(s.readyTimer);
    s.readyTimer = setTimeout(() => {
      if (!s.ready) {
        console.warn(`[WHATSAPP] ${id} not ready 90s after auth — restarting`);
        restartFor(id);
      }
    }, 90000);
  });
  s.client.on("ready", async () => {
    s.ready = true;
    s.lastQrDataUrl = null;
    s.connecting = false;
    s.loadingPct = 100;
    s.initRetries = 0;
    s.lastError = null;
    clearTimeout(s.startTimer);
    clearTimeout(s.readyTimer);
    console.log(`[WHATSAPP] ${id} client ready (pin=${WWEB_VERSION || "none"})`);
    try {
      const v = await s.client.getWWebVersion();
      console.log(`[WHATSAPP][DEBUG] ${id} loaded WWeb version=${v}; me=${s.client.info?.wid?._serialized || "?"}`);
    } catch (e) {
      console.warn(`[WHATSAPP][DEBUG] ${id} getWWebVersion failed:`, e.message);
    }
  });
  s.client.on("loading_screen", (pct, msg) => {
    s.connecting = true;
    const n = Number(pct);
    if (Number.isFinite(n)) s.loadingPct = n;
    clearTimeout(s.startTimer);
    console.log(`[WHATSAPP][DEBUG] ${id} loading ${pct}% ${msg || ""}`);
  });
  s.client.on("change_state", (st) => console.log(`[WHATSAPP][DEBUG] ${id} state=${st}`));
  s.client.on("auth_failure", (m) => console.error(`[WHATSAPP] ${id} auth failure:`, m));
  s.client.on("disconnected", (reason) => {
    console.error(`[WHATSAPP] ${id} disconnected:`, reason);
    const wasLinked = s.everAuthed;
    s.ready = false;
    s.client = null;
    s.starting = false;
    s.qrLogged = false;
    s.connecting = false;
    clearTimeout(s.startTimer);
    clearTimeout(s.readyTimer);
    // Only auto-reconnect a session that was actually LINKED (survive network
    // blips). A never-scanned session that ran out of QR retries is left
    // stopped — the teacher re-links on demand from the dashboard — so we don't
    // loop a headless browser + QR forever. CR-117: never reconnect during shutdown,
    // and TRACK the timer so lifecycleShutdown can clear it.
    if (wasLinked && !shuttingDown) s.reconnectTimer = setTimeout(() => { if (!shuttingDown) initFor(id); }, 10000);
    else if (!wasLinked) console.log(`[WHATSAPP] ${id} not linked — stopped (re-link from dashboard).`);
  });

  // Start watchdog: if this start neither shows a QR nor connects within the
  // window, the Chromium/init has HUNG (a known 2.3000.x failure) — recycle it and
  // auto-retry, instead of leaving the dashboard stuck on "QR hazırlanır…".
  const START_TIMEOUT = Number(process.env.WHATSAPP_START_TIMEOUT_MS || 75000);
  clearTimeout(s.startTimer);
  s.startTimer = setTimeout(async () => {
    if (shuttingDown || s.ready || s.lastQrDataUrl || s.connecting) return;
    console.warn(`[WHATSAPP] ${id} no QR/connect ${Math.round(START_TIMEOUT / 1000)}s after start — recycling`);
    const old = s.client;
    s.client = null;
    s.starting = false;
    try {
      if (old) await old.destroy();
    } catch {
      /* ignore */
    }
    clearStaleLocks(id);
    scheduleInitRetry(s, id, "no_qr_timeout");
  }, START_TIMEOUT);

  s.client.initialize().catch((e) => {
    console.error(`[WHATSAPP] ${id} initialize failed:`, e.message);
    clearTimeout(s.startTimer);
    s.ready = false;
    s.client = null;
    s.starting = false;
    s.connecting = false;
    scheduleInitRetry(s, id, "init_failed");
  });
}

// Force a clean restart for a stuck session (manual "refresh QR" from the
// dashboard): reset the retry budget + error, then recycle.
function refreshFor(ownerId) {
  const s = getSession(String(ownerId));
  s.initRetries = 0;
  s.lastError = null;
  clearTimeout(s.reconnectTimer);
  restartFor(String(ownerId));
}

// Tear down a stuck client and re-init (watchdog for the flaky "authenticated
// but never ready" reconnect state).
function restartFor(ownerId) {
  const id = String(ownerId);
  if (shuttingDown) return; // CR-117: no restarts once shutting down
  const s = getSession(id);
  clearTimeout(s.readyTimer);
  const old = s.client;
  s.client = null;
  s.ready = false;
  s.starting = false;
  s.lastQrDataUrl = null;
  Promise.resolve().then(async () => {
    try {
      if (old) await old.destroy();
    } catch {
      /* ignore */
    }
    clearStaleLocks(id);
    if (!shuttingDown) s.reconnectTimer = setTimeout(() => { if (!shuttingDown) initFor(id); }, 3000);
  });
}

const getStatusFor = (ownerId) => {
  const s = getSession(ownerId);
  return {
    enabled: ENABLED,
    ready: s.ready,
    hasQr: !!s.lastQrDataUrl,
    connecting: !!s.connecting && !s.ready,
    loadingPct: s.loadingPct || 0,
    error: !!s.lastError,
  };
};
const getQrFor = (ownerId) => getSession(ownerId).lastQrDataUrl;

// Unlink a teacher's number (forces a fresh QR on next init).
async function logoutFor(ownerId) {
  const s = getSession(ownerId);
  if (!s.client) return;
  try {
    await s.client.logout();
  } catch {
    /* ignore */
  }
  s.ready = false;
  s.lastQrDataUrl = null;
  s.client = null;
  s.starting = false;
}

// Send plain text from a teacher's session to a chat id ("<digits>@c.us" or
// "<id>@g.us"). Returns true on success.
async function sendForOwner(ownerId, chatId, text) {
  const s = getSession(ownerId);
  if (!s.ready || !s.client || !chatId) return false;
  try {
    await s.client.sendMessage(chatId, text);
    console.log(`[WHATSAPP] message sent for owner ${ownerId}`);
    return true;
  } catch {
    // Do not log the destination, message, or upstream error: WhatsApp errors
    // can echo phone numbers and message metadata.
    console.error(`[WHATSAPP] message send failed for owner ${ownerId}`);
    return false;
  }
}

// Send one message from a teacher's session to a phone number. Resolve the
// canonical WhatsApp id first (getNumberId) — sending to a raw "<digits>@c.us"
// is what triggers "No LID for user" on the current WhatsApp Web; the resolved
// id avoids it (and also confirms the number is actually on WhatsApp).
async function sendMessageFor(ownerId, phone, text) {
  const digits = toDigits(phone);
  if (!digits) return false;
  const s = getSession(ownerId);
  let chatId = `${digits}@c.us`;
  try {
    if (s.ready && s.client && typeof s.client.getNumberId === "function") {
      const wid = await s.client.getNumberId(digits);
      if (wid && wid._serialized) chatId = wid._serialized;
      else console.warn(`[WHATSAPP] recipient is not registered on WhatsApp (owner ${ownerId})`);
    }
  } catch {
    console.warn(`[WHATSAPP] recipient lookup failed for owner ${ownerId}`);
  }
  return sendForOwner(ownerId, chatId, text);
}

// Given candidate owner ids, return the first one whose WhatsApp session is
// linked AND ready (client up). Used by the auto-outreach watcher to pick a
// live admin session to send from; returns null if NONE are ready (→ the
// watcher stops without sending, per "if wp isn't linked, don't try").
function firstReadyOwner(ownerIds) {
  for (const id of ownerIds || []) {
    const s = sessions.get(String(id));
    if (s && s.ready && s.client) return String(id);
  }
  return null;
}

// A single admin can link a SECOND WhatsApp number in a separate "slot". Slot 1
// keeps the bare owner id (so an already-linked number needs NO re-scan); slot 2
// gets a filesystem-safe suffix. LocalAuth.clientId must match /^[-_\w]+$/, so the
// suffix uses only word chars — no colon, which would break Windows/Docker auth
// paths (.wwebjs_auth/session-<id>__wa2).
function accountKey(ownerId, slot) {
  const id = String(ownerId);
  return Number(slot) === 2 ? `${id}__wa2` : id;
}

// All given owner keys whose session is linked AND ready, in order.
function readyOwners(ownerIds) {
  const out = [];
  for (const id of ownerIds || []) {
    const s = sessions.get(String(id));
    if (s && s.ready && s.client) out.push(String(id));
  }
  return out;
}

// Round-robin over the ready sessions so auto-outreach alternates between the
// linked numbers "1 by 1" — spreading volume across numbers lowers per-number
// ban risk. A module-level cursor advances each call; null when NONE are ready.
let rrCursor = 0;
function nextReadyOwner(ownerIds) {
  const ready = readyOwners(ownerIds);
  if (!ready.length) return null;
  const pick = ready[rrCursor % ready.length];
  rrCursor = (rrCursor + 1) % ready.length;
  return pick;
}

// Send one outreach message, reporting WHY it didn't go through so the watcher
// can act differently per outcome. Returns:
//   "sent"        — delivered to WhatsApp
//   "no_whatsapp" — number is not registered on WhatsApp (skip, don't retry)
//   "not_ready"   — this owner's session isn't up (stop the sweep, retry later)
//   "failed"      — lookup/send error (mark error, don't auto-retry)
async function sendOutreachFor(ownerId, phone, text) {
  const digits = toDigits(phone);
  if (!digits) return "no_whatsapp";
  const s = getSession(ownerId);
  if (!s.ready || !s.client) return "not_ready";
  let chatId = null;
  try {
    if (typeof s.client.getNumberId === "function") {
      const wid = await s.client.getNumberId(digits);
      if (wid && wid._serialized) chatId = wid._serialized;
    } else {
      chatId = `${digits}@c.us`;
    }
  } catch {
    return "failed";
  }
  if (!chatId) return "no_whatsapp"; // number not on WhatsApp
  const ok = await sendForOwner(ownerId, chatId, text);
  return ok ? "sent" : "failed";
}

// List a teacher's WhatsApp groups so they can pick a notify group.
async function listGroupsFor(ownerId) {
  const s = getSession(ownerId);
  console.log(`[WHATSAPP][DEBUG] listGroups ${ownerId} ready=${s.ready} hasClient=${!!s.client}`);
  if (!s.ready || !s.client) return [];
  try {
    const chats = await s.client.getChats();
    const groups = chats.filter((c) => c.isGroup);
    console.log(`[WHATSAPP][DEBUG] listGroups ${ownerId} chats=${chats.length} groups=${groups.length}`);
    return groups.map((c) => ({ id: c.id._serialized, name: c.name || "(qrup)" }));
  } catch (e) {
    console.error(`[WHATSAPP] ${ownerId} listGroups failed:`, e.message);
    console.error(e.stack);
    return [];
  }
}

async function className(cls) {
  if (!cls) return "";
  return cls.name || (cls.level != null ? String(cls.level) : "");
}

// Notify the EXAM OWNER's students that a new exam is available — sent from the
// owner's own WhatsApp session, to the owner's chosen group (or per-student if
// no group), including the class join code. Idempotent (stamps studentsNotifiedAt).
async function notifyStudentsNewExam(examId, opts = {}) {
  const force = !!opts.force;
  const skip = (why) => console.log(`[WHATSAPP] notify skipped (${examId}): ${why}`);
  try {
    if (!ENABLED) return skip("disabled");
    const exam = await Exam.findById(examId);
    if (!exam) return skip("exam not found");
    if (exam.hidden) return skip("exam is hidden (draft)");
    if (!force && exam.studentsNotifiedAt) return skip("already notified");
    if (!exam.questions) return skip("no questions yet");
    if (!exam.class) return skip("exam has no class");
    const ownerId = exam.owner ? String(exam.owner) : "";
    if (!ownerId) return skip("exam has no owner");

    const s = getSession(ownerId);
    if (!s.ready) {
      // Only re-wake an ALREADY-linked teacher (their profile is on disk).
      // Never create a new Chromium profile here — a teacher who never opted
      // into WhatsApp must not get one spun up (and left behind) just because
      // they created an exam. They link on demand from the dashboard.
      if (hasPersistedSession(ownerId)) initFor(ownerId);
      return skip(`owner ${ownerId} WhatsApp not linked/ready`);
    }

    const cls = await Class.findById(exam.class).select("name level joinCode").lean();
    const cname = await className(cls);
    const code = cls && cls.joinCode ? cls.joinCode : "";
    const link = FRONTEND_URL ? `${FRONTEND_URL}/exam/details/${exam._id}` : "";
    const text = [
      "📚 Yeni imtahan əlavə olundu",
      "",
      `📝 ${exam.name || "İmtahan"}`,
      cname ? `🏫 ${cname}` : null,
      code ? `🔑 Sinif kodu: ${code}` : null,
      link ? `🔗 ${link}` : null,
    ]
      .filter((l) => l !== null)
      .join("\n");

    // GROUP MODE: one message to the owner's chosen group (safest, least spammy).
    const owner = await User.findById(ownerId).select("whatsappGroupId").lean();
    const groupId = owner && owner.whatsappGroupId ? owner.whatsappGroupId : "";
    if (groupId) {
      const ok = await sendForOwner(ownerId, groupId, text);
      exam.studentsNotifiedAt = new Date();
      await exam.save();
      console.log(`[WHATSAPP] new-exam -> owner ${ownerId} group ${groupId}: ok=${ok} (exam ${exam._id})`);
      return;
    }

    // PER-STUDENT MODE (no group set): message the owner's approved-enrolled
    // students one by one, throttled to reduce ban risk.
    const enrollments = await Enrollment.find({
      class: exam.class,
      status: "approved",
    }).populate("student", "phone whatsappOptIn");
    const students = enrollments.map((e) => e.student).filter(Boolean);
    let sent = 0;
    let skipped = 0;
    for (const st of students) {
      if (!st || st.whatsappOptIn === false || !toDigits(st.phone)) {
        skipped += 1;
        continue;
      }
      if (await sendMessageFor(ownerId, st.phone, text)) sent += 1;
      await new Promise((r) => setTimeout(r, 1500)); // throttle
    }
    exam.studentsNotifiedAt = new Date();
    await exam.save();
    console.log(`[WHATSAPP] new-exam -> owner ${ownerId} per-student: sent=${sent}, skipped=${skipped} (exam ${exam._id})`);
  } catch (e) {
    console.error("[WHATSAPP] notifyStudentsNewExam failed:", e.message);
  }
}

// On boot, re-link teachers who already linked (have a persisted auth dir), so
// their alerts keep working after a restart without re-scanning the QR.
function initPersistedSessions() {
  if (!ENABLED) return;
  let dirs = [];
  try {
    dirs = fs.readdirSync(AUTH_ROOT);
  } catch {
    return; // no auth dir yet — nobody has linked
  }
  const owners = dirs
    .filter((d) => d.startsWith("session-"))
    .map((d) => d.slice("session-".length))
    .filter(Boolean);
  if (!owners.length) return;
  console.log(`[WHATSAPP] re-linking ${owners.length} persisted teacher session(s)`);
  let started = 0;
  for (const o of owners) {
    if (started >= MAX_SESSIONS) {
      console.warn(`[WHATSAPP] cap reached on boot — ${owners.length - started} session(s) will start lazily`);
      break;
    }
    initFor(o);
    started += 1;
  }
}

// CR-117 — graceful shutdown for the optional WhatsApp subsystem. Prevents any new
// reconnect/start, clears every per-session timer, and DESTROYS each headless client
// (closes Chromium) WITHOUT logout() — the on-disk auth is preserved so the next boot
// re-links via initPersistedSessions. Bounded so a stuck client can't hang the process.
// Flag-off is a genuine no-op: nothing was started, so the sessions map is empty.
async function shutdownWhatsapp({ timeoutMs = 8000 } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  const tasks = [];
  let clients = 0;
  for (const s of sessions.values()) {
    if (s.readyTimer) { clearTimeout(s.readyTimer); s.readyTimer = null; }
    if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
    const c = s.client;
    s.client = null; s.ready = false; s.starting = false;
    if (c) { clients += 1; tasks.push(Promise.resolve().then(() => c.destroy()).catch(() => {})); }
  }
  if (ENABLED && (clients || sessions.size)) console.log(`[WHATSAPP] shutdown: destroying ${clients} client(s), timers cleared (auth preserved)`);
  // Bounded: don't let a wedged Chromium destroy() hang the graceful shutdown.
  await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, timeoutMs))]);
}

// Test-only: reset the shutdown latch so a fresh process-per-test starts clean.
function _resetShutdownForTests() { shuttingDown = false; sessions.clear(); }
// Test-only: inject a fake session so shutdown behaviour is unit-testable without a
// real headless Chromium. Returns the created session object.
function _injectSessionForTests(id, session) { const s = { ...getSession(id), ...session }; sessions.set(String(id), s); return s; }
function _isShuttingDownForTests() { return shuttingDown; }
function _initForTest(id) { return initFor(id); }

module.exports = {
  initFor,
  refreshFor,
  initPersistedSessions,
  shutdownWhatsapp,
  _resetShutdownForTests,
  _injectSessionForTests,
  _isShuttingDownForTests,
  _initForTest,
  getStatusFor,
  getQrFor,
  logoutFor,
  sendForOwner,
  sendMessageFor,
  sendOutreachFor,
  firstReadyOwner,
  accountKey,
  readyOwners,
  nextReadyOwner,
  listGroupsFor,
  notifyStudentsNewExam,
  toDigits,
};
