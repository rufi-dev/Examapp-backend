// Telegram Bot API helper. One bot (token in TELEGRAM_BOT_TOKEN) sends
// notifications to teachers who have linked their Telegram. Uses Node 18+'s
// global fetch — no extra dependency.
const User = require("../models/userModel");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "ImtahanNotificationBot";

const isTelegramConfigured = () => !!BOT_TOKEN;

// Deep link a teacher opens to bind their account: pressing Start sends the bot
// `/start <code>`, which the webhook maps back to the user.
const telegramDeepLink = (code) =>
  `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(code)}`;

// Low-level Telegram Bot API call. Returns the parsed JSON (or null on failure);
// never throws so callers can treat notifications as best-effort.
async function tgApi(method, body) {
  if (!isTelegramConfigured()) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return await res.json();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[TELEGRAM] ${method} failed:`, e.message);
    return null;
  }
}

// Send a message to a chat. HTML parse mode so we can bold the student name.
async function sendTelegram(chatId, text) {
  if (!chatId) return null;
  return tgApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// Escape the few characters that matter for Telegram's HTML parse mode so a
// student/exam name containing < & > can't break or inject markup.
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const fmtTime = () =>
  new Date().toLocaleString("az-AZ", {
    timeZone: "Asia/Baku",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });

// Scope check (opt-out): an exam notifies unless its class or its own id is in
// the teacher's excluded lists. Missing prefs => everything enabled.
function examNotifyEnabled(prefs, exam) {
  if (!prefs) return true;
  const cls = exam?.class ? String(exam.class) : "";
  if (cls && (prefs.excludedClasses || []).some((c) => String(c) === cls)) return false;
  if ((prefs.excludedExams || []).some((e) => String(e) === String(exam?._id))) return false;
  return true;
}

// A class-level event (enrollment) notifies unless the class is excluded.
function classNotifyEnabled(prefs, classId) {
  if (!prefs) return true;
  return !(prefs.excludedClasses || []).some((c) => String(c) === String(classId));
}

// Load the owner of an exam/class and return { owner } only when they're linked
// AND the given event flag isn't explicitly off. Returns null to skip.
async function resolveOwner(ownerId, flag) {
  if (!isTelegramConfigured() || !ownerId) return null;
  const owner = await User.findById(ownerId).select("telegramChatId telegramPrefs");
  if (!owner?.telegramChatId) return null;
  const prefs = owner.telegramPrefs || {};
  if (prefs[flag] === false) return null; // default (undefined) = on
  return { owner, prefs };
}

// Fire-and-forget: a student started the exam. Safe to call without awaiting.
async function notifyExamStarted(exam, student) {
  try {
    if (!exam?.owner) return;
    const r = await resolveOwner(exam.owner, "onStart");
    if (!r || !examNotifyEnabled(r.prefs, exam)) return;
    await sendTelegram(
      r.owner.telegramChatId,
      `🟢 <b>${esc(student?.name || "Şagird")}</b> imtahana başladı\n` +
        `📝 ${esc(exam.name || "İmtahan")}\n` +
        `🕒 ${esc(fmtTime())}`
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[TELEGRAM] notifyExamStarted failed:", e.message);
  }
}

// Fire-and-forget: a student finished an exam. `result` carries the score; when
// it was terminated for cheating we send the violation message instead (gated
// by the separate onViolation flag).
async function notifyExamFinished(exam, student, result) {
  try {
    if (!exam?.owner) return;
    const terminated = !!result?.terminated;
    const r = await resolveOwner(exam.owner, terminated ? "onViolation" : "onFinish");
    if (!r || !examNotifyEnabled(r.prefs, exam)) return;
    const name = esc(student?.name || "Şagird");
    const examName = esc(exam.name || "İmtahan");
    if (terminated) {
      await sendTelegram(
        r.owner.telegramChatId,
        `⛔️ <b>${name}</b> — imtahan pozuntuya görə dayandırıldı\n` +
          `📝 ${examName}\n` +
          `🚨 Pozuntu: ${Number(result?.violations || 0)}\n` +
          `🕒 ${esc(fmtTime())}`
      );
      return;
    }
    const pts = Number(result?.earnPoints ?? 0);
    const pass = exam.passingMarks != null ? pts >= Number(exam.passingMarks) : null;
    const verdict = pass === null ? "" : pass ? " (keçdi ✅)" : " (keçmədi ❌)";
    await sendTelegram(
      r.owner.telegramChatId,
      `🏁 <b>${name}</b> imtahanı bitirdi\n` +
        `📝 ${examName}\n` +
        `📊 Nəticə: ${pts}${exam.totalMarks ? "/" + Number(exam.totalMarks) : ""} bal${verdict}\n` +
        `🕒 ${esc(fmtTime())}`
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[TELEGRAM] notifyExamFinished failed:", e.message);
  }
}

// Fire-and-forget: a student joined / requested to join a class. `pending` =
// awaiting approval (vs auto-approved).
async function notifyEnrollment(klass, student, pending) {
  try {
    if (!klass?.owner) return;
    const r = await resolveOwner(klass.owner, "onJoin");
    if (!r || !classNotifyEnabled(r.prefs, klass._id)) return;
    await sendTelegram(
      r.owner.telegramChatId,
      `👥 <b>${esc(student?.name || "Şagird")}</b> ${
        pending ? "sinfə qoşulmaq istəyir" : "sinfə qoşuldu"
      }\n` +
        `🏫 ${esc(klass.name || "Sinif")}\n` +
        `🕒 ${esc(fmtTime())}`
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[TELEGRAM] notifyEnrollment failed:", e.message);
  }
}

module.exports = {
  isTelegramConfigured,
  telegramDeepLink,
  tgApi,
  sendTelegram,
  examNotifyEnabled,
  classNotifyEnabled,
  notifyExamStarted,
  notifyExamFinished,
  notifyEnrollment,
  BOT_USERNAME,
};
