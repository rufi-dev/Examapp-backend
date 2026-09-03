/*
 * The B variant of a finished paper.
 *
 * A and B keep the same structure, the same skills, the same difficulty and the same
 * marks. What changes is the QUESTION: B is a new, similar task, not A with one
 * value swapped.
 *
 * The teacher's original brief said "differ only in the numerical data", and that
 * was written for a maths paper. Applied literally to a language exam it produced a
 * B variant where five of fifteen questions came back byte-identical to A — the
 * formal-address questions contain no numbers, so there was nothing the rule
 * permitted the model to change. Same skill, same difficulty, new question is what
 * the rule was always FOR; "only the numbers" was one subject's way of saying it.
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

ƏSAS PRİNSİP: hər sual üçün BƏNZƏR YENİ SUAL yaz. Sualı köçürüb bir sözü/rəqəmi
dəyişmək kifayət deyil — eyni bacarığı yoxlayan, eyni çətinlikdə YENİ sual olmalıdır.
Şagird A və B variantına baxıb birini digərindən köçürə bilməməlidir.

DƏYİŞMƏZ QALIR:
- sualın TİPİ (qapalı/açıq, variantların sayı)
- yoxlanılan BACARIQ və qrammatik/riyazi qayda
- ÇƏTİNLİK səviyyəsi və Blum səviyyəsi
- sualların sayı, sırası və balı

YENİ OLUR:
- sualın özü: konkret situasiya, nümunə, ad, kontekst, rəqəm və kəmiyyətlər
- cavab variantları və düzgün cavab

NÜMUNƏ (dil fənni):
  A: "Polis məmuruna müraciət edərkən hansı sualı vermək düzgündür?"  (rəsmi müraciət)
  B: "Vağzalda tanımadığın sərnişindən yol soruşarkən hansı sual düzgündür?"  (rəsmi müraciət)
  Yoxlanılan qayda eynidir — sual isə yenidir.

NÜMUNƏ (riyaziyyat):
  A: "Kubun tərəfi 4 sm-dir. Səth sahəsini tapın."
  B: "Kubun tərəfi 7 sm-dir. Səth sahəsini tapın."
  Rəqəmi olan suallarda rəqəmi dəyişmək kifayətdir — süjeti saxla.

MÜTLƏQ QAYDALAR:
- Hər sual üçün "index" A variantındakı mövqe ilə eyni olmalıdır.
- HEÇ BİR SUAL olduğu kimi qaytarılmamalıdır. Bütün suallar üçün cavab qaytar.
- Yeni sualı YENİDƏN HƏLL ET və düzgün cavabı ona görə yaz.
  A variantının cavabını köçürmək ƏN CİDDİ SƏHVDİR — bütün açar yanlış olur.
- Qapalı suallarda variantların sayı A ilə eyni qalır; distraktorlar yeni suala
  uyğun və inandırıcı olmalıdır.
- Mətn blokları (oxu mətnləri) OLDUĞU KİMİ qaytarılır.
- Açıq tapşırıqda A variantında "Qiymətləndirmə meyarı:" sətri varsa, B variantında
  da OLMALIDIR — yeni suala uyğun yazılmış halda. Onu buraxmaq olmaz.
- Sual mövzudan kənara çıxmamalıdır: eyni fəsil, eyni mövzu, eyni lüğət səviyyəsi.
- Sualın mənasını pozma: kvadratın tərəfi mənfi ola bilməz, situasiya real olmalıdır.
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
  /*
   * Why a question was left alone, counted separately, because the three reasons
   * need different things from the teacher and blurring them misleads.
   *
   *   identical — the model returned the same text. Almost always "there was
   *               nothing here to vary": the rule used to be "only the NUMBERS
   *               change", and a grammar question has no numbers. Reporting that
   *               as an answer-key problem sent the teacher looking for a bug
   *               that was not there.
   *   missing   — the model skipped the index entirely.
   *   noKey     — new options with no key. The dangerous one, and rare.
   */
  const skipped = { identical: 0, missing: 0, noKey: 0 };

  const B = (items || []).map((q, i) => {
    const v = byIndex.get(i);
    const text = String(v?.text || "").trim();
    if (!v || !text) {
      if (q.type !== "reading") skipped.missing += 1;
      return { ...q };
    }
    if (text === String(q.text || "").trim()) {
      if (q.type !== "reading") skipped.identical += 1;
      return { ...q };
    }

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
    if (hadChoices && newChoices && !newKey) {
      skipped.noKey += 1;
      return { ...q };
    }

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

  return { B, varied, skipped };
}

module.exports = { VARIANT_SCHEMA, VARIANT_ITEM, SYSTEM, buildVariantPrompt, applyVariant };
