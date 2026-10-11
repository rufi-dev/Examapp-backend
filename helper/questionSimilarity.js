/*
 * How much a rewritten question still reads like the one it replaced.
 *
 * "AI ilə düzəlt" announced "Sual yeniləndi" over a question that had barely
 * moved: asked "Eləcə fərqi sal soruş" (a phone typo for "fərqli sual" — a
 * different question), the model read "fərqi" as set DIFFERENCE, turned
 * "simmetrik fərq" into "A\B fərq" over the same sets, and only the options
 * changed. The teacher saw the same question and was told it was new.
 *
 * So the result is measured: word overlap of the two stems (Jaccard over word
 * tokens, LaTeX commands and punctuation dropped). 1 is the same words, 0 none.
 */
const tokens = (text) =>
  new Set(
    String(text || "")
      .toLowerCase()
      .replace(/\\[a-z]+/g, " ") // \frac, \setminus …
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter(Boolean)
  );

function stemSimilarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size && !B.size) return 1;
  let both = 0;
  for (const t of A) if (B.has(t)) both += 1;
  return both / (A.size + B.size - both);
}

/* Above this a rewrite still reads as the same question. */
const SIMILAR_AT = 0.6;

/*
 * Did the teacher ask for the QUESTION to change (not just an option or the
 * answer)? Their words, read loosely: "dəyiş", "başqa", "fərqli", "yeni",
 * "əvəz", in Azerbaijani or English. A request about the options, the answer,
 * a letter or the type is a targeted edit and may rightly keep the stem.
 */
const CHANGE_WORDS = /(dəyiş|deyis|başqa|basqa|fərqli|ferqli|yeni\b|yenisi|əvəz|evez|another|different|change|replace|new question)/i;
const TARGETED = /(variant|seçim|secim|cavab|bənd|bend|\btip\b|tipini|\b[a-e]\)|\b[a-e]\s*variant|option|answer)/i;
const asksForNewQuestion = (instruction) => {
  const s = String(instruction || "");
  return CHANGE_WORDS.test(s) && !TARGETED.test(s);
};

module.exports = { stemSimilarity, SIMILAR_AT, asksForNewQuestion };
