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
process.env.WA_AI_MEDIA_RETRY_MS = "5";

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
AppSetting.find = (q) => chain(Object.entries(settings).filter(([k]) => (q?.key?.$in || []).includes(k)).map(([key, value]) => ({ key, value })));
AppSetting.updateOne = async (q, u) => {
  settings[q.key] = u.$set.value;
};
User.findById = () => ({ select: () => ({ lean: () => Promise.resolve({ role: "admin" }) }) });
const ADMIN_PHONE = "+994 55 111 58 59"; // the admin's profile phone: their first number
User.find = (q) => ({ select: () => ({ lean: async () => (q?.role === "admin" ? [{ phone: ADMIN_PHONE }] : [TEACHER]) }) });
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
let heardAs = { text: "Sinfi necə yaradım?", alt: "" };
let hearings = 0;
T.hear = async () => {
  hearings += 1;
  return heardAs;
};

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
    const stanza = `ST${Math.random().toString(36).slice(2)}`;
    const m = { id: { _serialized: `true_${chatId}_${stanza}`, id: stanza }, fromMe: true, to: chatId, body: text };
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
    ["someone writing in a group", incoming({ from: "120363000000000000@g.us", author: "994505440307@c.us" })],
    ["a channel", incoming({ from: "120363000000000000@newsletter" })],
    ["a broadcast list", incoming({ from: "1700000000@broadcast" })],
    ["a status", incoming({ isStatus: true })],
    ["our own message", incoming({ fromMe: true })],
    ["a picture", incoming({ type: "image" })],
  ]) {
    reset();
    ok(`${what} is not answered`, (await tryOnce(m)) === 0);
  }
  // WhatsApp's hidden ids ("@lid"): the phone comes from WhatsApp's own map, not the contact's
  // `number` (which can be the hidden id itself); a private message may carry an author.
  const LID = "123456789012345@lid";
  reset();
  c.getContactLidAndPhone = async () => [{ lid: LID, pn: CHAT }];
  ok(
    "a teacher writing under WhatsApp's hidden id is recognised by the phone behind it",
    (await tryOnce(incoming({ from: LID, author: LID, getContact: async () => ({ ...person, number: "123456789012345" }) }))) === 1 && c.sent[0]?.chatId === LID,
    JSON.stringify(c.sent)
  );
  reset();
  ok("…and without a known phone, not answered", (await tryOnce(incoming({ from: LID, getContact: async () => ({ ...person, number: "123456789012345" }) }))) === 0);
  // A teacher stored as "+994 0XX…" (the national 0 kept): WhatsApp gives the phone without it.
  reset();
  const TEACHER_PHONE = TEACHER.phone;
  TEACHER.phone = "+994 0505440307";
  c.getContactLidAndPhone = async () => [{ lid: LID, pn: CHAT }];
  ok("a teacher stored with the extra 0 after +994 is still recognised", (await tryOnce(incoming({ from: LID }))) === 1);
  TEACHER.phone = TEACHER_PHONE;
  const W = require("../helper/whatsapp");
  const same = ["+994 0505440307", "+994 50 544 03 07", "0505440307", "505440307", "+9940505440307", "00994505440307"];
  ok(
    "sending and matching read a stored phone the same way, extra 0 or not",
    same.every((p) => ai._digitsOf(p) === "994505440307" && W.toDigits(p) === "994505440307"),
    JSON.stringify(same.map((p) => [ai._digitsOf(p), W.toDigits(p)]))
  );
  ok("…and leave other countries' numbers alone", ai._digitsOf("+90 532 123 45 67") === "905321234567" && W.toDigits("+7 916 123 45 67") === "79161234567");
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

  // WhatsApp fetches a voice note only when asked; the first look can find it still on its way.
  const voiceNote = (over = {}) => ({ fromMe: false, body: "", type: "ptt", timestamp: now(), id: { _serialized: `false_${CHAT}_V${Math.random()}`, id: "V" }, ...over });
  reset();
  let looks = 0;
  c.history = [ourFirst(), voiceNote({ downloadMedia: async () => (++looks < 3 ? undefined : { data: Buffer.from("ogg").toString("base64"), mimetype: "audio/ogg" }) })];
  await tryOnce(incoming({ type: "ptt", body: "" }), 200);
  ok("a voice note still downloading is asked for again until it arrives, then heard", looks === 3 && /\[səs mesajı\] Sinfi necə yaradım\?/.test(asked[0]?.history.at(-1).text || ""), `looks=${looks} ${JSON.stringify(asked[0]?.history)}`);
  reset();
  c.history = [ourFirst(), voiceNote({ downloadMedia: async () => undefined })];
  await tryOnce(incoming({ type: "ptt", body: "" }), 200);
  ok("…one that never arrives is answered with a polite ask to say it again", asked[0]?.history.at(-1).text === "[səs mesajı göndərdi, amma eşidilmədi]");
  reset();
  heardAs = { text: "Sinfə necə keçim?", alt: "Sinfə şagird necə əlavə edim?" };
  hearings = 0;
  const sameNote = voiceNote({ downloadMedia: async () => ({ data: Buffer.from("ogg").toString("base64"), mimetype: "audio/ogg" }) });
  c.history = [ourFirst(), sameNote];
  await tryOnce(incoming({ type: "ptt", body: "" }), 150);
  ok("heard two ways: the AI sees both hearings", asked[0]?.history.at(-1).text === "[səs mesajı] Sinfə necə keçim? (başqa cür də eşidildi: «Sinfə şagird necə əlavə edim?»)", asked[0]?.history.at(-1).text);
  c.history = [ourFirst(), sameNote, { fromMe: true, body: "Cavab", type: "chat", timestamp: now() }, theirs("Bəs sonra?")];
  chats = {};
  await tryOnce(incoming(), 150);
  ok("each clip is heard once (not again on the next answer)", hearings === 1 && /Sinfə necə keçim/.test(asked[1]?.history.find((x) => /səs mesajı/.test(x.text))?.text || ""), `hearings=${hearings}`);
  heardAs = { text: "Sinfi necə yaradım?", alt: "" };
  reset();
  c.history = [ourFirst(), voiceNote({ timestamp: now() - 5 * 86400, downloadMedia: async () => ({ data: "eA==" }) }), theirs("Salam")];
  hearings = 0;
  await tryOnce(incoming(), 150);
  ok("a voice note from before the switch-on is only named, not heard or asked about", hearings === 0 && asked[0]?.history.some((x) => x.text === "[əvvəlki səs mesajı]"), JSON.stringify(asked[0]?.history));

  console.log("\ntest mode: the admin's own numbers, and never a loop");
  const OWN = "994551115859";
  const OWN_CHAT = `${OWN}@c.us`;
  const own = (over = {}) => incoming({ from: OWN_CHAT, getContact: async () => ({ ...person, number: OWN, isMyContact: true }), ...over });
  reset();
  c.history = [theirs("Salam, test")];
  ok("test mode off: my own number is not answered", (await tryOnce(own())) === 0);
  await ai.setTestOwn(true);
  ok("test mode is reported for the WhatsApp page", (await ai.statusFor(ADMIN)).testOwn === true);
  reset();
  c.history = [{ fromMe: true, body: "Sabah zəng edərəm", type: "chat", timestamp: now() - 86400 }, theirs("Salam, sinfi necə yaradım?")];
  ok("test mode on: my own number is answered (saved in the phone, an old chat, no outreach)", (await tryOnce(own())) === 1);
  ok("…reading only what came since the number was switched on", asked[0]?.history.length === 1 && asked[0].history[0].text === "Salam, sinfi necə yaradım?", JSON.stringify(asked[0]?.history));
  ok("…never recorded as a teacher", chats[`${ADMIN}|${OWN_CHAT}`]?.user === null);
  ok("every AI reply carries the invisible mark, and nothing else changes", c.sent[0]?.text === `Salam! *Siniflər* bölməsini açın.${ai.AI_MARK}`);
  reset();
  ok("a message an AI wrote is never answered", (await tryOnce(own({ body: `Salam!${ai.AI_MARK}` }))) === 0);
  reset();
  ok("…not from a teacher either", (await tryOnce(incoming({ body: `Cavab${ai.AI_MARK}` }))) === 0);

  // Two of the admin's numbers, both switched on, wired to each other the way WhatsApp is:
  // what one sends, the other receives with the same WhatsApp id.
  const twoNumbers = async ({ dropMark }) => {
    reset();
    const NUM1 = OWN;
    const NUM2 = "994705552054";
    const a = fakeClient();
    const b = fakeClient();
    a.info.wid.user = NUM1;
    b.info.wid.user = NUM2;
    ai.attach(a, ADMIN);
    ai.attach(b, WA2);
    const wire = (from, to, fromNum) => {
      const send = from.sendMessage;
      from.sendMessage = async (chatId, text) => {
        const m = await send(chatId, text);
        from.history.push({ fromMe: true, body: text, type: "chat", timestamp: now() });
        const body = dropMark ? text.split(ai.AI_MARK).join("") : text;
        const got = { from: `${fromNum}@c.us`, fromMe: false, type: "chat", body, timestamp: now(), id: { id: m.id.id }, getContact: async () => ({ ...person, number: fromNum }) };
        to.history.push({ ...got });
        await to.handlers.message(got);
        return m;
      };
    };
    wire(a, b, NUM1);
    wire(b, a, NUM2);
    // The owner types on number 1's phone, to number 2.
    const typed = { from: `${NUM1}@c.us`, fromMe: false, type: "chat", body: "Salam, test edirəm", timestamp: now(), id: { id: "HUMAN1" }, getContact: async () => ({ ...person, number: NUM1 }) };
    a.history.push({ fromMe: true, body: typed.body, type: "chat", timestamp: now() });
    b.history.push({ ...typed });
    await b.handlers.message(typed);
    await wait(500);
    return { one: a.sent.length, two: b.sent.length };
  };
  let r = await twoNumbers({ dropMark: false });
  ok("from number 1 to number 2: exactly one AI reply, and number 1 does not answer it", r.two === 1 && r.one === 0, JSON.stringify(r));
  r = await twoNumbers({ dropMark: true });
  ok("…even if WhatsApp dropped the invisible mark: the server knows its own message", r.two === 1 && r.one === 0, JSON.stringify(r));
  await ai.setTestOwn(false);
  reset();
  c.history = [theirs("Salam, test")];
  ok("test mode switched off: my own number is not answered again", (await tryOnce(own())) === 0);

  console.log("\nreading the chat in WhatsApp Web's page");
  const page = (models, { earlier = [], fail = false } = {}) => {
    let calls = 0;
    global.window = {
      require: (name) =>
        ({
          WAWebCollections: { Chat: { get: () => ({ isGroup: false, msgs: { getModelsArray: () => models } }) } },
          WAWebWidFactory: { createWid: (id) => id },
          WAWebChatLoadMessages: {
            loadEarlierMsgs: async () => {
              if (fail) throw new Error("r");
              return earlier[calls++] || [];
            },
          },
        })[name],
      WWebJS: { getMessageModel: (m) => m },
    };
  };
  const model = (i, fromMe, body) => ({ id: { fromMe, id: `M${i}`, _serialized: `${fromMe}_${CHAT}_M${i}`, remote: CHAT }, body, type: "chat", t: 1000 + i, from: fromMe ? "me" : CHAT });
  const pc = { pupPage: { evaluate: (fn, ...a) => fn(...a) } };
  page([model(2, false, "Salam")], { earlier: [[model(1, true, OUTREACH)]] });
  let rr = await ai._readChat(pc, CHAT, 60, true, ADMIN);
  ok(
    "the page's messages, older ones asked for, in order, as whatsapp-web.js Messages",
    rr.found && rr.complete && rr.msgs.length === 2 && rr.msgs[0].fromMe === true && rr.msgs[0].body === OUTREACH && rr.msgs[1].timestamp === 1002 && rr.msgs[1].id.id === "M2",
    JSON.stringify({ found: rr.found, complete: rr.complete, n: rr.msgs?.length })
  );
  ok("each message keeps its full WhatsApp id (a voice note is fetched by it)", rr.msgs[1]._data._key === `false_${CHAT}_M2`);
  const bare = { ...model(3, false, ""), id: { fromMe: false, id: "M3", toString: () => `false_${CHAT}_M3` } };
  page([bare]);
  rr = await ai._readChat(pc, CHAT, 24, false, ADMIN);
  ok("…even when the page's model leaves it out", rr.msgs[0]._data._key === `false_${CHAT}_M3`);
  page([model(2, false, "Salam")], { fail: true });
  rr = await ai._readChat(pc, CHAT, 60, true, ADMIN);
  ok("older messages failing to load: what was read is kept, and the start is not taken as reached", rr.found && !rr.complete && rr.msgs.length === 1);
  page([model(2, false, "Salam")]);
  rr = await ai._readChat(pc, CHAT, 24, false, ADMIN);
  ok("without asking for older ones: only what the page holds", rr.found && !rr.complete && rr.msgs.length === 1);
  delete global.window;

  console.log("\nfetching a voice note in WhatsApp Web's page");
  const audio = Buffer.from("OggS-voice-note");
  const rName = (msg) => Object.assign(new Error(msg), { name: "r" });
  const voicePage = ({ cached = false, onObject = true, askFails = false, decrypt = null, resolves = true } = {}) => {
    const msg = {
      id: { id: "S1" },
      mimetype: "audio/ogg; codecs=opus",
      filehash: "H",
      mediaData: { mediaStage: "FETCHING" },
      mediaObject: { filehash: "H", mediaBlob: onObject ? { forceToBlob: () => new Blob([audio]) } : null },
      downloadMedia: async () => {
        if (askFails) throw rName("");
        if (resolves) msg.mediaData.mediaStage = "RESOLVED";
      },
    };
    global.window = {
      require: (name) =>
        ({
          WAWebCollections: {
            Msg: { get: (k) => (k ? msg : undefined), getModelsArray: () => [msg] },
            Chat: { get: () => ({ msgs: { getModelsArray: () => [msg] } }) },
          },
          WAWebWidFactory: { createWid: (x) => x },
          WAWebMediaInMemoryBlobCache: { InMemoryMediaBlobCache: { get: (h) => (cached && h === "H" ? new Blob([audio]) : undefined) } },
          WAWebDownloadManager: {
            downloadManager: {
              downloadAndMaybeDecrypt: async () => {
                if (!decrypt) throw rName("");
                return decrypt;
              },
            },
          },
        })[name],
      WWebJS: { arrayBufferToBase64Async: async (ab) => Buffer.from(ab).toString("base64") },
    };
  };
  const vp = { pupPage: { evaluate: (fn, ...a) => fn(...a) } };
  const libraryFails = { id: { _serialized: `false_${CHAT}_V1` }, downloadMedia: async () => Promise.reject(rName("r")) };
  voicePage({ cached: true });
  let media = await ai._mediaOf(vp, libraryFails);
  ok("asked for, then taken from WhatsApp's media cache (no library decrypt)", Buffer.from(media.data, "base64").equals(audio) && /ogg/.test(media.mimetype));
  voicePage({});
  media = await ai._mediaOf(vp, libraryFails);
  ok("…or from the message's own media", Buffer.from(media.data, "base64").equals(audio));
  voicePage({ onObject: false, decrypt: new Uint8Array(audio) });
  media = await ai._mediaOf(vp, libraryFails);
  ok("…or, last, the old decrypt call", Buffer.from(media.data, "base64").equals(audio));
  voicePage({});
  media = await ai._mediaOf(vp, { id: { fromMe: false, id: "S1" }, downloadMedia: async () => Promise.reject(rName("r")) }, CHAT);
  ok("a voice note without its full id is found in the chat by its short id", Buffer.from(media.data, "base64").equals(audio));
  voicePage({ onObject: false, askFails: true, resolves: false });
  const whyNot = await ai._mediaOf(vp, libraryFails).then(
    () => "",
    (e) => e.message
  );
  ok("every way failing: the log names each step that failed (never the audio)", /in page: ask: r; decrypt: r; no audio \(stage FETCHING\)/.test(whyNot) && /library: r/.test(whyNot), whyNot);
  delete global.window;

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
  ok("test mode has its own switch, admins only", /router\.post\("\/ai-reply\/test", protect, adminOnly,/.test(route) && /setTestOwn\(req\.body\.on\)/.test(route));
  const userRoute = fs.readFileSync(path.join(__dirname, "..", "routes", "userRoute.js"), "utf8");
  ok("the old one-switch-for-all is gone", !/wa-auto-reply\/toggle/.test(userRoute));
  const ctl = fs.readFileSync(path.join(__dirname, "..", "controllers", "whatsappController.js"), "utf8");
  ok("the admin's own dashboard message counts as a person", /sendMessageFor\(ownerId, recipient\.phone, message, \{ human: true \}\)/.test(ctl));
  const { forWhatsApp } = require("../services/chatAssistant");
  ok("a reply made for WhatsApp: no guide markers, «words» in bold", forWhatsApp("1) «Siniflər» açın.\n[[steps:nav.sinifler]]") === "1) *Siniflər* açın.");
  // WhatsApp shows the stars when bold is not well formed (owner, 2026-10-13: *Zibil qutusu*nda).
  ok(
    "a word ending joined to «…» goes inside the bold",
    forWhatsApp("30 gün «Zibil qutusu»nda qalır, «Geri qaytar» ilə qaytarın, «Zibil qutusu»na keçin.") === "30 gün *Zibil qutusunda* qalır, *Geri qaytar* ilə qaytarın, *Zibil qutusuna* keçin."
  );
  ok("doubled or nested stars become one bold", forWhatsApp("**Pro** və *«Premium»*; «Planım»-dan baxın.") === "*Pro* və *Premium*; *Planım*-dan baxın.");
  ok("a star that would not make bold is dropped (2*3 stays)", forWhatsApp("Stray * star, 2*3, *ok* and a* broken* one.") === "Stray star, 2*3, *ok* and a broken one.");
  ok("the card's «⋯» menu is named, not drawn as dashes", forWhatsApp("Kartda «⋯» menyusuna basın.") === "Kartda *üç nöqtə ⋯* menyusuna basın.");
  ok("«Diqqət:» stays bold once", forWhatsApp("Diqqət: bu geri qaytarılmır.") === "*Diqqət:* bu geri qaytarılmır.");

  ai._reset();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
