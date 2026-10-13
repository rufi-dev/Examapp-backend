/*
 * The support AI answering on WhatsApp (owner, 2026-10-13): when a teacher we
 * wrote to first (the auto-outreach, either wave) writes back to one of the
 * admin's numbers, the same assistant as the in-app chat answers, from that
 * same number, with the same knowledge, written as a WhatsApp message.
 *
 * Only then:
 *   - switched on (AppSetting waAutoReplyEnabled), and only messages that
 *     arrived after it was switched on (waAutoReplySince) and in the last
 *     10 minutes: never the old messages, never a backlog after a restart;
 *   - a one-to-one chat with a teacher whose outreach was sent; anyone else
 *     (friends, family, groups, statuses) is never answered;
 *   - not while a person is handling the chat: a message the admin typed
 *     (on the phone, or from the dashboard) pauses the AI there for 12 hours;
 *   - at most 12 AI replies per chat and 150 in all per day.
 * Several quick messages are answered once, 9 s after the last; "yazır…" shows
 * while the reply is written; a voice message is heard (helper/transcribe).
 *
 * Logs never carry a phone number or a message (helper/whatsapp's rule).
 */

const AppSetting = require("../models/appSettingModel");
const User = require("../models/userModel");
const WaAutoChat = require("../models/waAutoChatModel");

const ENABLED_KEY = "waAutoReplyEnabled";
const SINCE_KEY = "waAutoReplySince";
const DEBOUNCE_MS = Number(process.env.WA_AI_DEBOUNCE_MS) || 9000;
// How long after a message from this number to look whether the system sent it.
const HUMAN_CHECK_MS = Number(process.env.WA_AI_HUMAN_CHECK_MS) || 4000;
const MAX_AGE_MS = 10 * 60 * 1000;
const HUMAN_PAUSE_MS = 12 * 3600 * 1000;
const PER_CHAT_PER_DAY = 12;
const DAILY_MAX = 150;
const HISTORY = 24;

const bakuDay = (t = Date.now()) => new Date(t + 4 * 3600 * 1000).toISOString().slice(0, 10);
const digitsOf = (raw) => {
  let s = String(raw || "").trim();
  const plus = s.startsWith("+");
  s = s.replace(/\D/g, "");
  if (!s) return null;
  if (!plus) {
    if (s.startsWith("00")) s = s.slice(2);
    else if (s.startsWith("0")) s = `994${s.slice(1)}`;
    else if (s.length === 9) s = `994${s}`;
  }
  return s.length >= 8 ? s : null;
};

/* ── settings ── */
let settingsCache = { at: 0, enabled: false, since: 0 };
async function getSettings({ fresh = false } = {}) {
  if (!fresh && Date.now() - settingsCache.at < 20000) return settingsCache;
  const rows = await AppSetting.find({ key: { $in: [ENABLED_KEY, SINCE_KEY] } }).lean();
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  settingsCache = { at: Date.now(), enabled: v[ENABLED_KEY] === true, since: v[SINCE_KEY] ? new Date(v[SINCE_KEY]).getTime() : 0 };
  return settingsCache;
}
async function setEnabled(on) {
  await AppSetting.updateOne({ key: ENABLED_KEY }, { $set: { value: !!on } }, { upsert: true });
  // Switching on starts from now: older messages are never answered.
  if (on) await AppSetting.updateOne({ key: SINCE_KEY }, { $set: { value: new Date() } }, { upsert: true });
  return getSettings({ fresh: true });
}
async function repliesToday() {
  const [row] = await WaAutoChat.aggregate([{ $match: { day: bakuDay() } }, { $group: { _id: null, n: { $sum: "$replies" } } }]);
  return row?.n || 0;
}

