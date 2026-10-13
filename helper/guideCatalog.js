/*
 * The chat's visual guides, and which question asks for which.
 *
 * Each guide is a set of real screenshots of the app (phone and desktop),
 * photographed by the frontend's e2e/guides-capture.spec.js; the chat shows one
 * when a reply ends with [[guide:ID]]. This file decides which ids fit a
 * teacher's question, so the right one reaches the AI (and, when the AI leaves
 * a plain how-to question without one, the reply). Keep the ids in step with
 * Frontend/src/components/chat/guideIds.js.
 *
 * Matching is on keyword STEMS over text folded to plain Latin letters, because
 * teachers type on phones with and without Azerbaijani letters alike: "sinif
 * yaratmaq", "sinif yaratmag", "şagirdləri" and "sagirdleri" must all count.
 * A guide matches when every one of its groups has a hit.
 */

const fold = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/ə/g, "e")
    .replace(/ı/g, "i")
    .replace(/i̇/g, "i")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/\s+/g, " ");

const CREATE = ["yarat", "yarad", "elave", "ac", "qur", "duzelt", "duzeld", "hazirla"];
const EXAM = ["imtahan", "sinaq", "test"];
const CHANGE = ["deyis", "yenile", "duzelt", "duzeld", "redakte", "duzelis", "teze"];
const SEE = ["bax", "gor", "harda", "harada", "yukle", "tap"];

