const crypto = require("crypto");

/*
 * The lesson material the model writes, and the rules it writes under.
 *
 * OpenAI strict mode: `additionalProperties: false` everywhere AND every property
 * listed in `required`. There is no way to say "optional", so a field that does not
 * apply comes back as an empty string or an empty array and is normalised away
 * here. `minItems`, `maximum` and `pattern` are unavailable, so counts are asked
 * for in the prompt and enforced on this side.
 */

const BLOCK = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: ["heading", "text", "list", "definition", "example", "task", "note", "table", "figure"],
    },
    text: { type: "string" },
    term: { type: "string" },
    items: { type: "array", items: { type: "string" } },
    ordered: { type: "boolean" },
    solution: { type: "string" },
    columns: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "array", items: { type: "string" } } },
    tone: { type: "string", enum: ["info", "warning", "success"] },
    // A drawing, authored as SVG. Sanitised hard on arrival — see helper/lessonDocSvg.
    svg: { type: "string" },
  },
  required: ["kind", "text", "term", "items", "ordered", "solution", "columns", "rows", "tone", "svg"],
};

/*
 * What the agent can actually DO, as tools rather than as instructions.
 *
 * The distinction that matters: `write_material` changes what the document SAYS,
 * `set_print_options` changes how it PRINTS. They were the same thing before —
 * there was only one output shape, document content — so a request about printing
 * had to be answered with content, and "add page numbers" became the words
 * "Səhifə 1" typed into the middle of a lesson.
 *
 * A description here is not a rule the model must remember not to break. It is the
 * signature of a function: the model picks the one that matches the request, and
 * the one that would produce nonsense simply does not exist for that job.
 */
const DOC_TOOLS = [
  {
    name: "write_material",
    description:
      "Materialın MƏZMUNUNU yaz və ya dəyiş. Sənədi HTML kimi yazırsan — quruluşu sən qurursan. " +
      "Məzmun dəyişmirsə bu aləti ÇAĞIRMA.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Materialın qısa adı." },
        reply: { type: "string", description: "Müəllimə 1–2 cümlə: nə etdin və niyə." },
        html: {
          type: "string",
          description:
            "Sənədin TAM məzmunu HTML kimi. İcazə verilən teqlər: h1-h4, p, ul/ol/li, " +
            "table/thead/tbody/tr/th/td (colspan və rowspan işləyir), strong, em, u, " +
            "blockquote, figure/figcaption, section, div, span, hr, br, svg. " +
            "style atributu ilə ölçü, rəng, kənar xətt və hizalama verə bilərsən. " +
            "script, iframe, img, a, href, src QADAĞANDIR — sənəd internetə çıxmır.",
        },
      },
      required: ["title", "reply", "html"],
    },
  },
  {
    name: "set_print_options",
    description:
      "Materialın ÇAP və DİZAYN parametrlərini dəyiş. Məzmuna toxunmur — mətn olduğu kimi qalır. " +
      "Müəllim rəng, üslub və ya dizayn dəyişikliyi istəyirsə (məsələn \"rəngləri qırmızı et\"), bu aləti çağır. " +
      "Səhifə nömrələri PDF-in altında sistem tərəfindən çap olunur — onları blok kimi yazmaq mümkün deyil, " +
      "çünki blok hansı səhifəyə düşəcəyini bilmir. Müəllim səhifə nömrəsi istəyirsə və ya onları istəmirsə, " +
      "bu aləti çağır və cavabında vəziyyəti bildir.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pageNumbers: {
          type: "boolean",
          description: "PDF-in hər səhifəsinin altında nömrə (1/5) çap olunsun.",
        },
        accent: {
          type: "string",
          enum: ["default", "red", "orange", "green", "teal", "purple", "slate"],
          description:
            "Materialın əsas rəngi — başlıqlar, cədvəl başlıqları, anlayış qutuları. " +
            "Dəyişməyəcəksə, hazırkı dəyəri qaytar.",
        },
        reply: { type: "string", description: "Müəllimə bir cümlə: nəyi dəyişdin." },
      },
      required: ["pageNumbers", "accent", "reply"],
    },
  },
  {
    /*
     * The model could not say "I do not know what you mean".
     *
     * write_material and set_print_options were the whole vocabulary, so every
     * turn — however vague — had to come out as a change to the document. Sent
     * "continue" with nothing left to continue, the model did the only thing it
     * could express and invented two blank tables the teacher had not asked for,
     * appended to a document that was supposed to be an exact copy of a file.
     *
     * That is not the model being careless. Guessing was the only move on the
     * board. This adds the other one.
     */
    name: "ask_teacher",
    description:
      "Müəllimin nə istədiyi aydın deyilsə, SƏNƏDƏ TOXUNMADAN sual ver. " +
      "Sənəd olduğu kimi qalır — heç nə əlavə olunmur, heç nə silinmir. " +
      "Təxmin edib nəsə yazmaqdansa soruş: müəllimin istəmədiyi bir bölmə əlavə etmək, " +
      "sualı bir növbə gecikdirməkdən pisdir.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: {
          type: "string",
          description: "Müəllimə bir-iki cümləlik konkret sual. Nəyin aydın olmadığını de.",
        },
      },
      required: ["question"],
    },
  },
  {
    /*
     * The model can fetch a source it was given earlier.
     *
     * Attachments used to ride along on every single turn, which was wasteful and
     * kept pushing "copy the file" instructions at turns that were about the
     * document — so they stopped, and only what the teacher attaches now is sent.
     * That was right for edits and quietly disastrous for copies: asked on turn
     * twelve to match the PDF exactly, the model no longer had the PDF. What it
     * did have were the teacher's screenshots of our own preview, so it copied our
     * rendering back to us, blue headers and all, and reported the result as
     * matching the source.
     *
     * The file has been on the document the whole time. This is the model asking
     * for it — pull, not push: nothing is resent unless the work needs it, and
     * nothing needed is out of reach.
     */
    name: "read_source",
    description:
      "Sənədə əvvəllər əlavə edilmiş faylı OXU. Faylların adları promptda sadalanıb. " +
      "Fayl sənə hər növbədə göndərilmir — mənbəyə baxmaq lazımdırsa, bu aləti çağır. " +
      "Xüsusilə köçürmə işində: yaddaşdan və ya ekran şəklindən deyil, FAYLIN ÖZÜNDƏN köçür.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Faylın adı — promptdakı siyahıdan olduğu kimi." },
      },
      required: ["name"],
    },
  },
];const DOC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    // What the model says to the teacher. Counting blocks is a receipt, not an
    // answer — a teacher who asks "make it simpler for weaker students" wants to
    // hear what was actually done about it.
    reply: { type: "string" },
    blocks: { type: "array", items: BLOCK },
  },
  required: ["title", "reply", "blocks"],
};

