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

const GUIDES = [
  // Verbs appear in both stems: "yarat-" becomes "yarad-" before a vowel
  // ("yaradım", "yaradın"), "düzəlt-" becomes "düzəld-".
  { id: "add-class", title: "Sinif yaratmaq", groups: [["sinif", "sinf", "qrup"], ["yarat", "yarad", "elave", "ac", "qur", "duzelt", "duzeld"]] },
  { id: "add-exam", title: "İmtahan əlavə etmək", groups: [["imtahan", "sinaq", "test"], ["yarat", "yarad", "elave", "ac", "qur", "duzelt", "duzeld", "hazirla"]] },
  { id: "ai-questions", title: "AI ilə sual hazırlamaq", groups: [["sual"], ["ai", "suni", "hazirla", "yarat", "yarad", "pdf", "fayl", "sekil", "yukle"]] },
  { id: "publish", title: "İmtahanı nəşr etmək", groups: [["nesr", "derc", "yayimla", "yayinla", "paylas"], ["imtahan", "sinaq", "test"]] },
  { id: "share-code", title: "Şagirdləri dəvət etmək", groups: [["sagird", "telebe", "usaq"], ["devet", "qos", "elave", "link", "kod", "paylas", "gonder"]] },
  { id: "shuffle-options", title: "Variantları qarışdırmaq", groups: [["variant", "cavab"], ["qaris", "sira", "hamisi a", "eyni yer", "eyni herf", "deyis"]] },
  { id: "homework", title: "Ev tapşırığı vermək", groups: [["tapsiriq", "ev isi", "ev tapsirig", "odev"], ["ver", "yarat", "elave", "gonder", "paylas"]] },
  { id: "lesson-plan", title: "Dərs planı hazırlamaq", groups: [["ders plan", "dersin plan", "plan hazirla"]] },
  { id: "studio", title: "Dərs studiyasında material", groups: [["studiya", "is vereq", "material hazirla", "material yarat"]] },
  // Suggested to the AI only (auto: false): a word like "kredit" or "itdi" is too
  // loose to put a picture under the answer by itself.
  { id: "plan-credits", title: "Paket və AI krediti", auto: false, groups: [["paket", "kredit", "pro ", "premium", "yuksel", "abune"]] },
  { id: "install-app", title: "Tətbiqi telefona qurmaq", groups: [["tetbiq", "app", "proqram"], ["qur", "yukle", "telefon", "ana ekran"]] },
  { id: "trash-restore", title: "Silinmiş imtahanı bərpa etmək", auto: false, groups: [["sil", "zibil", "itdi", "itib", "tapa bilmir", "yoxa cix"], ["imtahan", "sinaq", "test", "qaytar", "berpa", "geri"]] },
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
    if (hits.length === g.groups.length) out.push({ id: g.id, title: g.title, auto: g.auto !== false, score: hits.length });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 2);
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
