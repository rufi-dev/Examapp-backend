// Telegram Bot API helper. One bot (token in TELEGRAM_BOT_TOKEN) sends
// notifications to teachers/admins who have linked their Telegram. Uses Node
// 18+'s global fetch/FormData/Blob — no extra dependency.
const User = require("../models/userModel");
const Class = require("../models/classModel");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "ImtahanNotificationBot";
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");

const isTelegramConfigured = () => !!BOT_TOKEN;

const telegramDeepLink = (code) =>
  `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(code)}`;

// Low-level Telegram Bot API call (JSON). Never throws.
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

async function sendTelegram(chatId, text) {
  if (!chatId) return null;
  return tgApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// Upload a generated file (Buffer) to a chat as a document (multipart).
async function sendTelegramDocument(chatId, buffer, filename, caption) {
  if (!isTelegramConfigured() || !chatId || !buffer) return null;
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    form.append("document", new Blob([buffer]), filename);
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
      method: "POST",
      body: form,
    });
    return await res.json();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[TELEGRAM] sendDocument failed:", e.message);
    return null;
  }
}

// Escape Telegram HTML so names with < & > can't break/inject markup.
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

// "(email · +99450...)" — only the parts that exist.
const contactLine = (u) => {
  const parts = [u?.email, u?.phone].map((p) => String(p || "").trim()).filter(Boolean);
  return parts.length ? ` (${esc(parts.join(" · "))})` : "";
};

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

// ---- scope (opt-out) --------------------------------------------------------
function examNotifyEnabled(prefs, exam) {
  if (!prefs) return true;
  const cls = exam?.class ? String(exam.class) : "";
  if (cls && (prefs.excludedClasses || []).some((c) => String(c) === cls)) return false;
  if ((prefs.excludedExams || []).some((e) => String(e) === String(exam?._id))) return false;
  return true;
}
function classNotifyEnabled(prefs, classId) {
  if (!prefs) return true;
  return !(prefs.excludedClasses || []).some((c) => String(c) === String(classId));
}

// ---- recipients -------------------------------------------------------------
// A linked user is a recipient when the event flag isn't off and the scope
// check passes. Admins receive EVERYTHING (they're "at the top"), still subject
// to their own flags + exclusions.
function eligibleChat(user, flag, scopeOk) {
  if (!user?.telegramChatId) return null;
  const prefs = user.telegramPrefs || {};
  if (prefs[flag] === false) return null; // default (undefined) = on
  if (!scopeOk(prefs)) return null;
  return { userId: String(user._id), chatId: user.telegramChatId };
}

async function linkedAdmins() {
  return User.find({ role: "admin", telegramChatId: { $nin: [null, ""] } }).select(
    "telegramChatId telegramPrefs"
  );
}

// Owner + every linked admin, deduped by user id, each scope-checked.
async function recipientsForExam(exam, flag) {
  if (!isTelegramConfigured()) return [];
  const out = new Map();
  const scopeOk = (prefs) => examNotifyEnabled(prefs, exam);
  if (exam?.owner) {
    const owner = await User.findById(exam.owner).select("telegramChatId telegramPrefs");
    const r = eligibleChat(owner, flag, scopeOk);
    if (r) out.set(r.userId, r.chatId);
  }
  for (const a of await linkedAdmins()) {
    const r = eligibleChat(a, flag, scopeOk);
    if (r) out.set(r.userId, r.chatId);
  }
  return [...out.values()];
}

async function recipientsForClass(klass, flag) {
  if (!isTelegramConfigured()) return [];
  const out = new Map();
  const scopeOk = (prefs) => classNotifyEnabled(prefs, klass?._id);
  if (klass?.owner) {
    const owner = await User.findById(klass.owner).select("telegramChatId telegramPrefs");
    const r = eligibleChat(owner, flag, scopeOk);
    if (r) out.set(r.userId, r.chatId);
  }
  for (const a of await linkedAdmins()) {
    const r = eligibleChat(a, flag, scopeOk);
    if (r) out.set(r.userId, r.chatId);
  }
  return [...out.values()];
}

const broadcast = (chatIds, text) => Promise.all(chatIds.map((c) => sendTelegram(c, text)));

// ---- notifications ----------------------------------------------------------
async function notifyExamStarted(exam, student) {
  try {
    const recips = await recipientsForExam(exam, "onStart");
    if (!recips.length) return;
    const cname = await className(exam);
    const text = [
      "🟢 <b>İmtahana başladı</b>",
      `👤 ${esc(student?.name || "Şagird")}${contactLine(student)}`,
      `📝 ${esc(exam.name || "İmtahan")}${cname ? ` · 🏫 ${esc(cname)}` : ""}`,
      `🕒 ${fmtTime()}`,
    ].join("\n");
    await broadcast(recips, text);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[TELEGRAM] notifyExamStarted failed:", e.message);
  }
}

async function notifyExamFinished(exam, student, result) {
  try {
    const terminated = !!result?.terminated;
    const recips = await recipientsForExam(exam, terminated ? "onViolation" : "onFinish");
    if (!recips.length) return;
    const cname = await className(exam);
    const head = `📝 ${esc(exam.name || "İmtahan")}${cname ? ` · 🏫 ${esc(cname)}` : ""}`;
    const who = `👤 ${esc(student?.name || "Şagird")}${contactLine(student)}`;

    if (terminated) {
      await broadcast(
        recips,
        [
          "⛔️ <b>Pozuntuya görə dayandırıldı</b>",
          who,
          head,
          `🚨 Pozuntu sayı: ${Number(result?.violations || 0)}`,
          `🕒 ${fmtTime()}`,
        ].join("\n")
      );
      return;
    }

    const pts = Number(result?.earnPoints ?? 0);
    const total = exam.totalMarks != null ? Number(exam.totalMarks) : null;
    const pct = total ? Math.round((pts / total) * 100) : null;
    const pass = exam.passingMarks != null ? pts >= Number(exam.passingMarks) : null;
    const link = result?._id && FRONTEND_URL ? `${FRONTEND_URL}/result/${result._id}/review` : null;
    await broadcast(
      recips,
      [
        "🏁 <b>İmtahanı bitirdi</b>",
        who,
        head,
        `📊 Nəticə: <b>${pts}${total != null ? "/" + total : ""}</b> bal${
          pct != null ? ` (${pct}%)` : ""
        }${pass === null ? "" : pass ? " — keçdi ✅" : " — keçmədi ❌"}`,
        Number(result?.violations) ? `🚨 Pozuntu: ${Number(result.violations)}` : null,
        `🕒 ${fmtTime()}`,
        link ? `🔗 <a href="${link}">Cavablara bax</a>` : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[TELEGRAM] notifyExamFinished failed:", e.message);
  }
}

async function notifyEnrollment(klass, student, pending) {
  try {
    const recips = await recipientsForClass(klass, "onJoin");
    if (!recips.length) return;
    await broadcast(
      recips,
      [
        `👥 <b>${pending ? "Sinfə qoşulmaq istəyir" : "Sinfə qoşuldu"}</b>`,
        `👤 ${esc(student?.name || "Şagird")}${contactLine(student)}`,
        `🏫 ${esc(klass?.name || "Sinif")}`,
        `🕒 ${fmtTime()}`,
      ].join("\n")
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
  sendTelegramDocument,
  esc,
  fmtTime,
  examNotifyEnabled,
  classNotifyEnabled,
  recipientsForExam,
  recipientsForClass,
  className,
  notifyExamStarted,
  notifyExamFinished,
  notifyEnrollment,
  BOT_USERNAME,
};
