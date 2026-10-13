/* eslint-env node */
/*
 * The right real-screen guide reaches the right question.
 *
 * The chat shows a step-by-step guide made of real screenshots when a reply
 * ends with [[guide:ID]]. The catalogue matches a teacher's question to guides
 * by keyword (with or without Azerbaijani letters), hands them to the AI, and
 * adds one itself to a plain how-to question the AI left without.
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

const G = require("../helper/guideCatalog");
const top = (q) => (G.matchGuides(q)[0] || {}).id;

// Must equal Frontend/src/components/chat/guideIds.js (and the capture spec).
const IDS = ["add-class", "student-join", "board-share", "share-code", "class-settings", "parent-notifications", "delete-class", "students", "remove-student", "add-parent", "add-exam", "ai-questions", "dim-preset", "publish", "ai-fix", "manual-question", "question-image", "find-answers", "shuffle-options", "exam-password", "exam-attempts", "anti-cheat", "result-visibility", "exam-time", "hide-exam", "copy-exam", "delete-exam", "trash-restore", "live-monitor", "manual-grading", "results", "grade-homework", "homework", "attendance", "lesson-schedule", "payments", "material-share", "materials", "whiteboard", "lesson-plan", "studio", "achievements", "plan-payment", "plan-credits", "whatsapp-connect", "change-password", "forgot-password", "edit-profile", "logout-everywhere", "dark-mode", "install-app", "guide-videos", "register", "student-exam", "student-results", "student-homework"];
ok("the catalogue has exactly the guides the frontend can show", JSON.stringify([...G.GUIDE_IDS].sort()) === JSON.stringify([...IDS].sort()), G.GUIDE_IDS.join(","));

console.log("\nquestions teachers actually asked");
const cases = [
  ["Salam sinif nece yaradim?", "add-class"],
  ["sinfi necə yaradım", "add-class"],
  ["imtahan necə yaradılır?", "add-exam"],
  ["PDF-dən sual necə çıxarım?", "ai-questions"],
  ["imtahani nece nesr edim", "publish"],
  ["sagirdleri sinfe nece devet edim", "share-code"],
  ["Şagirdləri sinfə necə qoşum?", "share-code"],
  ["düzgün cavablar variantlar niyə hamsi A variantında verilir? bunu necə dəyişmək olar?", "shuffle-options"],
  ["ev tapsirigi nece verim", "homework"],
  ["Dərs planı hazırlanma prosesini izah edərdiniz zəhmət olmasa", "lesson-plan"],
  ["telefona tetbiqi nece yukleyim", "install-app"],
  // 13 Oct: "şifrəmi necə dəyişim?" got "I don't know" from the bot.
  ["sifremi nece deyisim?", "change-password"],
  ["şifrəmi unutmuşam, necə bərpa edim?", "forgot-password"],
  ["şagirdin şifrəsini necə dəyişim", "students"],
  ["imtahana şifrə necə qoyum", "exam-password"],
  ["valideynə bildiriş necə gedir", "parent-notifications"],
  ["lövhəni şagirdlərlə necə paylaşım", "board-share"],
  ["şagird sinfə necə qoşulur", "student-join"],
  ["imtahanın vaxtını necə uzadım", "exam-time"],
  ["B variantı necə edim", "copy-exam"],
  ["açıq sualları necə yoxlayım", "manual-grading"],
  ["davamiyyəti necə qeyd edim", "attendance"],
  ["qaranlıq tema necə", "dark-mode"],
];
for (const [q, want] of cases) ok(`«${q.slice(0, 48)}» → ${want}`, top(q) === want, String(top(q)));
ok("a thank-you matches nothing", G.matchGuides("Çox sağ olun təşəkkür edirəm").length === 0);
ok("a short stem only counts at the start of a word ('aç' not inside 'olacaq')", G.matchGuides("Bu sinifdə imtahan olacaq?").length === 0);
ok("'pro' only as a word, not inside 'prosesini'", !G.matchGuides("dərs planı hazırlanma prosesini izah edin").some((g) => g.id === "plan-credits"));

console.log("\nwhen the server adds a guide itself");
ok("a plain how-to question gets its guide", G.autoGuide("Salam sinif nece yaradim?") === "add-class");
ok("not a problem report ('I made an exam and can't find it')", G.autoGuide("Az öncə bir sınaq yaradırdım indi onu tapa bilmirəm o hara itdi?") === null);
ok("not a question that isn't asking how", G.autoGuide("imtahan yaratdım") === null);
ok("not a loose match (credits): that one is only a hint to the AI", G.autoGuide("Krediti necə artırım?") === null && top("Krediti necə artırım?") === "plan-credits");

console.log("\nwired into the support chat");
const src = fs.readFileSync(path.join(__dirname, "..", "services", "chatAssistant.js"), "utf8");
ok("the matching guides are named to the AI", /const fits = guides\.matchGuides\(asked\);/.test(src) && /BU SUALA UYĞUN ŞƏKİLLİ BƏLƏDÇİ/.test(src));
ok("the server adds one only when the reply has none", /!\/\\\[\\\[guide:\[a-z-\]\+\\\]\\\]\/\.test\(clean\) \? guides\.autoGuide\(asked\) : null/.test(src));
const prompt = require("../services/chatAssistant").SYSTEM_PROMPT;
ok("the AI's instructions list every guide", IDS.every((id) => prompt.includes(`[[guide:${id}]]`)));
ok("...and say they are real screens, at most one per reply", /REAL ekran şəkillərindən/.test(prompt) && /ən çox BİR bələdçi/.test(prompt));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
