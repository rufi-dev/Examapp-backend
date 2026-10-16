/* eslint-env node */
/*
 * "Yazır…" in the chat bubble is true: on while the AI writes a reply, off
 * before the reply is saved, off if the turn dies.
 */
process.env.NODE_ENV = "test";

const fs = require("fs");
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

const T = require("../helper/chatTyping");

console.log("the flag");
ok("nobody is typing to begin with", !T.isTyping("c1"));
const a = T.startTyping("c1");
ok("on while a reply is written", T.isTyping("c1"));
ok("only for that conversation", !T.isTyping("c2"));
const b = T.startTyping("c1");
T.stopTyping("c1", a);
ok("two overlapping replies: still on while one runs", T.isTyping("c1"));
T.stopTyping("c1", b);
ok("off when the last one ends", !T.isTyping("c1"));
T.stopTyping("c1", "no-such-token");
ok("stopping twice is harmless", !T.isTyping("c1"));
const t0 = 1_000_000;
T.startTyping("c3", t0);
ok("a turn that never ended stops counting after MAX_MS", T.isTyping("c3", t0 + 1000) && !T.isTyping("c3", t0 + T.MAX_MS + 1));

console.log("\nwired where the reply is made");
const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "chatController.js"), "utf8");
const reply = src.slice(src.indexOf("async function maybeAiReply"), src.indexOf("// Toggle \"human control\""));
const on = reply.indexOf("typing.startTyping(conversationId)");
const gen = reply.indexOf("generateSupportReply(recent, adminId");
const off = reply.indexOf("typing.stopTyping(conversationId, token)");
const save = reply.indexOf("Message.create(");
ok("starts right before the reply is generated", on > 0 && on < gen, `${on} ${gen}`);
ok("stops BEFORE the reply is saved, so no poll shows dots under an answer", off > gen && off < save, `${off} ${save}`);
ok("stops in a finally, so a failed turn cannot leave it on", /\} finally \{\s*typing\.stopTyping\(conversationId, token\);\s*\}/.test(reply));

console.log("\nthe admin sees which replies the AI wrote");
ok("an AI reply is saved marked as the AI's", /text,\s*ai: true,/.test(reply));
ok("the mark reaches the chat", /ai: !!m\.ai,/.test(src));
const model = fs.readFileSync(path.join(__dirname, "..", "models", "messageModel.js"), "utf8");
ok("the message keeps it", /ai: \{ type: Boolean, default: false \}/.test(model));
ok("the thread poll reports it", /aiTyping: typing\.isTyping\(conv\._id\)/.test(src));

console.log("\nthe teacher talks to «Examopia Köməkçi»");
ok("the poll says whether the AI answers this thread", /aiActive: isChatAiEnabled\(\) && !conv\.aiPaused/.test(src));
const welcome = src.slice(src.indexOf("const welcomeText"), src.indexOf("async function deliverWelcome"));
ok("the welcome introduces the assistant", /Mən Examopia Köməkçisiyəm/.test(welcome));
ok("...and no longer signs with the admin's name", !/firstName\(admin\)/.test(welcome) && !/welcomeText\(teacherName, admin\.name\)/.test(src));
const prompt = require("../services/chatAssistant").SYSTEM_PROMPT;
ok("the AI knows its name and does not hide that it is an AI", /^Sən «Examopia Köməkçi»sən/.test(prompt) && /AI olduğunu gizlətmə/.test(prompt));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
