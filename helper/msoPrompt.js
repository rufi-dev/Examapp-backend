/*
 * The MSO generation prompt — the teacher's own brief, turned into rules a model
 * is asked to follow and a server is able to check.
 *
 * Two things are deliberately NOT left to the prompt. The blueprint's locked
 * fields (task number, Bloom level, question type, points) are stated as given
 * rather than requested, so the model cannot drift from the structure the teacher
 * approved; and every rule that can be checked — four distinct choices, exactly one
 * correct answer, A/B differing only in numbers, no long run of the same answer
 * letter, a citation that resolves to a real page — is ALSO enforced in
 * helper/msoValidators.js. A prompt is a request, not a guarantee.
 */

const BASE = `
Sən Azərbaycan kurikulumu üzrə SUMMATİV QİYMƏTLƏNDİRMƏ (MSO) hazırlayan
təcrübəli metodistsən. Cavabı YALNIZ verilmiş JSON sxemi ilə qaytar.
Bütün mətn Azərbaycan dilində olsun.

İKİ VARİANT — ƏSAS QAYDA:
- Hər tapşırıq üçün HƏM "A", HƏM DƏ "B" variantını qaytar.
- A və B strukturca EYNİ olmalıdır: eyni bacarığı yoxlamalı, eyni süjet, eyni
  ifadə tərzi, eyni çətinlik səviyyəsi.
- YALNIZ rəqəmlər/kəmiyyətlər fərqlənir. Mövzunu, tipi və ya çətinliyi dəyişmə.
- Rəqəmləri elə seç ki, cavab da fərqli çıxsın — eyni cavabı təkrarlama.

QAPALI TAPŞIRIQ (closed4):
- DƏQİQ 4 cavab variantı ("choices"), yalnız BİRİ düzgün ("correctIndex" 0-3).
- Distraktorlar inandırıcı olsun: tipik səhvlərdən yaransın, təsadüfi ədəd olmasın.
- İki düzgün cavab olan tapşırıq QADAĞANDIR.
- "rubric" boş qalsın.

AÇIQ TAPŞIRIQ (short / extended):
- "choices" boş massiv, "correctIndex" -1.
- "answer": tam düzgün cavab.
- "solution": ADDIM-ADDIM həll — düstur, əvəzetmə, nəticə.
- "rubric": qiymətləndirmə meyarı — hansı addıma neçə bal verilir.

HƏR TAPŞIRIQ ÜÇÜN:
- "testedSkill": tapşırıq NƏYİ yoxlayır (qısa ifadə).
- "criterion": qiymətləndirmə meyarı.
- "subStandard": YALNIZ verilmiş alt-standartlardan biri. Yenisini uydurma.

ÜMUMİ TƏLƏBLƏR:
- İfadələr aydın, artıq mətnsiz. Məlumatlar realistik.
- Çətinlik tədricən artır.
- Ardıcıl tapşırıqlarda eyni hərfli düzgün cavab təkrarlanmasın.
`.trim();

const WITH_SOURCE = `
MƏNBƏ VAR — DƏRSLİK YÜKLƏNİB:
- BÜTÜN tapşırıqlar YALNIZ yüklənmiş dərslikdən götürülməlidir.
- Hər tapşırıq üçün MÜTLƏQ göstər:
  * "printedPageLabel" — səhifənin ÜZƏRİNDƏ çap olunmuş nömrə (faylın neçənci
    səhifəsi olduğu YOX).
  * "sourceTaskNo" — dərslikdəki tapşırığın nömrəsi.
  * "sourceExcerpt" — həmin səhifədən ƏN AZI 40 simvol HƏRFİ-HƏRFİNƏ köçürülmüş
    mətn. Bu, server tərəfindən fayl ilə tutuşdurulur.
- Dərslikdən kənar tapşırıq UYDURMAQ QADAĞANDIR.
- Səhifədə uyğun çalışma tapmasan, tapşırıq uydurma — o sətri boş qaytar.
- B variantı üçün eyni dərslik tapşırığını götür, yalnız rəqəmləri dəyiş.
`.trim();

const NO_SOURCE = `
MƏNBƏ YOXDUR — dərslik yüklənməyib:
- Tapşırıqları özün qur.
- "printedPageLabel", "sourceTaskNo" və "sourceExcerpt" BOŞ qalsın.
- Heç bir səhifə və ya çalışma nömrəsi yazma — nə bu sahələrdə, nə tapşırıq
  mətnində. Uydurulmuş istinad ən pis səhvdir.
`.trim();

// One row, stated as GIVEN. The model fills the content, never the structure.
const rowLine = (r) =>
  [
    `№${r.no}`,
    `Blum: ${r.bloom}`,
    `tip: ${r.questionType === "closed4" ? "qapalı, 4 variant" : r.questionType === "short" ? "açıq (qısa cavab)" : "açıq (geniş cavab)"}`,
    `bal: ${r.points}`,
    r.subStandard ? `alt-standart: ${r.subStandard}` : "",
    r.testedSkill ? `yoxlayır: ${r.testedSkill}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

/*
 * `rows` is the slice of the blueprint this batch covers. Both variants of every
 * row are requested in ONE call, which is what makes "identical except the
 * numbers" achievable at all.
 */
function buildMsoPrompt({ blueprint = {}, rows = [], hasSource = false } = {}) {
  const system = [BASE, hasSource ? WITH_SOURCE : NO_SOURCE].join("\n\n");
  const subs = (blueprint.subStandards || []).filter(Boolean);
  const prompt = [
    `Mövzu/başlıq: ${blueprint.title || "(qeyd olunmayıb)"}`,
    `Sinif: ${blueprint.grade || "(qeyd olunmayıb)"}`,
    `Fənn: ${blueprint.subject || "(qeyd olunmayıb)"}`,
    blueprint.standard ? `Standart: ${blueprint.standard}` : "",
    subs.length
      ? `Alt-standartlar (YALNIZ bunlardan istifadə et): ${subs.join(", ")}`
      : "Alt-standart verilməyib: bu sahəni boş saxla.",
    "",
    "BU DƏFƏ HAZIRLANACAQ TAPŞIRIQLAR (struktur DƏYİŞDİRİLMƏZ, verilmiş kimidir):",
    ...rows.map(rowLine),
    "",
    `Hər sətir üçün 2 obyekt qaytar — biri "A", biri "B". Cəmi ${rows.length * 2} obyekt.`,
    '"no" sahəsi yuxarıdakı nömrə ilə eyni olmalıdır.',
  ]
    .filter(Boolean)
    .join("\n");
  return { system, prompt };
}

module.exports = { buildMsoPrompt, BASE, WITH_SOURCE, NO_SOURCE };