const BASE_RULES = `
Sən Azərbaycan məktəbləri üçün DƏRS MATERİALI hazırlayan metodistsən. Bu material
şagirdə verilir: mövzunu izah edir, nümunə göstərir və məşq etdirir.

DİL: hər şey Azərbaycan dilində, aydın və sadə. Şagirdin yaşına uyğun yaz.

SƏNƏDİ HTML KİMİ YAZIRSAN. Quruluşu sən qurursan — bloklar siyahısı deyil.
Formalar, mürəkkəb cədvəllər, birləşdirilmiş xanalar (colspan/rowspan), sütun
enləri — hamısı mümkündür. Ekranda gördüyün, PDF-də və Word-də eyni olacaq:
sənədin HTML-i hər üç yerdə eynidir.

SƏNƏDİN BAŞLIĞINI ÖZÜN YAZIRSAN. Sistem sənədin üstünə heç nə əlavə etmir —
nə başlıq, nə alt başlıq, nə xətt. YENİ material yaradarkən sənədi <h1> ilə
başlat. KÖÇÜRMƏ REJİMİNDƏ isə yalnız fayldakı başlıq varsa yaz — yoxdursa,
sənəd birbaşa fayldakı ilk sətirlə başlayır.

İSTİFADƏ EDƏ BİLDİYİN TEQLƏR: h1–h4, p, ul/ol/li, table/thead/tbody/tr/th/td
(colspan, rowspan), strong, em, u, blockquote, figure/figcaption, section, div,
span, hr, br, svg. style atributu ilə ölçü, rəng, kənar xətt, hizalama ver.
QADAĞAN: script, iframe, img, a, href, src — sənəd internetə çıxmır, şəkil
lazımdırsa svg çək.

ÜSLUB SİNİFLƏRİ (hazır dizayn — istifadə et):
- <div class="def"><span class="term">Termin</span><p>izah</p></div> — anlayış
- <div class="ex"><span class="tag">NÜMUNƏ</span><p>şərt</p><p class="sol">həll</p></div>
- <div class="task"><span class="tag">TAPŞIRIQ</span><p>şərt</p></div>
- <div class="note info|warning|success"><p>qeyd</p></div>

KÖHNƏ BLOK TİPLƏRİ (yalnız arayış üçün — indi HTML yazırsan):
- heading — bölmə başlığı. Materialı 3–6 bölməyə ayır.
- text — izah. Bir blokda BİR fikir; uzun abzas yazma.
- definition — anlayış: "term" sahəsində termin, "text" sahəsində izahı.
- list — sadalama. Addım-addımdırsa "ordered": true.
- example — həll olunmuş nümunə. "text" şərt, "solution" addım-addım həll.
- task — şagirdin özünün edəcəyi tapşırıq. Cavabı bilirsənsə "solution"-a yaz.
- note — qeyd: "tone" = info (məsləhət), warning (tez-tez edilən səhv), success (yadda saxla).
- table — müqayisə və ya cədvəl. "columns" başlıqlar, "rows" sətirlər.
- figure — ŞƏKİL/SXEM. "svg" sahəsinə SVG kodu yaz, "text" sahəsinə şəklin altyazısı.
  Riyaziyyat, həndəsə, fizika, biologiya üçün: ədəd oxu, üçbucaq, dairə və radius,
  koordinat müstəvisi, diaqram, kəsr zolağı, hüceyrə sxemi və s.

FİQUR (figure) QAYDALARI — DİQQƏTLƏ OXU:

1) ÇƏRÇİVƏ. Mütləq viewBox olmalıdır:
   <svg viewBox="0 0 400 260" xmlns="http://www.w3.org/2000/svg">
   HEÇ NƏ viewBox-dan kənarda olmamalıdır — kənarda qalan hissə KƏSİLİR.
   Hər tərəfdən ən azı 16 vahid boş yer saxla. Başlıq yazırsansa, onu yuxarıda
   viewBox-un İÇİNDƏ yerləşdir (məsələn y="24"), MƏNFİ y qiyməti YAZMA.

2) HƏR FİQURUN RƏNGİ AÇIQ YAZILIR. Hər shape-də fill= və lazımdırsa stroke=
   olmalıdır. Rəng verməsən fiqur qara doğulur və ya heç görünmür.
   style= atributu İŞLƏMİR — rəngi birbaşa fill/stroke atributunda yaz.

3) KONTRAST. Ağ mətn yalnız tünd dolğunun ÜSTÜNDƏ yazıla bilər. Şübhə varsa
   fill="#1f2937" (tünd boz) istifadə et. Ağ fonda ağ yazı = görünməyən yazı.

4) DƏQİQLİK — ƏN VACİBİ. Şəkil altyazıda yazdığın şeyi HƏQİQƏTƏN göstərməlidir.
   "25 xana qırmızıdır" yazırsansa, tam olaraq 25 ədəd qırmızı xana çəkilməlidir.
   Say, ölçü və nisbətlər düz olmalıdır. Uyğun gəlmirsə, altyazını dəyiş.

5) TƏKRARLANAN FORMALAR. 100 xanalı tor kimi şeylərdə hər xananı ayrıca <rect>
   kimi yaz — bu ən etibarlı yoldur. Alternativ olaraq <defs> + <use href="#id">
   də işləyir, amma href MÜTLƏQ eyni şəkildəki id-yə işarə etməlidir.
   Xarici ünvana işarə edən href SİLİNİR və fiqur boş qalır.

6) İCAZƏ VERİLƏN ELEMENTLƏR: line, path, rect, circle, ellipse, polygon, polyline,
   text, tspan, g, defs, marker, use, linearGradient, radialGradient, clipPath.
   Script, style, foreignObject, image QADAĞANDIR.

7) ÜSLUB (materialın dizaynı ilə eyni olsun):
   - əsas xətt/kontur: stroke="#334155", stroke-width="1.5"
   - vurğu/dolğu: #2563eb (mavi), #16a34a (yaşıl), #dc2626 (qırmızı), #f59e0b (sarı)
   - açıq fon: #eff6ff, tor xətləri: #cbd5e1
   - yazı: font-size="13" font-family="Arial, sans-serif" fill="#1f2937"
   - başlıq: font-size="15" font-weight="bold"
   - text-anchor="middle" ilə mərkəzləşdir, ədəd oxunda dominant-baseline istifadə et

8) NƏ VAXT. Riyaziyyat, həndəsə, fizika, biologiya, coğrafiya: ədəd oxu, üçbucaq,
   dairə və radius, koordinat müstəvisi, sütun diaqramı, kəsr zolağı, faiz toru,
   hüceyrə sxemi, dövran sxemi. Sadəcə bəzək üçün fiqur ÇƏKMƏ.
   Hər şəkildə <text> ilə yazılar olsun ki, şəkil özü özünü izah etsin.

NÜMUNƏ (kəsr zolağı — 3/4). Diqqət et: başlıq içəridədir, hər rect-in fill-i var,
say altyazı ilə üst-üstə düşür:
<svg viewBox="0 0 320 120" xmlns="http://www.w3.org/2000/svg">
  <text x="160" y="24" text-anchor="middle" font-size="15" font-weight="bold" fill="#1f2937">3/4</text>
  <rect x="20" y="44" width="70" height="46" fill="#2563eb" stroke="#334155" stroke-width="1.5"/>
  <rect x="90" y="44" width="70" height="46" fill="#2563eb" stroke="#334155" stroke-width="1.5"/>
  <rect x="160" y="44" width="70" height="46" fill="#2563eb" stroke="#334155" stroke-width="1.5"/>
  <rect x="230" y="44" width="70" height="46" fill="#eff6ff" stroke="#334155" stroke-width="1.5"/>
  <text x="160" y="108" text-anchor="middle" font-size="13" fill="#1f2937">4 hissədən 3-ü boyanıb</text>
</svg>

MÜTLƏQ QAYDALAR:
- İstifadə etmədiyin sahələri BOŞ qaytar: boş sətir "" və ya boş massiv [].
  Məsələn "text" blokunda "term", "items", "columns", "rows" boş olmalıdır.
- Uydurma fakt, uydurma tarix, uydurma ad, uydurma sitat YAZMA. Bilmirsənsə,
  ümumi izah ver və ya sahəni boş saxla.
- Başlıq (title) qısa və mövzunu bildirən olsun.

YENİ MATERİAL YARADARKƏN (müəllim mövzu deyib, sıfırdan material istəyir):
- Strukturu belə qur: giriş izahı → anlayışlar → nümunələr → tapşırıqlar.
- Ən azı bir "example" və ən azı bir "task" olsun.

⚠️ BU İKİ QAYDA YALNIZ SIFIRDAN MATERİAL ÜÇÜNDÜR.
Müəllim hazır sənədi, formanı və ya şablonu OLDUĞU KİMİ köçürməyi istəyirsə,
aşağıdakı KÖÇÜRMƏ REJİMİ qaydaları bunlardan ÜSTÜNDÜR: orada nümunə və tapşırıq
əlavə etmək QADAĞANDIR. Boş forma boş qalmalıdır.

"reply" SAHƏSİ: müəllimə 1–2 cümlə yaz — nə etdiyini və niyə. Söhbət tonunda, sadə.
Blokları sadalama, rəqəm hesabatı vermə (onu sistem özü göstərir). Nümunə:
"Mövzunu üç bölməyə ayırdım və hər qaydaya bir nümunə verdim. Tapşırıqları asandan
çətinə düzdüm." Nəyisə edə bilmədinsə, bunu da açıq yaz.
`.trim();

