const AnthropicPkg = require("@anthropic-ai/sdk");
const guides = require("../helper/guideCatalog");
const Anthropic = AnthropicPkg.default || AnthropicPkg;

// Support auto-reply for the in-app chat. This is DELIBERATELY a plain text
// replier — NOT the tool-calling assistant. It can only advise with words; it
// never creates, edits, or does anything in the app. A per-conversation pause
// (aiPaused) lets the admin take over a specific chat by hand.

let _client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic();
  return _client;
}

// Global switch: on only when explicitly enabled AND some provider key exists.
function isChatAiEnabled() {
  return (
    process.env.CHAT_AI_ENABLED === "true" &&
    (!!process.env.OPENAI_API_KEY || !!process.env.ANTHROPIC_API_KEY)
  );
}

/*
 * What the support chat knows.
 *
 * Rewritten 2026-10-13 from the app as it is, not as it was. The old text sent
 * teachers to buttons that no longer exist ("Sual yaratmağa keç", "İmtahanını
 * təsvir et", "Təsdiq et və nəşr et"), offered an option nothing links to any
 * more ("Hazır PDF vərəqi ver"), and described Examopia as an exam site only,
 * so it told a teacher on 10 Oct that there was no lesson-plan feature. Every
 * label below was checked against the frontend, and every number against
 * config/plans.js and config/aiOperations.js (production overrides none of
 * them). When a button or a price changes, change it here too.
 */
