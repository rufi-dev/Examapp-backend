/* eslint-env node */
/*
 * The chat's welcome arrives on the dashboard, once, from the assistant.
 *
 * Owner, 2026-10-13: no personal name in it, a better and more persuasive
 * text, and sent when the teacher reaches the dashboard after the first-exam
 * steps (it used to fire a minute after sign-up, inside the guided flow where
 * the chat is hidden).
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

const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "chatController.js"), "utf8");
const ping = src.slice(src.indexOf("const ping = asyncHandler"), src.indexOf("const ping = asyncHandler") + 1600);
const welcome = src.slice(src.indexOf("const welcome = asyncHandler"), src.indexOf("const welcome = asyncHandler") + 700);
const text = src.slice(src.indexOf("const WELCOME_PERKS"), src.indexOf("async function deliverWelcome"));

console.log("when it is sent");
ok("not from the heartbeat any more (that fired on any page)", !/maybeSendWelcome\(/.test(ping) && !/function maybeSendWelcome/.test(src));
ok("only to a working teacher, once ever", /role: "teacher", teacherApproval: \{ \$in: \["approved", "approved_legacy"\] \}, chatWelcomedAt: null/.test(welcome));

console.log("\nwhat it says");
ok("introduces the assistant, not a person", /Mən Examopia Köməkçisiyəm/.test(text) && !/firstName\(admin\)/.test(text));
ok("words it by whether the teacher already has an exam", /const hasExam = !!\(await Exam\.exists\(\{ owner: teacherId, deletedAt: null \}\)\);/.test(src) && /hasExam\s*\?/.test(text));
ok("with an exam: congratulates and points to inviting students, with that guide", /İlk imtahanınız hazırdır — təbriklər!/.test(text) && /ui\.stepsMarker\(WELCOME_STEPS\.invite\)/.test(text));
ok("without one: how to make it, with that guide", /İlk imtahanınızı bir neçə dəqiqəyə hazırlaya bilərsiniz/.test(text) && /ui\.stepsMarker\(WELCOME_STEPS\.exam\)/.test(text));
// The guides' controls exist in the captured catalogue, so the welcome really shows them.
const ui = require("../helper/uiCatalog");
const steps = src.slice(src.indexOf("const WELCOME_STEPS"), src.indexOf("const welcomeText"));
for (const key of ["invite", "exam"]) {
  const ids = [...steps.slice(steps.indexOf(`${key}:`)).split("\n")[0].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const marker = ui.stepsMarker(ids);
  ok(`the ${key} guide's controls are all captured (${ids.join(", ")})`, ids.length >= 2 && marker.startsWith("[[steps:") && ids.every((id) => marker.includes(id)), marker);
}
ok("sells what teachers stay for", /AI ilə bir neçə dəqiqəyə yeni imtahan/.test(text) && /QR kodla davamiyyət/.test(text) && /Valideynlərə WhatsApp bildirişləri/.test(text));
ok("addresses the teacher as 'siz'", /yazın/.test(text) && !/\byaz —/.test(text));
const slips = require("../services/chatAssistant").turkishSlips(text);
ok("no Turkish slips", slips.length === 0, slips.join(","));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