/* ── who may be answered ── */
const adminCache = new Map(); // ownerKey -> { at, admin }
async function isAdminNumber(ownerKey) {
  const hit = adminCache.get(ownerKey);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.admin;
  const id = String(ownerKey).split("__")[0];
  const u = await User.findById(id).select("role").lean().catch(() => null);
  const admin = u?.role === "admin";
  adminCache.set(ownerKey, { at: Date.now(), admin });
  return admin;
}
let outreached = { at: 0, list: [] };
async function outreachedTeachers() {
  if (Date.now() - outreached.at < 5 * 60 * 1000) return outreached.list;
  const rows = await User.find({ role: "teacher", $or: [{ outreachStatus: "sent" }, { reengageStatus: "sent" }] })
    .select("_id phone")
    .lean();
  outreached = { at: Date.now(), list: rows.map((r) => ({ _id: r._id, digits: digitsOf(r.phone) })).filter((r) => r.digits) };
  return outreached.list;
}
// The sender's phone digits: from "<digits>@c.us", else the contact, else WhatsApp's LID map.
async function senderDigits(client, msg) {
  const from = String(msg.from || "");
  if (from.endsWith("@c.us")) return from.split("@")[0];
  try {
    const c = await msg.getContact();
    if (c?.number) return String(c.number).replace(/\D/g, "");
  } catch {
    /* next */
  }
  if (from.endsWith("@lid") && typeof client.getContactLidAndPhone === "function") {
    try {
      const [r] = await client.getContactLidAndPhone([from]);
      const pn = String(r?.pn || "").split("@")[0];
      if (pn) return pn.replace(/\D/g, "");
    } catch {
      /* none */
    }
  }
  return null;
}
async function teacherFor(client, msg) {
  const digits = await senderDigits(client, msg);
  if (!digits) return null;
  return (await outreachedTeachers()).find((t) => t.digits === digits) || null;
}

/* ── what the system sent, and what a person typed ── */
const systemSent = new Set(); // message ids the system sent (outreach, notifications, AI replies)
function remember(id) {
  if (!id) return;
  systemSent.add(id);
  if (systemSent.size > 5000) systemSent.delete(systemSent.values().next().value);
}
async function pauseForHuman(ownerKey, chatId) {
  await WaAutoChat.updateOne(
    { key: `${ownerKey}|${chatId}` },
    { $set: { owner: ownerKey, humanUntil: new Date(Date.now() + HUMAN_PAUSE_MS) } },
    { upsert: true }
  );
}
// Called for every message helper/whatsapp sends; `human` = typed by the admin in the dashboard.
function noteSent(ownerKey, sent, { human = false, chatId = "" } = {}) {
  remember(sent?.id?._serialized);
  if (human && chatId) pauseForHuman(ownerKey, chatId).catch(() => {});
}
// A message from this number that the system did not send was typed by a person.
function onCreated(ownerKey, msg) {
  if (!msg?.fromMe) return;
  const id = msg.id?._serialized;
  const to = String(msg.to || "");
  if (!id || !to || to.endsWith("@g.us") || to === "status@broadcast") return;
  // sendMessage resolves after this event fires: give it a moment to be noted.
  setTimeout(() => {
    if (systemSent.has(id)) return;
    pauseForHuman(ownerKey, to).catch(() => {});
  }, HUMAN_CHECK_MS);
}

/* ── answering ── */
const pending = new Map(); // chat key -> timer
const busy = new Set();
const again = new Set();

async function voiceText(m) {
  try {
    const media = await m.downloadMedia();
    if (!media?.data) return "";
    const { transcribe } = require("./transcribe");
    return await transcribe(Buffer.from(media.data, "base64"), { mimetype: media.mimetype || "audio/ogg", filename: "voice.ogg" });
  } catch {
    return "";
  }
}