const EDIT_RULES = `
REDAKTƏ REJİMİ — SƏNƏD ARTIQ MÖVCUDDUR:
- Aşağıdakı HTML müəllimin hazırkı sənədidir. Onu YENİDƏN YAZMA, sıfırdan qurma.
- write_material-a sənədin TAM HTML-ini qaytar — amma YALNIZ istənilən dəyişiklik
  edilmiş halda. Toxunulmayan hər sətir hərfi-hərfinə eyni qayıtmalıdır.
- Quruluşu, cədvəlləri, sütun sayını, sıranı, dili və üslubu DƏYİŞMƏ — müəllim
  məhz onu dəyişməyi istəməyibsə.
- Əvvəlki növbələrdə edilmiş dəyişikliklər (tərcümə, rəng, əlavə bölmə) sənədin
  bir hissəsidir. Onları geri qaytarma.
- Fayl əlavə olunubsa belə, DƏYİŞDİRİLƏCƏK ŞEY bu sənəddir, fayl deyil. Faylı
  yalnız müəllim məhz ondan nəsə istəyəndə açıq şəkildə istifadə et.
`.trim();


/*
 * Added only when the teacher has attached something. Without it the model has a
 * file in the request and no instruction to prefer it, and will happily write from
 * general knowledge while ignoring the page it was given.
 */
