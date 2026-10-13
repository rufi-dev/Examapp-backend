/* eslint-env node */
/*
 * The support AI answering on WhatsApp (owner, 2026-10-13): only teachers we
 * wrote to first, only new messages, never over a person, within its limits.
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
AppSetting.find = () => chain(Object.entries(settings).map(([key, value]) => ({ key, value })));
AppSetting.updateOne = async (q, u) => {
  settings[q.key] = u.$set.value;
};
User.findById = () => ({ select: () => ({ lean: () => Promise.resolve({ role: "admin" }) }) });
User.find = () => ({ select: () => ({ lean: async () => [TEACHER] }) });
WaAutoChat.findOne = (q) => chain(chats[q.key] || null);
WaAutoChat.updateOne = async (q, u) => {
  const cur = chats[q.key] || {};
  chats[q.key] = { ...cur, ...(u.$set || {}), ...(u.$inc ? { replies: (cur.replies || 0) + u.$inc.replies } : {}) };
};
WaAutoChat.aggregate = async () => [{ n: Object.values(chats).reduce((a, c) => a + (c.replies || 0), 0) }];

/* ── the assistant and the speech-to-text, stubbed ── */
const asked = [];
const assistant = require("../services/chatAssistant");
assistant.generateSupportReply = async (history, adminId, opts) => {
  asked.push({ history, adminId, opts });
  return "Salam! *Siniflər* bölməsini açın.";
};
const T = require("../helper/transcribe");
T.transcribe = async () => "Sinfi necə yaradım?";

const ai = require("../helper/waAutoReply");

/* ── a fake WhatsApp ── */
function fakeClient() {
  const c = { sent: [], typing: 0, handlers: {}, history: [] };
  c.on = (ev, fn) => (c.handlers[ev] = fn);
  c.sendMessage = async (chatId, text) => {
    const m = { id: { _serialized: `sent-${c.sent.length}` }, fromMe: true, to: chatId, body: text };
    c.sent.push({ chatId, text });
    return m;
  };
  c.getChatById = async () => ({
    fetchMessages: async () => c.history,
    sendStateTyping: async () => {
      c.typing += 1;
    },
    clearState: async () => {},
  });
  return c;
}
const CHAT = "994505440307@c.us";
const now = () => Math.floor(Date.now() / 1000);
const incoming = (over = {}) => ({ from: CHAT, fromMe: false, type: "chat", body: "Salam, sinfi necə yaradım?", timestamp: now(), getContact: async () => ({ number: "994505440307" }), ...over });

