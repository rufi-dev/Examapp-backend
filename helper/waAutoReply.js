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
 *
 * Test mode (AppSetting waAutoReplyTestOwn, a switch on the WhatsApp page): the
 * admin's OWN numbers (their profile phone, and every linked admin number) are
 * answered too, so the owner can try it from one number to the other. Gates
 * 4-6 don't apply to them, and only messages since the number was switched on
 * are read.
 *
 * Never a loop: every AI reply carries an invisible mark (AI_MARK), and a
 * message with the mark is never answered; nor is a message whose WhatsApp id
 * this server sent itself (from another of its numbers). So two numbers, or
 * two AIs, can never keep answering each other; the per-chat cap is the
 * last backstop.
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
// Test mode: the admin's own numbers are answered too (true / false).
const TEST_KEY = "waAutoReplyTestOwn";
// Invisible (invisible separator, zero-width space, invisible separator), at the end of every AI reply.
const AI_MARK = String.fromCharCode(0x2063, 0x200b, 0x2063);
const aiWritten = (body) => String(body || "").includes(AI_MARK);
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
let settingsCache = { at: 0, numbers: {}, testOwn: false };
async function getSettings({ fresh = false } = {}) {
  if (!fresh && Date.now() - settingsCache.at < 20000) return settingsCache;
  const rows = await AppSetting.find({ key: { $in: [NUMBERS_KEY, TEST_KEY] } }).lean();
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const numbers = v[NUMBERS_KEY] && typeof v[NUMBERS_KEY] === "object" ? v[NUMBERS_KEY] : {};
  settingsCache = { at: Date.now(), numbers, testOwn: v[TEST_KEY] === true };
  return settingsCache;
}
async function setTestOwn(on) {
  await AppSetting.updateOne({ key: TEST_KEY }, { $set: { value: !!on } }, { upsert: true });
  return (await getSettings({ fresh: true })).testOwn;
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
  const settings = await getSettings({ fresh: true });
  const s = numberSwitch(settings, ownerKey);
  const repliedToday = await repliesToday(ownerKey).catch(() => null);
  return {
    on: s.on,
    since: s.since ? new Date(s.since) : null,
    testOwn: settings.testOwn,
    repliedToday,
    dailyMax: DAILY_MAX,
    perChatPerDay: PER_CHAT_PER_DAY,
  };
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
/*
 * The sender's phone digits, and where they came from: "<digits>@c.us" is the
 * phone itself; for WhatsApp's hidden id ("@lid") its own id-to-phone map comes
 * first, since a contact's `number` can be the hidden id rather than the phone;
 * last, the contact's id when WhatsApp gives it as a phone ("@c.us").
 */
async function senderDigits(client, msg) {
  const from = String(msg.from || "");
  if (from.endsWith("@c.us")) return { digits: from.split("@")[0], via: "phone id" };
  if (!from.endsWith("@lid")) return { digits: null, via: "no id" };
  const pn = await lidPhone(client, from);
  if (pn) return { digits: pn, via: "WhatsApp's id map" };
  try {
    const c = await msg.getContact();
    if (c?.id?.server === "c.us" && c.id.user) return { digits: String(c.id.user).replace(/\D/g, ""), via: "contact" };
  } catch {
    /* none */
  }
  return { digits: null, via: "hidden id, no phone known" };
}
const ownNumber = (client) => String(client?.info?.wid?.user || "");
// The admin's own numbers: their profile phones, and every linked admin number.
let adminPhones = { at: 0, set: new Set() };
async function ownNumbers() {
  if (Date.now() - adminPhones.at > 5 * 60 * 1000) {
    const rows = await User.find({ role: "admin" }).select("phone").lean();
    adminPhones = { at: Date.now(), set: new Set(rows.map((r) => digitsOf(r.phone)).filter(Boolean)) };
  }
  const set = new Set(adminPhones.set);
  for (const [key, c] of clients) {
    const d = ownNumber(c);
    if (d && (await isAdminNumber(key))) set.add(d);
  }
  return set;
}
// Who wrote: a teacher our automatic message went to, or (test mode only) one of
// the admin's own numbers. Anyone else: { who: null, why }. This number itself: never.
async function whoFor(client, msg, settings) {
  const { digits, via } = await senderDigits(client, msg);
  if (!digits) return { who: null, why: `the sender's phone is not known (${via})` };
  if (digits === ownNumber(client)) return { who: null, why: "this number itself" };
  if ((await ownNumbers()).has(digits)) {
    return settings.testOwn ? { who: { _id: null, digits, tester: true } } : { who: null, why: "your own number, test mode off" };
  }
  const teacher = (await outreachedTeachers()).find((t) => t.digits === digits) || null;
  return teacher ? { who: teacher } : { who: null, why: `not a teacher we wrote to, nor your own number (sender via ${via})` };
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
const sentStanzas = new Set(); // the same messages' WhatsApp ids, as the number they went to sees them
const bounded = (set, v) => {
  if (!v) return;
  set.add(v);
  if (set.size > 5000) set.delete(set.values().next().value);
};
function remember(sent) {
  bounded(systemSent, sent?.id?._serialized);
  bounded(sentStanzas, sent?.id?.id);
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
  remember(sent);
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

const MEDIA_RETRY_MS = Number(process.env.WA_AI_MEDIA_RETRY_MS) || 1500;
const VOICE_MAX_BYTES = 16 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/*
 * A voice note's audio, fetched in WhatsApp Web's own page. whatsapp-web.js
 * 1.34.7's downloadMedia() threw "r" on every try on this WhatsApp Web build
 * (2026-10-13, "Bu səs mesajı da mənə çatmadı"): its decrypt call no longer
 * works. This follows the library's unreleased fix (main branch,
 * WWebJS.resolveMediaBlob): ask WhatsApp to download the clip, wait until it
 * has, then take the audio from WhatsApp's in-memory media cache. The old
 * decrypt call stays as the last try. Every step that fails is named in
 * `steps` (WhatsApp's error names only, never the audio).
 */
async function downloadVoiceInPage(msgId, pollMs = 500, stanzaId = "", chatId = "") {
  const steps = [];
  const note = (step, e) => steps.push(`${step}: ${[e && e.name, e && e.message].filter(Boolean).join(": ") || String(e)}`.slice(0, 160));
  const C = window.require("WAWebCollections");
  let msg = msgId ? C.Msg.get(msgId) : null;
  if (!msg && msgId) {
    try {
      msg = (await C.Msg.getMessagesById([msgId]))?.messages?.[0];
    } catch (e) {
      note("find", e);
    }
  }
  // By its short id, in the chat (or anywhere the page holds it), when the full id is not known.
  if (!msg && stanzaId) {
    try {
      const chat = chatId ? C.Chat.get(window.require("WAWebWidFactory").createWid(chatId)) : null;
      const same = (x) => x && x.id && x.id.id === stanzaId;
      msg = (chat && chat.msgs.getModelsArray().find(same)) || C.Msg.getModelsArray().find(same) || null;
    } catch (e) {
      note("find by short id", e);
    }
  }
  if (!msg) return { steps: [...steps, "message not found"] };
  if (!msg.mediaData) return { steps: [...steps, "no media data"] };
  if (msg.mediaData.mediaStage === "REUPLOADING") return { steps: [...steps, "the clip has expired on WhatsApp"] };
  try {
    await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true });
  } catch (e) {
    note("ask", e);
  }
  const stage = () => String(msg.mediaData.mediaStage || "");
  for (let i = 0; i < 20 && stage() !== "RESOLVED" && !stage().includes("ERROR"); i++) await new Promise((r) => setTimeout(r, pollMs));
  let blob = null;
  try {
    const cache = window.require("WAWebMediaInMemoryBlobCache").InMemoryMediaBlobCache;
    blob = cache.get(msg.mediaObject?.filehash) || cache.get(msg.filehash) || null;
  } catch (e) {
    note("cache", e);
  }
  for (const [name, holder] of [
    ["media object", msg.mediaObject],
    ["media data", msg.mediaData],
  ]) {
    if (blob) break;
    try {
      if (holder?.mediaBlob) blob = holder.mediaBlob.forceToBlob();
    } catch (e) {
      note(name, e);
    }
  }
  if (!blob) {
    try {
      const qpl = {
        addAnnotations() {
          return this;
        },
        addPoint() {
          return this;
        },
      };
      const buf = await window.require("WAWebDownloadManager").downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: msg.type,
        signal: new AbortController().signal,
        downloadQpl: qpl,
      });
      blob = new Blob([buf]);
    } catch (e) {
      note("decrypt", e);
    }
  }
  if (!blob) return { steps: [...steps, `no audio (stage ${stage()})`] };
  const data = await window.WWebJS.arrayBufferToBase64Async(await blob.arrayBuffer());
  return { data, mimetype: msg.mimetype, steps };
}
// The audio: in the page first (above), then the library's own way, asked again a little later each time.
async function mediaOf(client, m, chatId = "") {
  const id = m.id?._serialized || m._data?._key || "";
  const stanza = m.id?.id || "";
  const tried = [];
  if (!client.pupPage || typeof client.pupPage.evaluate !== "function") tried.push("in page: no page");
  else if (!id && !stanza) tried.push("in page: the message has no id");
  else {
    for (const wait of [0, 2].map((x) => x * MEDIA_RETRY_MS)) {
      if (wait) await sleep(wait);
      try {
        const r = await timeBoxed(client.pupPage.evaluate(downloadVoiceInPage, id, Math.round(MEDIA_RETRY_MS / 3), stanza, chatId), 30000, "in-page download");
        if (r?.data) return r;
        tried.push(`in page: ${(r?.steps || []).join("; ") || "nothing"}`);
      } catch (e) {
        tried.push(`in page: ${e?.message || e}`);
      }
    }
  }
  let last = "no media";
  for (const wait of [0, 1, 2].map((x) => x * MEDIA_RETRY_MS)) {
    if (wait) await sleep(wait);
    try {
      const fresh = wait && typeof client.getMessageById === "function" ? (await client.getMessageById(id).catch(() => null)) || m : m;
      const media = await timeBoxed(fresh.downloadMedia(), 20000, "download");
      if (media?.data) return media;
      last = "not downloaded yet";
    } catch (e) {
      last = e?.message || String(e);
    }
  }
  tried.push(`library: ${last}`);
  throw new Error(`download: ${tried.join(" | ")}`);
}
// What a voice note says, heard twice ({ text, alt }, helper/transcribe); each clip is heard once.
const heardCache = new Map(); // message id -> { text, alt }
async function voiceText(client, m, ownerKey, chatId = "") {
  const id = m.id?._serialized || m._data?._key || m.id?.id;
  if (id && heardCache.has(id)) return heardCache.get(id);
  try {
    const media = await mediaOf(client, m, chatId);
    const buf = Buffer.from(media.data, "base64");
    if (buf.length > VOICE_MAX_BYTES) throw new Error("too large");
    const { hear } = require("./transcribe");
    const heard = await hear(buf, { mimetype: media.mimetype || "audio/ogg", filename: "voice.ogg" });
    const out = { text: heard?.text || "", alt: heard?.alt || "" };
    if (id && out.text) {
      heardCache.set(id, out);
      if (heardCache.size > 500) heardCache.delete(heardCache.keys().next().value);
    }
    if (!out.text) console.warn(`[WA-AI] voice not heard on ${ownerKey}: no speech found`);
    return out;
  } catch (e) {
    console.warn(`[WA-AI] voice not heard on ${ownerKey}: ${e?.message || e}`);
    return { text: "", alt: "" };
  }
}