// Order matters on a tie: the more specific guide comes first.
const GUIDES = [
  /* classes and people */
  { id: "add-class", title: "Sinif yaratmaq", groups: [["sinif", "sinf", "qrup"], CREATE] },
  { id: "student-join", title: "Şagird sinfə necə qoşulur", groups: [["sagird", "usaq", "telebe"], ["qosulur", "qosulsun", "qosulmaq", "kodu hara", "sinfe nece gir"]] },
  { id: "board-share", title: "Lövhəni paylaşmaq", groups: [["lovhe", "doska"], ["paylas", "gorsun", "goster", "sagird"]] },
  { id: "share-code", title: "Şagirdləri dəvət etmək", groups: [["sagird", "telebe", "usaq"], ["devet", "link", "kod", "paylas", "gonder", "qos"]] },
  { id: "class-settings", title: "Sinfin adını və kodunu dəyişmək", groups: [["sinif", "sinf"], ["adini", "adi", "kodu", "kod", "sekli", "qabig", ...CHANGE]] },
  { id: "parent-notifications", title: "Valideynlərə WhatsApp bildirişləri", groups: [["valideyn", "ana", "ata"], ["bildiris", "mesaj", "whatsapp", "vatsap", "xeber"]] },
  { id: "delete-class", title: "Sinfi silmək", groups: [["sinif", "sinf"], ["sil", "legv et"]] },
  { id: "students", title: "Şagirdin şifrəsini dəyişmək", groups: [["sagird", "usaq", "telebe"], ["sifre", "parol"]] },
  { id: "remove-student", title: "Şagirdi sinifdən çıxarmaq", groups: [["sagird", "usaq", "telebe"], ["cixar", "uzaqlasdir", "sil"]] },
  { id: "add-parent", title: "Valideyn hesabı yaratmaq", groups: [["valideyn"], ["hesab", "elave", "qos", "yarat", "yarad"]] },
  /* exams: creating */
  { id: "add-exam", title: "İmtahan əlavə etmək", groups: [EXAM, CREATE] },
  { id: "ai-questions", title: "AI ilə sual hazırlamaq", groups: [["sual"], ["ai", "suni", "hazirla", "yarat", "yarad", "pdf", "fayl", "yukle", "cixar"]] },
  { id: "dim-preset", title: "Hazır DİM strukturu", groups: [["dim", "buraxilis", "mso", "dqt", "blok", "ielts", "struktur", "sablon"]] },
  { id: "publish", title: "İmtahanı nəşr etmək", groups: [["nesr", "derc", "yayimla", "yayinla"], EXAM] },
  { id: "ai-fix", title: "Bir sualı AI ilə dəyişmək", groups: [["sual"], ["deyis", "duzelt", "duzeld", "basqa", "yeniden yaz"]] },
  { id: "manual-question", title: "Sualı əl ilə yazmaq", groups: [["sual"], ["el ile", "elle", "ozum", "tipini"]] },
  { id: "question-image", title: "Suala şəkil əlavə etmək", groups: [["sekil", "foto", "diaqram", "fiqur", "resm"], ["sual", "suala", "variant"]] },
  { id: "find-answers", title: "Cavabları AI ilə tapmaq", groups: [["cavab"], ["tap", "avtomatik", "doldur", "ai"]] },
  /* exams: settings and card */
  { id: "shuffle-options", title: "Variantları qarışdırmaq", groups: [["variant", "cavab"], ["qaris", "sira", "hamisi a", "hamsi a", "a variant", "eyni yer", "eyni herf", "eyni variant"]] },
  { id: "exam-password", title: "İmtahana şifrə qoymaq", groups: [EXAM, ["sifre", "parol"]] },
  { id: "exam-attempts", title: "Cəhd sayını məhdudlaşdırmaq", groups: [["cehd", "bir defe", "yeniden yaza", "tekrar yaza", "neçe defe", "nece defe"]] },
  { id: "anti-cheat", title: "Köçürməyə qarşı qoruma", groups: [["kocur", "kopy", "firildaq", "tam ekran", "tab", "baxib yaz"]] },
  { id: "result-visibility", title: "Nəticəni və düzgün cavabları göstərmək", groups: [["netice", "bal", "duzgun cavab", "cavablari"], ["goster", "gorunsun", "gizle", "gormesin", "acilsin", "gorsun"]] },
  { id: "exam-time", title: "İmtahanın vaxtını dəyişmək", groups: [["vaxt", "muddet", "tarix", "saat", "deqiqe"], ["deyis", "uzat", "uzad", "qoy", "teyin", "artir"]] },
  { id: "hide-exam", title: "İmtahanı gizlətmək", groups: [EXAM, ["gizle", "gorunmesin", "gizlet"]] },
  { id: "copy-exam", title: "İmtahanın nüsxəsi və B variantı", groups: [["nusxe", "b variant", "dublikat", "kopya", "ikinci variant"]] },
  { id: "delete-exam", title: "İmtahanı silmək", groups: [EXAM, ["sil"]] },
  // Suggested to the AI only (auto: false): too loose to put a picture under
  // the answer by itself.
  { id: "trash-restore", title: "Silinmiş imtahanı bərpa etmək", auto: false, groups: [["zibil", "berpa", "qaytar", "itdi", "itib", "tapa bilmir", "silinmis", "silinen", "yoxa cix"]] },
  /* results */
  { id: "live-monitor", title: "İmtahanı canlı izləmək", groups: [["canli", "real vaxt", "izle"]] },
  { id: "manual-grading", title: "Açıq sualları əl ilə yoxlamaq", groups: [["el ile", "yoxla", "qiymetlendir", "bal ver"], ["aciq", "yazili", "esse", "insa"]] },
  { id: "results", title: "Nəticələrə baxmaq və yükləmək", groups: [["netice", "analitika", "statistika", "bal"], [...SEE, "excel", "pdf"]] },
  /* teaching tools */
  { id: "grade-homework", title: "Ev tapşırığını yoxlamaq", groups: [["tapsiriq", "ev isi", "ev tapsirig"], ["yoxla", "qiymet", "bal", "qiymetlendir"]] },
  { id: "homework", title: "Ev tapşırığı vermək", groups: [["tapsiriq", "ev isi", "ev tapsirig", "odev"], ["ver", "yarat", "yarad", "elave", "gonder", "paylas"]] },
  { id: "attendance", title: "Davamiyyət və QR", groups: [["davamiyyet", "qr", "gelmeyen", "gelib", "gecikdi"]] },
  { id: "lesson-schedule", title: "Dərs cədvəli", groups: [["ders"], ["cedvel", "teqvim", "elave", "yarat", "yarad", "qeyd"]] },
  { id: "payments", title: "Ödənişləri qeyd etmək", auto: false, groups: [["sagird", "valideyn", "ayliq", "ders haqq", "borc"], ["odenis", "pul", "borc", "haqq"]] },
  { id: "material-share", title: "Materialı linklə paylaşmaq", groups: [["material", "sened"], ["link", "paylas"]] },
  { id: "materials", title: "Dərs materialı yükləmək", groups: [["material", "sened", "video", "pdf", "word", "powerpoint"], ["yukle", "elave", "qoy", "paylas"]] },
  { id: "whiteboard", title: "Lövhədən istifadə", groups: [["lovhe", "doska", "yazi taxtasi"]] },
  { id: "lesson-plan", title: "Dərs planı hazırlamaq", groups: [["ders plan", "dersin plan", "plan hazirla"]] },
  { id: "studio", title: "Dərs studiyasında material", groups: [["studiya", "is vereq", "material hazirla", "material yarat", "word", "pdf yukle"]] },
  { id: "achievements", title: "Nailiyyətləri paylaşmaq", groups: [["nailiyyet", "ugur hekaye", "sertifikat"]] },
  /* account */
  { id: "plan-payment", title: "Paketin ödənişi", groups: [["paket", "pro ", "premium", "plan"], ["odenis", "ode", "kart", "odedim"]] },
  { id: "plan-credits", title: "Paket və AI krediti", auto: false, groups: [["paket", "kredit", "pro ", "premium", "yuksel", "abune", "limit"]] },
  { id: "whatsapp-connect", title: "Öz WhatsApp nömrənizi qoşmaq", groups: [["whatsapp", "vatsap", "wp"], ["qos", "bagla", "oz nomre", "nomremi"]] },
  { id: "change-password", title: "Şifrəni dəyişmək", groups: [["sifre", "parol"], CHANGE] },
  { id: "forgot-password", title: "Şifrəni unutmusunuzsa", groups: [["sifre", "parol"], ["unut", "yadimdan", "yaddan", "sifirla", "berpa"]] },
  { id: "edit-profile", title: "Profili dəyişmək", groups: [["profil", "adimi", "seklimi", "fotomu", "telefonumu", "nomremi"], CHANGE] },
  { id: "logout-everywhere", title: "Bütün cihazlardan çıxmaq", groups: [["butun cihaz", "cihazlardan cix", "hesabdan cix", "cixis"]] },
  { id: "dark-mode", title: "Qaranlıq tema", groups: [["qaranliq", "tema", "gece rejimi", "dark"]] },
  { id: "install-app", title: "Tətbiqi telefona qurmaq", groups: [["tetbiq", "app", "proqram"], ["qur", "yukle", "telefon", "ana ekran"]] },
  { id: "guide-videos", title: "Video bələdçilər", auto: false, groups: [["video"], ["izah", "beledci", "telimat", "oyren", "istifade"]] },
  { id: "register", title: "Qeydiyyat", auto: false, groups: [["qeydiyyat", "hesab ac", "qeydiyyatdan"]] },
  /* the student side */
  { id: "student-exam", title: "Şagird imtahanı necə yazır", groups: [["sagird", "usaq", "telebe"], EXAM, ["yazir", "yazsin", "verir", "basla", "bitir", "isleyir"]] },
  { id: "student-results", title: "Şagird nəticəsini harada görür", groups: [["sagird", "usaq", "telebe"], ["netice", "bal"], ["gorur", "gore biler", "bilecek", "gorsun"]] },
  { id: "student-homework", title: "Şagird ev tapşırığını təhvil verir", groups: [["sagird", "usaq", "telebe"], ["tapsiriq", "ev isi"], ["tehvil", "yukle", "gonder"]] },
];

