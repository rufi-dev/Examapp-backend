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

// ownerId(string) -> { client, ready, lastQrDataUrl, starting, readyTimer }
const sessions = new Map();

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
    s = { client: null, ready: false, lastQrDataUrl: null, starting: false, readyTimer: null };
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

// Boot (or re-boot) a teacher's WhatsApp client. Safe to call repeatedly.
function initFor(ownerId) {
  if (!ENABLED || !ownerId) return;
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

  s.client = new Client({
    authStrategy: new LocalAuth({ clientId: id, dataPath: AUTH_ROOT }),
    // Stop endlessly re-issuing a QR for a session nobody scans (~6 × 20s ≈ 2
    // min); after that the client gives up (we won't auto-reconnect it below).
    qrMaxRetries: Number(process.env.WHATSAPP_QR_MAX_RETRIES || 6),
    // Pin a known-good WhatsApp Web build (see WWEB_VERSION above).
    ...(WWEB_VERSION
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
    clearTimeout(s.readyTimer);
    console.log(`[WHATSAPP] ${id} client ready (pin=${WWEB_VERSION || "none"})`);
    try {
      const v = await s.client.getWWebVersion();
      console.log(`[WHATSAPP][DEBUG] ${id} loaded WWeb version=${v}; me=${s.client.info?.wid?._serialized || "?"}`);
    } catch (e) {
      console.warn(`[WHATSAPP][DEBUG] ${id} getWWebVersion failed:`, e.message);
    }
  });
  s.client.on("loading_screen", (pct, msg) =>
    console.log(`[WHATSAPP][DEBUG] ${id} loading ${pct}% ${msg || ""}`)
  );
  s.client.on("change_state", (st) => console.log(`[WHATSAPP][DEBUG] ${id} state=${st}`));
  s.client.on("auth_failure", (m) => console.error(`[WHATSAPP] ${id} auth failure:`, m));
  s.client.on("disconnected", (reason) => {
    console.error(`[WHATSAPP] ${id} disconnected:`, reason);
    const wasLinked = s.everAuthed;
    s.ready = false;
    s.client = null;
    s.starting = false;
    s.qrLogged = false;
    clearTimeout(s.readyTimer);
    // Only auto-reconnect a session that was actually LINKED (survive network
    // blips). A never-scanned session that ran out of QR retries is left
    // stopped — the teacher re-links on demand from the dashboard — so we don't
    // loop a headless browser + QR forever.
    if (wasLinked) setTimeout(() => initFor(id), 10000);
    else console.log(`[WHATSAPP] ${id} not linked — stopped (re-link from dashboard).`);
  });

  s.client.initialize().catch((e) => {
    console.error(`[WHATSAPP] ${id} initialize failed:`, e.message);
    s.ready = false;
    s.client = null;
    s.starting = false;
  });
}

// Tear down a stuck client and re-init (watchdog for the flaky "authenticated
// but never ready" reconnect state).
function restartFor(ownerId) {
  const id = String(ownerId);
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
    setTimeout(() => initFor(id), 3000);
  });
}

const getStatusFor = (ownerId) => {
  const s = getSession(ownerId);
  return { enabled: ENABLED, ready: s.ready, hasQr: !!s.lastQrDataUrl };
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
  console.log(
    `[WHATSAPP][DEBUG] sendForOwner ${ownerId} chatId=${chatId} ready=${s.ready} hasClient=${!!s.client}`
  );
  if (!s.ready || !s.client || !chatId) return false;
  try {
    await s.client.sendMessage(chatId, text);
    console.log(`[WHATSAPP][DEBUG] sendForOwner ${ownerId} -> OK to ${chatId}`);
    return true;
  } catch (e) {
    console.error(`[WHATSAPP] ${ownerId} send failed to ${chatId}:`, e.message);
    console.error(e.stack);
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
  console.log(`[WHATSAPP][DEBUG] sendMessageFor ${ownerId} phone=${phone} digits=${digits} ready=${s.ready}`);
  try {
    if (s.ready && s.client && typeof s.client.getNumberId === "function") {
      const wid = await s.client.getNumberId(digits);
      console.log(`[WHATSAPP][DEBUG] getNumberId(${digits}) ->`, wid && wid._serialized ? wid._serialized : wid);
      if (wid && wid._serialized) chatId = wid._serialized;
      else console.warn(`[WHATSAPP] ${ownerId} ${digits} is not on WhatsApp`);
    }
  } catch (e) {
    console.warn(`[WHATSAPP] ${ownerId} getNumberId failed (${digits}):`, e.message);
  }
  return sendForOwner(ownerId, chatId, text);
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
      initFor(ownerId); // lazily boot the owner's session for next time
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

module.exports = {
  initFor,
  initPersistedSessions,
  getStatusFor,
  getQrFor,
  logoutFor,
  sendForOwner,
  sendMessageFor,
  listGroupsFor,
  notifyStudentsNewExam,
  toDigits,
};