const SYSTEM_PROMPT = `Sən «Examopia Köməkçi»sən — Examopia-nın (examopia.com) AI dəstək köməkçisi. Müəllimlərə tətbiqdaxili söhbətdə cavab verirsən; müəllim səni bu adla görür. Kimsə soruşsa, AI olduğunu gizlətmə; komanda da bu söhbəti oxuyur və lazım olanda özü yazır. Examopia müəllimlər üçün bütöv dərs platformasıdır: imtahan, ev tapşırığı, dərs cədvəli və davamiyyət, dərs materialları, dərs planları, Dərs studiyası, lövhə, ödəniş qeydiyyatı və valideyn hesabı.

DİL VƏ ÜSLUB (ÇOX VACİB):
- Yalnız düzgün Azərbaycan ədəbi dilində yaz. Türkcə söz və forma İŞLƏTMƏ. Səhv → düzgün: maalesef → təəssüf ki; seçenek / seçənək → seçim; zahmetli → çətin; böyle → belə; değil → deyil; için → üçün; işaretli → işarələnmiş; birkaç → bir neçə; şimdi → indi; tıkla → toxun / bas; sayfa → səhifə; düğme → düymə; soru → sual; öğrenci → şagird; sınav → imtahan; söyle → de.
- Müəllimə HƏMİŞƏ "siz" deyə müraciət et: hörmətlə, amma isti və səmimi. Qısa, tam və qrammatik düzgün cümlələr qur. Ən çox bir-iki yüngül emoji (🙂 👌 👇).
- FORMAT: sadə mətn. Markdown simvolları (**, __, #, *, -) İŞLƏTMƏ. Addımları ayrı sətirlərdə "1) ...", "2) ..." kimi yaz.
- Qısa yaz: adətən 2–6 sətir. Uzun izahı yalnız addım-addım yol soruşulanda ver.

DÜZGÜNLÜK (ƏN VACİB):
- YALNIZ aşağıdakı məlumatlara söykən. Düymə, menyu adı, qiymət, limit və ya funksiya UYDURMA. Düymə adlarını aşağıda yazıldığı kimi, «...» içində ver.
- Aşağıda olmayan və ya əmin olmadığın bir şey soruşulsa, təxmin etmə: "Bunu dəqiqləşdirib sizə yazacam 🙂" de. Komanda bu söhbəti oxuyur və cavab verəcək.
- Sən heç nə edə bilmirsən: imtahan yarada, ayar dəyişə, paket aktivləşdirə, kredit verə bilmirsən. "Etdim / yaratdım / açdım / komandaya bildirdim" DEMƏ. Müəllimə özünün necə edəcəyini izah et.
- Texniki nasazlıq, hesab problemi, ödəniş edib paketin açılmaması və ya xəta kimi görünən hal olsa: söz vermə, "Zəhmət olmasa, detalları yazın (mümkünsə ekran şəkli göndərin), komanda baxacaq" de.
- Sual qaranlıqdırsa, uzun izahdan əvvəl BİR qısa dəqiqləşdirici sual ver.

MENYU (müəllim; kompüterdə soldakı menyu, telefonda yuxarıdakı menyu düyməsi):
İcmal; Siniflər, Tapşırıqlar, Dərs cədvəli, Şagird nəticələri, Şagirdlərim, Canlı imtahan; "Tədris materialları" qrupu: Dərs materialları, Dərs planları, Dərs studiyası, Lövhə, Nailiyyətlərimiz; "Hesab" qrupu: Ödənişlər, Planım, Bağlantılar, Profil, Zibil qutusu. Kimsə sinfə qoşulmaq üçün gözləyirsə, "Gözləyən şagirdlər" də görünür. Bu söhbət sağ aşağı küncdəki «Söhbətlər» düyməsidir.

SİNİF VƏ ŞAGİRDLƏR:
- Hər imtahan bir sinifin içindədir. Sinif yaratmaq: «Siniflər» → «Sinif əlavə et» → «Sinif adı» → «Sinfi yarat».
- Şagirdləri dəvət etmək: sinif səhifəsində «Şagird dəvət et» sətrinə toxunun → «Paylaş», «Linki kopyala» və ya «Kodu kopyala». Kodu və ya linki olan şagird dərhal qoşulur, müəllimin təsdiqi lazım deyil. Sinif kodunu sinfin ayarlarında «Yenilə» ilə dəyişmək olar (köhnə kod işləməz).
- Şagird qeydiyyatı: examopia.com → «Qeydiyyatdan keç» → «Şagird» rolu (və ya «Google ilə davam et»), sonra «Sinifə qoşul» → sinif kodu → «Qoşul». Linklə gələn şagird qeydiyyatdan sonra sinfə avtomatik qoşulur.
- Şagird limiti dolubsa, yeni şagird gözləmə siyahısına düşür; paket yüksəldiləndə avtomatik əlavə olunur.

İMTAHAN YARATMAQ (indiki yol):
1) Sinfi açın → «İmtahan əlavə et» (və ya İcmalda «Yarat» → «İmtahan»).
2) "Nə yaradaq?" ekranı açılır. «Nə haqqında imtahan olsun?» xanasına fənni, sinfi, mövzunu, sual sayını və çətinliyi yazın, məs. "11-ci sinif Azərbaycan dili, buraxılış modeli, 20 test sualı". Təsvir nə qədər dəqiq olsa, suallar o qədər yaxşı olur.
3) Hazır PDF və ya test kağızının şəkli varsa: «Fayl əlavə et» (PDF və ya şəkil, hər fayl 30 MB-a qədər, ən çox 10 fayl). Mətni boş qoysanız, fayldakı bütün suallar çıxarılır.
4) «Sualları hazırla» — AI sualları bir-bir yazır, bir neçə dəqiqə çəkə bilər.
5) Sonra cavab açarı açılır, düzgün cavablar yaşıl işarələnir. Hər sualı yoxlayın; dəyişmək üçün sualın yanındakı «AI ilə düzəlt» və ya aşağıdakı «Redaktə et».
6) «Təsdiq et və davam et» → "İmtahanı nəşr et" səhifəsi: «İmtahanın adı», «Müddət (dəqiqə)», başlama və bitmə tarixi, bal (standart 100, keçid balı 50) → «Nəşr et».
- Sualları özünüz yazmaq üçün: «Əl ilə yazacağam». Hazır struktur üçün: «+ Hazır DİM strukturu seç» (Buraxılış 9 və 11-ci sinif, DQT, Blok, MSO, IELTS və s.).
- Redaktorda saxlamaq: «Yadda saxla» (telefonda «Sualları yadda saxla»), açılan pəncərədə ad və tarixləri yazıb «Dərc et».
- Sualsız imtahan yaranmır, şagird onu görmür.
- Sual tipləri: Tək seçim, Çox seçim, Qısa cavab, Həlli göstərilən sual, Uyğunlaşdırma, Boşluq doldurma, Cədvəl doldurma; bölmə kimi Mətn bloku və Dinləmə bloku (audio ilə). Sualı müəllimin özü qiymətləndirsin deyə: «Əl ilə yoxla».
- Hər suala şəkil əlavə etmək olar; yüklənmiş PDF-dən fiqur götürmək üçün «PDF-dən kəs».
- «Cavabları tap» (redaktorda «Alətlər» → «Cavablar»): AI boş qalan cavabları özü tapır.

İMTAHAN AYARLARI (imtahan kartında «Redaktə et» → «Ətraflı parametrlər»):
- «Variantları qarışdır»: hər şagird variantları fərqli sırada görür. "Düzgün cavabların hamısı A-dadır" deyən müəllimə bunu təklif edin. Həmçinin «Sualları qarışdır», «Çox seçimdə hissəvi bal».
- «Cəhd sayını məhdudlaşdır», «Şifrə ilə qoru», «Neqativ qiymətləndirmə», «Köçürməyə qarşı qoruma» (tam ekran, 3 pozuntudan sonra imtahan bitir), «Şagird həll şəkli göndərsin», «Video həll».
- «Nəticə görünüşü»: «Balı göstər», «Düzgün cavabları göstər» — «İmtahan bitdikdən sonra» və ya «Dərhal».
- Redaktorun «Alətlər» panelində: «Səhifədə sual sayı», «Yalnız irəli» (şagird əvvəlki suala qayıda bilməz).
- İmtahan kartında: «Gizlət» / «Göstər», «Nəticələr», «Sual əlavə et», «Redaktə et»; əlavə menyuda «Canlı izlə», «Nüsxə / B variantı», «İmtahanı sil» (30 gün «Zibil qutusu»nda qalır, «Geri qaytar» ilə bərpa olunur).

NƏTİCƏLƏR: «Şagird nəticələri» → imtahanı seçin → «Analitika» və «Şagirdlər»; «PDF ixrac et», «Excel ixrac et». Əl ilə yoxlanan suallar üçün şagirdin yanında «Yoxla» → «Doğru», «Yanlış» və ya «Qismən».

DİGƏR BÖLMƏLƏR:
- Tapşırıqlar: «Yeni tapşırıq» → başlıq, təlimat, son tarix → «Tapşırığı yarat». Şagird işini fayl kimi yükləyir, müəllim qiymətləndirir.
- Dərs cədvəli: «Yeni dərs» (sinif, vaxt, həftəlik təkrar). Dərsdə davamiyyət: «Gəldi», «Gecikdi», «Gəlmədi»; «QR göstər» ilə şagirdlər QR kodu oxudub özlərini qeyd edir.
- Dərs materialları: «Əlavə et» → «Sənəd yüklə» (PDF, Word, PowerPoint, şəkil) və ya «Video izah əlavə et» (video yalnız Premium paketdə).
- Dərs planları: «Yeni dərs planı» → mövzu, istəsəniz dərslik fəsli → AI plan hazırlayır (məqsədlər, meyarlar, mərhələlər, tapşırıqlar).
- Dərs studiyası: «Yeni material» → nə hazırlamaq istədiyinizi yazın → «Hazırla»; dəyişiklik üçün yazıb «Dəyiş». Fayl əlavə etmək olar, hazır materialı PDF və ya Word kimi yükləmək olur.
- Lövhə: «Yeni lövhə» — onlayn lövhə, avtomatik saxlanır, şagirdlərlə paylaşmaq olar.
- Canlı imtahan: hazırda gedən imtahanları canlı izləmək.
- Ödənişlər: şagirdlərin dərs haqqını qeyd etmək üçün dəftərdir (kim borcludur, bu ay nə yığılıb); real ödəniş qəbul etmir.
- Valideyn: valideyn «Valideyn» rolu ilə qeydiyyatdan keçir və uşağını kodla əlavə edir; kodu şagird öz hesabında «Valideynlərim» → «Kodu göstər»-də görür. Müəllim valideynləri «Şagirdlərim» → «Valideynlər»də görür. Valideynə WhatsApp bildirişləri sinfin ayarlarında «Valideyn bildirişləri»ndən açılır.
- Bağlantılar: öz WhatsApp nömrənizi qoşmaq (yalnız Premium).
- Telefon tətbiqi: İcmalda «Tətbiqi telefonuna qur» → «Tətbiqi qur». App Store və Google Play-də yoxdur, birbaşa saytdan qurulur. iPhone-da: Safari → «Paylaş» → «Ana ekrana əlavə et».

PAKET, KREDİT VƏ QİYMƏT (dəqiq bu rəqəmlər; "hər şey pulsuzdur" DEMƏ):
- Qeydiyyat pulsuzdur; şagirddən heç vaxt pul alınmır.
- Pulsuz: 1 sinif, 10 şagird, cəmi 3 imtahan (bütün müddət üçün, hər ay yenilənmir), eyni anda 2 aktiv tapşırıq, 50 MB yer, qeydiyyatda 60 AI krediti. Pulsuz kredit hər ay avtomatik artmır.
- Pro — 15 AZN/ay: 5 sinif, 40 şagird, limitsiz imtahan, 30 tapşırıq, 2 GB yer, aktivləşəndə 350 AI krediti.
- Premium — 20 AZN/ay: limitsiz sinif, şagird, imtahan və tapşırıq, 15 GB yer, aktivləşəndə 2000 AI krediti, öz WhatsApp nömrəsi, video materiallar.
- AI kreditləri: AI ilə imtahan yaratmaq və ya fayldan sual çıxarmaq 10; B variantı 10; bir sualı «AI ilə düzəlt» 2; «Cavabları tap» 4; dərs planı 6; Dərs studiyasında material yaratmaq 6, dəyişmək 2. Alınmayan əməliyyata görə kredit çıxılmır. Əl ilə yaratmaq, redaktə, paylaşmaq, qiymətləndirmək və bu söhbət pulsuzdur.
- Kredit almaq: «Planım» → +100 kredit 5 AZN, +300 kredit 12 AZN. Balans yuxarıda başlıqda görünür.
- Ödəniş: «Planım» → paketi seçin → kart nömrəsinə köçürmə (m10 və ya bank) → «Ödədim» → qəbzi WhatsApp ilə göndərin; komanda yoxlayıb aktivləşdirir.
- Paketin müddəti bitəndə heç nə silinmir: limitdən artıq şagirdlər gözləmə siyahısına keçir, 3-dən artıq imtahan bloklanır; paket yenilənəndə hamısı qayıdır.

ŞƏKİLLİ BƏLƏDÇİ: Müəllim "necə", "harada", "hansı düymə", "ilişdim" kimi yol soruşanda, qısa izahdan SONRA cavabın SONUNA aşağıdakılardan UYĞUN olanı olduğu kimi əlavə et. Tətbiq onu saytın REAL ekran şəkillərindən addım-addım bələdçiyə çevirir (telefonda telefon görünüşü, kompüterdə kompüter görünüşü, basılacaq yer işarələnmiş). İşarəni dəyişmə və izah etmə; ən çox BİR bələdçi əlavə et; uyğun mövzu yoxdursa, heç birini əlavə etmə:
[[guide:add-class]] — sinif yaratmaq
[[guide:add-exam]] — sinifdə imtahan əlavə etmək (sinfi açmaq → «İmtahan əlavə et» → mövzu → «Sualları hazırla»)
[[guide:ai-questions]] — AI ilə sual hazırlamaq, PDF və ya şəkil əlavə etmək
[[guide:publish]] — cavab açarını təsdiqləyib imtahanı nəşr etmək
[[guide:share-code]] — şagirdləri link və ya kodla dəvət etmək
[[guide:shuffle-options]] — variantları qarışdırmaq («Ətraflı parametrlər»)
[[guide:homework]] — ev tapşırığı vermək
[[guide:lesson-plan]] — dərs planı hazırlamaq
[[guide:studio]] — Dərs studiyasında material hazırlamaq
[[guide:plan-credits]] — paketi yüksəltmək və ya AI krediti almaq
[[guide:install-app]] — tətbiqi telefona qurmaq
[[guide:trash-restore]] — silinmiş imtahanı zibil qutusundan bərpa etmək

Cavabların qısa, dəqiq və köməkçi olsun.`;

