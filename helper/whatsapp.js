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
const path = require("path");
const QRCode = require("qrcode");
const Exam = require("../models/examModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");

const ENABLED = process.env.WHATSAPP_WEB_ENABLED === "true";
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");

let client = null;
let ready = false;
let lastQrDataUrl = null;
let starting = false;

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

// Boot (or re-boot) the WhatsApp Web client. Safe to call repeatedly.
function initWhatsApp() {
  if (!ENABLED || client || starting) return;
  starting = true;
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
  });
  client.on("ready", () => {
    ready = true;
    lastQrDataUrl = null;
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

// Send one plain-text WhatsApp message. Returns true on success.
async function sendMessage(phone, text) {
  if (!ready || !client) return false;
  const digits = toDigits(phone);
  if (!digits) return false;
  try {
    await client.sendMessage(`${digits}@c.us`, text);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[WHATSAPP] sendMessage failed:", e.message);
    return false;
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
async function notifyStudentsNewExam(examId) {
  // Verbose skip-reason logging so a "nothing happened" is diagnosable.
  const skip = (why) => console.log(`[WHATSAPP] notify skipped (${examId}): ${why}`);
  try {
    if (!ENABLED) return skip("disabled");
    if (!ready) return skip("client not ready/linked");
    const exam = await Exam.findById(examId);
    if (!exam) return skip("exam not found");
    if (exam.hidden) return skip("exam is hidden (draft)");
    if (exam.studentsNotifiedAt) return skip("already notified");
    if (!exam.questions) return skip("no questions yet");
    if (!exam.class) return skip("exam has no class");

    const enrollments = await Enrollment.find({ class: exam.class, status: "approved" }).populate(
      "student",
      "phone whatsappOptIn name"
    );
    // eslint-disable-next-line no-console
    console.log(
      `[WHATSAPP] notify: class=${exam.class} approvedEnrollments=${enrollments.length}`
    );
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

    let sent = 0;
    let skipped = 0;
    for (const en of enrollments) {
      const s = en.student;
      if (!s || s.whatsappOptIn === false || !toDigits(s.phone)) {
        skipped += 1;
        continue;
      }
      if (await sendMessage(s.phone, text)) sent += 1;
      await new Promise((r) => setTimeout(r, 1500)); // throttle
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
  notifyStudentsNewExam,
  toDigits,
};
