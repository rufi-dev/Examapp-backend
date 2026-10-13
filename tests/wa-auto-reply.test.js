/* eslint-env node */
/*
 * The support AI answering on WhatsApp (owner, 2026-10-13): only teachers we
 * wrote to first, only new messages, never over a person, within its limits.
 * The number is the owner's personal phone too, so every gate is tried on its
 * own: groups, channels, saved contacts, business accounts, chats that existed
 * before our message, and the fresh re-check right before sending.
 * A fake WhatsApp client and stubbed database calls: nothing is sent.
 */
process.env.NODE_ENV = "test";
process.env.WA_AI_DEBOUNCE_MS = "20";
process.env.WA_AI_HUMAN_CHECK_MS = "20";

const path = require("path");

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log("  ✓", label);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", label, extra ? `- ${extra}` : "");
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── the database, in memory ── */
const AppSetting = require("../models/appSettingModel");
const User = require("../models/userModel");
const WaAutoChat = require("../models/waAutoChatModel");
const chain = (v) => ({ lean: async () => v, select() { return this; }, catch() { return this; }, then: (f) => Promise.resolve(v).then(f) });
let settings = {};
let chats = {};
const ADMIN = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TEACHER = { _id: "bbbbbbbbbbbbbbbbbbbbbbbb", phone: "+994 50 544 03 07" };
let teacherOutreached = true; // the teacher's record, as the fresh re-check reads it
AppSetting.findOne = (q) => chain(q.key in settings ? { key: q.key, value: settings[q.key] } : null);
AppSetting.updateOne = async (q, u) => {
  settings[q.key] = u.$set.value;
};
User.findById = () => ({ select: () => ({ lean: () => Promise.resolve({ role: "admin" }) }) });
User.find = () => ({ select: () => ({ lean: async () => [TEACHER] }) });
User.findOne = () => chain(teacherOutreached ? { phone: TEACHER.phone } : null);
WaAutoChat.findOne = (q) => chain(chats[q.key] || null);
WaAutoChat.updateOne = async (q, u) => {
  const cur = chats[q.key] || {};
  chats[q.key] = { ...cur, ...(u.$set || {}), ...(u.$inc ? { replies: (cur.replies || 0) + u.$inc.replies } : {}) };
};
WaAutoChat.aggregate = async () => [{ n: Object.values(chats).reduce((a, c) => a + (c.replies || 0), 0) }];

/* ── the assistant and the speech-to-text, stubbed ── */
const asked = [];
let whileWriting = null; // something that happens while the reply is being written
const assistant = require("../services/chatAssistant");
assistant.generateSupportReply = async (history, adminId, opts) => {
  asked.push({ history, adminId, opts });
  if (whileWriting) await whileWriting();
  return "Salam! *Siniflər* bölməsini açın.";
};
const T = require("../helper/transcribe");
T.transcribe = async () => "Sinfi necə yaradım?";

const ai = require("../helper/waAutoReply");
const { outreachMessage, reengageMessage } = require("../jobs/autoOutreach");
const OUTREACH = outreachMessage({ name: "Aysel Məmmədova" }, {});
const REENGAGE = reengageMessage({ name: "Aysel Məmmədova" });

/* ── a fake WhatsApp ── */
const CHAT = "994505440307@c.us";
const KEY = `${ADMIN}|${CHAT}`;
let person = {};
function fakeClient() {
  const c = { sent: [], typing: 0, handlers: {}, history: [], info: { wid: { user: "994501112200" } } };
  c.on = (ev, fn) => (c.handlers[ev] = fn);
  c.sendMessage = async (chatId, text) => {
    const m = { id: { _serialized: `sent-${c.sent.length}` }, fromMe: true, to: chatId, body: text };
    c.sent.push({ chatId, text });
    return m;
  };
  c.getContactById = async () => person;
  c.getChatById = async (id) => ({
    id: { _serialized: id },
    isGroup: false,
    fetchMessages: async () => c.history,
    sendStateTyping: async () => {
      c.typing += 1;
    },
    clearState: async () => {},
  });
  return c;
}
const now = () => Math.floor(Date.now() / 1000);
const incoming = (over = {}) => ({ from: CHAT, fromMe: false, type: "chat", body: "Salam, sinfi necə yaradım?", timestamp: now(), getContact: async () => person, ...over });
const ourFirst = (body = OUTREACH) => ({ fromMe: true, body, type: "chat", timestamp: now() - 3600 });
const theirs = (body = "Salam, sinfi necə yaradım?", ts = now()) => ({ fromMe: false, body, type: "chat", timestamp: ts });

