// UNOFFICIAL WhatsApp integration via whatsapp-web.js (drives WhatsApp Web with
// a headless Chromium session) — NOT the Meta Cloud API. It sends plain-text
// messages from a linked phone number, so no Business verification / templates
// are needed. The teacher links the number once by scanning a QR (admin page).
//
// ⚠️ Automated/bulk sending is against WhatsApp's Terms of Service and can get
// the number BANNED. Keep it low-volume + opt-in (we throttle sends and only
// message a class's enrolled, opted-in students).
//
// Gated by WHATSAPP_WEB_ENABLED ("true") so it only launches where Chromium is
// available (the Docker image sets this + PUPPETEER_EXECUTABLE_PATH). Running
// `node server.js` locally without that env is a safe no-op.
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const Exam = require("../models/examModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const User = require("../models/userModel");

const ENABLED = process.env.WHATSAPP_WEB_ENABLED === "true";
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");

let client = null;
let ready = false;
let lastQrDataUrl = null;
let starting = false;
let readyTimer = null;

// Tear down a stuck/old client and re-initialize from scratch. Used by the
// watchdog when "ready" never fires after authentication (a known flaky
// whatsapp-web.js reconnect state).
function restart() {
  clearTimeout(readyTimer);
  const old = client;
  client = null;
  ready = false;
  starting = false;
  lastQrDataUrl = null;
  Promise.resolve().then(async () => {
    try {
      if (old) await old.destroy();
    } catch {
      /* ignore */
    }
    clearStaleLocks();
    setTimeout(initWhatsApp, 3000);
  });
}

// Normalize a stored phone to bare international digits ("994501234567").
// Handles local Azerbaijani formats entered without a country code.
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

// Remove stale Chromium singleton locks left by an unclean shutdown (otherwise
// the next launch fails with "profile appears to be in use ... Code: 21"). Safe
// on boot because no Chromium is using this profile yet.
function clearStaleLocks() {
  const dir = path.join(process.cwd(), ".wwebjs_auth", "session");
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      fs.rmSync(path.join(dir, f), { force: true, recursive: true });
    } catch {
      /* ignore */
    }
  }
}

// Boot (or re-boot) the WhatsApp Web client. Safe to call repeatedly.
function initWhatsApp() {
  if (!ENABLED || client || starting) return;
  starting = true;
  clearStaleLocks();
  let Client, LocalAuth;
  try {
    ({ Client, LocalAuth } = require("whatsapp-web.js"));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[WHATSAPP] whatsapp-web.js unavailable:", e.message);
    starting = false;
    return;
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(process.cwd(), ".wwebjs_auth") }),
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

  client.on("qr", async (qr) => {
    ready = false;
    clearTimeout(readyTimer); // waiting for a human to scan — don't restart
    try {
      lastQrDataUrl = await QRCode.toDataURL(qr);
    } catch {
      lastQrDataUrl = null;
    }
    // eslint-disable-next-line no-console
    console.log("[WHATSAPP] QR ready — open the admin WhatsApp page to scan.");
  });
  client.on("authenticated", () => {
    // eslint-disable-next-line no-console
    console.log("[WHATSAPP] authenticated");
    // Linked — "ready" should follow within seconds. If it doesn't (flaky
    // reconnect that hangs on the loading screen), restart the client.
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      if (!ready) {
        // eslint-disable-next-line no-console
        console.warn("[WHATSAPP] not ready 90s after auth — restarting client");
        restart();
      }
    }, 90000);
  });
  client.on("ready", () => {
    ready = true;
    lastQrDataUrl = null;
    clearTimeout(readyTimer);
    // eslint-disable-next-line no-console
    console.log("[WHATSAPP] client ready");
  });
  client.on("auth_failure", (m) => {
    // eslint-disable-next-line no-console
    console.error("[WHATSAPP] auth failure:", m);
  });
  client.on("disconnected", (reason) => {
    // eslint-disable-next-line no-console
    console.error("[WHATSAPP] disconnected:", reason);
    ready = false;
    client = null;
    starting = false;
    clearTimeout(readyTimer);
    setTimeout(initWhatsApp, 10000); // auto-reconnect
  });

  client.initialize().catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[WHATSAPP] initialize failed:", e.message);
    ready = false;
    client = null;
    starting = false;
  });
}

const getStatus = () => ({ enabled: ENABLED, ready, hasQr: !!lastQrDataUrl });
const getQrDataUrl = () => lastQrDataUrl;

// Unlink the current number (forces a fresh QR on next init).
async function logout() {
  if (!client) return;
  try {
    await client.logout();
  } catch {
    /* ignore */
  }
  ready = false;
  lastQrDataUrl = null;
  client = null;
  starting = false;
  setTimeout(initWhatsApp, 2000);
}

// ---- notification target config (persisted in the session volume) ----------
// A teacher can pick ONE WhatsApp GROUP to receive all exam alerts. Posting one
// message to a group (instead of N individual chats) avoids cluttering the
// sender's chat list and is far safer against spam bans. Persisted as a file in
// the wa_auth volume so it survives redeploys.
const CONFIG_PATH = path.join(process.cwd(), ".wwebjs_auth", "notify-config.json");
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[WHATSAPP] writeConfig failed:", e.message);
  }
}
const getNotifyGroupId = () => readConfig().groupId || "";
function setNotifyGroupId(id) {
  const cfg = readConfig();
  cfg.groupId = id || "";
  writeConfig(cfg);
}