async function answer(ownerKey, client, chatId, teacher) {
  const key = `${ownerKey}|${chatId}`;
  if (busy.has(key)) {
    again.add(key);
    return;
  }
  busy.add(key);
  try {
    const settings = await getSettings();
    if (!settings.enabled) return;
    const today = bakuDay();
    const state = await WaAutoChat.findOne({ key }).lean();
    if (state?.humanUntil && new Date(state.humanUntil) > new Date()) return;
    if (state?.day === today && state.replies >= PER_CHAT_PER_DAY) return;
    if ((await repliesToday()) >= DAILY_MAX) return;

    const chat = await client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit: HISTORY });
    const last = msgs[msgs.length - 1];
    if (!last || last.fromMe) return; // already answered
    const ours = msgs.find((m) => m.fromMe && m.body);
    const history = [];
    for (const m of msgs) {
      let text = String(m.body || "").trim();
      if (!m.fromMe && (m.type === "ptt" || m.type === "audio")) {
        // Only a new voice message is heard (and paid for); older ones are named.
        const heard = m.timestamp * 1000 + 999 >= settings.since ? await voiceText(m) : "";
        text = heard ? `[səs mesajı] ${heard}` : "[səs mesajı göndərdi, amma eşidilmədi]";
      }
      if (text) history.push({ from: m.fromMe ? "support" : "teacher", text });
    }

    await chat.sendStateTyping().catch(() => {});
    const { generateSupportReply } = require("../services/chatAssistant");
    const reply = await generateSupportReply(history, "support", { channel: "whatsapp", context: ours?.body || "" });
    await chat.clearState().catch(() => {});
    if (!reply) return;

    // A person may have stepped in while it was written.
    const now = await WaAutoChat.findOne({ key }).lean();
    if (now?.humanUntil && new Date(now.humanUntil) > new Date()) return;
    const sent = await client.sendMessage(chatId, reply);
    remember(sent?.id?._serialized);
    await WaAutoChat.updateOne(
      { key },
      state?.day === today
        ? { $set: { owner: ownerKey, user: teacher._id, lastReplyAt: new Date() }, $inc: { replies: 1 } }
        : { $set: { owner: ownerKey, user: teacher._id, lastReplyAt: new Date(), day: today, replies: 1 } },
      { upsert: true }
    );
    console.info(`[WA-AI] replied on ${ownerKey} to teacher ${teacher._id}`);
  } catch (e) {
    console.warn(`[WA-AI] no reply on ${ownerKey}: ${e?.message || e}`);
  } finally {
    busy.delete(key);
    if (again.delete(key)) schedule(ownerKey, client, chatId, teacher);
  }
}

function schedule(ownerKey, client, chatId, teacher) {
  const key = `${ownerKey}|${chatId}`;
  clearTimeout(pending.get(key));
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      answer(ownerKey, client, chatId, teacher);
    }, DEBOUNCE_MS)
  );
}

async function onIncoming(ownerKey, client, msg) {
  if (!msg || msg.fromMe || msg.isStatus || msg.broadcast) return;
  const chatId = String(msg.from || "");
  if (!chatId || chatId.endsWith("@g.us") || chatId === "status@broadcast" || chatId.endsWith("@newsletter")) return;
  if (!["chat", "ptt", "audio"].includes(msg.type)) return;
  const settings = await getSettings();
  if (!settings.enabled) return;
  const at = (msg.timestamp || 0) * 1000;
  // Only new messages (WhatsApp stamps whole seconds, so the switch-on second counts).
  if (at + 999 < settings.since || Date.now() - at > MAX_AGE_MS) return;
  if (!(await isAdminNumber(ownerKey))) return;
  const teacher = await teacherFor(client, msg);
  if (!teacher) return;
  schedule(ownerKey, client, chatId, teacher);
}

// Wire a WhatsApp client (helper/whatsapp initFor) to the auto-reply.
function attach(client, ownerKey) {
  if (!client || typeof client.on !== "function") return;
  client.on("message", (msg) => {
    onIncoming(ownerKey, client, msg).catch((e) => console.warn(`[WA-AI] skipped on ${ownerKey}: ${e?.message || e}`));
  });
  client.on("message_create", (msg) => onCreated(ownerKey, msg));
}

module.exports = {
  attach,
  noteSent,
  getSettings,
  setEnabled,
  repliesToday,
  // for tests
  _onIncoming: onIncoming,
  _onCreated: onCreated,
  _answer: answer,
  _digitsOf: digitsOf,
  _reset() {
    settingsCache = { at: 0, enabled: false, since: 0 };
    outreached = { at: 0, list: [] };
    adminCache.clear();
    systemSent.clear();
    pending.forEach((t) => clearTimeout(t));
    pending.clear();
    busy.clear();
    again.clear();
  },
  ENABLED_KEY,
  SINCE_KEY,
  LIMITS: { DEBOUNCE_MS, MAX_AGE_MS, HUMAN_PAUSE_MS, PER_CHAT_PER_DAY, DAILY_MAX },
};