const timeBoxed = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);

/*
 * A chat's recent messages, read in WhatsApp Web's own page. whatsapp-web.js's
 * getChatById / fetchMessages threw ("r") on this WhatsApp Web build
 * (2026-10-13), as its getChats hangs (helper/whatsapp readGroupsInPage).
 * What the page holds is read first; with `earlier`, older messages are asked
 * for until `limit`, and `complete` says whether the chat's start was reached
 * (a failure there keeps what was read, and says the start is not in sight).
 */
function readChatInPage(chatId, limit, earlier) {
  const C = window.require("WAWebCollections");
  const wid = window.require("WAWebWidFactory").createWid(chatId);
  const chat = C.Chat.get(wid);
  if (!chat) return { found: false };
  const keep = (m) => !m.isNotification;
  let msgs = chat.msgs.getModelsArray().filter(keep);
  const done = async () => {
    let complete = false;
    if (earlier) {
      try {
        while (msgs.length < limit) {
          const more = await window.require("WAWebChatLoadMessages").loadEarlierMsgs({ chat });
          if (!more || !more.length) {
            complete = true;
            break;
          }
          msgs = [...more.filter(keep), ...msgs];
        }
      } catch {
        complete = false;
      }
    }
    msgs.sort((a, b) => (a.t > b.t ? 1 : -1));
    // `_key`: the message's full WhatsApp id, which the serialized model may not carry (a voice note is fetched by it).
    const model = (m) => ({ ...window.WWebJS.getMessageModel(m), _key: m.id ? m.id._serialized || String(m.id) : "" });
    return { found: true, isGroup: !!chat.isGroup, complete, msgs: msgs.slice(-limit).map(model) };
  };
  return done();
}
// The chat's messages as whatsapp-web.js Messages: in the page first, else the library's own way.
async function readChat(client, chatId, limit, earlier, ownerKey) {
  if (client.pupPage && typeof client.pupPage.evaluate === "function") {
    try {
      const r = await timeBoxed(client.pupPage.evaluate(readChatInPage, chatId, limit, earlier), 20000, "in-page chat read");
      if (r?.found) {
        const { Message } = require("whatsapp-web.js");
        return { ...r, msgs: r.msgs.map((m) => new Message(client, m)) };
      }
    } catch (e) {
      console.warn(`[WA-AI] in-page chat read failed on ${ownerKey} (${e?.message || e}); trying fetchMessages`);
    }
  }
  const chat = await client.getChatById(chatId);
  if (!chat) return { found: false };
  const msgs = (await chat.fetchMessages({ limit })) || [];
  return { found: true, isGroup: !!chat.isGroup, complete: msgs.length < limit, msgs };
}
// "yazır…" in the chat (or its end), without opening the chat through the library.
async function chatState(client, chatId, state) {
  try {
    if (client.pupPage && typeof client.pupPage.evaluate === "function") {
      await timeBoxed(client.pupPage.evaluate((id, s) => window.WWebJS.sendChatstate(s, id), chatId, state), 5000, "chat state");
    } else {
      const chat = await client.getChatById(chatId);
      if (state === "typing") await chat.sendStateTyping();
      else await chat.clearState();
    }
  } catch {
    /* a nicety */
  }
}