// Anthropic requires alternating user/assistant, starting with `user`. Build the
// history from our messages: teacher = user, admin = assistant. Merge runs of the
// same role, drop any leading assistant turns (the welcome), keep the last ~20.
function buildHistory(messages, adminId) {
  const mapped = messages
    .map((m) => {
      const role = String(m.from) === String(adminId) ? "assistant" : "user";
      const content = (m.text && m.text.trim()) || (m.imageUrl ? "[şəkil göndərdi]" : "");
      return content ? { role, content } : null;
    })
    .filter(Boolean);

  // Drop leading assistant turns so it starts with a user message.
  let start = 0;
  while (start < mapped.length && mapped[start].role === "assistant") start += 1;
  const trimmed = mapped.slice(start).slice(-20);

  // Merge consecutive same-role turns.
  const merged = [];
  for (const turn of trimmed) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.content += `\n${turn.content}`;
    else merged.push({ ...turn });
  }
  return merged;
}

/*
 * The API route, used when the CLI cannot answer.
 *
 * It was gpt-4o-mini, and on the CLI route the chat ran on the "light" tier
 * (Claude Haiku). Both are small models, and in Azerbaijani it showed: replies
 * in October 2026 mixed in Turkish ("Maalesef", "seçənəyi", "zahmetli",
 * "bildirmişem") and broke sentences ("Bir dəqiqliksən, dəqiq anlayım ki sən nə
 * istədir"). The CLI now runs the standard tier (Sonnet) and this route
 * gpt-5.6-luna, which took the same three seconds as 4o-mini in a side-by-side
 * and wrote clean Azerbaijani. GPT-5 models take max_completion_tokens and no
 * temperature, so the request is shaped by model.
 */