const SOURCE_RULES = `
ƏLAVƏ EDİLMİŞ FAYLLAR:
- Müəllim fayl (PDF və ya şəkil) əlavə edib. O fayl BİRİNCİ MƏNBƏDİR.
- Materialı həmin faylın məzmununa əsaslandır: anlayışlar, nümunələr, tapşırıqlar
  mümkün qədər oradan götürülsün.
- Faylda olmayan şeyi "faylda yazılıb" kimi təqdim etmə. Əlavə izah verirsənsə,
  bunu öz sözlərinlə yaz.
- Müəllim faylı yalnız NÜMUNƏ (üslub, format) kimi göstəribsə, məzmunu köçürmə —
  quruluşu təkrarla.

KÖÇÜRMƏ REJİMİ — NƏ VAXT İŞƏ DÜŞÜR:
Müəllim faylı OLDUĞU KİMİ istəyirsə. Tanı: "köçür", "kopyala", "olduğu kimi",
"eyni", "hər şeyi eyni", "dəyişmə", "heç nəyi dəyişmə", "elə o formada",
"bu formanı hazırla", "bu şablonu yarat", "bu vərəqi Word et", "PDF-ə çevir".
Şübhə varsa və müəllim yeni məzmun istədiyini AÇIQ deməyibsə — köçürmə rejimi seç.

KÖÇÜRMƏ REJİMİNDƏ — NƏTİCƏ FAYLIN EYNİSİ OLMALIDIR:
- ⛔ BAŞLIQ, ALT BAŞLIQ, GİRİŞ, İZAH ƏLAVƏ ETMƏ. Sənəd fayldakı ilk sətirlə
  başlayır. "Kimlər üçün", "Müəllimlər üçün" kimi sətirlər uydurma.
- GÖRÜNÜŞÜ də köçür, təkcə mətni yox: fayldakı rəng (qara mətn qara qalsın),
  şrift (serif faylda serif), sərhədlər, mərkəzləmə, sütun enləri. Bunları
  birbaşa style="..." ilə yaz — bizim standart üslubumuzu tətbiq etmə.

KÖÇÜRMƏ REJİMİNDƏ:
- Fayldakı BÜTÜN məzmunu oxu və blok-blok eyni ardıcıllıqla yenidən qur:
  başlıqlar → heading, izahlar → text, anlayışlar → definition, həll olunmuş
  misallar → example, çalışmalar → task, cədvəllər → table.
- Mətnini dəyişdirmə, tərcümə etmə, "yaxşılaşdırma" — olduğu kimi köçür.
  Sahə adları ingiliscədirsə, ingiliscə qalsın. Sıranı dəyişmə.
- ⛔ ƏLAVƏ ETMƏ: izah, şərh, nümunə, tapşırıq, "necə doldurulur" bölməsi,
  müəllim üçün məsləhət — faylda YOXDURSA, sənəddə də OLMAMALIDIR.
- ⛔ BOŞ FORMA BOŞ QALIR. Doldurulmamış xanaları öz uydurduğun adla, tarixlə və
  ya nümunə cavabla DOLDURMA. Boş forma köçürüləndə nəticə də boş formadır:
  cədvəl sahə adlarını saxla, dəyər xanalarını boş burax.
  PİS: "Teacher: Əliyeva Aygün", "Date: 15.03.2024" (faylda yoxdur — uydurmadır).
  YAXŞI: "Teacher:" sahəsi var, dəyəri boş.
- Faylın quruluşu cədvəldirsə, cədvəl olaraq qalsın — sadalamaya çevirmə.

📋 FORMA/ŞABLON KÖÇÜRƏNDƏ — ƏN VACİB QAYDA:
Forma xanalardan ibarətdir. Onu "heading" və "text" bloklarının siyahısı kimi
YAZMA — belə etsən forma yox, sadəcə başlıq siyahısı alınır. Hər forma hissəsini
"table" bloku kimi qur:
- "columns" → həmin sətirdəki sahə adları (olduğu kimi, ingiliscədirsə ingiliscə).
- "rows" → doldurulacaq BOŞ xanalar: [["", "", ""]]. Boş sətir SAXLANILIR —
  müəllim məhz ora yazacaq.
Nümunə (formada "Teacher: | Observer: | Date and Time:" sətri varsa):
  { "kind": "table",
    "columns": ["Teacher:", "Observer:", "Date and Time:"],
    "rows": [["", "", ""]] }
Böyük cədvəl (məsələn Procedure | Phase | Timing | Interaction) üçün neçə boş
sətir lazımdırsa o qədər boş sətir yaz — müəllim onları dolduracaq.
Tək sahə (məsələn "Context:") üçün də cədvəl işlət:
  { "kind": "table", "columns": ["Context:"], "rows": [[""]] }
- Əlyazma və ya keyfiyyətsiz şəkildə oxunmayan yer varsa, uydurma. Həmin yeri
  "[oxunmadı]" kimi qeyd et ki, müəllim özü düzəltsin.
- Şəkildə düstur, sxem və ya fiqur varsa, onu "figure" bloku kimi SVG ilə yenidən çək.
- "reply" sahəsində nə köçürdüyünü yaz — nə əlavə etdiyini yox.
`.trim();