(async () => {
  console.log("off unless switched on");
  ai._reset();
  settings = {};
  chats = {};
  let c = fakeClient();
  await ai._onIncoming(ADMIN, c, incoming());
  await wait(80);
  ok("switched off: nothing is answered", c.sent.length === 0);

  await ai.setEnabled(true);
  ok("switching on records from when (older messages never count)", settings[ai.SINCE_KEY] instanceof Date);

  console.log("\nonly the teachers we wrote to, only new messages");
  const reset = () => {
    ai._reset();
    chats = {};
    asked.length = 0;
    c = fakeClient();
    c.history = [
      { fromMe: true, body: "Salam! Examopia-dan yazırıq: ilk imtahanınızı hazırlamağa kömək edək?", type: "chat", timestamp: now() - 3600 },
      { fromMe: false, body: "Salam, sinfi necə yaradım?", type: "chat", timestamp: now() },
    ];
  };
  reset();
  await ai._onIncoming(ADMIN, c, incoming({ timestamp: now() - 3 * 3600 }));
  await wait(80);
  ok("a message from before it was switched on is not answered", c.sent.length === 0);
  reset();
  await ai._onIncoming(ADMIN, c, incoming({ from: "994551112233@c.us", getContact: async () => ({ number: "994551112233" }) }));
  await wait(80);
  ok("someone we never wrote to is not answered", c.sent.length === 0);
  for (const [what, m] of [
    ["a group", incoming({ from: "123-456@g.us" })],
    ["a status", incoming({ isStatus: true })],
    ["our own message", incoming({ fromMe: true })],
    ["a picture", incoming({ type: "image" })],
  ]) {
    reset();
    await ai._onIncoming(ADMIN, c, m);
    await wait(80);
    ok(`${what} is not answered`, c.sent.length === 0);
  }

  console.log("\nthe answer");
  reset();
  await ai._onIncoming(ADMIN, c, incoming());
  await ai._onIncoming(ADMIN, c, incoming({ body: "bir də soruşum" }));
  await wait(150);
  ok("a teacher we wrote to gets one answer for quick messages, from the same chat", c.sent.length === 1 && c.sent[0].chatId === CHAT, JSON.stringify(c.sent));
  ok("«yazır…» shows while it is written", c.typing >= 1);
  ok("the same assistant, in its WhatsApp mode, with our first message as context", asked[0]?.opts?.channel === "whatsapp" && /Examopia-dan yazırıq/.test(asked[0].opts.context));
  ok("the conversation is passed as teacher / support turns", asked[0].history.at(-1).from === "teacher" && asked[0].history[0].from === "support" && asked[0].adminId === "support");
  ok("the reply is counted for the chat", chats[`${ADMIN}|${CHAT}`]?.replies === 1);

  console.log("\na person takes over");
  reset();
  ai._onCreated(ADMIN, { fromMe: true, id: { _serialized: "typed-on-phone" }, to: CHAT });
  await wait(60);
  ok("a message typed on the phone pauses the AI in that chat", chats[`${ADMIN}|${CHAT}`]?.humanUntil > new Date());
  await ai._onIncoming(ADMIN, c, incoming());
  await wait(80);
  ok("…so the teacher's next message is left to the person", c.sent.length === 0);
  reset();
  const sys = await c.sendMessage(CHAT, "Avtomatik xatırlatma");
  ai.noteSent(ADMIN, sys);
  ai._onCreated(ADMIN, sys);
  await wait(60);
  ok("the system's own message (outreach, a reply) is not taken for a person", !chats[`${ADMIN}|${CHAT}`]?.humanUntil);
  reset();
  ai.noteSent(ADMIN, { id: { _serialized: "dash" } }, { human: true, chatId: CHAT });
  await wait(20);
  ok("a message the admin typed in the dashboard pauses it too", chats[`${ADMIN}|${CHAT}`]?.humanUntil > new Date());

  console.log("\nlimits and voice");
  reset();
  chats[`${ADMIN}|${CHAT}`] = { day: new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10), replies: ai.LIMITS.PER_CHAT_PER_DAY };
  await ai._onIncoming(ADMIN, c, incoming());
  await wait(80);
  ok(`at most ${ai.LIMITS.PER_CHAT_PER_DAY} AI replies a day in one chat`, c.sent.length === 0);
  reset();
  c.history = [
    { fromMe: true, body: "Salam! Examopia-dan yazırıq.", type: "chat", timestamp: now() - 3600 },
    { fromMe: false, body: "", type: "ptt", timestamp: now(), downloadMedia: async () => ({ data: Buffer.from("ogg").toString("base64"), mimetype: "audio/ogg" }) },
  ];
  await ai._onIncoming(ADMIN, c, incoming({ type: "ptt", body: "" }));
  await wait(150);
  ok("a voice message is heard and answered", c.sent.length === 1 && /\[səs mesajı\] Sinfi necə yaradım\?/.test(asked[0]?.history.at(-1).text || ""), JSON.stringify(asked[0]?.history));

  console.log("\nwired in");
  const fs = require("fs");
  const wa = fs.readFileSync(path.join(__dirname, "..", "helper", "whatsapp.js"), "utf8");
  ok("every WhatsApp client gets the auto-reply", /require\("\.\/waAutoReply"\)\.attach\(s\.client, id\)/.test(wa));
  ok("every send is noted (so the system is never taken for a person)", /require\("\.\/waAutoReply"\)\.noteSent\(String\(ownerId\), sent, \{ human, chatId \}\)/.test(wa));
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
