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

// Fire-and-forget: notify the exam's owner that a student started it. Safe to
// call without awaiting — any failure is swallowed so it can never affect the
// student's exam start.
async function notifyExamStarted(exam, student) {
  try {
    if (!isTelegramConfigured() || !exam?.owner) return;
    const owner = await User.findById(exam.owner).select("telegramChatId");
    if (!owner?.telegramChatId) return;
    const time = new Date().toLocaleString("az-AZ", {
      timeZone: "Asia/Baku",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    });
    const text =
      `🔔 <b>${esc(student?.name || "Şagird")}</b> imtahana başladı\n` +
      `📝 ${esc(exam.name || "İmtahan")}\n` +
      `🕒 ${esc(time)}`;
    await sendTelegram(owner.telegramChatId, text);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[TELEGRAM] notifyExamStarted failed:", e.message);
  }
}

module.exports = {
  isTelegramConfigured,
  telegramDeepLink,
  tgApi,
  sendTelegram,
  notifyExamStarted,
  BOT_USERNAME,
};
