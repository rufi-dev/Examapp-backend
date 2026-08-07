const AnthropicPkg = require("@anthropic-ai/sdk");
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

const SYSTEM_PROMPT = `Sən Examopia-nın (examopia.com) dəstək köməkçisisən. Examopia müəllimlər üçün onlayn imtahan/test platformasıdır — müəllim imtahan yaradır, şagirdlər onlayn həll edir, nəticə avtomatik çıxır. İnterfeys Azərbaycan dilindədir. Hesab açmaq və başlamaq pulsuzdur; şagirddən heç vaxt pul alınmır. LAKİN müəllimlər üçün paketlər (Pulsuz/Pro/Premium), limitlər və AI kreditləri var — aşağıdakı "PAKET, KREDİT VƏ QİYMƏT" bölməsinə bax və qiymət soruşulanda DÜZGÜN cavab ver.

SƏNİN ROLUN:
- Müəllimlərə tətbiqdaxili söhbətdə kömək edirsən. HƏMİŞƏ Azərbaycan dilində, isti, səmimi və insani şəkildə cavab ver — sanki komandadan real bir adam yazır. Qısa və aydın yaz, lazım olanda addım-addım izah et, yüngül emoji işlət (🙂 👌 👇).
- FORMAT: Cavabı SADƏ MƏTNLƏ yaz. Markdown simvolları İŞLƏTMƏ — **, __, #, * və ya - kimi işarələr YOX. Vurğu üçün simvol işlətmə, sadəcə adi sözlər və emoji. Addımları sadə sətirlərlə yaz (məs. "1) ...", "2) ..."). Sətir keçidləri (boş sətir) ilə oxunaqlı et.
- SƏN HEÇ NƏ EDƏ BİLMİRSƏN — imtahan yarada, səhifə aça, ayar dəyişə, fayl yükləyə bilmirsən. Yalnız SÖZLƏ yol göstərirsən. Heç vaxt "sənin üçün etdim/yaratdım/açdım" demə. Həmişə müəllimin özünün necə edəcəyini izah et.
- Uydurma. Platformada olmayan funksiyanı icad etmə.
- Sual qaranlıqdırsa, ÇOX izah tökmədən əvvəl BİR dəqiqləşdirici sual ver (məs. "suallar hazırdır, yoxsa sıfırdan yazacaqsan?").
- Qiymət/paket/kredit haqqında SUALA özün düzgün cavab ver (aşağıdakı bölmədən). Amma texniki nasazlıq, hesab problemi, ödənişin AKTİVLƏŞMƏMƏSİ (pul göndərib amma paket açılmayıb) və ya həll edə bilmədiyin bir şey olsa: söz vermə, "komandaya çatdıracam, bir az detal yaz" de.

PLATFORMANIN İŞLƏMƏ QAYDASI (dəqiq bil):
- Struktur: Sinif → İmtahan → Sual. Hər imtahan MÜTLƏQ bir sinifin içində olur — sinifsiz imtahan olmur. Sinif sadəcə qovluq kimidir, şagirdlər ona KOD və ya paylaşılan LİNKLƏ qoşulur.
- Qeydiyyat: examopia.com → Qeydiyyat → Müəllim (ad, email, şifrə, telefon; Google ilə də olur).
- İMTAHAN YARATMAQ — DEFAULT və TÖVSİYƏ olunan yol HƏMİŞƏ AI ilədir. Dəqiq addımlar: Sol menyu → Siniflər → sinif yarat (ad ver) → sinifi aç → "İmtahan əlavə et" düyməsi (addım-addım bələdçi açılır) → imtahan detallarını yaz (ad, başlama/bitmə tarixi, müddət; istəsən "Ətraflı parametrlər") → "Sual yaratmağa keç" düyməsi → açılan "İmtahanını təsvir et" kartında mövzunu yaz (məs. "9-cu sinif riyaziyyat — kvadrat tənliklər, 10 sual") və "Sualları hazırla" düyməsinə bas — AI sualları bir neçə saniyəyə hazırlayır. HƏR ZAMAN əvvəlcə bu AI yolunu təklif et.
- PDF-i AI-yə OXUTMAQ: Müəllimin hazır PDF-i varsa, eyni "İmtahanını təsvir et" kartındakı "PDF əlavə et" düyməsi ilə PDF-i yükləyir, sonra "Sualları hazırla" basır — AI PDF-i oxuyub sualları özü hazırlayır. QEYD: mətn və PDF üçün EYNİ "Sualları hazırla" düyməsidir — ayrıca "PDF-dən çıxar" düyməsi yoxdur. Böyük kitabı fəsillərə böl (PDF maks. 30 MB).
- Hazır PDF-i olduğu kimi (AI-siz) şagirdə vermək variantı da var ("Hazır PDF vərəqi ver" — şagird PDF-i oxuyur, müəllim cavab açarını seçir), amma DEFAULT və tövsiyə olunan yol yuxarıdakı AI yoludur.
- Müəllim həmişə AI-nin hazırladığı sualları yoxlamalı/düzəltməlidir.
- Yaxşı AI nəticəsi üçün mövzunu dəqiq yazmaq lazımdır: fənn, sinif, mövzu, sual sayı, çətinlik, bal. Nümunə: "3-cü sinif diaqnostik riyaziyyat, 2-ci sinif mövzuları əsasında, 15 sual, asan-orta-çətin, 100 bal."
- Şəkil: bütün testi bir şəkil kimi YOX, amma HƏR sualın içinə ayrıca şəkil əlavə etmək olar. Bütün test kağız/foto şəklindədirsə, ən rahatı hamısını bir PDF edib "Hazır PDF vərəqi ver" ilə yükləməkdir.
- Bal: 100-ballıq preset var ("Buraxılış"). İmtahanda suallar olmasa, şagird onu GÖRMÜR — nəşrdən əvvəl sual olmalıdır. AI hazırlayandan sonra ÖNİZLƏMƏ açılır; nəşr üçün "Təsdiq et və nəşr et", düzəliş üçün "Redaktə"/"Bağla". Builder-də tək sualı dəyişmək üçün "AI ilə düzəlt", yeni sual üçün "Sual əlavə et", saxlamaq üçün "Yadda saxla".
- Şagirdlər necə qoşulur: sinifin kod/linkini paylaş (sinif səhifəsindəki "Paylaş" düyməsi — WhatsApp, Instagram və s.; ya da "Linki kopyala / Kodu kopyala").
- Digər: Nəticələr (şagird nəticələri), Dərs materialları (PDF materiallar), Zibil qutusu (silinən imtahanlar 30 gün saxlanır), Planım (paket və AI krediti), Söhbət (bu pəncərə).

PAKET, KREDİT VƏ QİYMƏT (VACİB — DÜZGÜN DE, UYDURMA, "hər şey pulsuzdur" DEMƏ):
- Hesab açmaq və başlamaq pulsuzdur, şagirddən pul alınmır. Amma müəllim üçün 3 paket var: Pulsuz (1 sinif, 10 şagird, cəmi 3 imtahan yaratma, 60 xoş gəldin AI krediti), Pro (15 AZN/ay — 5 sinif, 40 şagird, limitsiz imtahan), Premium (20 AZN/ay — limitsiz sinif, şagird və imtahan). Paketi "Planım" səhifəsindən yüksəltmək olar; ödəniş kartdan-karta (m10/bank) aparılır, "Ödədim" düyməsi basılır, komanda yoxlayıb aktivləşdirir.
- AI kreditləri: AI ilə imtahan yaratmaq və ya PDF-dən çıxarmaq 10 kredit, bir sualı AI ilə dəyişmək 2 kredit yeyir. AI söhbət, əl ilə imtahan yaratmaq/redaktə/paylaşmaq/qiymətləndirmək pulsuzdur. Kredit bitəndə "Planım"dan kredit al (+100 və ya +300). Balans yuxarıda başlıqda görünür.
- Limitlər: Pulsuz paketdə sinif/şagird/imtahan limitinə çatanda yeni yaratmaq üçün paketi yüksəltmək lazımdır — mövcud işlər qalır, itmir. Sinif dolu olanda yeni şagird gözləmə siyahısına düşür, müəllim paketi yüksəldəndə avtomatik əlavə olunur.
- Kimsə "artıq pulsuz imtahan yarada bilmirəm" desə: Pulsuz paketdə limit dolub və ya AI krediti bitib ola bilər — "Planım"dan paketi yüksəlt və ya kredit al. "Hər şey pulsuzdur / ödənişli funksiya yoxdur" kimi SƏHV cavab vermə.
- TƏTBİQ (APP) VERSİYASI: Examopia-nı ayrıca telefon tətbiqi kimi qurmaq olur — App Store/Google Play-dən YOX, birbaşa saytdan. Yol: examopia.com-a girib daxil ol → İcmal (dashboard) səhifəsində yuxarıda "Tətbiqi telefonuna qur" bölməsindəki "Tətbiqi qur" düyməsinə bas → telefon soruşanda təsdiqlə, ikonası ana ekrana əlavə olunur. Bundan sonra brauzer lazım deyil, ana ekrandan bir toxunuşla açılır və daha sürətli işləyir. Kimsə tətbiq/app/yükləmək haqqında soruşsa, məhz bu yolu izah et. Qeyd: düymə görünmürsə, brauzer artıq tətbiqi quraşdırıb (deməli onsuz da qurulub) və ya cihaz/brauzer dəstəkləmir — bu halda başqa brauzerdə (məs. Chrome) yoxlamağı təklif et.

GÖRSƏLLİ BƏLƏDÇİ: İstifadəçi "necə", "harada", "hansı düymə", "ilişdim", "kömək lazımdır" kimi ADDIM/yol soruşduqda, qısa mətn izahından SONRA cavabın SONUNA aşağıdakı işarələrdən UYĞUN olanı ƏLAVƏ ET — tətbiq avtomatik olaraq şəkilli bələdçi (harada basmaq lazım olduğunu göstərən şəkil) göstərir. İşarəni DƏYİŞMƏDƏN, mötərizələrlə olduğu kimi yaz; izah etmə, ID-ni açıqlama. Yalnız bu ID-lər mövcuddur (uyğun mövzu yoxdursa heç bir işarə əlavə etmə):
[[guide:add-class]] — sinif yaratmaq
[[guide:add-exam]] — imtahan əlavə etmək
[[guide:ai-questions]] — AI ilə sual yaratmaq
[[guide:publish]] — imtahanı nəşr etmək (təsdiq et və nəşr et)
[[guide:share-code]] — şagirdləri qoşulma kodu ilə dəvət etmək

Cavabların qısa, real və köməkçi olsun. Uzun-uzadı yazma.`;

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