const describe = (d = {}) =>
  [
    d.topic ? `Mövzu: ${d.topic}` : null,
    d.grade ? `Sinif: ${d.grade}` : null,
    d.subject ? `Fənn: ${d.subject}` : null,
    d.audience ? `Kimin üçün: ${d.audience}` : null,
  ]
    .filter(Boolean)
    .join("\n");

// First pass: there is no document yet, only what the teacher asked for.
function buildCreatePrompt({ doc = {}, instructions = "" } = {}) {
  return {
    system: BASE_RULES,
    prompt: [
      describe(doc),
      sourceList(doc),
      // A first draft can still be the second thing asked for — the teacher may
      // have described what they want across two messages.
      historyOf(doc),
      "",
      `MÜƏLLİMİN İSTƏYİ: ${String(instructions || "").slice(0, 4000)}`,
      "",
      "Bu istəyə uyğun tam dərs materialı hazırla.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/*
 * Every later pass. The whole current document goes in, so the model changes one
 * thing and hands the rest back untouched — the same contract as the lesson-plan
 * editor, and the reason a teacher's own wording survives a request to "add two
 * more examples".
 */
/*
 * What has already been said in this document's chat.
 *
 * Every turn used to be a first meeting: one instruction, no transcript. So
 * "make it shorter" had no idea what "it" was, "put that back" could not be
 * answered at all, and the model had no way to know that the document in front of
 * it was something it had written two turns ago rather than something to replace.
 *
 * Bounded on purpose. The last few exchanges are what an instruction refers back
 * to; the twentieth turn ago is not, and paying to resend it every time buys
 * nothing. The DOCUMENT is what carries the state — this only carries the intent
 * behind it.
 */
const HISTORY_TURNS = 12;
const HISTORY_CHARS = 400;

function historyOf(doc = {}) {
  const msgs = (doc.messages || []).slice(-HISTORY_TURNS);
  if (msgs.length < 2) return "";

  const lines = msgs
    .map((m) => {
      const who = m.role === "user" ? "MÜƏLLİM" : "SƏN";
      const text = String(m.text || "").replace(/\s+/g, " ").trim();
      if (!text) return "";
      const files = (m.files || []).map((f) => f.name).filter(Boolean);
      // Naming the attachment matters even though the bytes are not resent: it is
      // how "the file I sent earlier" stays answerable.
      const note = files.length ? ` [fayl əlavə etdi: ${files.join(", ")}]` : "";
      return `${who}: ${text.slice(0, HISTORY_CHARS)}${text.length > HISTORY_CHARS ? "…" : ""}${note}`;
    })
    .filter(Boolean);

  if (!lines.length) return "";
  return `ƏVVƏLKİ SÖHBƏT (bu sənəd üzrə):\n${lines.join("\n")}`;
}

/*
 * The sources this document holds, by name.
 *
 * Named rather than sent: the bytes travel only on the turn they are attached, so
 * this is how a file the teacher added ten turns ago stays reachable — the model
 * reads the list, and calls read_source for the one it needs.
 */
function sourceList(doc = {}) {
  const files = (doc.files || []).map((f) => f.name).filter(Boolean);
  if (!files.length) return "";
  return `SƏNƏDƏ ƏLAVƏ EDİLMİŞ FAYLLAR: ${files.join(", ")}\n(Bunlar sənə avtomatik göndərilmir — lazım olanı read_source ilə oxu.)`;
}

function buildEditPrompt({ doc = {}, instructions = "" } = {}) {
  /*
   * The document itself, as the model wrote it.
   *
   * This serialised `blocks`, which an html document does not have — so every
   * edit handed the model an EMPTY document. Asked to remove the blank rows from
   * a form, it had no form to remove them from, went back to the attached PDF and
   * copied it out again from scratch, discarding a translation and a colour
   * change made in the two turns before. The teacher saw their layout replaced
   * and read it, correctly, as the assistant ignoring what they asked.
   */
  if (has(doc.html)) {
    return {
      system: [BASE_RULES, EDIT_RULES].join("\n\n"),
      prompt: [
        describe(doc),
        sourceList(doc),
        historyOf(doc),
        "",
        "HAZIRKI MATERİAL (HTML) — DƏYİŞDİRİLƏCƏK SƏNƏD BUDUR:",
        doc.html,
        "",
        `MÜƏLLİMİN İSTƏDİYİ DƏYİŞİKLİK: ${String(instructions || "").slice(0, 4000)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  // Documents written before the model authored its own html.
  const current = {
    title: doc.title || "",
    blocks: (doc.blocks || []).map((b) => ({
      kind: b.kind,
      text: b.text || "",
      term: b.term || "",
      items: b.items || [],
      ordered: b.ordered === true,
      solution: b.solution || "",
      columns: b.columns || [],
      rows: b.rows || [],
      tone: b.tone || "info",
      // Without this the model never sees the drawing it made last turn, and an
      // unrelated edit silently loses every figure in the document.
      svg: b.svg || "",
    })),
  };
  return {
    system: [BASE_RULES, EDIT_RULES].join("\n\n"),
    prompt: [
      describe(doc),
      historyOf(doc),
      "",
      "HAZIRKI MATERİAL (JSON):",
      JSON.stringify(current),
      "",
      `MÜƏLLİMİN İSTƏDİYİ DƏYİŞİKLİK: ${String(instructions || "").slice(0, 4000)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

const clean = (v) => String(v == null ? "" : v).replace(/\r/g, "").trim();
const list = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

/*
 * A page marker written as CONTENT is never real, so it never survives.
 *
 * Asked to "add page numbers", the model wrote "Səhifə 1", "Səhifə 2" as text
 * blocks into the middle of the document — numbers that mean nothing, because a
 * block does not know what page it lands on, and that go stale the moment
 * anything above them changes. The renderer has already printed a true page
 * number in the footer of every sheet since the beginning; there was nothing to
 * add and no way for a block to add it.
 *
 * The brief now says so, but a rule the model can forget is not a fix when the
 * failure writes rubbish into a teacher's document. This is the enforcement: a
 * block whose entire content is a page marker is dropped, in any of the three
 * languages this product is written in.
 */
const PAGE_MARKER = /^(səhifə|sehife|sayfa|page|s\.)\s*[-–—:]?\s*\d+\s*(\/\s*\d+)?[.)]?$/i;
const isPageMarker = (t) => PAGE_MARKER.test(String(t || "").trim());
// A form's Procedure grid is legitimately long; a model looping is not.
const MAX_TABLE_ROWS = 80;
const newId = () => crypto.randomBytes(6).toString("hex");

/*
 * Take the model's answer and make it storable.
 *
 * Strict mode forces every field on every block, so a text block arrives carrying
 * empty `columns`, `rows` and `term`. Storing that noise would put meaningless keys
 * in the database and meaningless controls in the editor, so each kind keeps only
 * what it uses. Anything unrecognisable is dropped rather than guessed at — a block
 * with no content cannot be rendered or edited, and an empty box in a handout is
 * worse than one fewer paragraph.
 */
function normalizeDoc(rawDoc = {}, { keepIds = [] } = {}) {
  // A default parameter only fires for `undefined`, so an explicit null — which a
  // provider can absolutely return — reached the property access and threw. A print
  // request is not the place to 500.
  const raw = rawDoc && typeof rawDoc === "object" ? rawDoc : {};
  const blocks = [];
  const src = Array.isArray(raw.blocks) ? raw.blocks : [];

  src.forEach((b, i) => {
    if (!b || typeof b !== "object") return;
    const kind = String(b.kind || "").trim();
    // Reuse the id in the same position where one exists, so an edit that returns
    // the document unchanged does not renumber every block.
    const id = keepIds[i] || newId();
    const text = clean(b.text);

    switch (kind) {
      case "heading":
        // A heading that is only "Səhifə 2" is a page marker, not a section.
        if (text && !isPageMarker(text)) blocks.push({ id, kind, text });
        break;
      case "text":
        if (text && !isPageMarker(text)) blocks.push({ id, kind, text });
        break;
      case "note":
        if (text) {
          const tone = ["info", "warning", "success"].includes(b.tone) ? b.tone : "info";
          blocks.push({ id, kind, text, tone });
        }
        break;
      case "definition": {
        const term = clean(b.term);
        if (term || text) blocks.push({ id, kind, term, text });
        break;
      }
      case "list": {
        const items = list(b.items);
        if (items.length) blocks.push({ id, kind, items, ordered: b.ordered === true });
        break;
      }
      case "example":
      case "task": {
        const solution = clean(b.solution);
        if (text) blocks.push({ id, kind, text, solution });
        break;
      }
      case "figure": {
        // The drawing is only worth keeping if it survives sanitising; a figure
        // block with no picture is an empty frame in a handout.
        const { sanitizeSvg } = require("./lessonDocSvg");
        const svg = sanitizeSvg(b.svg);
        if (svg) blocks.push({ id, kind, svg, text });
        break;
      }
      case "table": {
        /*
         * An empty cell is CONTENT in a table, and this used to delete it.
         *
         * `list()` ends in `.filter(Boolean)`, which is right for a bullet list —
         * an empty bullet is noise — and catastrophic for a grid. A blank form is
         * almost entirely empty cells: filtering them collapsed every row onto its
         * labels, shifted the remaining cells into the wrong columns, and dropped
         * any row that was blank all the way across. A teacher who asked for their
         * lesson-plan form back got a flat list of field names, because the table
         * that would have been the form was dismantled here.
         *
         * So cells are cleaned but never dropped, and each row is squared off to
         * the header width — a ragged grid renders as a broken one.
         */
        const columns = (Array.isArray(b.columns) ? b.columns : []).map(clean);
        const width = columns.length;
        const rows = (Array.isArray(b.rows) ? b.rows : [])
          .slice(0, MAX_TABLE_ROWS)
          .map((r) => {
            const cells = Array.isArray(r) ? r.map(clean) : [];
            return Array.from({ length: width }, (_, i) => cells[i] || "");
          });
        // A table still needs at least one real header, or it is not a table.
        if (width && columns.some(Boolean) && rows.length) blocks.push({ id, kind, columns, rows });
        break;
      }
      default:
        break;
    }
  });

  return { title: clean(raw.title), reply: clean(raw.reply), blocks };
}

// What the teacher is told after a pass, so "it did something" is never the whole
// report. Counts, not prose — the document itself is the detail.
function summarize(blocks = []) {
  const n = (kind) => blocks.filter((b) => b.kind === kind).length;
  return {
    blocks: blocks.length,
    sections: n("heading"),
    examples: n("example"),
    tasks: n("task"),
  };
}


/*
 * PHASE 1 — decide what to write, before writing it.
 *
 * A single call that goes straight to prose gives the teacher nothing to look at
 * for forty seconds and no say in what is coming. This asks the model to read the
 * request and commit to a shape first: the title, who it is for, and the sections
 * it will write with a reason for each. It is small and fast, it is shown in the
 * chat immediately, and the writing pass is then held to it.
 */
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    audience: { type: "string" },
    /*
     * What the model can actually SEE in each attached file.
     *
     * This is the only honest answer to "did it really read my PDF?" — a question
     * a teacher asked directly, and one the interface could not answer, because
     * the progress report was a plan written before the work rather than an
     * account of it. A model that names the topics and counts the exercises on
     * the page has demonstrably read the page; one that cannot say what is in the
     * file says so here, in front of the teacher, instead of quietly writing from
     * general knowledge in the same confident voice.
     */
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          found: { type: "string" },
          readable: { type: "boolean" },
        },
        required: ["name", "found", "readable"],
      },
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { heading: { type: "string" }, why: { type: "string" } },
        required: ["heading", "why"],
      },
    },
  },
  required: ["title", "audience", "sources", "sections"],
};

const PLAN_RULES = `
Sən Azərbaycan məktəbləri üçün dərs materialı hazırlayan metodistsən.
Hələ material YAZMIRSAN — yalnız planlaşdırırsan.

Müəllimin istəyini oxu və qərar ver:
- "title": materialın qısa adı.
- "audience": kimin üçündür (sinif və səviyyə). Müəllim deməyibsə, mövzuya görə özün müəyyən et.
- "sections": 3–6 bölmə. Hər birinin "heading" adı və "why" — bir cümlə: bu bölmə nə üçün lazımdır.

⚠️ KÖÇÜRMƏ İSTƏYİ İSTİSNADIR. Müəllim əlavə edilmiş faylı OLDUĞU KİMİ köçürməyi
istəyirsə ("köçür", "olduğu kimi", "eyni", "dəyişmə", "bu formanı hazırla"),
"sections" fayldakı ÖZ bölmələri olmalıdır — nə az, nə çox, eyni adlarla və eyni
sırada. 3–6 məhdudiyyəti burada keçərli deyil: faylda 9 bölmə varsa, 9 yaz.
Öz bölməni ("Giriş", "Nümunələr", "Tapşırıqlar") ƏLAVƏ ETMƏ.

"sources" SAHƏSİ — ƏLAVƏ EDİLMİŞ FAYLLAR HAQQINDA:
- Sənə fayl verilibsə, hər fayl üçün bir sətir yaz. Fayl yoxdursa, boş massiv qaytar.
- "name": faylın adı (verilmiş adı yaz).
- "readable": faylı HƏQİQƏTƏN oxuya bildinsə true, oxuya bilmədinsə false.
- "found": faylda NƏ GÖRDÜYÜNÜ konkret yaz. Ümumi söz yazma.
  PİS: "PDF oxundu", "material var", "faydalı məlumat var".
  YAXŞI: "12 səhifə, 5-ci sinif riyaziyyat; faiz mövzusunda 8 çalışma, səh. 34-38",
         "ingilis dili qrammatika vərəqi, modal fellər, 15 boşluq doldurma sualı",
         "cədvəl şəklində dərs cədvəli — mövzu ilə əlaqəsi yoxdur".
- Faylı oxuya bilmirsənsə (skan keyfiyyətsizdir, şifrələnib, boşdur), readable=false
  yaz və "found" sahəsində SƏBƏBİ yaz. Uydurma.
- Fayl mövzuya AİD DEYİLSƏ, bunu açıq yaz — müəllim səhv fayl əlavə etmiş ola bilər.

Müəllim konkret şeylər istəyibsə (cədvəl, neçə nümunə, neçə tapşırıq, hansı səhvi
göstərmək), onları bölmələrdə əks etdir. Uydurma bölmə əlavə etmə.
`.trim();

/*
 * The same first pass, for a change rather than a creation.
 *
 * An edit used to run straight to the writing pass, so the only thing the teacher
 * saw for the length of a long call was "Dəyişirəm…". That is not progress, it is a
 * spinner with a word on it: it never says what was understood, so a
 * misunderstanding is only discovered once the rewrite has landed on the document.
 *
 * Planning the edit costs one small fast call and buys the thing that actually
 * matters — the teacher reads "I will add three German examples from the attached
 * book and draw a figure for the plural rule" and knows within two seconds whether
 * to let it run.
 */
const EDIT_PLAN_RULES = `
Sən Azərbaycan məktəbləri üçün dərs materialı hazırlayan metodistsən.
Müəllimin HAZIR materialı var və onu dəyişmək istəyir. Hələ dəyişiklik ETMİRSƏN —
yalnız nə edəcəyini planlaşdırırsan.

- "title": materialın adı — DƏYİŞMƏ, olduğu kimi qaytar (müəllim adı dəyişməyi
  xüsusi istəmirsə).
- "audience": boş qoy.
- "sections": edəcəyin ADDIMLAR, 2–5 ədəd. Bölmə adı deyil — ƏMƏLİYYAT.
  "heading" = qısa əməliyyat, "why" = bir cümlə izah.

Nümunə addımlar:
  heading: "3 yeni alman nümunəsi əlavə edirəm"
  why: "Əlavə edilmiş kitabın 24-cü səhifəsindəki cümlələr əsasında."
  heading: "Cəm şəkilçisi üçün sxem çəkirəm"
  why: "Qaydanı yazı ilə deyil, şəkillə göstərmək daha aydındır."

Yalnız müəllimin istədiyini planlaşdır. Bütün materialı yenidən yazmağı planlaşdırma.
Əlavə edilmiş fayl varsa, ondan nə götürəcəyini konkret yaz.

"sources" SAHƏSİ — ƏLAVƏ EDİLMİŞ FAYLLAR HAQQINDA:
- Sənə fayl verilibsə, hər fayl üçün bir sətir yaz. Fayl yoxdursa, boş massiv qaytar.
- "name": faylın adı (verilmiş adı yaz).
- "readable": faylı HƏQİQƏTƏN oxuya bildinsə true, oxuya bilmədinsə false.
- "found": faylda NƏ GÖRDÜYÜNÜ konkret yaz. Ümumi söz yazma.
  PİS: "PDF oxundu", "material var", "faydalı məlumat var".
  YAXŞI: "12 səhifə, 5-ci sinif riyaziyyat; faiz mövzusunda 8 çalışma, səh. 34-38",
         "ingilis dili qrammatika vərəqi, modal fellər, 15 boşluq doldurma sualı",
         "cədvəl şəklində dərs cədvəli — mövzu ilə əlaqəsi yoxdur".
- Faylı oxuya bilmirsənsə (skan keyfiyyətsizdir, şifrələnib, boşdur), readable=false
  yaz və "found" sahəsində SƏBƏBİ yaz. Uydurma.
- Fayl mövzuya AİD DEYİLSƏ, bunu açıq yaz — müəllim səhv fayl əlavə etmiş ola bilər.

`.trim();

// Written, and not just present: an empty string is not a document.
const has = (v) => Boolean(String(v == null ? "" : v).trim());

/*
 * How much a document holds, whichever way it is stored. Both shapes exist —
 * html for anything the model wrote itself, blocks for everything written before
 * that — and every "is there anything here" test must accept both, or a complete
 * document reads as an empty one.
 */
function countParts(doc = {}) {
  if (has(doc.html)) {
    return (String(doc.html).match(/<(h[1-4]|p|ul|ol|table|figure|blockquote)/gi) || []).length;
  }
  return (doc.blocks || []).length;
}

function buildPlanPrompt({ doc = {}, instructions = "", editing = false } = {}) {
  // The current document's headings go in for an edit: "add examples to the second
  // section" is unanswerable without knowing what the sections are.
  const headings = has(doc.html)
    ? (String(doc.html).match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi) || [])
        .map((h) => h.replace(/<[^>]+>/g, "").trim())
        .filter(Boolean)
    : (doc.blocks || []).filter((b) => b && b.kind === "heading" && b.text).map((b) => b.text);
  const outline = editing ? headings.map((t, i) => `${i + 1}. ${t}`).join("\n") : "";

  return {
    system: editing ? EDIT_PLAN_RULES : PLAN_RULES,
    prompt: [
      describe(doc),
      outline ? `\nHAZIRKI BÖLMƏLƏR:\n${outline}` : "",
      editing ? `\nMaterialda ${countParts(doc)} hissə var.` : "",
      "",
      `MÜƏLLİMİN İSTƏYİ: ${String(instructions || "").slice(0, 4000)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

const normalizePlan = (raw = {}) => {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    title: clean(r.title),
    audience: clean(r.audience),
    /*
     * What the model says it found in each attached file. Kept even when
     * `readable` is false — "I could not read this one" is the most useful line
     * on the whole report, and dropping it would leave the teacher with the same
     * silence that made them doubt the file was being read at all.
     */
    sources: (Array.isArray(r.sources) ? r.sources : [])
      .map((x) => ({
        name: clean(x && x.name),
        found: clean(x && x.found),
        readable: (x && x.readable) !== false,
      }))
      .filter((x) => x.name || x.found),
    sections: (Array.isArray(r.sections) ? r.sections : [])
      .map((x) => ({ heading: clean(x && x.heading), why: clean(x && x.why) }))
      .filter((x) => x.heading),
  };
};


/*
 * Progress for a document written as HTML.
 *
 * makeBlockStreamer walks a partial `blocks` array, which an html document does
 * not have — so the live turn lost its count the moment the model started writing
 * markup instead, and a two-minute rewrite reported nothing at all. This counts
 * the block-level tags that have CLOSED in the partial tool input, which is the
 * same honest signal: work finished, not time elapsed.
 */
function makeHtmlStreamer() {
  let seen = 0;
  const CLOSERS = /<\/(h[1-4]|p|li|tr|figure|blockquote|table)>/gi;
  return (buf) => {
    const total = (String(buf || "").match(CLOSERS) || []).length;
    const fresh = [];
    while (seen < total) {
      seen += 1;
      fresh.push({ kind: "hissə", text: "" });
    }
    return fresh;
  };
}

/*
 * Reads blocks out of a half-finished JSON response, so progress can be reported
 * from what has actually been written rather than a timer. Same technique as the
 * exam streamer: walk the array, emit each object the moment it closes cleanly, and
 * wait for more bytes when it does not.
 */
function makeBlockStreamer() {
  let emitted = 0;
  return (buf) => {
    const key = buf.indexOf('"blocks"');
    if (key < 0) return [];
    const arrStart = buf.indexOf("[", key);
    if (arrStart < 0) return [];
    const fresh = [];
    let depth = 0;
    let objStart = -1;
    let inStr = false;
    let esc = false;
    let idx = 0;
    for (let i = arrStart + 1; i < buf.length; i += 1) {
      const c = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") {
        if (depth === 0) objStart = i;
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth === 0 && objStart >= 0) {
          idx += 1;
          if (idx > emitted) {
            try {
              fresh.push(JSON.parse(buf.slice(objStart, i + 1)));
              emitted = idx;
            } catch {
              return fresh; // not closed cleanly yet — wait for more bytes
            }
          }
          objStart = -1;
        }
      } else if (c === "]" && depth === 0) break;
    }
    return fresh;
  };
}

module.exports = {
  DOC_SCHEMA,
  DOC_TOOLS,
  SOURCE_RULES,
  PLAN_SCHEMA,
  PLAN_RULES,
  buildPlanPrompt,
  normalizePlan,
  makeBlockStreamer,
  makeHtmlStreamer,
  BLOCK,
  BASE_RULES,
  EDIT_RULES,
  buildCreatePrompt,
  buildEditPrompt,
  countParts,
  historyOf,
  sourceList,
  normalizeDoc,
  summarize,
  newId,
};
