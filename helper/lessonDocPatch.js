/*
 * Change part of a material without rewriting all of it.
 *
 * WHY THIS EXISTS. `write_material` takes the WHOLE document as its input, so
 * every edit re-emitted the entire thing — 31 KB of HTML to move one heading.
 * Output tokens bill at the output rate, five times input, and once prompt
 * caching landed the rewrite became the LARGEST line on a turn: 64,100 output
 * tokens, $1.60 of a $2.94 bill, most of it the model retyping text that was
 * already correct. It is also slow, and every retyped character is a character
 * that can come back subtly different from the one it replaced.
 *
 * WHY FIND/REPLACE AND NOT LINE NUMBERS OR IDS. The document is one HTML string
 * with no stable element ids (the block model that had them was retired when the
 * model started authoring its own markup). Line numbers would mean numbering the
 * document for the model and re-numbering after every edit, and they go stale
 * the moment anything above them changes. An exact quote of the text to replace
 * is self-describing: it either matches what is there or it does not, and "does
 * not" is a fact this file can state rather than a corruption it has to guess at.
 *
 * THE RULE THAT MAKES IT SAFE: every `find` must match EXACTLY ONCE in the
 * document as it stands now. Zero matches means the model quoted something that
 * is not there — usually because it retyped from memory instead of copying. Two
 * or more means the edit is ambiguous and applying it to the first hit would be
 * a coin toss. Both are refused and reported, and the report is what the model
 * needs to try again with more surrounding context. Nothing is applied until
 * every edit in the batch is known to be unambiguous — a half-applied batch is
 * the one outcome worse than a rejected one.
 */

const MAX_EDITS = 40;

const count = (haystack, needle) => {
  if (!needle) return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
};

// Enough of the quote to recognise in a message, without pasting a page of HTML
// into a reply the teacher may end up reading.
const snip = (s, n = 60) => {
  const one = String(s || "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/*
 * Apply a batch of replacements to `html`.
 *
 * Returns `{ html, applied, problems }`. `problems` is a list of sentences
 * addressed to the MODEL — they go back as a tool error so it can correct
 * itself, which is the whole mechanism. When `problems` is non-empty, `html` is
 * returned unchanged and `applied` is 0: all or nothing.
 */
function applyEdits(html, edits) {
  const source = typeof html === "string" ? html : "";
  const list = Array.isArray(edits) ? edits : [];
  const problems = [];

  if (!source) {
    return { html: source, applied: 0, problems: ["Sənəd boşdur — edit_material yerinə write_material ilə yaz."] };
  }
  if (!list.length) {
    return { html: source, applied: 0, problems: ["Heç bir dəyişiklik göndərilmədi: edits siyahısı boşdur."] };
  }
  if (list.length > MAX_EDITS) {
    return {
      html: source,
      applied: 0,
      problems: [
        `${list.length} dəyişiklik çoxdur (maksimum ${MAX_EDITS}). ` +
          "Bu qədər yer dəyişirsə, sənədi write_material ilə bütövlükdə yaz.",
      ],
    };
  }

  /*
   * Located against the ORIGINAL text, all of them, before anything is written.
   * Matching one edit against a string an earlier edit already altered is how a
   * batch becomes order-dependent, and an order-dependent batch is one the model
   * cannot reason about from what it was shown.
   */
  const spans = [];
  list.forEach((e, i) => {
    const find = e && typeof e.find === "string" ? e.find : "";
    const replace = e && typeof e.replace === "string" ? e.replace : "";
    const label = `#${i + 1}`;

    if (!find.trim()) {
      problems.push(`${label}: "find" boşdur — dəyişdirilməli mətni sənəddən olduğu kimi köçür.`);
      return;
    }
    const hits = count(source, find);
    if (hits === 0) {
      problems.push(
        `${label}: "${snip(find)}" sənəddə tapılmadı. Mətni YADDAŞDAN yazma — ` +
          "promptdaki HAZIRKI MATERİAL bölməsindən hərfi-hərfinə köçür (boşluqlar və teqlər daxil)."
      );
      return;
    }
    if (hits > 1) {
      problems.push(
        `${label}: "${snip(find)}" sənəddə ${hits} yerdə var — hansı olduğu bəlli deyil. ` +
          "Ətrafından daha çox mətn əlavə et ki, yalnız bir yerə uyğun gəlsin."
      );
      return;
    }
    const at = source.indexOf(find);
    spans.push({ at, end: at + find.length, replace, label });
  });

  if (problems.length) return { html: source, applied: 0, problems };

  // Two edits that cover the same characters cannot both be honoured, and
  // whichever lost would be lost silently.
  spans.sort((a, b) => a.at - b.at);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].at < spans[i - 1].end) {
      return {
        html: source,
        applied: 0,
        problems: [
          `${spans[i - 1].label} və ${spans[i].label} sənədin eyni hissəsini dəyişir. ` +
            "Onları bir dəyişiklikdə birləşdir.",
        ],
      };
    }
  }

  let out = "";
  let cursor = 0;
  for (const s of spans) {
    out += source.slice(cursor, s.at) + s.replace;
    cursor = s.end;
  }
  out += source.slice(cursor);

  return { html: out, applied: spans.length, problems: [] };
}

module.exports = { applyEdits, MAX_EDITS };
