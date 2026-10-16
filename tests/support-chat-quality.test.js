/* eslint-env node */
/*
 * The support chat (the «Söhbətlər» bubble) answers in Azerbaijani, about the
 * app as it is, on a model that can write the language.
 *
 * October 2026, real replies to teachers: Turkish mixed in ("Maalesef",
 * "seçənəyi", "zahmetli", "işaretli", "böylə", "Bir kaç"), broken sentences,
 * and wrong facts: "Examopia-da dərs planı yaratma ... feature yoxdur", buttons
 * that no longer exist. It ran on Claude Haiku (CLI "light" tier) with a
 * gpt-4o-mini fallback, from a prompt written for an older app.
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

const C = require("../services/chatAssistant");
const { PLANS, CREDIT_TOPUPS } = require("../config/plans");
const { AI_OPERATIONS } = require("../config/aiOperations");
const P = C.SYSTEM_PROMPT;
const src = fs.readFileSync(path.join(__dirname, "..", "services", "chatAssistant.js"), "utf8");

console.log("it describes the app as it is");
for (const gone of ["Sual yaratmağa keç", "İmtahanını təsvir et", "Təsdiq et və nəşr et", "PDF əlavə et"]) {
  ok(`no longer sends teachers to «${gone}»`, !P.includes(gone));
}
// The card's «Sinfi dəyiş» (2026-10-16, as BunkerMath has it).
ok("names the card's «Sinfi dəyiş»", /«Sinfi dəyiş» \(imtahanı başqa sinfinizə köçürür: «Yeni sinif» → «Köçür»/.test(P));
// The ready-PDF exam is back on the "Nə yaradaq?" screen (2026-10-16).
ok("tells «extract the PDF's questions» (Fayl əlavə et) from «give the PDF as it is» (Hazır PDF vərəqi ver)", /PDF-dəki sualları platformaya çıxarım[^"]*" = «Fayl əlavə et»[^"]*"PDF-i olduğu kimi verim[^"]*" = «Hazır PDF vərəqi ver»/.test(P));
ok("names the ready-PDF exam and keeps it apart from «Fayl əlavə et»", /«Hazır PDF vərəqi ver»[^\n]*cavab açarı[^\n]*«Fayl əlavə et»-dən fərqlidir/.test(P));
for (const now of ["Nə haqqında imtahan olsun?", "Fayl əlavə et", "Sualları hazırla", "Təsdiq et və davam et", "Nəşr et", "Şagird dəvət et", "Linki kopyala", "Variantları qarışdır", "Ətraflı parametrlər", "Cavabları tap"]) {
  ok(`names «${now}»`, P.includes(now));
}
for (const feature of ["Dərs planları", "Dərs studiyası", "Lövhə", "Tapşırıqlar", "Dərs cədvəli", "Ödənişlər", "Valideyn", "Canlı imtahan"]) {
  ok(`knows ${feature} exists`, P.includes(feature));
}
ok("never claims to have passed something on", /komandaya bildirdim" DEMƏ/.test(P));
ok("says it will check instead of guessing", /Bunu dəqiqləşdirib sizə yazacam/.test(P));
ok("addresses teachers as 'siz'", /HƏMİŞƏ "siz" deyə müraciət et/.test(P));

console.log("\nhow it talks and sells (owner, 2026-10-13: too long, too passive, a FAQ, not a seller)");
ok("two modes: complete steps when a teacher needs help, short and persuasive in talk", /1\) KÖMƏK:[\s\S]{0,400}AYDIN, TAM təlimatdır/.test(P) && /2\) SÖHBƏT:/.test(P) && /qısaltmaq üçün addım atlama/.test(P));
ok("in help, selling is one short line at the most, and none on errors", /sonda ən çox BİR qısa cümlə ilə əlaqəli fayda; xəta və şikayətdə heç satma/.test(P));
ok("no feature lists unless asked for everything", /funksiya siyahısı sadalama/.test(P));
ok("sells the benefit, not the feature", /Funksiyanı yox, FAYDANI sat/.test(P));
ok("ends with one next step, not a weak generic close", /BİR kiçik növbəti addım/.test(P) && /"Əlavə sualınız olsa, müraciət edin", "Uğurlar" kimi zəif sonluq yalnız söhbət açıq-aydın bitəndə/.test(P));
ok("knows the teacher's stage, A to F, and does not hard-sell a paying teacher", /MÜƏLLİMİN MƏRHƏLƏSİ/.test(P) && /F\) Ödənişli \(Pro və ya Premium\) → satışa sıxma/.test(P));
for (const [objection, rule] of [
  ["no time", /"Vaxtım yoxdur": "vaxtınız olanda yazın" DEMƏ/],
  ["could not do it", /"Bacarmadım", "alınmadı": dərhal razılaşma/],
  ["adding questions takes long", /"Sualları əlavə etmək vaxt aparır": yanlış təsəvvürü düzəlt/],
  ["school year not started", /"Tədris ili başlamayıb": "başlayanda yazın" DEMƏ/],
  ["upper grades only", /"Elə bildim yalnız yuxarı siniflər üçündür": dərhal düzəlt/],
  ["not a school teacher (NOT only, never 'not for')", /"Məktəb müəllimi deyiləm": "Examopia TƏKCƏ məktəb müəllimləri üçün deyil: repetitorlar/],
  ["too dear", /hansı aylıq qiymət sizə uyğun və verilən faydaya dəyər olardı/],
  ["don't need it", /"bəlkə sizə lazım deyil" DEMƏ/],
  ["PDF in vs PDF out", /PDF: iki şeyi qarışdırma/],
  ["safety, without absolute guarantees", /Mütləq təhlükəsizlik zəmanəti vermə/],
  ["a vague download problem", /qeyri-müəyyən sözlə kifayətlənmə; dəqiq xətanı və ya ekran şəklini istə/],
]) ok(`objection: ${objection}`, rule.test(P));
ok("the video guide link is the real public page", P.includes("https://examopia.com/beledci"));
ok("the old hype lines are gone", !/Cəmi 2 dəqiqəlik işdir!/.test(P) && !/İndi yoxlayaq\? 💪/.test(P) && !/Həvəsli və müsbət yaz/.test(P));
ok("light on emoji and stock phrases", /Emoji çox az: adətən 0–1, ən çox 2/.test(P) && /Şablon ifadələri İŞLƏTMƏ/.test(P));
ok("on WhatsApp: 1–4 short sentences in talk, full steps in help, and why we wrote", /SÖHBƏT-də WhatsApp mesajı kimi yaz: adətən 1–4 qısa cümlə/.test(src) && /KÖMƏK-də \(necə edim, harada, alınmır\) addımları/.test(src) && /qeydiyyat zamanı özü yazıb, başqa yerdən götürülməyib/.test(src));

console.log("\nits numbers are the config's numbers");
const free = PLANS.free;
const pro = PLANS.pro;
const premium = PLANS.premium;
ok("Pro price", P.includes(`Pro — ${pro.priceAzn} AZN/ay`));
ok("Premium price", P.includes(`Premium — ${premium.priceAzn} AZN/ay`));
ok("Free limits", P.includes(`Pulsuz: ${free.limits.classes} sinif, ${free.limits.students} şagird, cəmi ${free.limits.examCreations} imtahan`));
ok("Free tasks and storage", P.includes(`${free.limits.assignments} aktiv tapşırıq, ${free.limits.storageMb} MB yer, qeydiyyatda ${free.credits.welcome} AI krediti`));
ok("Pro limits", P.includes(`${pro.limits.classes} sinif, ${pro.limits.students} şagird, limitsiz imtahan, ${pro.limits.assignments} tapşırıq, ${pro.limits.storageMb / 1024} GB yer, aktivləşəndə ${pro.credits.monthly} AI krediti`));
ok("Premium storage and credits", P.includes(`${premium.limits.storageMb / 1024} GB yer, aktivləşəndə ${premium.credits.monthly} AI krediti`));
ok("top-ups", CREDIT_TOPUPS.every((t) => P.includes(`+${t.credits} kredit ${t.priceAzn} AZN`)));
const cost = (op) => AI_OPERATIONS[op].cost;
ok("exam generation cost", P.includes(`AI ilə imtahan yaratmaq və ya fayldan sual çıxarmaq ${cost("ai.generate.questions")}`) && cost("ai.extract.questions") === cost("ai.generate.questions"));
ok("rewrite cost", P.includes(`«AI ilə düzəlt» ${cost("ai.regenerate.question")}`));
ok("answer finding cost", P.includes(`«Cavabları tap» ${cost("ai.solve.answers")}`));
ok("lesson plan cost", P.includes(`dərs planı ${cost("ai.generate.lessonplan")}`));
ok("Studio costs", P.includes(`material yaratmaq ${cost("ai.generate.material")}, dəyişmək ${cost("ai.edit.material")}`));
ok("the free monthly credit that code never grants is not promised", /Pulsuz kredit hər ay avtomatik artmır/.test(P));

console.log("\nTurkish is caught, Azerbaijani is not");
const oct10 = "Maalesef Examopia-da bunun üçün açıq bir seçənəyi yoxdur. YOLU 1: Əl ilə hər sualı düzəlt (daha zahmetli). Doğru cavab onun yanında işaretli olur. böylə bir seçənəyin. Bir kaç yerdə ola bilər.";
const slips = C.turkishSlips(oct10);
for (const w of ["maalesef", "seçənəyi", "zahmetli", "işaretli", "böylə", "bir kaç"]) ok(`catches «${w}» from the 10 Oct reply`, slips.includes(w), slips.join(","));
const clean = "Salam 🙂 Sınaq yaratmaq üçün sinfi açın və «İmtahan əlavə et»ə toxunun. Düzgün cavab yaşıl işarələnir, işarəni dəyişmək olar. Bu, deyil ki çətindir; bir neçə dəqiqə çəkir. Əsla narahat olmayın.";
ok("a clean Azerbaijani reply has no slips", C.turkishSlips(clean).length === 0, C.turkishSlips(clean).join(","));
const facts = P.slice(P.indexOf("DÜZGÜNLÜK"));
ok("the prompt's own facts have no slips", C.turkishSlips(facts).length === 0, C.turkishSlips(facts).join(","));

console.log("\nthe engine");
ok("the CLI runs the standard tier (Sonnet), not Haiku", /const tier = process\.env\.CHAT_SUPPORT_CLI_TIER \|\| "standard"/.test(src) && /runCliChat\(\{ provider: cliProvider, messages: history, system, tier \}\)/.test(src));
ok("the API fallback is gpt-5.6-luna, not gpt-4o-mini", /process\.env\.CHAT_SUPPORT_MODEL \|\| "gpt-5\.6-luna"/.test(src) && !/CHAT_SUPPORT_MODEL \|\| "gpt-4o-mini"/.test(src));
ok("a GPT-5 request uses max_completion_tokens and no temperature", /gpt5 \? \{ max_completion_tokens: 2000, reasoning_effort: "low" \} : \{ max_tokens: 700, temperature: 0\.4 \}/.test(src));
ok("a reply with Turkish words is rewritten once, and the cleaner one wins", /if \(text && slips\.length\)[\s\S]{0,260}const again = await ask\(`\$\{system\}\\n\\n\$\{slipNote\(slips\)\}`\);\s*if \(again && turkishSlips\(again\)\.length < slips\.length\) text = again;/.test(src));
ok("which model answered is logged", /\[CHAT-AI\] answered via \$\{cliProvider\}-cli/.test(src) && /\[CHAT-AI\] answered via api/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