// Send plain text to any chat id (a "<digits>@c.us" contact or "<id>@g.us"
// group). Returns true on success.
async function sendToChat(chatId, text) {
  if (!ready || !client || !chatId) return false;
  try {
    await client.sendMessage(chatId, text);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[WHATSAPP] send failed:", e.message);
    return false;
  }
}

// Send one plain-text WhatsApp message to a phone number. Returns true on success.
async function sendMessage(phone, text) {
  const digits = toDigits(phone);
  if (!digits) return false;
  return sendToChat(`${digits}@c.us`, text);
}

// List the linked account's groups so the teacher can pick a notification group.
async function listGroups() {
  if (!ready || !client) return [];
  try {
    const chats = await client.getChats();
    return chats
      .filter((c) => c.isGroup)
      .map((c) => ({ id: c.id._serialized, name: c.name || "(qrup)" }));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[WHATSAPP] listGroups failed:", e.message);
    return [];
  }
}

async function className(exam) {
  try {
    if (!exam?.class) return "";
    const c = await Class.findById(exam.class).select("name level");
    if (!c) return "";
    return c.name || (c.level != null ? String(c.level) : "");
  } catch {
    return "";
  }
}

// Notify the approved students of an exam's class that a new exam is available.
// Idempotent + lazy: re-reads the exam fresh, only fires when the client is
// ready, the exam is visible (not a draft) and has questions, and hasn't been
// announced yet — then stamps studentsNotifiedAt so it never double-sends.
// Sends are throttled to reduce the chance of a spam ban.
// opts.force = re-send even if already notified (used when a teacher re-publishes
// by un-hiding). The default (no force) keeps edit/re-save from re-spamming.
async function notifyStudentsNewExam(examId, opts = {}) {
  const force = !!opts.force;
  // Verbose skip-reason logging so a "nothing happened" is diagnosable.
  const skip = (why) => console.log(`[WHATSAPP] notify skipped (${examId}): ${why}`);
  try {
    if (!ENABLED) return skip("disabled");
    if (!ready) return skip("client not ready/linked");
    const exam = await Exam.findById(examId);
    if (!exam) return skip("exam not found");
    if (exam.hidden) return skip("exam is hidden (draft)");
    if (!force && exam.studentsNotifiedAt) return skip("already notified");
    if (!exam.questions) return skip("no questions yet");
    if (!exam.class) return skip("exam has no class");

    const cname = await className(exam);
    const link = FRONTEND_URL ? `${FRONTEND_URL}/exam/details/${exam._id}` : "";
    const text = [
      "📚 Yeni imtahan əlavə olundu",
      "",
      `📝 ${exam.name || "İmtahan"}`,
      cname ? `🏫 ${cname}` : null,
      link ? `🔗 ${link}` : null,
    ]
      .filter((l) => l !== null)
      .join("\n");

    // GROUP MODE: if a notification group is set, post ONE message there and stop
    // (one chat, one send — no per-student blast, minimal ban risk). Students
    // just need to be in the group; phone numbers don't matter here.
    const groupId = getNotifyGroupId();
    if (groupId) {
      const ok = await sendToChat(groupId, text);
      exam.studentsNotifiedAt = new Date();
      await exam.save();
      // eslint-disable-next-line no-console
      console.log(`[WHATSAPP] new-exam notify -> group ${groupId}: ok=${ok} (exam ${exam._id})`);
      return;
    }

    // PER-STUDENT MODE (no group configured). A PUBLIC class (requireCode=false)
    // is open to everyone → notify all opted-in users; a code-based class only
    // notifies its approved (enrolled) students.
    const classDoc = await Class.findById(exam.class).select("requireCode").lean();
    const isPublic = classDoc && classDoc.requireCode === false;
    let students;
    if (isPublic) {
      students = await User.find({ whatsappOptIn: { $ne: false } }).select(
        "phone whatsappOptIn"
      );
    } else {
      const enrollments = await Enrollment.find({
        class: exam.class,
        status: "approved",
      }).populate("student", "phone whatsappOptIn");
      students = enrollments.map((e) => e.student).filter(Boolean);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[WHATSAPP] notify: class=${exam.class} scope=${
        isPublic ? "public(all students)" : "enrolled"
      } candidates=${students.length}`
    );

    let sent = 0;
    let skipped = 0;
    for (const s of students) {
      if (!s || s.whatsappOptIn === false || !toDigits(s.phone)) {
        skipped += 1;
        continue;
      }
      if (await sendMessage(s.phone, text)) sent += 1;
      await new Promise((r) => setTimeout(r, 1500)); // throttle (reduce ban risk)
    }

    exam.studentsNotifiedAt = new Date();
    await exam.save();
    // eslint-disable-next-line no-console
    console.log(
      `[WHATSAPP] new-exam notify: sent=${sent}, skipped(no phone / opted-out)=${skipped} for exam ${exam._id}`
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[WHATSAPP] notifyStudentsNewExam failed:", e.message);
  }
}

module.exports = {
  initWhatsApp,
  getStatus,
  getQrDataUrl,
  logout,
  sendMessage,
  sendToChat,
  listGroups,
  getNotifyGroupId,
  setNotifyGroupId,
  notifyStudentsNewExam,
  toDigits,
};
