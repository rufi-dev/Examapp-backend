/*
 * The B variant of a finished paper.
 *
 * The brief is precise: A and B have the same structure, the same skills, the same
 * wording and difficulty, and differ ONLY in their numbers.
 *
 * Two approaches were possible. Asking for both variants inside the main generation
 * call would have meant threading a composed schema through six provider call sites
 * that all reference the shared EXTRACTION_SCHEMA — invasive, and it changes what
 * the model is asked for on every ordinary quiz. Deriving B from the FINISHED A is
 * both smaller and a stronger guarantee: B cannot drift from a paper it was handed
 * as input, whereas two halves of one answer can drift from each other.
 *
 * What it must never do is shift the numbers mechanically. Changing "4 sm" to
 * "6 sm" silently invalidates the answer key of every closed question computed from
 * it, so the model re-solves each question and returns the new key with it.
 */

// OpenAI strict mode: additionalProperties:false everywhere AND every property in
// `required`. "Not applicable" is an empty string or an empty array.
const VARIANT_ITEM = {
  type: "object",
  additionalProperties: false,
  properties: {
    // Position in the A paper, so a short or reordered answer cannot silently
    // pair question 3 with question 7's numbers.
    index: { type: "integer" },
    // The same question with different numbers; the sentence is otherwise identical.
    text: { type: "string" },
    // Closed questions: the four options again, RE-SOLVED for the new numbers.
    choices: { type: "array", items: { type: "string" } },
    // 0-based indexes into `choices`. Must be the key for the NEW numbers.
    correct: { type: "array", items: { type: "integer" } },
    // Open questions: the answer for the new numbers.
    openAnswer: { type: "string" },
  },
  required: ["index", "text", "choices", "correct", "openAnswer"],
};

const VARIANT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { questions: { type: "array", items: VARIANT_ITEM } },
  required: ["questions"],
};

const SYSTEM = `
Sən Azərbaycan kurikulumu üzrə summativ qiymətləndirmə hazırlayan metodistsən.
Sənə HAZIR imtahanın (A variantı) sualları verilir. Sənin işin — HƏMİN imtahanın
B VARİANTINI qaytarmaqdır.

DƏYİŞMƏZ QALIR:
- sualın tipi, süjeti, ifadə tərzi və cümlə quruluşu
- yoxlanılan bacarıq və çətinlik səviyyəsi
- sualların sayı və sırası

YALNIZ DƏYİŞİR:
- rəqəmlər, kəmiyyətlər, ölçülər, qiymətlər

MÜTLƏQ QAYDALAR:
- Hər sual üçün "index" A variantındakı mövqe ilə eyni olmalıdır.
- Rəqəmləri dəyişdikdən sonra sualı YENİDƏN HƏLL ET və düzgün cavabı ona görə yaz.
  A variantının cavabını köçürmək ƏN CİDDİ SƏHVDİR — bütün açar yanlış olur.
- Qapalı suallarda 4 variant saxlanılır, distraktorlar yeni rəqəmlərə uyğun olmalıdır.
- Mətn blokları (oxu mətnləri) və rəqəmi olmayan suallar OLDUĞU KİMİ qaytarılır.
- Rəqəmləri elə seç ki, cavab A variantındakından fərqli çıxsın.
- Sualın mənasını pozma: məsələn kvadratın tərəfi mənfi ola bilməz.
`.trim();

// The A paper, reduced to what the model needs to rewrite it. Answer keys are sent
// too: without them it cannot tell which option it must re-derive.
function buildVariantPrompt(items) {
  const lines = (items || []).map((q, i) => {
    const parts = [`#${i} [${q.type}] ${String(q.text || "").replace(/\s+/g, " ").trim()}`];
    if (Array.isArray(q.choices) && q.choices.length) {
      parts.push(
        "   variantlar: " +
          q.choices.map((c, ci) => `${ci}) ${typeof c === "string" ? c : c?.text || ""}`).join("  ")
      );
      if (Array.isArray(q.correct)) parts.push(`   düzgün: ${q.correct.join(",")}`);
    }
    if (q.answer || q.openAnswer) parts.push(`   cavab: ${q.answer || q.openAnswer}`);
    return parts.join("\n");
  });
  return [
    `A variantında ${(items || []).length} sual var. Hamısı üçün B variantını qaytar.`,
    "",
    ...lines,
  ].join("\n");
}

/*
 * Apply the model's answer onto the A paper.
 *
 * B inherits everything structural from A — type, reading blocks, manual-grade
 * flags, blanks — and takes only its text, choices and key from the variant. A
 * question the model skipped, or one whose text came back identical, is COPIED
 * unchanged rather than dropped: the two papers must have the same length and the
 * same numbering, and a B paper with a hole in it is worse than one where question
 * nine happens to match.
 */
function applyVariant(items, variants) {
  const byIndex = new Map(
    (Array.isArray(variants) ? variants : [])
      .filter((v) => Number.isInteger(v?.index))
      .map((v) => [v.index, v])
  );
  let varied = 0;

  const B = (items || []).map((q, i) => {
    const v = byIndex.get(i);
    const text = String(v?.text || "").trim();
    if (!v || !text || text === String(q.text || "").trim()) return { ...q };

    const hadChoices = Array.isArray(q.choices) && q.choices.length > 0;
    const newChoices = Array.isArray(v.choices) && v.choices.length > 0;
    const newKey = Array.isArray(v.correct) && v.correct.length > 0;

    /*
     * New options with NO key is the one combination that must never be applied.
     * The numbers have changed, so A's key points at whatever now sits in that
     * position — every student is marked against the wrong answer, and nothing in
     * the interface looks wrong. Keeping A's question verbatim is the safe
     * failure: a B paper where one question matches A costs a little copying;
     * a B paper with a wrong key costs the grades.
     */
    if (hadChoices && newChoices && !newKey) return { ...q };

    const out = { ...q, text };
    if (newChoices) {
      // Keep the A shape: choices are objects in the builder, strings from the model.
      const asObjects = hadChoices && typeof q.choices[0] === "object";
      out.choices = v.choices.map((c) => (asObjects ? { text: String(c), latex: "" } : String(c)));
      if (newKey) out.correct = v.correct;
    }
    const open = String(v.openAnswer || "").trim();
    if (open) {
      out.answer = open;
      if (q.openAnswer !== undefined) out.openAnswer = open;
    }
    varied += 1;
    return out;
  });

  return { B, varied };
}

module.exports = { VARIANT_SCHEMA, VARIANT_ITEM, SYSTEM, buildVariantPrompt, applyVariant };