const GUIDE_IDS = GUIDES.map((g) => g.id);

// "How do I…" in the words teachers use. Only such a question gets a guide
// added by the server; the AI may still attach one to anything else.
const HOW = ["nece", "harada", "harda", "haradan", "hardan", "hansi duyme", "hansi bolme", "ilisdim", "bilmirem", "tapa bilmir", "komek", "izah", "goster", "olmur", "alinmir"];

// A stem counts only at the START of a word: "aç" must not fire inside
// "olacaq", "pro" inside "proses".
const startsWord = (text, stem) => {
  const at = text.indexOf(stem);
  for (let i = at; i >= 0; i = text.indexOf(stem, i + 1)) {
    if (i === 0 || !/[a-z0-9]/.test(text[i - 1])) return true;
  }
  return false;
};

function matchGuides(text) {
  const t = fold(text);
  const out = [];
  for (const g of GUIDES) {
    const hits = g.groups.filter((alts) => alts.some((a) => startsWord(t, a)));
    if (hits.length === g.groups.length) out.push({ id: g.id, title: g.title, auto: g.auto !== false, score: hits.length, order: GUIDES.indexOf(g) });
  }
  return out.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 2);
}

const asksHow = (text) => {
  const t = fold(text);
  return HOW.some((w) => startsWord(t, w));
};

// Something went wrong ("lost", "not showing", "not working"): the answer is a
// diagnosis, not a walkthrough, so the server adds no picture of its own.
const PROBLEM = ["itdi", "itib", "tapa bilmir", "gorunmur", "silin", "xeta", "islemir", "alinmir", "acilmir", "yoxa cix", "yox oldu"];
const describesProblem = (text) => {
  const t = fold(text);
  return PROBLEM.some((w) => startsWord(t, w));
};

/*
 * The guide the server adds when the AI did not: a plain how-to question, no
 * problem described, and a match strong enough to stand on its own.
 */
function autoGuide(text) {
  if (!asksHow(text) || describesProblem(text)) return null;
  const top = matchGuides(text)[0];
  return top && top.auto ? top.id : null;
}

module.exports = { GUIDES, GUIDE_IDS, matchGuides, asksHow, describesProblem, autoGuide, fold };
