/*
 * The support AI answering on WhatsApp (owner, 2026-10-13): when a teacher we
 * wrote to first (the auto-outreach, either wave) writes back to one of the
 * admin's numbers, the same assistant as the in-app chat answers, from that
 * same number, with the same knowledge, written as a WhatsApp message.
 *
 * The admin's number is also a personal phone, so every gate below must pass,
 * and the last one checks it all again, fresh, right before anything is sent:
 *   1. switched on for THIS number (each number has its own switch, on the
 *      WhatsApp page: AppSetting waAutoReplyNumbers; WA_AUTO_REPLY=off stops it
 *      everywhere), and only messages that arrived after that number was
 *      switched on and in the last 10 minutes: never the old messages, never a
 *      backlog after a restart;
 *   2. a chat with one person ("<digits>@c.us" / "@lid", allow-listed): never
 *      a group, community, channel, broadcast list or status;
 *   3. on one of the admin's numbers;
 *   4. the sender is a registered teacher (not deleted) our automatic message
 *      was sent to, and not this number itself;
 *   5. not someone the phone knows: a saved contact, a business account or a
 *      blocked number is left to the owner;
 *   6. the chat began with our automatic message (nothing before it, from
 *      either side), so a conversation that existed before is never entered;
 *   7. not while a person is handling the chat: a message the admin typed (on
 *      the phone, or from the dashboard) pauses the AI there for 12 hours;
 *   8. at most 12 AI replies per chat and 150 in all per day.
 * Anyone who fails 1-5 is not looked at any further: the chat is not opened,
 * nothing is read, heard or stored, nothing is logged. A reply only ever goes
 * back to the chat the teacher's message came from.
 *
 * Several quick messages are answered once, 9 s after the last; "yazır…" shows
 * while the reply is written; a voice message is heard (helper/transcribe).
 *
 * Logs never carry a phone number or a message (helper/whatsapp's rule).
 */

const AppSetting = require("../models/appSettingModel");
const User = require("../models/userModel");
const WaAutoChat = require("../models/waAutoChatModel");

// One switch per WhatsApp number: { "<ownerKey>": { on, since } }.
const NUMBERS_KEY = "waAutoReplyNumbers";
const DEBOUNCE_MS = Number(process.env.WA_AI_DEBOUNCE_MS) || 9000;
// How long after a message from this number to look whether the system sent it.
const HUMAN_CHECK_MS = Number(process.env.WA_AI_HUMAN_CHECK_MS) || 4000;
const MAX_AGE_MS = 10 * 60 * 1000;
const HUMAN_PAUSE_MS = 12 * 3600 * 1000;
const PER_CHAT_PER_DAY = 12;
const DAILY_MAX = 150;
const HISTORY = 24;
// How far back it looks for the start of a chat it has not verified yet: a longer chat is left to the owner.
const CHAT_WINDOW = 60;

/*
 * The openings of every automatic outreach message ever sent (jobs/autoOutreach).
 * Keep in step with its templates: tests/wa-auto-reply checks each one.
 */
const OUR_OPENINGS = [
  "Examopia komandasından yazıram", // wave 1, 2026-08-06 to 2026-10-09
  "Examopia-da qeydiyyatdan keçdiyinizi", // wave 1 since 2026-10-09
  "*Examopia*-da qeydiyyatdan keçmişdiniz", // wave 2
];
const isOurOutreach = (m) => {
  const body = String(m?.body || "");
  return !!m?.fromMe && /^\s*Salam/.test(body) && OUR_OPENINGS.some((o) => body.includes(o));
};
// WhatsApp's own notices in a chat (encryption, changes): not something a person sent.
const NOTICE_TYPES = new Set(["e2e_notification", "notification", "notification_template", "gp2", "protocol"]);
// A chat with one person. Everything else is never touched.
const personChat = (id) => /^\d{6,15}@c\.us$/.test(String(id || "")) || /^\d{6,20}@lid$/.test(String(id || ""));
// The person as the phone knows them. Fails closed: if WhatsApp can't say, no answer.
const contactOk = (c) => !!c && !c.isMe && !c.isGroup && !c.isBlocked && !c.isMyContact && !c.isBusiness && !c.isEnterprise;
const killed = () => process.env.WA_AUTO_REPLY === "off";

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
let settingsCache = { at: 0, numbers: {} };
async function getSettings({ fresh = false } = {}) {
  if (!fresh && Date.now() - settingsCache.at < 20000) return settingsCache;
  const row = await AppSetting.findOne({ key: NUMBERS_KEY }).lean();
  const numbers = row?.value && typeof row.value === "object" ? row.value : {};
  settingsCache = { at: Date.now(), numbers };
  return settingsCache;
}
// One number's switch: { on, since (ms) }. A number never switched on is off.
function numberSwitch(settings, ownerKey) {
  const n = settings?.numbers?.[ownerKey];
  return { on: n?.on === true, since: n?.since ? new Date(n.since).getTime() : 0 };
}
async function setEnabled(ownerKey, on) {
  const { numbers } = await getSettings({ fresh: true });
  const prev = numbers[ownerKey] || {};
  // Switching on starts from now: older messages are never answered.
  const next = { ...numbers, [ownerKey]: { on: !!on, since: on ? new Date() : prev.since || null } };
  await AppSetting.updateOne({ key: NUMBERS_KEY }, { $set: { value: next } }, { upsert: true });
  return numberSwitch(await getSettings({ fresh: true }), ownerKey);
}
// AI replies today (Baku day): on one number, or on all of them.
async function repliesToday(ownerKey) {
  const match = ownerKey ? { day: bakuDay(), owner: ownerKey } : { day: bakuDay() };
  const [row] = await WaAutoChat.aggregate([{ $match: match }, { $group: { _id: null, n: { $sum: "$replies" } } }]);
  return row?.n || 0;
}
// One number's switch, for the admin's WhatsApp page.
async function statusFor(ownerKey) {
  const s = numberSwitch(await getSettings({ fresh: true }), ownerKey);
  const repliedToday = await repliesToday(ownerKey).catch(() => null);
  return { on: s.on, since: s.since ? new Date(s.since) : null, repliedToday, dailyMax: DAILY_MAX, perChatPerDay: PER_CHAT_PER_DAY };
}