async function replyWithOpenAI(history, system = SYSTEM_PROMPT) {
  const model = process.env.CHAT_SUPPORT_MODEL || "gpt-5.6-luna";
  const gpt5 = /^gpt-5/i.test(model);
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...history],
      ...(gpt5 ? { max_completion_tokens: 2000, reasoning_effort: "low" } : { max_tokens: 700, temperature: 0.4 }),
    }),
  });
  const data = await r.json();
  if (!r.ok || data?.error) {
    throw new Error(data?.error?.message || `OpenAI ${r.status}`);
  }
  return (data.choices?.[0]?.message?.content || "").trim();
}

// Anthropic fallback (used only if there is no OpenAI key).
async function replyWithAnthropic(history, system = SYSTEM_PROMPT) {
  const client = getClient();
  if (!client) return "";
  const model = process.env.CHAT_SUPPORT_MODEL_FALLBACK || "claude-haiku-4-5-20251001";
  const msg = await client.messages.create({
    model,
    max_tokens: 700,
    system,
    messages: history,
  });
  return (msg.content || []).map((b) => b.text).filter(Boolean).join("").trim();
}

// The message bubble renders plain text, so strip any markdown the model still
// emits (bold/italic markers, headings) and normalise list bullets to "• ".
function toPlainText(s) {
  return String(s || "")
    .replace(/\*\*(.*?)\*\*/g, "$1") // **bold**
    .replace(/__(.*?)__/g, "$1") // __bold__
    .replace(/`([^`]+)`/g, "$1") // `code`
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // # headings
    .replace(/^\s*[-*]\s+/gm, "• ") // - / * bullets → •
    .replace(/\*(?=\S)(.+?)\*/g, "$1") // *italic*
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/*
 * Turkish that reads as Azerbaijani to a model, and not to a teacher.
 *
 * Every entry is a word that is NOT Azerbaijani (with what Azerbaijani says), so
 * a hit is a slip, never a false alarm on a correct word: "işaret" is caught and
 * "işarə"/"işarət" are not, "sınav" is caught and "sınaq" is not. Matching is on
 * whole words with Unicode letters, because \b does not know that ş and ə are
 * letters.
 */
const TURKISH_SLIPS = [
  ["maalesef", "təəssüf ki"], ["malesef", "təəssüf ki"], ["şimdi", "indi"],
  ["seçenek", "seçim"], ["seçənək", "seçim"], ["seçənəyi", "seçimi"], ["zahmet", "zəhmət"], ["zahmetli", "çətin"],
  ["böyle", "belə"], ["böylə", "belə"], ["değil", "deyil"], ["için", "üçün"],
  ["işaret", "işarə"], ["işaretli", "işarələnmiş"], ["birkaç", "bir neçə"], ["bir kaç", "bir neçə"],
  ["teşekkür", "təşəkkür"], ["lütfen", "zəhmət olmasa"], ["evet", "bəli"], ["hayır", "xeyr"],
  ["nasıl", "necə"], ["olarak", "olaraq"], ["gerek", "lazım"], ["gerekli", "lazım"],
  ["tıkla", "toxun"], ["tıklayın", "toxunun"], ["sayfa", "səhifə"], ["sayfası", "səhifəsi"],
  ["kullan", "istifadə et"], ["kullanın", "istifadə edin"], ["düğme", "düymə"], ["düğmesi", "düyməsi"],
  ["öğrenci", "şagird"], ["öğrenciler", "şagirdlər"], ["ödev", "tapşırıq"], ["sınav", "imtahan"],
  ["bildirmişem", "bildirmişəm"], ["söyleyin", "deyin"],
];
const SLIP_RE = new RegExp(
  `(?<!\\p{L})(${TURKISH_SLIPS.map(([w]) => w.replace(/ /g, "\\s+")).sort((a, b) => b.length - a.length).join("|")})(?!\\p{L})`,
  "giu"
);
function turkishSlips(text) {
  const found = new Set();
  for (const m of String(text || "").matchAll(SLIP_RE)) found.add(m[1].toLowerCase().replace(/\s+/g, " "));
  return [...found];
}
function slipNote(slips) {
  const fix = slips.map((w) => {
    const hit = TURKISH_SLIPS.find(([t]) => t === w);
    return hit ? `«${w}» → «${hit[1]}»` : `«${w}»`;
  });
  return `DİQQƏT: əvvəlki cavabında türkcə sözlər var idi (${fix.join(", ")}). Cavabı yenidən, YALNIZ Azərbaycan ədəbi dilində yaz.`;
}

// Generate a support reply text, or null if unavailable / nothing to say. Logs
// failures so silent non-replies are visible, and which route answered, so a
// strange reply can be traced to the model that wrote it.
async function generateSupportReply(messages, adminId) {
  const history = buildHistory(messages, adminId);
  if (!history.length || history[history.length - 1].role !== "user") return null;

  /*
   * The support chat obeys the platform's API/CLI setting like everything else.
   * It sits in its own service and was missed entirely by the first version of
   * the switch, which is exactly why the choice now lives in one gateway rather
   * than being remembered at each call site.
   */
  const { runAi } = require("../helper/aiRuntime");
  const tier = process.env.CHAT_SUPPORT_CLI_TIER || "standard";
  const ask = (system) =>
    runAi({
      label: "support-chat",
      capability: "structured",
      cli: async (cliProvider) => {
        const { runCliChat } = require("../helper/cliAi");
        const out = await runCliChat({ provider: cliProvider, messages: history, system, tier });
        console.info(`[CHAT-AI] answered via ${cliProvider}-cli (${tier})`);
        return out.text;
      },
      api: () => replyOnApi(history, system),
    }).catch((e) => {
      console.error("[CHAT-AI] reply failed:", e?.message);
      return "";
    });

  /*
   * Which guides fit this question, found by keyword (helper/guideCatalog), so
   * the AI is told by name instead of having to recall the list; and when it
   * leaves a plain how-to question without one, the server adds the match.
   */
  const asked = history[history.length - 1].content;
  const fits = guides.matchGuides(asked);
  const system = fits.length
    ? `${SYSTEM_PROMPT}\n\nBU SUALA UYĞUN ŞƏKİLLİ BƏLƏDÇİ (açar sözlərlə tapılıb): ${fits.map((g) => `[[guide:${g.id}]] — ${g.title}`).join("; ")}. Müəllim yol soruşursa, uyğun olanı cavabın sonuna əlavə et.`
    : SYSTEM_PROMPT;

  let text = await ask(system);
  // One rewrite when the reply slipped into Turkish; the cleaner of the two wins.
  const slips = turkishSlips(text);
  if (text && slips.length) {
    console.warn(`[CHAT-AI] Turkish words in reply (${slips.join(", ")}); asking once more`);
    const again = await ask(`${system}\n\n${slipNote(slips)}`);
    if (again && turkishSlips(again).length < slips.length) text = again;
  }

  let clean = toPlainText(text);
  const auto = clean && !/\[\[guide:[a-z-]+\]\]/.test(clean) ? guides.autoGuide(asked) : null;
  if (auto) clean = `${clean}\n\n[[guide:${auto}]]`;
  return clean || null;
}

async function replyOnApi(history, system = SYSTEM_PROMPT) {
  let text = "";
  if (process.env.OPENAI_API_KEY) {
    try {
      text = await replyWithOpenAI(history, system);
      console.info(`[CHAT-AI] answered via api (${process.env.CHAT_SUPPORT_MODEL || "gpt-5.6-luna"})`);
    } catch (e) {
      console.error("[CHAT-AI] OpenAI reply failed:", e.message);
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          text = await replyWithAnthropic(history, system);
        } catch (e2) {
          console.error("[CHAT-AI] Anthropic fallback failed:", e2.message);
        }
      }
    }
  } else {
    text = await replyWithAnthropic(history, system);
  }
  return text;
}

module.exports = { isChatAiEnabled, generateSupportReply, SYSTEM_PROMPT, turkishSlips, buildHistory };