const stopAt = (ownerKey, why) => {
  console.info(`[WA-AI] not answered on ${ownerKey}: ${why}`);
};
// In test mode the log also says which gate stopped a message (never who, never what),
// so a try that got no answer can be explained. Quiet otherwise.
const testNote = (settings, ownerKey, why) => {
  if (settings?.testOwn) console.info(`[WA-AI] test: not answered on ${ownerKey}: ${why}`);
};

// The last gate, right before anything is sent: everything once more, fresh.
async function stillAllowed(ownerKey, client, chatId, teacher) {
  if (killed() || !personChat(chatId)) return false;
  const settings = await getSettings({ fresh: true });
  if (!numberSwitch(settings, ownerKey).on) return false;
  const state = await WaAutoChat.findOne({ key: `${ownerKey}|${chatId}` }).lean();
  if (state?.humanUntil && new Date(state.humanUntil) > new Date()) return false;
  // The admin's own number, in test mode: still on, still theirs.
  if (teacher.tester) {
    // The last check's contact lookup for a teacher, tried too, so a test proves it (ok / failed only).
    if (settings.testOwn && typeof client.getContactById === "function") {
      const p = await client.getContactById(chatId).then(
        (c) => (c ? "ok" : "empty"),
        (e) => `failed (${e?.message || e})`
      );
      console.info(`[WA-AI] test: the last check's contact lookup ${p}`);
    }
    return settings.testOwn && (await ownNumbers()).has(teacher.digits);
  }
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
    const settings = await getSettings();
    const sw = numberSwitch(settings, ownerKey);
    const note = (why) => testNote(settings, ownerKey, why);
    if (!sw.on || killed()) return note("switched off on this number");
    const today = bakuDay();
    const state = await WaAutoChat.findOne({ key }).lean();
    if (state?.humanUntil && new Date(state.humanUntil) > new Date()) return note("a person wrote in this chat in the last 12 hours");
    if (state?.day === today && state.replies >= PER_CHAT_PER_DAY) return note(`${PER_CHAT_PER_DAY} replies in this chat today already`);
    if ((await repliesToday()) >= DAILY_MAX) return note(`${DAILY_MAX} replies today already`);

    const verified = !teacher.tester && !!state?.verified && String(state.user) === String(teacher._id);
    // A teacher's chat not yet seen to begin with our message is read back to its start. (In test
    // mode the owner's own chat is read the same way, so a test also proves that path works.)
    const needStart = !verified;
    const read = await readChat(client, chatId, verified || teacher.tester ? HISTORY : CHAT_WINDOW, needStart, ownerKey);
    if (!read?.found || read.isGroup) return note("the chat could not be read as a one-person chat");
    if (teacher.tester) note(`(not a stop) read ${read.msgs.length} messages, start of the chat ${read.complete ? "reached" : "not reached"}`);
    const msgs = read.msgs;
    // The admin's own numbers have talked before: only what came since this number was switched on is read.
    const real = msgs.filter((m) => !NOTICE_TYPES.has(m.type) && (!teacher.tester || m.timestamp * 1000 + 999 >= sw.since));
    const last = real[real.length - 1];
    // Already answered, or an AI wrote it. (Checked again here, after the wait: another of our
    // numbers can receive our reply a moment before the send has told us its WhatsApp id.)
    if (!last) return note("no message in the chat since the switch-on");
    if (last.fromMe) return note("the chat's last message is this number's own");
    if (aiWritten(last.body) || sentStanzas.has(last.id?.id)) return note("the last message was written by an AI");
    if (!verified && !teacher.tester) {
      // The chat must begin with our automatic message, and its beginning must be in sight.
      if (!read.complete || msgs.length >= CHAT_WINDOW || !isOurOutreach(real[0])) return stopAt(ownerKey, "the chat did not begin with our message");
      await WaAutoChat.updateOne({ key }, { $set: { owner: ownerKey, user: teacher._id, verified: true } }, { upsert: true });
    }
    const ours = real.find(isOurOutreach);
    const history = [];
    for (const m of real.slice(-HISTORY)) {
      let text = String(m.body || "").split(AI_MARK).join("").trim();
      if (!m.fromMe && (m.type === "ptt" || m.type === "audio")) {
        // Only a voice message since the switch-on is heard (and paid for); older ones are only named.
        if (m.timestamp * 1000 + 999 >= sw.since) {
          const heard = await voiceText(client, m, ownerKey, chatId);
          text = require("./chatVoice").voiceForAi(heard.text, heard.alt);
        } else {
          text = "[əvvəlki səs mesajı]";
        }
      }
      if (text) history.push({ from: m.fromMe ? "support" : "teacher", text });
    }

    await chatState(client, chatId, "typing");
    const { generateSupportReply } = require("../services/chatAssistant");
    // Who the teacher is, in counts (the admin's own number in test mode: none).
    const profile = teacher.tester ? "" : await require("./teacherContext").teacherContext(teacher._id);
    const reply = await generateSupportReply(history, "support", { channel: "whatsapp", context: ours?.body || "", profile });
    await chatState(client, chatId, "stop");
    if (!reply) return note("the AI gave no reply");

    // Everything once more: a person may have stepped in, or it was switched off, while it was written.
    if (!(await stillAllowed(ownerKey, client, chatId, teacher))) return stopAt(ownerKey, "a gate closed before sending");
    const sent = await client.sendMessage(chatId, `${reply}${AI_MARK}`);
    remember(sent);
    await WaAutoChat.updateOne(
      { key },
      state?.day === today
        ? { $set: { owner: ownerKey, user: teacher._id, lastReplyAt: new Date() }, $inc: { replies: 1 } }
        : { $set: { owner: ownerKey, user: teacher._id, lastReplyAt: new Date(), day: today, replies: 1 } },
      { upsert: true }
    );
    console.info(`[WA-AI] replied on ${ownerKey} to ${teacher.tester ? "the admin's own number (test mode)" : `teacher ${teacher._id}`}`);
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
  // 2. a message one person sent, in the chat with that person. (A group's messages
  // come from the group's id, so the chat id alone keeps groups out.)
  if (!msg || msg.fromMe || msg.isStatus || msg.broadcast) return;
  const chatId = String(msg.from || "");
  const settings = await getSettings();
  const note = (why) => testNote(settings, ownerKey, why);
  if (!personChat(chatId)) {
    // Groups, channels and statuses are expected; any other kind of id is worth seeing in test mode (its kind only).
    if (!/@(g\.us|newsletter|broadcast)$/.test(chatId)) note(`an unrecognised chat id kind (${chatId.replace(/^[^@]*/, "") || "empty"})`);
    return;
  }
  if (!["chat", "ptt", "audio"].includes(msg.type)) return note(`a "${msg.type}" message (only text and voice are answered)`);
  // Never a loop: an AI's reply (ours, from another number or another server) is never answered.
  if (aiWritten(msg.body) || sentStanzas.has(msg.id?.id)) return note("an AI wrote it");
  // 1. switched on for this number, and the message is new (WhatsApp stamps whole seconds, so the switch-on second counts)
  const sw = numberSwitch(settings, ownerKey);
  if (!sw.on) return note("switched off on this number");
  const at = (msg.timestamp || 0) * 1000;
  if (at + 999 < sw.since) return note("sent before the number was switched on");
  if (Date.now() - at > MAX_AGE_MS) return note("older than 10 minutes");
  // 3. on one of the admin's numbers
  if (!(await isAdminNumber(ownerKey))) return;
  // 4. a registered teacher our automatic message went to (or, in test mode, the admin's own number)
  const { who: teacher, why } = await whoFor(client, msg, settings);
  if (!teacher) return note(why);
  // 5. not someone the phone knows (the admin's own number is known, and is let through in test mode)
  if (!teacher.tester) {
    const contact = await Promise.resolve()
      .then(() => msg.getContact())
      .catch(() => null);
    if (!contactOk(contact)) return note("a saved contact, a business account or a blocked number");
  }
  if (teacher.tester) {
    // The contact lookup a teacher's message goes through, tried too, so a test proves it (ok / failed only).
    const probe = await Promise.resolve()
      .then(() => msg.getContact())
      .then(
        (c) => (c ? "ok" : "empty"),
        (e) => `failed (${e?.message || e})`
      );
    console.info(`[WA-AI] test: answering on ${ownerKey} in ${DEBOUNCE_MS / 1000} s (contact lookup ${probe})`);
  }
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
  setTestOwn,
  statusFor,
  repliesToday,
  isOurOutreach,
  // for tests
  _onIncoming: onIncoming,
  _onCreated: onCreated,
  _answer: answer,
  _digitsOf: digitsOf,
  _personChat: personChat,
  _readChat: readChat,
  _mediaOf: mediaOf,
  _reset() {
    settingsCache = { at: 0, numbers: {}, testOwn: false };
    outreached = { at: 0, list: [] };
    adminPhones = { at: 0, set: new Set() };
    sentStanzas.clear();
    heardCache.clear();
    adminCache.clear();
    clients.clear();
    systemSent.clear();
    pending.forEach((t) => clearTimeout(t));
    pending.clear();
    busy.clear();
    again.clear();
  },
  NUMBERS_KEY,
  TEST_KEY,
  AI_MARK,
  OUR_OPENINGS,
  LIMITS: { DEBOUNCE_MS, MAX_AGE_MS, HUMAN_PAUSE_MS, PER_CHAT_PER_DAY, DAILY_MAX, CHAT_WINDOW },
};