/* ── who may be answered ── */
const clients = new Map(); // ownerKey -> its WhatsApp client
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
const OUTREACHED = { role: "teacher", deletedAt: null, $or: [{ outreachStatus: "sent" }, { reengageStatus: "sent" }] };
let outreached = { at: 0, list: [] };
async function outreachedTeachers() {
  if (Date.now() - outreached.at < 5 * 60 * 1000) return outreached.list;
  const rows = await User.find(OUTREACHED).select("_id phone").lean();
  outreached = { at: Date.now(), list: rows.map((r) => ({ _id: r._id, digits: digitsOf(r.phone) })).filter((r) => r.digits) };
  return outreached.list;
}
async function lidPhone(client, lid) {
  if (!client || typeof client.getContactLidAndPhone !== "function") return null;
  try {
    const [r] = await client.getContactLidAndPhone([lid]);
    return String(r?.pn || "").split("@")[0].replace(/\D/g, "") || null;
  } catch {
    return null;
  }
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
  return from.endsWith("@lid") ? lidPhone(client, from) : null;
}
const ownNumber = (client) => String(client?.info?.wid?.user || "");
async function teacherFor(client, msg) {
  const digits = await senderDigits(client, msg);
  if (!digits || digits === ownNumber(client)) return null;
  return (await outreachedTeachers()).find((t) => t.digits === digits) || null;
}
// The teacher a chat is with, if it is one the AI may answer (else null).
async function teacherForChat(ownerKey, chatId) {
  if (!personChat(chatId)) return null;
  const digits = chatId.endsWith("@c.us") ? chatId.split("@")[0] : await lidPhone(clients.get(ownerKey), chatId);
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
// Only a chat with a teacher the AI may answer is remembered: anyone else's chat leaves no trace.
async function pauseForHuman(ownerKey, chatId) {
  const teacher = await teacherForChat(ownerKey, chatId);
  if (!teacher) return;
  await WaAutoChat.updateOne(
    { key: `${ownerKey}|${chatId}` },
    { $set: { owner: ownerKey, user: teacher._id, humanUntil: new Date(Date.now() + HUMAN_PAUSE_MS) } },
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
  if (!id || !personChat(to)) return;
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

const stopAt = (ownerKey, why) => {
  console.info(`[WA-AI] not answered on ${ownerKey}: ${why}`);
};

// The last gate, right before anything is sent: everything once more, fresh.
async function stillAllowed(ownerKey, client, chatId, teacher) {
  if (killed() || !personChat(chatId)) return false;
  if (!numberSwitch(await getSettings({ fresh: true }), ownerKey).on) return false;
  const state = await WaAutoChat.findOne({ key: `${ownerKey}|${chatId}` }).lean();
  if (state?.humanUntil && new Date(state.humanUntil) > new Date()) return false;
  const u = await User.findOne({ _id: teacher._id, ...OUTREACHED }).select("phone").lean();
  if (!u || digitsOf(u.phone) !== teacher.digits) return false;
  if (chatId.endsWith("@c.us") && chatId.split("@")[0] !== teacher.digits) return false;
  const contact = typeof client.getContactById === "function" ? await client.getContactById(chatId).catch(() => null) : null;
  return contactOk(contact);
}

async function answer(ownerKey, client, chatId, teacher) {
  const key = `${ownerKey}|${chatId}`;
  if (busy.has(key)) {
    again.add(key);
    return;
  }
  busy.add(key);
  try {
    const sw = numberSwitch(await getSettings(), ownerKey);
    if (!sw.on || killed()) return;
    const today = bakuDay();
    const state = await WaAutoChat.findOne({ key }).lean();
    if (state?.humanUntil && new Date(state.humanUntil) > new Date()) return;
    if (state?.day === today && state.replies >= PER_CHAT_PER_DAY) return;
    if ((await repliesToday()) >= DAILY_MAX) return;

    const chat = await client.getChatById(chatId);
    // (WhatsApp may name the same person's chat by phone or by LID: either is a person.)
    if (!chat || chat.isGroup || !personChat(chat.id?._serialized || chatId)) return;
    const verified = !!state?.verified && String(state.user) === String(teacher._id);
    const msgs = (await chat.fetchMessages({ limit: verified ? HISTORY : CHAT_WINDOW })) || [];
    const real = msgs.filter((m) => !NOTICE_TYPES.has(m.type));
    const last = real[real.length - 1];
    if (!last || last.fromMe) return; // already answered
    if (!verified) {
      // The chat must begin with our automatic message, and its beginning must be in sight.
      if (msgs.length >= CHAT_WINDOW || !isOurOutreach(real[0])) return stopAt(ownerKey, "the chat did not begin with our message");
      await WaAutoChat.updateOne({ key }, { $set: { owner: ownerKey, user: teacher._id, verified: true } }, { upsert: true });
    }
    const ours = real.find(isOurOutreach);
    const history = [];
    for (const m of real.slice(-HISTORY)) {
      let text = String(m.body || "").trim();
      if (!m.fromMe && (m.type === "ptt" || m.type === "audio")) {
        // Only a new voice message is heard (and paid for); older ones are named.
        const heard = m.timestamp * 1000 + 999 >= sw.since ? await voiceText(m) : "";
        text = heard ? `[səs mesajı] ${heard}` : "[səs mesajı göndərdi, amma eşidilmədi]";
      }
      if (text) history.push({ from: m.fromMe ? "support" : "teacher", text });
    }

    await chat.sendStateTyping().catch(() => {});
    const { generateSupportReply } = require("../services/chatAssistant");
    const reply = await generateSupportReply(history, "support", { channel: "whatsapp", context: ours?.body || "" });
    await chat.clearState().catch(() => {});
    if (!reply) return;

    // Everything once more: a person may have stepped in, or it was switched off, while it was written.
    if (!(await stillAllowed(ownerKey, client, chatId, teacher))) return stopAt(ownerKey, "a gate closed before sending");
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
  if (killed()) return;
  // 2. a message one person sent, in the chat with that person
  if (!msg || msg.fromMe || msg.isStatus || msg.broadcast) return;
  if (msg.author && msg.author !== msg.from) return; // written by someone in a group
  const chatId = String(msg.from || "");
  if (!personChat(chatId)) return;
  if (!["chat", "ptt", "audio"].includes(msg.type)) return;
  // 1. switched on for this number, and the message is new (WhatsApp stamps whole seconds, so the switch-on second counts)
  const sw = numberSwitch(await getSettings(), ownerKey);
  if (!sw.on) return;
  const at = (msg.timestamp || 0) * 1000;
  if (at + 999 < sw.since || Date.now() - at > MAX_AGE_MS) return;
  // 3. on one of the admin's numbers
  if (!(await isAdminNumber(ownerKey))) return;
  // 4. a registered teacher our automatic message went to
  const teacher = await teacherFor(client, msg);
  if (!teacher) return;
  // 5. not someone the phone knows
  const contact = await Promise.resolve()
    .then(() => msg.getContact())
    .catch(() => null);
  if (!contactOk(contact)) return;
  schedule(ownerKey, client, chatId, teacher);
}

// Wire a WhatsApp client (helper/whatsapp initFor) to the auto-reply.
function attach(client, ownerKey) {
  if (!client || typeof client.on !== "function") return;
  clients.set(ownerKey, client);
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
  statusFor,
  repliesToday,
  isOurOutreach,
  // for tests
  _onIncoming: onIncoming,
  _onCreated: onCreated,
  _answer: answer,
  _digitsOf: digitsOf,
  _personChat: personChat,
  _reset() {
    settingsCache = { at: 0, numbers: {} };
    outreached = { at: 0, list: [] };
    adminCache.clear();
    clients.clear();
    systemSent.clear();
    pending.forEach((t) => clearTimeout(t));
    pending.clear();
    busy.clear();
    again.clear();
  },
  NUMBERS_KEY,
  OUR_OPENINGS,
  LIMITS: { DEBOUNCE_MS, MAX_AGE_MS, HUMAN_PAUSE_MS, PER_CHAT_PER_DAY, DAILY_MAX, CHAT_WINDOW },
};
