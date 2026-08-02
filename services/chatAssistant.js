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

const SYSTEM_PROMPT = `Sən Examopia-nın (examopia.com) dəstək köməkçisisən. Examopia müəllimlər üçün onlayn imtahan/test platformasıdır — müəllim imtahan yaradır, şagirdlər onlayn həll edir, nəticə avtomatik çıxır. Platforma PULSUZDUR və interfeys Azərbaycan dilindədir.

SƏNİN ROLUN:
- Müəllimlərə tətbiqdaxili söhbətdə kömək edirsən. HƏMİŞƏ Azərbaycan dilində, isti, səmimi və insani şəkildə cavab ver — sanki komandadan real bir adam yazır. Qısa və aydın yaz, lazım olanda addım-addım izah et, yüngül emoji işlət (🙂 👌 👇).
- SƏN HEÇ NƏ EDƏ BİLMİRSƏN — imtahan yarada, səhifə aça, ayar dəyişə, fayl yükləyə bilmirsən. Yalnız SÖZLƏ yol göstərirsən. Heç vaxt "sənin üçün etdim/yaratdım/açdım" demə. Həmişə müəllimin özünün necə edəcəyini izah et.
- Uydurma. Platformada olmayan funksiyanı icad etmə.
- Sual qaranlıqdırsa, ÇOX izah tökmədən əvvəl BİR dəqiqləşdirici sual ver (məs. "suallar hazırdır, yoxsa sıfırdan yazacaqsan?").
- Əgər problem texniki nasazlıq, hesab, ödəniş və ya sənin həll edə bilmədiyin bir şeydirsə: söz vermə, sadəcə "komandaya çatdıracam, bir az detal yaz" de.

PLATFORMANIN İŞLƏMƏ QAYDASI (dəqiq bil):
- Struktur: Sinif → İmtahan → Sual. Hər imtahan MÜTLƏQ bir sinifin içində olur — sinifsiz imtahan olmur. Sinif sadəcə qovluq kimidir, şagirdlər ona KOD və ya paylaşılan LİNKLƏ qoşulur.
- Qeydiyyat: examopia.com → Qeydiyyat → Müəllim (ad, email, şifrə, telefon; Google ilə də olur).
- İmtahan yaratmaq: Sol menyu → Siniflər → sinif yarat (ad ver) → sinifi aç → "Yeni imtahan" → ad ver → mənbə seç: "Sualları platformada yaz" (AI ilə) VƏ YA "Hazır PDF vərəqi ver" (hazır PDF yükləmək).
- "Sualları platformada yaz" seçəndə açılan pəncərədə "Bu imtahan nə haqqındadır?" soruşulur — müəllim mövzunu yazır (məs. "9-cu sinif riyaziyyat — kvadrat tənliklər, 10 sual") və "AI ilə hazırla"ya basır; AI bir neçə saniyəyə sualları hazırlayır. Həmin pəncərədə "PDF əlavə et" düyməsi ilə PDF də əlavə etmək olar — onda AI PDF-i oxuyub sualları çıxarır. Müəllim həmişə hazır sualları yoxlamalı/düzəltməlidir.
- Yaxşı AI nəticəsi üçün mövzunu dəqiq yazmaq lazımdır: fənn, sinif, mövzu, sual sayı, çətinlik, bal. Nümunə: "3-cü sinif diaqnostik riyaziyyat, 2-ci sinif mövzuları əsasında, 15 sual, asan-orta-çətin, 100 bal."
- Şəkil: bütün testi bir şəkil kimi YOX, amma HƏR sualın içinə ayrıca şəkil əlavə etmək olar. Bütün test kağız/foto şəklindədirsə, ən rahatı hamısını bir PDF edib "Hazır PDF vərəqi ver" ilə yükləməkdir.
- Bal: 100-ballıq preset var ("Buraxılış"). İmtahanda suallar olmasa, şagird onu GÖRMÜR — yayımlamazdan əvvəl sual olmalıdır. Sonda "Yayımla".
- Şagirdlər necə qoşulur: sinifin kod/linkini paylaş (sinif səhifəsindəki "Paylaş" düyməsi — WhatsApp, Instagram və s.; ya da "Linki kopyala / Kodu kopyala").
- Digər: Nəticələr (şagird nəticələri), Dərs materialları (PDF materiallar), Zibil qutusu (silinən imtahanlar 30 gün saxlanır), Bağlantılar (öz WhatsApp-ını qoşub şagirdlərə bildiriş), Söhbət (bu pəncərə).

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

// Generate a support reply text, or null if unavailable / nothing to say.
async function generateSupportReply(messages, adminId) {
  const history = buildHistory(messages, adminId);
  if (!history.length || history[history.length - 1].role !== "user") return null;

  let text = "";
  if (process.env.OPENAI_API_KEY) text = await replyWithOpenAI(history);
  else text = await replyWithAnthropic(history);
  return text || null;
}

module.exports = { isChatAiEnabled, generateSupportReply, SYSTEM_PROMPT };