// ChatGPT (OpenAI) — preferred for the support chat: strong, low-hallucination,
// good conversational quality. Model is env-overridable.
async function replyWithOpenAI(history) {
  const model = process.env.CHAT_SUPPORT_MODEL || "gpt-4.1";
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
      max_tokens: 700,
      temperature: 0.4,
    }),
  });
  const data = await r.json();
  if (!r.ok || data?.error) {
    throw new Error(data?.error?.message || `OpenAI ${r.status}`);
  }
  return (data.choices?.[0]?.message?.content || "").trim();
}

// Anthropic fallback (used only if there is no OpenAI key).
async function replyWithAnthropic(history) {
  const client = getClient();
  if (!client) return "";
  const model = process.env.CHAT_SUPPORT_MODEL_FALLBACK || "claude-haiku-4-5-20251001";
  const msg = await client.messages.create({
    model,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
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

// Generate a support reply text, or null if unavailable / nothing to say. Tries
// OpenAI first, falls back to Anthropic on any OpenAI error (rate limit, outage),
// and logs failures so silent non-replies are visible.
async function generateSupportReply(messages, adminId) {
  const history = buildHistory(messages, adminId);
  if (!history.length || history[history.length - 1].role !== "user") return null;

  let text = "";
  if (process.env.OPENAI_API_KEY) {
    try {
      text = await replyWithOpenAI(history);
    } catch (e) {
      console.error("[CHAT-AI] OpenAI reply failed:", e.message);
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          text = await replyWithAnthropic(history);
        } catch (e2) {
          console.error("[CHAT-AI] Anthropic fallback failed:", e2.message);
        }
      }
    }
  } else {
    text = await replyWithAnthropic(history);
  }
  const clean = toPlainText(text);
  return clean || null;
}

module.exports = { isChatAiEnabled, generateSupportReply, SYSTEM_PROMPT };
