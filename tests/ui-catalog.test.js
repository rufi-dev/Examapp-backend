/* eslint-env node */
/*
 * The chat's picture guides show the control the answer is about, on its screen.
 *
 * Owner, 2026-10-13: asked "how do I delete an exam from the bin", the chat
 * showed deleting an exam; asked "how do I change my bio", it showed the photo
 * button. The old 56 hand-made guides could only offer the nearest one. Now
 * every control of every screen is captured (data/ui-catalog.json), the search
 * hands the AI the ones that fit, the AI names them in [[steps:…]], and the
 * server drops unknown IDs and adds the way to each screen.
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

const ui = require("../helper/uiCatalog");

// A small app: the menu, the bin, the profile, a class with an exam card menu.
const at = (state, y = 100) => ({ state, x: 20, y, w: 120, h: 40 });
const both = (state, y) => ({ m: at(state, y), d: at(state, y) });
const img = { src: "/ui/x.webp", w: 390, h: 844 };
const cat = ui.index({
  states: {
    nav: { title: "Menyu", as: "teacher", via: [], m: img, d: img },
    dashboard: { title: "İcmal", as: "teacher", via: [["nav", "^İcmal"]], m: img, d: img },
    classes: { title: "Siniflər", as: "teacher", via: [["nav", "^Siniflər"]], m: img, d: img },
    "class-page": { title: "Sinif səhifəsi: imtahanlar", as: "teacher", via: [["classes", "^İmtahanlar"]], m: img, d: img },
    "exam-card-menu": { title: "İmtahan kartının menyusu", as: "teacher", via: [["class-page", "^Menyu$"]], m: img, d: img },
    composer: { title: "Yeni imtahan: Nə yaradaq?", as: "teacher", via: [["class-page", "İmtahan əlavə et"]], m: img, d: img },
    trash: { title: "Zibil qutusu: silinmiş imtahanlar", as: "teacher", via: [["nav", "^Zibil qutusu"]], m: img, d: img },
    profile: { title: "Profil: ad, telefon, şəkil, haqqımda (bio), şifrə", as: "teacher", via: [["nav", "^Profil"]], m: img, d: img },
  },
  elements: {
    "nav.icmal": { label: "İcmal", kind: "nav", context: "", scope: "nav", ...both("nav", 100) },
    "nav.sinifler": { label: "Siniflər", kind: "nav", context: "", scope: "nav", ...both("nav", 150) },
    "nav.zibil-qutusu": { label: "Zibil qutusu", kind: "nav", context: "", scope: "nav", ...both("nav", 600) },
    "nav.profil": { label: "Profil", kind: "nav", context: "", scope: "nav", ...both("nav", 650) },
    "classes.imtahanlar": { label: "İmtahanlar", kind: "button", context: "9-A Riyaziyyat", scope: "classes", ...both("classes") },
    "class-page.menyu": { label: "Menyu", kind: "button", context: "Kəsrlər", scope: "class-page", ...both("class-page") },
    "class-page.imtahan-elave-et": { label: "İmtahan əlavə et", kind: "button", context: "", scope: "class-page", ...both("class-page", 200) },
    "exam-card-menu.imtahani-sil": { label: "İmtahanı sil", kind: "button", context: "", scope: "exam-card-menu", ...both("exam-card-menu") },
    "exam-card-menu.gizlet": { label: "Gizlət", kind: "button", context: "", scope: "exam-card-menu", ...both("exam-card-menu", 160) },
    "composer.suallari-hazirla": { label: "Sualları hazırla", kind: "button", context: "", scope: "composer", ...both("composer") },
    "trash.geri-qaytar": { label: "Geri qaytar", kind: "button", context: "Onluq kəsrlər", scope: "trash", d: at("trash") },
    "trash.qaytar": { label: "Qaytar", kind: "button", context: "Onluq kəsrlər", scope: "trash", m: at("trash") },
    "trash.hemiselik-sil": { label: "Həmişəlik sil", kind: "button", context: "Onluq kəsrlər", scope: "trash", ...both("trash", 140) },
    "profile.sekil-sec": { label: "Şəkil seç", kind: "file", context: "Profil şəkli", scope: "profile", ...both("profile") },
    "profile.haqqimda": { label: "Haqqımda", kind: "field", context: "Şəxsi məlumat", scope: "profile", ...both("profile", 300) },
    "profile.ad": { label: "Ad", kind: "field", context: "Şəxsi məlumat", scope: "profile", ...both("profile", 250) },
    "profile.deyis": { label: "Dəyiş", kind: "button", context: "Şifrə", scope: "profile", ...both("profile", 500) },
    "profile.adi-deyis": { label: "Adı dəyiş", kind: "button", context: "", scope: "profile", ...both("profile", 60) },
    "profile.telefonu-deyis": { label: "Telefonu dəyiş", kind: "button", context: "", scope: "profile", ...both("profile", 80) },
    "profile.haqqinda": { label: "+ haqqında", kind: "button", context: "", scope: "profile", ...both("profile", 120) },
  },
});
const top = (q, n = 1) => ui.search(q, { cat, limit: n }).map((r) => r.id);

console.log("\nsearch basics (a small app; ranking is judged on the real catalogue below)");
const shown = (q) => ui.candidatesFor(q, { cat });
ok("the bin question shows the bin's «Həmişəlik sil»", /trash\.hemiselik-sil/.test(shown("imtahanı necə zibil qutusundan silim")));
ok("...also typed without Azerbaijani letters", /trash\.hemiselik-sil/.test(shown("imtahani zibil qutusundan nece silim")));
ok("the bio question shows the «Haqqımda» field", /profile\.haqqimda/.test(shown("biomu necə dəyişim")));
ok("restoring from the bin shows «Geri qaytar» / «Qaytar»", /trash\.(geri-)?qaytar/.test(shown("silinmiş imtahanı necə bərpa edim")));
ok("a thank-you finds nothing", top("çox sağ olun").length === 0);

console.log("\nstems");
ok("suffixes match (qutusundan ~ qutusu, imtahanı ~ imtahan)", ui.sameStem("qutusundan", "qutusu") && ui.sameStem(ui.fold("imtahanı"), "imtahan"));
ok("unrelated words with a shared start do not (sil ~ sinif)", !ui.sameStem("sil", "sinif"));
ok("teachers' words become the app's (bio → haqqimda, parol → sifre, wp → whatsapp)", ui.queryWords("bio").includes("haqqimda") && ui.queryWords("parol").includes("sifre") && ui.queryWords("wp").includes("whatsapp"));

console.log("\nthe way to each control is added; nothing is invented");
const ex = (ids) => ui.expandSteps(ids, { cat }).join(" > ");
ok("bin: menu item, then the button", ex(["trash.hemiselik-sil"]) === "nav.zibil-qutusu > trash.hemiselik-sil", ex(["trash.hemiselik-sil"]));
ok("a dialog: menu → class → card menu → the item", ex(["exam-card-menu.gizlet"]) === "nav.sinifler > classes.imtahanlar > class-page.menyu > exam-card-menu.gizlet", ex(["exam-card-menu.gizlet"]));
ok("a second target on the screen the first opens follows straight on", ex(["class-page.imtahan-elave-et", "composer.suallari-hazirla"]) === "nav.sinifler > classes.imtahanlar > class-page.imtahan-elave-et > composer.suallari-hazirla", ex(["class-page.imtahan-elave-et", "composer.suallari-hazirla"]));
ok("two controls on one screen: the way once", ex(["profile.ad", "profile.haqqimda"]) === "nav.profil > profile.ad > profile.haqqimda");
ok("an unknown ID is dropped", ex(["made.up", "profile.haqqimda"]) === "nav.profil > profile.haqqimda");
ok("only unknown IDs → no steps", ex(["made.up"]) === "");
ok("the menu and the top bar need no way there", ex(["nav.profil"]) === "nav.profil");
ok("a screen opened from the menu starts at the menu item, not at İcmal", ex(["profile.haqqimda"]) === "nav.profil > profile.haqqimda");

const fixed = ui.fixSteps("Profilə keçin.\n\n[[steps:profile.haqqimda|made.up]]\n[[steps:trash.qaytar]] [[guide:edit-profile]]", { cat });
ok("a reply's marker is rebuilt; a second one and old [[guide:…]] markers go", fixed === "Profilə keçin.\n\n[[steps:nav.profil|profile.haqqimda]]", JSON.stringify(fixed));
ok("a marker with nothing valid disappears", ui.fixSteps("Yazın.\n[[steps:nope]]", { cat }) === "Yazın.");
ok("the welcome's marker needs every target to exist", ui.stepsMarker(["class-page.imtahan-elave-et"], { cat }).startsWith("[[steps:nav.sinifler|") && ui.stepsMarker(["nope"], { cat }) === "");

console.log("\nwhat the AI is shown");
const list = ui.candidatesFor("imtahanı necə zibil qutusundan silim", { cat });
ok("the bin screen with its way and its buttons", /Ekran: Zibil qutusu: silinmiş imtahanlar — yol: «Zibil qutusu»/.test(list) && /trash\.hemiselik-sil — «Həmişəlik sil» \(düymə\)/.test(list), list.split("\n").slice(0, 6).join(" | "));
ok("a control only one layout has says so", /trash\.qaytar — «Qaytar» \(düymə\).*yalnız telefonda/.test(list));

console.log("\nwired into the support chat");
const src = fs.readFileSync(path.join(__dirname, "..", "services", "chatAssistant.js"), "utf8");
ok("the controls that fit are handed to the AI", /const found = ui\.candidatesFor\(asked\);/.test(src) && /EKRAN ELEMENTLƏRİ/.test(src));
ok("the reply's steps are rebuilt from the catalogue", /ui\.fixSteps\(toPlainText\(text\)\)/.test(src));
ok("no trace of the old fixed guides", !/guideCatalog|\[\[guide:/.test(src));
const prompt = require("../services/chatAssistant").SYSTEM_PROMPT;
ok("the AI is told to use only listed IDs, final targets only, or none", /\[\[steps:ID\|ID\|ID\]\]/.test(prompt) && /YALNIZ sonda verilən «EKRAN ELEMENTLƏRİ»/.test(prompt) && /\[\[steps\]\] YAZMA/.test(prompt));
ok("...with the owner's two cases as the counter-examples", /zibil qutusundan silmək sualına «İmtahanı sil» düyməsi YOX/.test(prompt) && /«Haqqımda» sualına şəkil düyməsi YOX/.test(prompt));

console.log("\nthe captured catalogue (data/ui-catalog.json)");
const real = ui.load();
ok("is present and covers the app", Object.keys(real.states).length >= 70 && real.ids.length >= 500, `${Object.keys(real.states).length} screens, ${real.ids.length} controls`);
let missing = 0;
for (const id of real.ids) {
  for (const dev of ["m", "d"]) {
    const a = real.elements[id][dev];
    if (a && !real.states[a.state]?.[dev]) missing += 1;
  }
}
ok("every control's screen has its screenshot", missing === 0, `${missing} without`);
const realTop = (q) => ui.search(q, { cat: real, limit: 3 }).map((r) => r.id);
const realShown = (q) => ui.candidatesFor(q, { cat: real });
ok("real: the bin question → the bin's «Həmişəlik sil» in the first two", realTop("imtahanı necə zibil qutusundan silim").slice(0, 2).some((id) => id.startsWith("trash.hemiselik-sil")), realTop("imtahanı necə zibil qutusundan silim").join(","));
ok("real: the bio question → the profile's bio («Haqqımda», «+ haqqında», «Özün haqqında…»)", /^profile\.(haqqimda|haqqinda|ozun-haqqinda)/.test(realTop("biomu necə dəyişim")[0] || ""), realTop("biomu necə dəyişim").join(","));
ok("real: the bin question shows the bin's «Həmişəlik sil» and its menu item", /trash\.hemiselik-sil/.test(realShown("imtahanı necə zibil qutusundan silim")) && /nav\.zibil-qutusu/.test(realShown("imtahanı necə zibil qutusundan silim")));
ok("real: the bio question shows the profile's «Haqqımda» field", /profile\.haqqimda — «Haqqımda» \(xana\)/.test(realShown("biomu necə dəyişim")));
ok("real: a route the AI starts from another entrance follows it (results list → results → Excel)", ui.expandSteps(["nav.sagird-neticeleri", "results.excel-ixrac-et"], { cat: real }).join(" > ") === "nav.sagird-neticeleri > results-list.kesrler-1-ci-yoxlama > results.excel-ixrac-et", ui.expandSteps(["nav.sagird-neticeleri", "results.excel-ixrac-et"], { cat: real }).join(" > "));
ok("real: the bin's way starts at the menu", ui.expandSteps(["trash.hemiselik-sil"], { cat: real })[0] === "nav.zibil-qutusu", ui.expandSteps(["trash.hemiselik-sil"], { cat: real }).join(" > "));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