(async () => {
  let c = fakeClient();
  const reset = () => {
    ai._reset();
    chats = {};
    asked.length = 0;
    whileWriting = null;
    teacherOutreached = true;
    person = { number: "994505440307", isUser: true, isMyContact: false, isBusiness: false, isEnterprise: false, isBlocked: false, isMe: false, isGroup: false };
    c = fakeClient();
    c.history = [ourFirst(), theirs()];
  };
  const tryOnce = async (m = incoming(), ms = 120) => {
    await ai._onIncoming(ADMIN, c, m);
    await wait(ms);
    return c.sent.length;
  };

  console.log("off unless switched on, one switch per number");
  reset();
  settings = {};
  ok("never switched on: nothing is answered", (await tryOnce()) === 0);
  await ai.setEnabled(ADMIN, true);
  ok("switching on records from when (older messages never count)", settings[ai.NUMBERS_KEY][ADMIN].on === true && settings[ai.NUMBERS_KEY][ADMIN].since instanceof Date);
  const WA2 = `${ADMIN}__wa2`;
  reset();
  await ai._onIncoming(WA2, c, incoming());
  await wait(120);
  ok("number 2 has its own switch: still off there", c.sent.length === 0);
  await ai.setEnabled(WA2, true);
  reset();
  await ai._onIncoming(WA2, c, incoming());
  await wait(120);
  ok("…switched on there, number 2 answers", c.sent.length === 1 && chats[`${WA2}|${CHAT}`]?.replies === 1);
  await ai.setEnabled(ADMIN, false);
  reset();
  ok("number 1 switched off: not answered there, while number 2 stays on", (await tryOnce()) === 0 && (await ai.statusFor(WA2)).on === true);
  const st = await ai.statusFor(ADMIN);
  ok("each number's state for the WhatsApp page", st.on === false && st.since instanceof Date && st.dailyMax === ai.LIMITS.DAILY_MAX && typeof st.repliedToday === "number");
  await ai.setEnabled(ADMIN, true);
  reset();
  process.env.WA_AUTO_REPLY = "off";
  ok("WA_AUTO_REPLY=off stops it outright", (await tryOnce()) === 0);
  delete process.env.WA_AUTO_REPLY;

  console.log("\nonly the teachers we wrote to, only new messages");
  reset();
  ok("a message from before it was switched on is not answered", (await tryOnce(incoming({ timestamp: now() - 3 * 3600 }))) === 0);
  reset();
  ok(
    "someone we never wrote to is not answered",
    (await tryOnce(incoming({ from: "994551112233@c.us", getContact: async () => ({ ...person, number: "994551112233" }) }))) === 0
  );
  reset();
  c.info.wid.user = "994505440307";
  ok("this number itself is not answered", (await tryOnce()) === 0);
  for (const [what, m] of [
    ["a group", incoming({ from: "120363000000000000@g.us" })],
    ["someone writing in a group", incoming({ author: "994551112233@c.us" })],
    ["a channel", incoming({ from: "120363000000000000@newsletter" })],
    ["a broadcast list", incoming({ from: "1700000000@broadcast" })],
    ["a status", incoming({ isStatus: true })],
    ["our own message", incoming({ fromMe: true })],
    ["a picture", incoming({ type: "image" })],
  ]) {
    reset();
    ok(`${what} is not answered`, (await tryOnce(m)) === 0);
  }
  ok("only a one-person chat id passes", ai._personChat(CHAT) && ai._personChat("123456789012@lid") && !ai._personChat("120363@g.us") && !ai._personChat("status@broadcast") && !ai._personChat(""));

  console.log("\nnot anyone the phone knows");
  for (const [what, flag] of [
    ["a saved contact", "isMyContact"],
    ["a business account", "isBusiness"],
    ["an enterprise account", "isEnterprise"],
    ["a blocked number", "isBlocked"],
  ]) {
    reset();
    person[flag] = true;
    ok(`${what} is not answered, even if registered and written to`, (await tryOnce()) === 0);
  }
  reset();
  ok(
    "if WhatsApp can't say who it is, no answer",
    (await tryOnce(
      incoming({
        getContact: async () => {
          throw new Error("no contact");
        },
      })
    )) === 0
  );

  console.log("\nonly a chat that began with our message");
  reset();
  c.history = [theirs("Salam qardaş, necəsən?", now() - 90 * 86400), ourFirst(), theirs()];
  ok("a chat that existed before our message is not answered", (await tryOnce()) === 0);
  ok("…and nothing about it is stored", !chats[KEY]);
  reset();
  c.history = [{ fromMe: true, body: "Sabah görüşürük", type: "chat", timestamp: now() - 86400 }, ourFirst(), theirs()];
  ok("a chat where the owner wrote first is not answered", (await tryOnce()) === 0);
  reset();
  c.history = [theirs("Salam, Examopia necə işləyir?", now() - 7200), theirs()];
  ok("a chat with no message of ours is not answered", (await tryOnce()) === 0);
  reset();
  c.history = [ourFirst(), ...Array.from({ length: ai.LIMITS.CHAT_WINDOW }, (_, i) => theirs(`mesaj ${i}`, now() - 60 + i))];
  ok("a chat too long to see its beginning is left to the owner", (await tryOnce()) === 0);
  reset();
  c.history = [{ fromMe: false, type: "e2e_notification", body: "", timestamp: now() - 4000 }, ourFirst(), theirs()];
  ok("WhatsApp's own notices before our message don't count as people", (await tryOnce()) === 1);
  ok("…and the chat is marked as begun by us", chats[KEY]?.verified === true && chats[KEY]?.user === TEACHER._id);
  reset();
  c.history = [ourFirst(REENGAGE), theirs()];
  ok("a chat begun by the second wave is answered", (await tryOnce()) === 1);

  console.log("\nthe answer");
  reset();
  await ai._onIncoming(ADMIN, c, incoming());
  await ai._onIncoming(ADMIN, c, incoming({ body: "bir də soruşum" }));
  await wait(150);
  ok("a teacher we wrote to gets one answer for quick messages, in the same chat", c.sent.length === 1 && c.sent[0].chatId === CHAT, JSON.stringify(c.sent));
  ok("«yazır…» shows while it is written", c.typing >= 1);
  ok("the same assistant, in its WhatsApp mode, with our first message as context", asked[0]?.opts?.channel === "whatsapp" && asked[0].opts.context === OUTREACH);
  ok("the conversation is passed as teacher / support turns", asked[0].history.at(-1).from === "teacher" && asked[0].history[0].from === "support" && asked[0].adminId === "support");
  ok("the reply is counted for the chat", chats[KEY]?.replies === 1);

  console.log("\nthe last gate, fresh, right before sending");
  const switches = settings[ai.NUMBERS_KEY];
  for (const [what, change] of [
    ["this number switched off", () => (settings[ai.NUMBERS_KEY] = { ...switches, [ADMIN]: { on: false } })],
    ["the teacher's record no longer outreached", () => (teacherOutreached = false)],
    ["saved as a contact", () => (person.isMyContact = true)],
    ["a person stepped in", () => (chats[KEY] = { ...(chats[KEY] || {}), humanUntil: new Date(Date.now() + 3600e3) })],
  ]) {
    reset();
    whileWriting = change;
    const n = await tryOnce();
    ok(`${what} while the reply was written: nothing is sent`, asked.length === 1 && n === 0, `asked=${asked.length} sent=${n}`);
    settings[ai.NUMBERS_KEY] = switches;
  }

  console.log("\na person takes over");
  reset();
  ai._onCreated(ADMIN, { fromMe: true, id: { _serialized: "typed-on-phone" }, to: CHAT });
  await wait(60);
  ok("a message typed on the phone pauses the AI in that chat", chats[KEY]?.humanUntil > new Date());
  ok("…so the teacher's next message is left to the person", (await tryOnce()) === 0);
  reset();
  ai._onCreated(ADMIN, { fromMe: true, id: { _serialized: "to-a-friend" }, to: "994551112233@c.us" });
  ai._onCreated(ADMIN, { fromMe: true, id: { _serialized: "to-a-group" }, to: "120363000000000000@g.us" });
  await wait(60);
  ok("writing to a friend or a group stores nothing at all", Object.keys(chats).length === 0, JSON.stringify(chats));
  reset();
  const sys = await c.sendMessage(CHAT, "Avtomatik xatırlatma");
  ai.noteSent(ADMIN, sys);
  ai._onCreated(ADMIN, sys);
  await wait(60);
  ok("the system's own message (outreach, a reply) is not taken for a person", !chats[KEY]?.humanUntil);
  reset();
  ai.noteSent(ADMIN, { id: { _serialized: "dash" } }, { human: true, chatId: CHAT });
  await wait(20);
  ok("a message the admin typed in the dashboard pauses it too", chats[KEY]?.humanUntil > new Date());

  console.log("\nlimits and voice");
  reset();
  chats[KEY] = { day: new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10), replies: ai.LIMITS.PER_CHAT_PER_DAY };
  ok(`at most ${ai.LIMITS.PER_CHAT_PER_DAY} AI replies a day in one chat`, (await tryOnce()) === 0);
  reset();
  c.history = [
    ourFirst(),
    { fromMe: false, body: "", type: "ptt", timestamp: now(), downloadMedia: async () => ({ data: Buffer.from("ogg").toString("base64"), mimetype: "audio/ogg" }) },
  ];
  await tryOnce(incoming({ type: "ptt", body: "" }), 150);
  ok("a voice message is heard and answered in text", c.sent.length === 1 && /\[səs mesajı\] Sinfi necə yaradım\?/.test(asked[0]?.history.at(-1).text || ""), JSON.stringify(asked[0]?.history));

  console.log("\nour messages, recognised");
  const OLD = "Salam Aysel müəllim 🙂 Examopia komandasından yazıram. Gördüm ki, qeydiyyatdan keçmisiniz, amma hələ başlamamısınız.";
  ok("every outreach message ever sent opens a chat the AI may answer", [OUTREACH, REENGAGE, OLD].every((body) => ai.isOurOutreach({ fromMe: true, body })));
  ok("the same words from the teacher are not ours", !ai.isOurOutreach({ fromMe: false, body: OUTREACH }));
  ok("a personal message that mentions Examopia is not ours", !ai.isOurOutreach({ fromMe: true, body: "Salam, Examopia-da qeydiyyatdan keçdin?" }));

  console.log("\nwired in");
  const fs = require("fs");
  const wa = fs.readFileSync(path.join(__dirname, "..", "helper", "whatsapp.js"), "utf8");
  ok("every WhatsApp client gets the auto-reply", /require\("\.\/waAutoReply"\)\.attach\(s\.client, id\)/.test(wa));
  ok("every send is noted (so the system is never taken for a person)", /require\("\.\/waAutoReply"\)\.noteSent\(String\(ownerId\), sent, \{ human, chatId \}\)/.test(wa));
  const route = fs.readFileSync(path.join(__dirname, "..", "routes", "whatsappRoute.js"), "utf8");
  ok(
    "each number's switch is read and set on the WhatsApp page, admins only",
    /router\.get\("\/ai-reply", protect, adminOnly,/.test(route) && /router\.post\("\/ai-reply", protect, adminOnly,/.test(route) && /setEnabled\(key\(req\), req\.body\.on\)/.test(route)
  );
  const userRoute = fs.readFileSync(path.join(__dirname, "..", "routes", "userRoute.js"), "utf8");
  ok("the old one-switch-for-all is gone", !/wa-auto-reply\/toggle/.test(userRoute));
  const ctl = fs.readFileSync(path.join(__dirname, "..", "controllers", "whatsappController.js"), "utf8");
  ok("the admin's own dashboard message counts as a person", /sendMessageFor\(ownerId, recipient\.phone, message, \{ human: true \}\)/.test(ctl));
  const { forWhatsApp } = require("../services/chatAssistant");
  ok("a reply made for WhatsApp: no guide markers, «words» in bold", forWhatsApp("1) «Siniflər» açın.\n[[steps:nav.sinifler]]") === "1) *Siniflər* açın.");

  ai._reset();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
