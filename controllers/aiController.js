const asyncHandler = require("express-async-handler");
const AnthropicPkg = require("@anthropic-ai/sdk");
// CJS interop: the constructor is the default export on recent builds.
const Anthropic = AnthropicPkg.default || AnthropicPkg;
const AiUsage = require("../models/aiUsageModel");
const { runAi } = require("../helper/aiRuntime");
const User = require("../models/userModel");
const Exam = require("../models/examModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");

/*
 * The exam this AI call belongs to, when there is one.
 *
 * File- and prompt-fed exams are generated BEFORE the exam row exists, so these
 * routes are mounted without an id as well. A missing or non-id value must leave
 * the field unset rather than throw a cast error and lose the cost row, which is
 * the billing record.
 */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const usageExamId = (req) => {
  const id = req?.params?.examId;
  return id && OBJECT_ID.test(String(id)) ? String(id) : undefined;
};

// Lazy client so the server still boots without the key (the feature just
// returns a clear error until ANTHROPIC_API_KEY is set in the env).
let _client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic();
  return _client;
}

// The shape we force Claude to return — it mirrors the structured-question
// builder, so the extracted output drops straight into it. Strict structured
// output requires every field present + additionalProperties:false, so the
// model fills empty strings/arrays where a field doesn't apply.
/*
 * The few teacher-facing strings the extraction paths share.
 *
 * Named rather than inlined because both the CLI and API routes use them and
 * they must not drift apart - and because editing Azerbaijani text inline in
 * this file has twice been mangled by a tooling round-trip.
 */
const EXTRACT_CLI_PROMPT =
  "Yüklənmiş əlavə(lər)i oxu. Sənəddə hazır suallar varsa, hamısını olduğu kimi çıxar. " +
  "Hazır sual yoxdursa (qrammatika qaydası, mövzu izahı, nəzəriyyə, lüğət, nümunələr) — " +
  "həmin materiala əsasən imtahan suallarını ÖZÜN qur və düzgün cavabları da yaz. " +
  "Sənədi ümumiyyətlə oxuya bilmirsənsə, sual uydurma: documentKind=\"unreadable\" qaytar. " +
  "Cavab yalnız JSON olmalıdır.";
const PDF_READING_MSG = "PDF oxunur…";
const CONTINUING_MSG = "ilə davam edilir…";
const EXTRACT_FAILED_MSG = "AI emalı alınmadı. Bir az sonra yenidən cəhd edin.";

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          // Cm = single-choice, Cs = multi-select, Co = open, Cma = matching,
          // reading = a passage block (not a question) shown before its questions.
          type: { type: "string", enum: ["Cm", "Cs", "Co", "Cd", "Cma", "reading"] },
          text: { type: "string" },
          // A heading for a reading passage (e.g. "Mətn 1"). For the mso-15 preset
          // this also carries the citation line the analytic table is built from —
          // see the presetHint below and helper/msoReport.js. "" otherwise.
          title: { type: "string" },
          latex: { type: "string" },
          choices: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { text: { type: "string" }, latex: { type: "string" } },
              required: ["text", "latex"],
            },
          },
          // Correct choice indices — ONLY when the PDF explicitly marks them;
          // otherwise an empty array (the teacher marks the answer).
          correct: { type: "array", items: { type: "integer" } },
          pairs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                left: { type: "string" },
                leftLatex: { type: "string" },
                right: { type: "string" },
                rightLatex: { type: "string" },
              },
              required: ["left", "leftLatex", "right", "rightLatex"],
            },
          },
          // True when the question relies on a figure/diagram the teacher must
          // upload manually (Claude can read a figure but can't hand back an image).
          hasFigure: { type: "boolean" },
          openAnswer: { type: "string" },
          // Open (Co): EVERY acceptable answer as its own array item (synonyms /
          // variants). Empty for non-open questions.
          openAnswers: { type: "array", items: { type: "string" } },
          // Manual grading: true ONLY for a genuinely open question the TEACHER
          // asked for whose answer can't be matched exactly (essay / "explain" /
          // "give examples"). The teacher grades it by hand. false for everything
          // else. Ignored unless manual grading is enabled server-side.
          manualGrade: { type: "boolean" },
        },
        required: [
          "type",
          "text",
          "title",
          "latex",
          "choices",
          "correct",
          "pairs",
          "hasFigure",
          "openAnswer",
          "openAnswers",
          "manualGrade",
        ],
      },
    },
  },
  required: ["questions"],
};

/*
 * The shape for work that starts from a DOCUMENT, as opposed to a prompt.
 *
 * Same questions, one field more. It is deliberately not folded into the schema
 * above, because that one is also what a generate-from-a-prompt turn must
 * satisfy, and asking a model that was handed no document at all to classify one
 * is a question with no honest answer.
 *
 * `documentKind` decides whether the questions below were COPIED or WRITTEN. A
 * teacher does not only upload finished papers - they upload the grammar page,
 * the topic summary, the worked examples, and expect an exam out of it. Refusing
 * those with "no questions found" was us enforcing a shape they never agreed to.
 *
 * The third value is the one that protects them. A model that cannot see the
 * page must say so, because the alternative is that it concludes the document
 * has no questions and helpfully invents twenty - handing back a fabricated
 * paper where the teacher's own test should have been. Unreadable is a failure
 * to pass on, never a licence to write.
 */
const DOCUMENT_SCHEMA = {
  ...EXTRACTION_SCHEMA,
  properties: {
    documentKind: { type: "string", enum: ["questions", "material", "unreadable"] },
    ...EXTRACTION_SCHEMA.properties,
  },
  /* Both listed: OpenAI's strict mode requires every property to be. */
  required: ["documentKind", "questions"],
};

const SYSTEM_PROMPT = `You turn a teacher's uploaded document into an exam, for a platform used for ANY school subject (maths, physics, chemistry, biology, history, geography, IT, literature, languages, …). The content is in Azerbaijani; keep all text in its original language.

FIRST decide what the document is, and set "documentKind" to say so. This decides everything that follows:

- "questions" — the document ALREADY contains exam questions (a test paper, a question bank, a past paper, an exercise set). COPY them. This is the normal case and the rest of this prompt is about doing it faithfully. Never rewrite, improve, reorder or invent anything; if the paper has 21 questions, return 21.

- "material" — the document is TEACHING CONTENT with no ready questions: grammar rules, a topic summary, a theory page, a vocabulary list, worked examples, a textbook section, notes. Then WRITE the exam yourself FROM THAT CONTENT. Only from that content: every question must be answerable by someone who has read this document, and must test what the document actually teaches — not the general subject. Follow the document's own examples and level. Produce a sensible paper (about 10–15 questions unless the teacher asked otherwise), mostly "Cm" with 4–5 plausible options, and because YOU wrote them you DO know the answers, so fill "correct" / "openAnswer" properly. Cover the document's main points rather than one paragraph of it.

- "unreadable" — you could NOT see the content: the Read tool errored, the file was refused for its size, the pages came back blank, or the scan is too poor to make out. Then set documentKind to "unreadable" and return an EMPTY questions array.
  THIS IS IMPORTANT AND NOT OPTIONAL: when you cannot read the document you must NOT fall back to writing questions about what you guess the topic might be, and you must NOT report it as "material". A teacher who uploaded their own test and received twenty invented questions instead has been given something worse than an error. Say you could not read it and stop.

A page whose questions are PICTURES — a scan, a photograph, a screenshot, an image-only PDF — is still "questions". Read the text out of the image and copy it. Only genuine illegibility is "unreadable".

Everything below describes how to write each question. It applies to BOTH copied and written questions, except where it says the PDF must state something (an answer key, a marked option) — those rules exist to stop you inventing answers for a paper you are copying, and they do not apply when documentKind is "material", where the answers are yours to give.

Output one item per question, in document order, using these types:
- "Cm": single correct answer among options.
- "Cs": multiple correct answers among options (only when the question clearly allows more than one).
- "Co": open / free-text answer (no options) — a SHORT written answer (a number, expression, word).
- "Cd": open question that REQUIRES A WRITTEN SOLUTION / working ("Həlli tələb olunan açıq sual"). Use "Cd" (NOT "Co") for questions in a "detailed answer" / "ətraflı yazın" / "həllini yazın" / "show your work" section — e.g. a DİM Buraxılış paper's final "…saylı tapşırıqları ətraflı yazın" block. Still open answers; fill openAnswer/openAnswers the same way as Co when the PDF states the answer.
- "Cma": matching (left column items paired with right column items).
- "reading": a reading-comprehension PASSAGE (a "mətn" / text the student must read), NOT a question. When the PDF contains a passage that several following questions refer to, emit it as ONE separate "reading" item placed IMMEDIATELY BEFORE those questions, then continue with the questions as normal types. Never inline the passage into each question and never duplicate it.

TYPE DECISION — check in this order, stop at the first match:
1. Does the question offer UPPERCASE A–E answer variants? → "Cm" (or "Cs" if it asks for several). Those A–E texts, and ONLY those, become "choices".
2. No A–E variants, but there is a numbered list (1., 2., 3. …) AND a separate lowercase-lettered list (a., b., c. …)? → "Cma". Build "pairs" (1→its letter). The lowercase a., b., c. items are the RIGHT-HAND column of a matching table — they are NEVER "choices". Emitting them as choices is WRONG.
3. No A–E variants, just one numbered list the student picks from? → "Cs", each numbered item a choice.
4. Nothing to pick from — the student writes the answer? → "Co" (or "Cd" in a detailed-solution section).

Rules:
- "text": the question STATEMENT ONLY — do NOT include the multiple-choice answer options (the A/B/C/D/E choices) here; those go in "choices". Write every mathematical formula INLINE, at the EXACT position it appears, as LaTeX wrapped in single dollar signs ($...$). Keep the math in the same order and place as the document — do NOT move formulas to the end. Examples:
  - "3500-ün $\\\\frac{5}{7}$ hissəsini tapın."
  - "$\\\\begin{cases}x^{2}y-xy^{2}=12\\\\\\\\xy=6\\\\end{cases}$ tənliklər sistemindən $x^{2}+y^{2}$-nın cəmini tapın."
  - "$\\\\sqrt{3}=a$ və $\\\\sqrt{5}=b$ olarsa, $\\\\sqrt{540}$ ədədini $a$ və $b$ ilə əvəz edin."
  Use $$...$$ only for a big standalone display formula. Write a literal dollar sign as \\\\$. IMPORTANT: use $...$ ONLY for genuine mathematical expressions/formulas — NEVER for plain numbers, numeric ranges (e.g. 20–30), measurements, percentages, years or dates; write those as ordinary text ("20–30 santimetr", not "$20-30$").
- FAITHFUL TEXT: reproduce the wording EXACTLY as printed — same words, same order, same punctuation. Keep every special symbol/marker exactly where it appears in the line: paragraph icons/bullets (▲ ■ ● ► ◆ ★ • ♦), Roman-numeral paragraph labels (I, II, III, IV …), and footnote/superscript numbers. Never drop, move, or normalize any of these.
- EMPHASIS / FORMATTING — mirror the PDF's character formatting exactly, using these HTML tags (preferred — emit them literally):
    • italic word/phrase → <i>word</i>  (e.g. <i>yaralı</i>)
    • bold word/phrase → <b>word</b>
    • UNDERLINED word/phrase → <u>word</u>  (Az-dili "altından xətt çəkilmiş söz" is ALWAYS underlined — wrap it)
    • superscript/footnote number → <sup>2</sup>  (e.g. parçalamağa<sup>2</sup>, yaralı<sup>1</sup>)
  Apply everywhere the PDF italicises/bolds/underlines or uses a superscript; leave normal text unmarked. Do NOT use $...$ for these.
- PRESERVE LINE BREAKS inside "text": keep the document's line structure for the question STATEMENT. Put each numbered statement item that is PART OF THE QUESTION (e.g. 1., 2., 3., … or I., II., III. sub-statements) on its own line using a real newline (\\n), and keep a blank line between distinct statement groups. NEVER collapse a multi-line question into a single line. Do NOT put the answer options (the A/B/C/D/E choices) in "text" at all — they belong ONLY in "choices".
- TABLES & DIAGRAMS → PHOTO (do NOT reproduce them): if a question contains a TABLE/grid (Doğrudur/Yanlışdır, Səbəb/Nəticə, Müddəa/Faktlar, "cədvəli tamamlayın", müqayisə cədvəli, any column grid), a Venn/Euler diagram, a chart/graph, or a syntactic-analysis scheme, set "hasFigure": true and DO NOT try to rebuild it as text or markdown — the teacher will add a photo of it from the PDF. Still extract the question's instruction text (and the A–E "choices" if the question has them). This keeps extraction simple and accurate.
- "title": ONLY for a "reading" item — its real heading/name if the passage has one (e.g. a story title like "Yeni ada"). Do NOT use a section label such as "Mətn (37–46-cı suallar üçün)" or "Mətn 1" as the title — those are labels, not titles; if there is only such a label and no real title, return "". For every normal (non-reading) question return "". For a "reading" item, put the FULL passage body in "text" and SEPARATE EACH PARAGRAPH WITH A BLANK LINE (two newlines \\n\\n) so paragraph spacing is preserved; use a single \\n only for a forced line break. Keep Roman-numeral paragraph labels (I, II, III …) and any ▲/● markers at the start of the lines where they appear. Do NOT write the HTML tag <br>. Set choices=[], correct=[], pairs=[], hasFigure=false, openAnswer="". Then the questions about that passage follow as their own items. If the passage is a FILL-IN-THE-BLANK / cloze exercise AND the correct words are visible (an answer key), write each blank inline in the text as [[correct word]] ([[word|alternative]] for several accepted answers) and do NOT create separate questions for those blanks; if the blanks are empty with no answer shown, leave them as normal blanks.
- "latex": ALWAYS return an empty string "". All math now lives inline inside the text fields, never in a separate field.
- "choices": for Cm/Cs, one object per option in the order shown (drop the A/B/C labels — they are implicit by position). Put each option's text in "text" with any math inline via $...$ (e.g. "$9ab$", "2500"). Set the choice "latex" to "". The options live ONLY here — never repeat them inside the question "text". For Co/Cma, use an empty array.
- OPTION CONTENT (important): each answer option's FULL text goes in its "choices" entry EXACTLY as printed — even if the option is long or spans several lines (e.g. a poem couplet, a whole sentence). NEVER replace an option with just its letter, and NEVER dump the list of options into the question "text". The question "text" holds only the instruction (+ any numbered items the question asks about).
- DIAGRAM / SCHEME OPTIONS: if the answer options THEMSELVES are pictures (e.g. the A–E syntactic-analysis line/arc schemes under a sentence), you cannot transcribe them — set "hasFigure": true and output each choice as JUST its letter ("A", "B", "C", "D", "E") so the teacher can add the picture of the options.
- "correct": indices (0-based) into "choices" of the correct option(s) — ONLY if the PDF itself marks/states the correct answer (e.g. an answer key, a highlighted option, or a stated solution). If the correct answer is NOT given in the PDF, return an EMPTY array. NEVER guess or solve the question to fill this — leave it empty for the teacher to mark.
- NEVER PACK A SET OR A PAIRING INTO AN OPEN ANSWER. If the correct answer can only be written as a list of item numbers ("2,5"), or as a number–letter sequence ("1b2d3c", "1-b, 2-d"), the question is NOT open (Co/Cd). Pick the structured type instead — the app marks those automatically, while an open answer forces the student to type the exact string:
  • A numbered list (1., 2., 3. …) that the student must pick from, with NO uppercase A–E answer variants → "Cs", NOT "Cm". Each numbered item becomes its own "choices" entry, IN ORDER, WITHOUT its number; "correct" holds the 0-based indexes (answer "2,5" over five items → correct: [1, 4]). Do not leave the items in "text". Use "Cs" even when you cannot tell how many are correct: the paper only shows A–E variants when exactly one answer is wanted, so a bare numbered list means "select every one that applies". "Cm" REQUIRES uppercase A–E variants to choose between.
  • A numbered list PLUS a separate lettered list (a., b., c. …) with NO uppercase A–E answer variants → "Cma", one "pairs" entry per number (answer "1b2d3c" → pairs 1→b, 2→d, 3→c).
  Reserve Co/Cd for answers a student genuinely writes out: a number, a word, a formula.
- "manualGrade": ALWAYS false when extracting from a PDF (the teacher decides manual grading, not extraction).
- MATCHING WITH ANSWER VARIANTS → CLOSED, NOT Cma: a question may say "Uyğunluğu müəyyən(ləşdir)in" yet PROVIDE lettered answer variants A–E that each encode a pairing (e.g. "A) 1 – a, b; 2 – d"  "B) 1 – a, c; 2 – b, e"). That is a CLOSED single-choice question: use type "Cm". Put the items being matched (the 1., 2., … list AND the a., b., c., … list) in "text", and put each A–E variant as a "choices" entry with its exact text (e.g. "1 – a, b; 2 – d"). Do NOT output "Cma"/pairs for these. Use "Cma" ONLY when the question gives NO answer variants and the student must build the pairing themselves. (The lowercase a., b., c. items belong in "text" — they are content to match, NOT the answer choices; only the uppercase A–E variants are choices.)
- "pairs" — READ THIS CAREFULLY, IT IS THE MOST COMMONLY GOT WRONG. The app renders a Cma question as a BARE number→letter grid:
      1 →  A B C D E
      2 →  A B C D E
  The student sees ONLY the numbers and the letters. NOTHING you put in "pairs" is ever displayed — it is the answer key, not content. So the ITEMS THEMSELVES (the numbered list AND the lettered list, with their full wording) MUST appear in "text", or the question is unanswerable.
  • "text" = the instruction + the numbered list (each item on its own line) + the lettered list (each item on its own line).
  • "pairs" = the mapping only: "left" is just the number ("1"), "right" is just its correct letter(s) ("b", or "a, d" when one number matches several). A letter may repeat across lefts.
  • NEVER empty for a "Cma" question — emit one object per LEFT item even when the paper does not reveal the correct letters (leave "right" as "" then), so the teacher gets a grid with the right number of rows to fill in, in order.
  CORRECT:   text: "Uyğunluğu müəyyən edin.\\n1. [p]\\n2. [m]\\n\\na) dodaq\\nb) burun"   pairs: [{"left":"1","right":"a"},{"left":"2","right":"b"}]
  WRONG:     text: "Uyğunluğu müəyyən edin."                                        pairs: [{"left":"1. [p]","right":"a"}]
  • LETTERS: use only the English-alphabet letters a, b, c, d, e … as labels. Never use the Azerbaijani-only letters ç, ə, ğ, ı, ö, ş, ü as a matching label — the app does not recognise them. If the PDF itself labels the list with them, relabel in order (a, b, c, d, e) in BOTH the text and "right".
  Put math inline in "left"/"right" via $...$ and set "leftLatex"/"rightLatex" to "". Empty array for non-matching questions.
- "openAnswer" / "openAnswers": for open (Co) questions, the correct answer(s). Write them as PLAIN TEXT exactly as a student types on a keyboard — NO LaTeX, NO $...$ dollar signs, NO markup. Examples: write x+2 (NOT $x + 2$), 3/4 (NOT $\\\\frac{3}{4}$), x=5, 25. Put the primary answer in "openAnswer" AND list EVERY acceptable form in the "openAnswers" ARRAY, each variant as its own element — include the spaced and unspaced forms (x+2 AND x + 2), reordered equivalents (2+x), and common synonyms/notations students would realistically type. A typed answer is marked correct if it matches ANY item (compared case- and space-insensitively), so cover the realistic variations. Fill these ONLY if the PDF states the answer; otherwise openAnswer="" and openAnswers=[]. For non-open questions: openAnswer="" and openAnswers=[].
- "hasFigure": true whenever the question relies on anything that is not plain text — a geometric figure, graph/chart, image, ANY table/grid, a Venn/Euler diagram, or a syntactic-analysis scheme. Set hasFigure=true and still extract the instruction text (+ A–E choices if any); the teacher crops the figure/table from the PDF.
- NEVER repeat the answer options inside "text". The A/B/C/D/E choices a student selects belong ONLY in "choices" (for Cm/Cs) — never in "text". "text" holds the question statement plus any items that are PART of it (e.g. the numbered 1-5 statements being asked about, or the a-e items of a matching list), but NOT the final lettered answer choices.
- AZƏRBAYCAN DİLİ BURAXILIŞ context (when the PDF is an Az-dili graduation paper): questions are almost always single-choice (Cm) or open/written (Co) — genuine pair-building matching (Cma) is RARE, so prefer Cm/Co. The paper is typically a grammar section (~10 single-choice) plus 1–2 reading passages with their questions. (9th grade ≈ 26 closed + 4 open; 11th grade ≈ 20 closed + 10 open — but always follow what the PDF actually shows; never invent or pad to hit a count.)
- SCOPE / FILTER: the teacher's extra instructions (provided separately) take priority over plain document order. If they ask for only a specific subject, section, page range, or question range, extract ONLY what they ask for and SKIP everything else in the PDF — even content that appears in between. If they give no such limit, extract every question in document order as usual.

Transcribe faithfully. Do not invent questions, options, or answers. If the PDF is a question bank with no answer key, every "correct" array is empty and that is correct.`;

// Optional per-extraction instructions the teacher typed. We bound the length so
// a runaway paste can't blow the context, and frame them as ADDITIONS that must
// not override the schema/output contract above.
const clampInstr = (s) => String(s ?? "").trim().slice(0, 4000);
const instructionBlock = (instr) =>
  instr
    ? `\n\n--- MÜƏLLİMİN ƏLAVƏ TƏLİMATLARI (bunlara əməl et, amma yuxarıdakı JSON sxemini və qaydaları POZMA) ---\n${instr}`
    : "";

// Subject/structure hint derived from the exam's preset, so the AI knows what
// kind of exam it's reading (e.g. an English DİM exam with Listening/Grammar/
// Reading). Prepended to the teacher's instructions before extraction.
const presetHint = (presetId) => {
  const p = String(presetId || "");
  if (p === "custom") {
    return "STRUCTURE: This is a CUSTOM exam with NO fixed blueprint — do NOT assume any preset structure or question count. Detect the ACTUAL number of questions from the document, and for EACH question decide its type from the content: if it has answer choices (A–E / A–D) it is a CLOSED multiple-choice question; if it asks for a written answer with no choices it is an OPEN question; a match-the-columns task is a MATCHING question. Extract any reading passages as reading blocks. Preserve the document's original question count, order, and language.";
  }
  if (p === "en-buraxilis-9" || p === "en-buraxilis-11") {
    return "SUBJECT: This is an ENGLISH (İngilis dili) DİM buraxılış exam — the question and answer text is in ENGLISH, so KEEP it in English (do not translate to Azerbaijani). Expected structure: a LISTENING (Dinləmə) section (~6 questions; the audio is uploaded separately, so just extract each question's text + its A–E choices), a GRAMMAR & VOCABULARY section (~16 multiple-choice), and a READING (Oxu) section — one passage extracted as a reading block, followed by closed (A–E) questions and OPEN-ENDED questions (extract those as open questions, not multiple-choice).";
  }
  if (p === "az-buraxilis-9" || p === "az-buraxilis-11") {
    return "SUBJECT: This is an Azerbaijani-language (Azərbaycan dili) DİM buraxılış exam: language-rule multiple-choice questions, then reading passages (Mətn) each extracted as a reading block and followed by closed and OPEN (written) questions.";
  }
  if (p === "buraxilis-9") {
    return "SUBJECT: This is a MATH (Riyaziyyat) 9th-grade DİM buraxılış exam. Structure: a CLOSED (Qapalı) multiple-choice section, then an OPEN (Açıq) short-answer section, then a final 'solution-required' section (labelled '…saylı tapşırıqları ətraflı yazın' / həlli tələb olunan). Type the solution-required questions as \"Cd\" (NOT \"Co\"); the short open ones as \"Co\"; the multiple-choice ones as \"Cm\".";
  }
  /*
   * MSO — summativ qiymətləndirmə. The teacher's brief, as rules the model can
   * follow. Structure and points are NOT stated here: the preset owns those and
   * the server scores from the preset id, so a model that miscounts cannot change
   * the paper. What the prompt owns is everything a schema cannot express — where
   * the tasks must come from, how the citation is written, the Bloom order, and
   * the report the teacher needs afterwards.
   */
  if (p === "mso-15") {
    return [
      "SUBJECT: Bu, Azərbaycan kurikulumu üzrə SUMMATİV QİYMƏTLƏNDİRMƏDİR (MSO). Bütün mətn Azərbaycan dilində.",
      "STRUKTUR: DƏQİQ 15 tapşırıq. 1–11 qapalı tip (4 cavab variantı, YALNIZ 1 düzgün cavab). 12–15 açıq tip (qısa cavab). Bu struktur dəyişdirilə bilməz.",
      "MƏNBƏ: Yüklənmiş dərslikdən başqa heç bir yerdən tapşırıq götürmə. Dərslikdən kənar tapşırıq uydurmaq QADAĞANDIR. Uyğun çalışma tapmasan, dərslikdəki ən yaxın çalışmanı götür — uydurma.",
      "İSTİNAD VƏ ANALİTİKA: Hər tapşırığın \"title\" sahəsini DƏQİQ bu formatda doldur (sıra və ayırıcı · dəyişməz):",
      "(Dərslik, səh. 124, № 8) · Blum: Tətbiq · Alt-standart: 3.4.1 · Meyar: Sahəni hesablayır · Yoxlayır: Sahə düsturunun bilinməsi",
      "Bu sətir sonda hazırlanan ANALİTİK CƏDVƏLİN mənbəyidir — beş hissənin hamısı olmalıdır. Səhifə nömrəsi kitabın ÜZƏRİNDƏ çap olunmuş nömrədir, faylın neçənci səhifəsi olduğu YOX. Səhifəni göstərməyi buraxmaq olmaz.",
      "BLUM SIRASI (pozulmamalıdır): 1–3 Yadda saxlama · 4–6 Anlama · 7–11 Tətbiq · 12–13 Təhlil · 14 Qiymətləndirmə · 15 Yaratma. Səviyyələri qarışdırmaq olmaz.",
      "AÇIQ TAPŞIRIQLAR (12–15): tam düzgün cavabı yaz və qiymətləndirmə meyarını — hansı addıma neçə bal verildiyini — tapşırıq mətninin sonunda \"Qiymətləndirmə meyarı:\" kimi göstər.",
      "KEYFİYYƏT: Distraktorlar inandırıcı olsun — tipik şagird səhvlərindən yaransın, təsadüfi ədəd olmasın. Çətinlik tədricən artsın. Ardıcıl tapşırıqlarda eyni hərfli düzgün cavab təkrarlanmasın. İki düzgün cavabı olan tapşırıq QADAĞANDIR. İfadələr aydın, artıq mətnsiz, məlumatlar realistik.",
    ].join("\n");
  }

  if (p === "ielts-reading") {
    return "SUBJECT: This is an IELTS Academic Reading exam — write EVERYTHING in English. Each reading passage must be a LONG, multi-paragraph academic text (~700–900 words) on a real academic topic, extracted as a reading block. For each passage use a realistic IELTS question mix — choose the appropriate ones from: True/False/Not Given, Yes/No/Not Given, Matching Headings to paragraphs, Matching Information to paragraphs, Multiple Choice, Sentence Completion, Summary Completion, Short Answer (no more than three words). For sentence/summary completion, write the sentence(s) as a reading block with the gaps inline as [[answer]] (do NOT make separate questions for those gaps). Each statement is a SEPARATE question. Aim for a realistic full IELTS test — roughly 13 questions per passage. You decide the topics and the exact question mix.";
  }
  return "";
};

// Combine the preset subject hint with the teacher's typed instructions.
const buildInstructions = (presetId, typed) =>
  clampInstr([presetHint(presetId), clampInstr(typed)].filter(Boolean).join("\n\n"));

/*
 * Claude pricing, USD per 1M tokens, per model.
 *
 * This was a single Opus 4.8 constant, which was true while Opus 4.8 was the
 * only Claude model we called. Studio now offers several tiers spanning a 10x
 * spread — Fable 5.1 costs twice Opus and ten times Haiku — so one rate would
 * mis-state the bill by a multiple, and always in the same direction: the most
 * expensive model would report the cheapest-looking number.
 *
 * Cache write is 1.25x base input at the 5-minute TTL and 2x at the one-hour
 * TTL; cache read is 0.1x base input; output includes thinking tokens. Those
 * ratios hold across models, so only the two base rates are listed.
 */
const CLAUDE_PRICE_PER_MTOK = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

// The model the exam-extraction paths have always used, and the rate an unknown
// id falls back to. An unrecognised model is priced rather than free: a $0 row
// reads as "this cost nothing", which is the one thing it certainly did not.
const COST_MODEL_DEFAULT = "claude-opus-4-8";

const claudePriceFor = (model) => {
  const base =
    CLAUDE_PRICE_PER_MTOK[model] ||
    // A dated snapshot ("claude-haiku-4-5-20251001") prices as its family.
    CLAUDE_PRICE_PER_MTOK[String(model || "").replace(/-\d{8}$/, "")] ||
    CLAUDE_PRICE_PER_MTOK[COST_MODEL_DEFAULT];
  return { ...base, cacheWrite: base.input * 1.25, cacheWrite1h: base.input * 2, cacheRead: base.input * 0.1 };
};

const PRICE_PER_MTOK = claudePriceFor(COST_MODEL_DEFAULT);

// Turn an Anthropic usage object into a token breakdown + USD cost for THIS call,
// so the teacher can see (and tally) what each extraction cost.
function computeCost(u, model = COST_MODEL_DEFAULT, opts = {}) {
  if (!u) return null;
  const price = claudePriceFor(model);
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;

  /*
   * A one-hour cache write costs 2x base input, not 1.25x.
   *
   * Lesson Studio caches its system block with ttl:"1h" (see LONG_LIVED in
   * aiDocAdapters) and every one of its turns was billed here at the five-minute
   * rate — a 60% understatement on the cache-write portion of every Studio call.
   * The direction matters: the admin cost page exists to answer "are we charging
   * enough", and it was answering with a number that flattered us.
   *
   * The API reports the split per TTL when it knows it; `cacheTtl` covers the
   * older flat shape, where the caller knows what it asked for and the usage
   * object does not say.
   */
  const split = u.cache_creation || null;
  const write5 = split ? (split.ephemeral_5m_input_tokens || 0) : 0;
  const write1h = split ? (split.ephemeral_1h_input_tokens || 0) : 0;
  const flat = u.cache_creation_input_tokens || 0;
  const known = write5 + write1h;
  const rest = Math.max(0, flat - known);
  const restIs1h = opts.cacheTtl === "1h";
  const cacheWrite = known + rest;
  const writeCost =
    write5 * price.cacheWrite +
    write1h * price.cacheWrite1h +
    rest * (restIs1h ? price.cacheWrite1h : price.cacheWrite);

  const usd =
    (input * price.input +
      output * price.output +
      writeCost +
      cacheRead * price.cacheRead) /
    1e6;
  return {
    model,
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    totalTokens: input + output + cacheWrite + cacheRead,
    usd: Number(usd.toFixed(4)),
  };
}

// ---- Gemini (Google) provider: a cheaper alternative to Claude. Same prompt,
// same output shape. Uses the REST generateContent API (no extra dependency). ---
// Primary = the cheap, fast flash model (thinking off — see geminiGenConfig). It
// does the job for normal extraction; set GEMINI_MODEL=gemini-2.5-pro to switch
// to the higher-fidelity Pro model for dense papers.
// gemini-2.5-flash — verified to accept the PDF + json-schema extraction config
// (gemini-flash-latest returns 400 "invalid argument" on it and wastes a call).
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
// Stable fallback tried if the primary model stays overloaded (503). NOTE: keep
// this a model the key actually has quota for AND that accepts the extraction
// config — the Pro tier does; gemini-2.0-flash is retired / limit:0.
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-pro";
// Document generation (lesson plans / MSO) — its own knob so tuning it can never
// disturb question extraction, which shares neither prompt nor schema.
const GEMINI_DOC_MODEL = process.env.GEMINI_DOC_MODEL || GEMINI_MODEL;
// Approx USD per 1M tokens, by model tier (env-overridable). 2.5 Pro is pricier
// than Flash but far more faithful; both are well under Claude Opus (5 / 25).
const GEMINI_PRICES = {
  pro: { input: Number(process.env.GEMINI_PRICE_IN || 1.25), output: Number(process.env.GEMINI_PRICE_OUT || 10) },
  flash: { input: 0.3, output: 2.5 },
};
const geminiPriceFor = (model) =>
  String(model || "").includes("pro") ? GEMINI_PRICES.pro : GEMINI_PRICES.flash;
// Per-model generation config: Pro thinks (dynamic budget) with a big output
// budget so the JSON still has room; Flash keeps thinking OFF (it otherwise
// burned the budget and returned empty) with the standard budget.
const geminiGenConfig = (model) => {
  const isPro = String(model || "").includes("pro");
  return {
    responseMimeType: "application/json",
    responseSchema: GEMINI_SCHEMA,
    maxOutputTokens: isPro ? 64000 : 32000,
    temperature: 0.2,
    thinkingConfig: { thinkingBudget: isPro ? -1 : 0 },
  };
};

// Gemini responseSchema (OpenAPI subset: UPPERCASE types, no additionalProperties)
// mirroring EXTRACTION_SCHEMA so the output drops into the same builder shape.
const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["Cm", "Cs", "Co", "Cd", "Cma", "reading"] },
          text: { type: "STRING" },
          title: { type: "STRING" },
          latex: { type: "STRING" },
          choices: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { text: { type: "STRING" }, latex: { type: "STRING" } },
              required: ["text", "latex"],
            },
          },
          correct: { type: "ARRAY", items: { type: "INTEGER" } },
          pairs: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                left: { type: "STRING" },
                leftLatex: { type: "STRING" },
                right: { type: "STRING" },
                rightLatex: { type: "STRING" },
              },
              required: ["left", "leftLatex", "right", "rightLatex"],
            },
          },
          hasFigure: { type: "BOOLEAN" },
          openAnswer: { type: "STRING" },
          openAnswers: { type: "ARRAY", items: { type: "STRING" } },
          manualGrade: { type: "BOOLEAN" },
        },
        required: [
          "type", "text", "title", "latex", "choices", "correct",
          "pairs", "hasFigure", "openAnswer", "openAnswers", "manualGrade",
        ],
      },
    },
  },
  required: ["questions"],
};

function computeGeminiCost(u, model) {
  const input = u?.promptTokenCount || 0;
  const output = u?.candidatesTokenCount || 0;
  const price = geminiPriceFor(model);
  const usd = (input * price.input + output * price.output) / 1e6;
  return {
    model,
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: u?.totalTokenCount || input + output,
    usd: Number(usd.toFixed(4)),
  };
}

// ---- provider content-part builders (pure; exported for tests) ----
// The ONE place each provider's file/image block shape is written. They were
// inlined at five call sites, which is how extractWithClaude drifted into
// emitting an EMPTY text block for a single file (see the note there).
const claudeContentParts = (parts) =>
  parts.map((p) =>
    p.isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.data } }
      : { type: "image", source: { type: "base64", media_type: p.mime, data: p.data } }
  );

const openaiContentParts = (parts, prefix = "file") =>
  parts.map((p, i) =>
    p.isPdf
      ? { type: "input_file", filename: `${prefix}-${i + 1}.pdf`, file_data: `data:application/pdf;base64,${p.data}` }
      : { type: "input_image", image_url: `data:${p.mime};base64,${p.data}` }
  );

const geminiContentParts = (parts) =>
  parts.map((p) => ({ inline_data: { mime_type: p.mime, data: p.data } }));

// Build an error carrying an HTTP status + Azerbaijani user message.
function aiError(status, userMessage, fallback = false) {
  const e = new Error(userMessage);
  e.aiStatus = status;
  e.userMessage = userMessage;
  e.aiFallback = fallback; // true → caller may retry with another provider (Claude)
  return e;
}

async function extractWithClaude(parts, instructions = "") {
  const client = getClient();
  if (!client) throw aiError(503, "AI funksiyası konfiqurasiya olunmayıb (ANTHROPIC_API_KEY)");
  const instr = clampInstr(instructions);
  // SYSTEM_PROMPT stays cached; the teacher's varying instructions go in a
  // separate, uncached block so the cache hit on the big prompt is preserved.
  const system = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
  if (instr) system.push({ type: "text", text: instructionBlock(instr) });
  let message;
  try {
    message = await client.messages
      .stream({
        model: "claude-opus-4-8",
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        system,
        output_config: {
          effort: "high",
          format: { type: "json_schema", schema: DOCUMENT_SCHEMA },
        },
        messages: [
          {
            role: "user",
            // The multi-file hint is only ADDED when there is more than one file.
            // It used to be a block whose text was "" for a single file, which the
            // Anthropic API rejects — so single-file non-streaming Claude
            // extraction 400'd and was masked by the provider fallback chain.
            content: [
              ...claudeContentParts(parts),
              ...(parts.length > 1
                ? [{ type: "text", text: `Bu ${parts.length} faylın HAMISINDAKI sualları çıxar.` }]
                : []),
              { type: "text", text: "Bu PDF-dəki bütün sualları çıxar." },
            ],
          },
        ],
      })
      .finalMessage();
  } catch (e) {
    console.error("AI extract (claude) error:", e?.status, e?.message);
    throw aiError(502, "AI emalı alınmadı. Bir az sonra yenidən cəhd edin.");
  }
  if (message.stop_reason === "refusal") throw aiError(422, "AI bu sənədi emal edə bilmədi.");
  const textBlock = message.content.find((b) => b.type === "text");
  let parsed;
  try {
    parsed = JSON.parse(textBlock?.text || "{}");
  } catch {
    throw aiError(502, "AI cavabı oxunmadı. Yenidən cəhd edin.");
  }
  return {
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    usage: message.usage,
    cost: computeCost(message.usage),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Should a failed provider hand off to the NEXT one? Yes for AVAILABILITY
// problems — rate-limit, 5xx, network, or out-of-credit/billing/quota — so one
// engine being down or unpaid never dead-ends the teacher. A plain bad request
// (e.g. an unreadable file) is not retried across providers. Reads the status
// off aiError OR a raw provider error, and sniffs the message for billing text.
const isRetriable = (e) => {
  if (e?.aiFallback) return true;
  const status = Number(e?.status || e?.statusCode || e?.aiStatus || e?.response?.status || 0);
  const msg = String(e?.message || e?.error?.message || "").toLowerCase();
  return (
    status === 429 ||
    status >= 500 ||
    status === 0 ||
    /credit balance|billing|quota|insufficient|payment|overloaded|rate limit|balance is too low/.test(msg)
  );
};


// Extract from a PDF with OpenAI. Same signature and return shape as the Gemini
// and Claude extractors, so the callers do not care which one ran.
//
// Uses the Responses API rather than chat completions: that is the endpoint
// that takes a PDF as an input_file, so the whole paper goes over in one call
// exactly as it does for the other two providers.
async function extractWithOpenAI(parts, instructions = "", modelId) {
  if (!process.env.OPENAI_API_KEY)
    throw aiError(503, "AI funksiyası konfiqurasiya olunmayıb (OPENAI_API_KEY)", true);
  const model = modelId || DEFAULT_AI_MODEL;
  const instr = clampInstr(instructions);

  let r;
  try {
    r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: SYSTEM_PROMPT + instructionBlock(instr) }],
          },
          {
            role: "user",
            content: [
              ...openaiContentParts(parts, "exam"),
              { type: "input_text", text: "Yüklənmiş fayl(lar)dakı bütün sualları çıxar." },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "exam_questions",
            strict: true,
            schema: DOCUMENT_SCHEMA,
          },
        },
        max_output_tokens: 32000,
      }),
    });
  } catch {
    throw aiError(502, "AI PDF-i emal edə bilmədi. Yenidən cəhd et.", true);
  }

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error("OpenAI extract failed:", r.status, body.slice(0, 400));
    // Quota/5xx are worth handing to another provider; a 400 is our own bug.
    throw aiError(
      502,
      "AI PDF-i emal edə bilmədi. Yenidən cəhd et.",
      r.status === 429 || r.status >= 500
    );
  }

  const data = await r.json();
  // output_text is the convenience field; fall back to walking the content
  // blocks if the SDK-less shape differs.
  const text =
    data.output_text ||
    (data.output || [])
      .flatMap((o) => o.content || [])
      .map((c) => c.text)
      .filter(Boolean)
      .join("") ||
    "";
  let parsed;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    console.error("OpenAI extract: unparseable output, head =", text.slice(0, 200));
    throw aiError(502, "AI cavabı oxunmadı. Yenidən cəhd et.", true);
  }

  const usage = {
    prompt_tokens: data?.usage?.input_tokens || 0,
    completion_tokens: data?.usage?.output_tokens || 0,
    total_tokens: data?.usage?.total_tokens || 0,
    prompt_tokens_details: {
      cached_tokens: data?.usage?.input_tokens_details?.cached_tokens || 0,
    },
  };
  return {
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    // Carried through, not dropped: it is the difference between "your file did
    // not open" and "your file had nothing to build from".
    documentKind: parsed.documentKind || "questions",
    usage,
    cost: computeOpenAIGenCost(usage, data?.model, model),
  };
}

async function extractWithGemini(parts, instructions = "") {
  if (!process.env.GEMINI_API_KEY) throw aiError(503, "AI funksiyası konfiqurasiya olunmayıb (GEMINI_API_KEY)");
  const instr = clampInstr(instructions);
  const buildBody = (model) =>
    JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT + instructionBlock(instr) }] },
      contents: [
        {
          role: "user",
          parts: [
            ...geminiContentParts(parts),
            { text: "Bu PDF-dəki bütün sualları çıxar." },
          ],
        },
      ],
      generationConfig: geminiGenConfig(model),
    });

  // Try the primary model with backoff; if it stays overloaded (429/500/503),
  // fall back to a stable model. "high demand" 503s are transient.
  const models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL].filter(
    (m, i, a) => m && a.indexOf(m) === i
  );
  let lastStatus = 0;
  for (const model of models) {
    // Keep this short: the teacher is waiting and a long retry storm overruns the
    // reverse-proxy timeout (surfaces as a 502). 2 quick tries per model, then
    // we bail and let the caller fall back to Claude.
    for (let attempt = 0; attempt < 2; attempt++) {
      let r, data;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-goog-api-key": process.env.GEMINI_API_KEY,
            },
            body: buildBody(model),
          }
        );
        data = await r.json();
      } catch (e) {
        console.error("AI extract (gemini) request failed:", e?.message);
        await sleep(1200 * (attempt + 1));
        continue;
      }
      if (r.ok && !data?.error) {
        const text =
          (data.candidates?.[0]?.content?.parts || [])
            .map((p) => p.text)
            .filter(Boolean)
            .join("") || "{}";
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw aiError(502, "AI cavabı oxunmadı. Yenidən cəhd edin.");
        }
        return {
          questions: Array.isArray(parsed.questions) ? parsed.questions : [],
          usage: data.usageMetadata,
          cost: computeGeminiCost(data.usageMetadata, model),
        };
      }
      lastStatus = Number(data?.error?.code || r.status);
      console.error("AI extract (gemini) error:", model, lastStatus, data?.error?.message);
      // Only overload / rate-limit / server errors are worth retrying.
      if (![429, 500, 503].includes(lastStatus)) break; // non-retryable → next model
      await sleep(700 * (attempt + 1));
    }
  }
  // Busy / quota / server errors are fallback-eligible: the caller can retry the
  // whole extraction on Claude so the teacher still gets their questions.
  const fallbackable = [429, 500, 502, 503].includes(lastStatus) || lastStatus === 0;
  throw aiError(
    503,
    lastStatus === 503
      ? "Gemini hazırda məşğuldur. Claude ilə yenidən cəhd edilir…"
      : lastStatus === 429
      ? "Gemini kvotası bitib. Claude ilə yenidən cəhd edilir…"
      : "Gemini emalı alınmadı. Claude ilə yenidən cəhd edilir…",
    fallbackable
  );
}

// Extract structured questions from an uploaded PDF. Teacher-only. Provider is
// "claude" (default, higher quality, expensive) or "gemini" (cheaper). Returns
// { questions: [...] } in the builder's shape for review (never auto-saved).

// ── tidy the model's text before anyone sees it ──────────────────────────
// Two failures show up often enough to be worth fixing here rather than hoping
// a prompt prevents them:
//
//   1. A whole sentence wrapped in $...$. The builder hands anything in dollars
//      to KaTeX, which cannot typeset prose, so the question renders as a red
//      error line under the field.
//   2. Literal \" inside the text, from the model escaping quotes a second time
//      after JSON already escaped them.
//
// Both are unambiguous, so they are repaired on every path — PDF extraction and
// prompt generation alike — instead of being left for the teacher to clean up.
const unescapeQuotes = (t) => String(t ?? "").replace(/\\+(["'])/g, "$1");

// Real maths carries a command, a super/subscript, a brace group, or an
// operator between numbers. Prose carries none of those, so a $...$ wrapper
// around prose can be removed without touching a genuine formula.
const looksLikeMath = (s) => /[\\^_{}]|\d\s*[+\-*/=]\s*\d/.test(s);

// Count `$` DELIMITER tokens, ignoring `\$` literals and treating `$$` as one
// token — so an odd result means a dropped closing `$` (unbalanced).
const dollarDelims = (s) => {
  const str = String(s ?? "");
  let n = 0;
  for (let i = 0; i < str.length; i += 1) {
    if (str[i] === "\\" && str[i + 1] === "$") { i += 1; continue; }
    if (str[i] === "$") { if (str[i + 1] === "$") i += 1; n += 1; }
  }
  return n;
};

// A field "leaks" LaTeX when it has an unbalanced `$` OR carries a bare LaTeX
// command / sub-superscript OUTSIDE any `$...$` span — i.e. the student would see
// raw source. Used by the audit so the agentic verify loop re-asks the model to
// wrap/balance the math (and so `verified` is only true when the math is clean).
const hasMathLeak = (s) => {
  const str = String(s ?? "");
  if (!str) return false;
  if (dollarDelims(str) % 2 !== 0) return true; // dropped closing $
  const outside = str
    .replace(/\\\$/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$]*\$/g, "");
  return /\\[a-zA-Z]{2,}|[_^]\{|[A-Za-z0-9][_^][A-Za-z0-9]/.test(outside);
};

const stripProseMath = (t) => {
  const s = String(t ?? "").trim();
  if (!(s.startsWith("$") && s.endsWith("$") && s.length > 2)) return t;
  const inner = s.slice(1, -1);
  // Several segments (e.g. "$a$ and $b$") — not a single wrapper, leave it.
  if (inner.includes("$")) return t;
  if (looksLikeMath(inner)) return t;
  return inner.trim();
};

// Models under-escape LaTeX in their JSON — they emit `\times` (a JSON tab escape
// + "imes") instead of `\\times`, so JSON.parse turns `\times` into a TAB + "imes"
// and the maths renders as "imes" / "rac" / etc. A CONTROL char (tab, form-feed,
// backspace, carriage-return) directly followed by a LETTER was the start of a
// backslash-command, so restore the backslash. Newline is left alone (a real line
// break). A correctly-escaped `\times` parses to a real backslash — no control
// char — so it is never touched, and this cannot double-corrupt.
const fixMathEscapes = (t) =>
  String(t)
    .replace(/\t(?=[a-zA-Z])/g, "\\t")
    .replace(/\f(?=[a-zA-Z])/g, "\\f")
    .replace(/\x08(?=[a-zA-Z])/g, "\\b")
    .replace(/\r(?=[a-zA-Z])/g, "\\r");
// Azerbaijani Ə/ə is frequently mis-emitted/OCR'd as Greek theta (Θ/θ) — the
// "ƏBOB → θBOB", "hərf → hθrf" bug. Inside a WORD (adjacent to a letter) a theta is
// virtually always a mangled Ə, never a maths angle, so restore it; a standalone
// angle "θ" is left alone, and math spans ($...$, where \theta is legitimate) are
// never touched. Case follows the neighbouring letter (ƏBOB stays upper-case).
const fixAzTheta = (s) => {
  const str = String(s);
  if (str.indexOf("θ") === -1 && str.indexOf("Θ") === -1) return str;
  const fixProse = (p) =>
    p
      .replace(/(\p{L})[θΘ]/gu, (_m, a) => a + (/\p{Lu}/u.test(a) ? "Ə" : "ə"))
      .replace(/[θΘ](\p{L})/gu, (_m, b) => (/\p{Lu}/u.test(b) ? "Ə" : "ə") + b);
  const re = /\\\$|\$\$[\s\S]*?\$\$|\$[^$]*\$/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) out += fixProse(str.slice(last, m.index));
    out += m[0];
    last = re.lastIndex;
  }
  if (last < str.length) out += fixProse(str.slice(last));
  return out;
};

const cleanText = (t) => (typeof t === "string" ? fixAzTheta(stripProseMath(fixMathEscapes(unescapeQuotes(t)))) : t);

// A matching question is rendered as a bare number→letter grid: nothing in
// `pairs` reaches the student. When a model writes the items INTO pairs.left
// instead of into the question text — the single most common way it gets this
// type wrong — that content would vanish and leave an unanswerable question.
//
// This does not invent anything: it moves wording the model already produced
// into the one place that is displayed, and only when the text does not
// already contain it. The lettered legend cannot be recovered this way (the
// model has to write it), which is why the prompts spell that out.
// The letter grid only understands a–z. A model reaching for the Azerbaijani
// alphabet ("ç") produces a label the app silently drops, which quietly changes
// the question from a letter grid into an unusable 1:1 drag list.
//
// Relabelling is safe because the letters are positional: the question's own
// lettered list defines the order, so the nth entry becomes the nth Latin
// letter in both the text and the answer key. Nothing is invented or dropped.
const LETTER_LINE = /^([^\s).\]]{1,2})\s*[).\]]\s+/;
const normaliseMatchingLetters = (q) => {
  if (q?.type !== "Cma" || !Array.isArray(q.pairs) || !q.pairs.length) return q;
  const rights = q.pairs.flatMap((p) =>
    String(p?.right ?? "")
      .split(/[,;/|\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  // Every label already a plain latin letter? Nothing to do.
  if (!rights.length || rights.every((r) => /^[a-z]$/.test(r))) return q;

  const text = String(q.text || "");
  const labels = [];
  for (const line of text.split("\n")) {
    const m = line.match(LETTER_LINE);
    const label = m && m[1].toLowerCase();
    // Numbers are the LEFT column's labels — only letter labels count here.
    if (label && !/^\d+$/.test(label) && !labels.includes(label)) labels.push(label);
  }
  if (labels.length < 2) return q; // no lettered list to take an order from

  const latin = (i) => String.fromCharCode(97 + i);
  const remap = new Map(labels.map((l, i) => [l, latin(i)]));
  // Untouched if the list is already a, b, c… in order.
  if (labels.every((l, i) => l === latin(i))) return q;

  const newText = text
    .split("\n")
    .map((line) => {
      const m = line.match(LETTER_LINE);
      const label = m && m[1].toLowerCase();
      if (!label || !remap.has(label)) return line;
      return line.replace(m[1], remap.get(label));
    })
    .join("\n");

  return {
    ...q,
    text: newText,
    pairs: q.pairs.map((p) => ({
      ...p,
      right: String(p?.right ?? "")
        .split(/[,;/|\s]+/)
        .map((s) => {
          const k = s.trim().toLowerCase();
          return remap.get(k) ?? s.trim();
        })
        .filter(Boolean)
        .join(", "),
    })),
  };
};

const foldMatchingItemsIntoText = (q) => {
  if (q?.type !== "Cma" || !Array.isArray(q.pairs) || q.pairs.length < 2) return q;
  // "1", "2." and "" carry nothing; anything else is content that would be lost.
  const contentful = q.pairs.filter((p) => {
    const left = String(p?.left ?? "").trim();
    return left && !/^\d+[.)]?$/.test(left);
  });
  if (contentful.length !== q.pairs.length) return q;

  const text = String(q.text || "");
  const stripped = (s) => s.replace(/^\s*\d+\s*[.)]\s*/, "").trim();
  // Already listed in the question? Then the model did it right; leave it alone.
  // Tested on the LIST STRUCTURE, not on the item wording — a matched item is
  // often a single character ("p", "m") that occurs all over the text anyway.
  const numberedLines = (text.match(/^\s*\d+\s*[.)]/gm) || []).length;
  if (numberedLines >= q.pairs.length) return q;

  const list = q.pairs.map((p, i) => `${i + 1}. ${stripped(String(p?.left ?? ""))}`).join("\n");
  return {
    ...q,
    text: `${text.trim()}\n${list}`.trim(),
    pairs: q.pairs.map((p, i) => ({ ...p, left: String(i + 1) })),
  };
};

const cleanQuestions = (list) =>
  (Array.isArray(list) ? list : []).map((q0) => {
    const q = normaliseMatchingLetters(foldMatchingItemsIntoText(q0));
    if (!q || typeof q !== "object") return q;
    const out = { ...q };
    // Manual grading: honor the flag ONLY when enabled, and only for open
    // questions. Flag OFF ⇒ strip the field so behavior is exactly as before (the
    // audit still flags an unmatchable open question for conversion to Cm).
    if (require("../config/featureFlags").flags.MANUAL_GRADING_ENABLED) {
      out.manualGrade = !!q.manualGrade && (q.type === "Co" || q.type === "Cd");
      if (!out.manualGrade) delete out.manualGrade;
    } else {
      delete out.manualGrade;
    }
    out.text = cleanText(q.text);
    if (typeof q.latex === "string") out.latex = fixMathEscapes(q.latex);
    if (typeof q.title === "string") out.title = cleanText(q.title);
    if (typeof q.openAnswer === "string") out.openAnswer = cleanText(q.openAnswer);
    if (Array.isArray(q.openAnswers)) out.openAnswers = q.openAnswers.map(cleanText);
    if (Array.isArray(q.choices)) {
      out.choices = q.choices.map((c) =>
        c && typeof c === "object"
          ? { ...c, text: cleanText(c.text), ...(typeof c.latex === "string" ? { latex: fixMathEscapes(c.latex) } : {}) }
          : cleanText(c)
      );
    }
    if (Array.isArray(q.pairs)) {
      out.pairs = q.pairs.map((pr) =>
        pr && typeof pr === "object"
          ? { ...pr, left: cleanText(pr.left), right: cleanText(pr.right) }
          : pr
      );
    }
    return out;
  });

// Deterministic quality audit. Catches the structural mistakes a model makes —
// a correct-index pointing past the last choice, a single-choice with two
// answers, duplicated or blank options, an open question with no answer — the
// bugs that turn into a mis-marked or unanswerable question. Pure and
// exported, so it can be tested and so the reviewer below can be told exactly
// what to fix.
//
// `requireAnswers` is on for GENERATED exams (the AI's job is to mark the
// answer) and off for EXTRACTION (the teacher marks it).
const AUDIT_STRIP = (s) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const AUDIT_TYPES = new Set(["Cm", "Cs", "Co", "Cd", "Cma", "reading"]);
const splitMatchLabels = (s) =>
  String(s ?? "")
    .split(/[,;/|\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

const letterLabelsInText = (text) => {
  const labels = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(LETTER_LINE);
    const label = m && String(m[1] || "").toLowerCase();
    if (label && !/^\d+$/.test(label) && /^[a-z]$/.test(label) && !labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels;
};

// An open (Co) question is only fair when its answer has ONE exact spelling a
// student can type: a number, a single term, a date, a short formula. When the
// prompt invites an explanation, a list, or "give an example" — or the marked
// answer is itself a multi-word phrase — no student can reproduce the exact
// string, so the auto-grader marks even a perfect answer wrong. We flag those so
// the verify pass rewrites them as single-choice (Cm). A concrete number/short
// formula answer is NEVER flagged, so maths short-answers stay untouched.
const OPEN_ENDED_QUESTION_RE =
  /(sadala|izah\s*ed|şərh\s*ed|müzakirə|təsvir\s*ed|fikrin|fikriniz|fikrincə|nümunə|misal|qısaca\s*yaz|qısa\s*qeyd|öz\s*sözlər|nələr|nə\s*nəticə|nəticələrə\s*səbəb|nə\s*baş\s*ver|necə\s*dəyiş|nə\s*olur|necədir|barədə\s*yaz|haqqında\s*yaz|niyə|nə\s*üçün|qeyd\s*ed|bilirsiniz|bilirsən)/;

const answerIsConcrete = (s) => {
  const t = String(s ?? "").trim();
  if (!t) return false;
  // Pure number / date / range / percentage (2500, 3,14, 1941-1945, 50%).
  if (/^[-+]?\d[\d.,:/%\s-]*$/.test(t)) return true;
  // A short mathematical expression / formula (has an operator or LaTeX, few words).
  if (/[=+\-*/^()$∙×÷√πθ]|\\[a-z]/i.test(t) && t.split(/\s+/).filter(Boolean).length <= 6) return true;
  return false;
};
const wordCount = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean).length;

const looksOpenEndedOpen = (q) => {
  if (q?.type !== "Co") return false;
  // A question the teacher grades by hand is MEANT to be open — not a defect.
  if (q.manualGrade) return false;
  const text = AUDIT_STRIP(q.text);
  if (!text) return false;
  const answers = [...(Array.isArray(q.openAnswers) ? q.openAnswers : []), q.openAnswer]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  // Every accepted answer is a concrete value or a short (≤2-word) term → fair.
  if (answers.length && answers.every((a) => answerIsConcrete(a) || wordCount(a) <= 2)) return false;
  const subjective = OPEN_ENDED_QUESTION_RE.test(text);
  // The marked answer is a multi-word phrase / joined concepts — unmatchable.
  const phraseAnswer = answers.some(
    (a) =>
      !answerIsConcrete(a) &&
      (wordCount(a) >= 4 || (/(^|\s)(və|həmçinin|eləcə)(\s|$)|[,;]/.test(a.toLowerCase()) && wordCount(a) >= 3))
  );
  return subjective || phraseAnswer;
};

const auditQuestions = (list, { requireAnswers = false } = {}) => {
  const issues = [];
  const add = (index, code, detail) => issues.push({ index, code, detail });

  (Array.isArray(list) ? list : []).forEach((q, i) => {
    if (!q || typeof q !== "object") return add(i, "not-an-object", "");
    if (!AUDIT_TYPES.has(q.type)) return add(i, "unknown-type", `type=${q.type || ""}`);
    if (q.type === "reading") {
      if (!AUDIT_STRIP(q.text)) add(i, "empty-passage", "reading block has no text");
      return;
    }
    const hasFig = !!q.hasFigure;
    if (!AUDIT_STRIP(q.text) && !hasFig) add(i, "empty-text", "question has no text");
    // Math delimiters: flag unwrapped/unbalanced LaTeX so the verify loop re-asks
    // the model to fix it (raw LaTeX must never reach a student).
    if (hasMathLeak(q.text)) add(i, "math-delimiters", "unwrapped or unbalanced LaTeX in text — wrap every formula in $...$");

    const choices = Array.isArray(q.choices) ? q.choices : [];
    const texts = choices.map((c) => AUDIT_STRIP(c?.text ?? c));
    choices.forEach((c, ci) => {
      if (hasMathLeak(c?.text)) add(i, "math-delimiters", `unwrapped or unbalanced LaTeX in choice ${ci + 1} — wrap every formula in $...$`);
    });
    const correct = Array.isArray(q.correct) ? q.correct : [];

    if (q.type === "Cm" || q.type === "Cs") {
      if (choices.length < 2) add(i, "too-few-choices", `only ${choices.length} choice(s)`);
      texts.forEach((t, ci) => {
        if (!t && !hasFig) add(i, "empty-choice", `choice ${ci + 1} is blank`);
      });
      const seen = new Map();
      texts.forEach((t, ci) => {
        if (!t) return;
        if (seen.has(t)) add(i, "duplicate-choice", `choices ${seen.get(t) + 1} and ${ci + 1} are identical`);
        else seen.set(t, ci);
      });
      correct.forEach((idx) => {
        if (!Number.isInteger(idx) || idx < 0 || idx >= choices.length)
          add(i, "bad-correct-index", `correct=${idx} but there are ${choices.length} choices`);
      });
      const seenCorrect = new Set();
      correct.forEach((idx) => {
        if (!Number.isInteger(idx)) return;
        if (seenCorrect.has(idx)) add(i, "duplicate-correct-index", `choice ${idx + 1} is repeated`);
        seenCorrect.add(idx);
      });
      if (q.type === "Cm" && correct.length > 1)
        add(i, "cm-multi-correct", `single-choice marked ${correct.length} correct answers`);
      if (requireAnswers && correct.length === 0)
        add(i, "no-correct-answer", "no correct answer marked");
    } else if (q.type === "Co" || q.type === "Cd") {
      const answers = (Array.isArray(q.openAnswers) ? q.openAnswers : [])
        .map(AUDIT_STRIP)
        .filter(Boolean);
      if (AUDIT_STRIP(q.openAnswer)) answers.push(AUDIT_STRIP(q.openAnswer));
      // A manually-graded open question has no answer KEY (the teacher marks it),
      // so it is exempt from "needs an answer key" and "open-ended". It still needs
      // a SAMPLE: the preview showed "Düzgün cavab: təyin edilməyib" under every
      // "write a sentence with…" task, and the teacher had nothing to mark against.
      if (requireAnswers && !answers.length && !q.manualGrade) add(i, "no-open-answer", "no accepted answer");
      if (requireAnswers && !answers.length && q.manualGrade)
        add(i, "no-sample-answer", "əl ilə yoxlanan sual — müəllimin müqayisə edəcəyi 1-2 NÜMUNƏ cavab yaz (openAnswers), manualGrade=true saxla");
      if (choices.length) add(i, "open-with-choices", "open question should have no choices");
      // A subjective / multi-answer short-answer can never be matched exactly by a
      // student — flag it so verify converts it to single-choice (Cm).
      if (q.type === "Co" && looksOpenEndedOpen(q))
        add(i, "open-ended-answer", "açıq-uçlu/çoxcavablı açıq sual — şagird cavabı dəqiq uyğunlaşdıra bilməz. Müəllim açıq sual istəyibsə manualGrade=true qoy; əks halda «Cm» çoxseçimli et (düzgün cavabı variant kimi saxla, 4-5 variant qur, openAnswers boşalt)");
    } else if (q.type === "Cma") {
      const pairs = Array.isArray(q.pairs) ? q.pairs : [];
      if (pairs.length < 2) add(i, "too-few-pairs", `only ${pairs.length} pair(s)`);
      const numberedLines = (String(q.text || "").match(/^\s*\d+\s*[.)]/gm) || []).length;
      if (pairs.length >= 2 && numberedLines < pairs.length) {
        add(i, "matching-missing-left-list", `text shows ${numberedLines} numbered item(s), pairs has ${pairs.length}`);
      }
      const labels = letterLabelsInText(q.text);
      const labelSet = new Set(labels);
      if (pairs.length >= 2 && labels.length < 2) {
        add(i, "matching-missing-letter-list", "text has no visible a/b/c letter list");
      }
      pairs.forEach((p, pi) => {
        const left = String(p?.left ?? "").trim();
        const rights = splitMatchLabels(p?.right);
        if (!AUDIT_STRIP(left)) add(i, "incomplete-pair", `pair ${pi + 1} has no left item`);
        else if (!/^\d+[.)]?$/.test(left)) {
          add(i, "matching-left-not-label", `pair ${pi + 1} left should be just a number`);
        }
        if (requireAnswers && !rights.length)
          add(i, "incomplete-pair", `pair ${pi + 1} has no answer letter`);
        rights.forEach((r) => {
          if (!/^[a-z]$/.test(r) || (labelSet.size && !labelSet.has(r))) {
            add(i, "bad-matching-label", `pair ${pi + 1} uses '${r}'`);
          }
        });
      });
    }
  });
  return issues;
};

// Sum two AI cost objects (generation + each review round) so the teacher is
// billed and shown the true total.
const sumCost = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  const keys = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens", "totalTokens", "usd"];
  const out = { model: a.model || b.model };
  keys.forEach((k) => (out[k] = (a[k] || 0) + (b[k] || 0)));
  return out;
};

// The critic. Reuses the generator's provider/schema/fallback, but with a
// review system prompt — so it returns the SAME question shape, corrected.
const REVIEW_SYSTEM_PROMPT = `Sən imtahan suallarını YOXLAYAN və DÜZƏLDƏN təcrübəli AI redaktorsan. Sənə hazır suallar (JSON) verilir. Vəzifən: hər sualı diqqətlə oxu, SƏHVLƏRİ tap və düzəlt. Nəticəni YALNIZ verilən JSON sxemi ilə, EYNİ SAYDA və EYNİ ARDICILLIQLA qaytar (heç bir sualı silmə və əlavə etmə).

DİQQƏTLƏ YOXLA VƏ DÜZƏLT:
1. DÜZGÜN CAVAB: "correct" massivində göstərilən variant həqiqətən düzgündürmü? Riyazi/məntiqi sualları ÖZÜN HƏLL ET və cavabı yoxla. Səhvdirsə, düzgün variantın indeksinə dəyiş.
2. TƏK SEÇİM (Cm): variantlardan YALNIZ BİRİ düzgün olmalıdır. Bir neçəsi düzgündürsə, ya sualı dəqiqləşdir, ya variantları düzəlt ki, yalnız biri düzgün qalsın.
3. ÇOX SEÇİM (Cs): BÜTÜN düzgün variantların indeksi "correct" massivində olmalıdır.
4. Düzgün cavab qeyd olunmayıbsa (boş "correct"), düzgün variantı tapıb qeyd et.
5. DISTRAKTORLAR: yanlış variantlar aydın yanlış, amma inandırıcı olmalıdır. Təkrarlanan, boş və ya açıq-aşkar absurd variantları düzəlt.
6. AÇIQ suallar (Co/Cd): "openAnswers" düzgün və tam olmalıdır — şagirdin yaza biləcəyi bütün formalar. Cavab səhvdirsə düzəlt.
6a. ⛔ AÇIQ-UÇLU AÇIQ SUALI DÜZƏLT: Əgər bir açıq (Co) sualın ÇOX SAYDA fərqli düzgün cavabı ola bilərsə (məs. «bir yer bildirən isim yaz», «şəxs bildirən söz yaz», «bir nümunə göstər»), bu SƏHVDİR — sadalanan 3-4 cavabdan başqasını yazan şagird haqsız yerə səhv sayılır. Bunu DÜZƏLT: tipi «Cm» et, sualı saxla və 4-5 variant qur (biri düzgün — mövcud openAnswers-dən birini götür), "correct"-ə düzgün indeksi yaz, "openAnswers"-i boşalt. (Sualın cavabı əslən yeganədirsə — hesablanmış ədəd, konkret termin — Co qalsın.)
6b. ⛔ TƏSVİR/MÜNASİBƏT CAVABLI AÇIQ SUALI DÜZƏLT: Əgər bir açıq (Co) sualın cavabı bir ANLAYIŞ, MÜNASİBƏT, BƏRABƏRSİZLİK və ya CÜMLƏdirsə (məs. openAnswers = ["diskriminant < 0","diskriminant mənfidir","D<0","mənfi"], ya da sual «...necədir?», «nə baş verir?», «necə dəyişir?» şəklindədir), bu SƏHVDİR — şagird eyni fikri onlarla cür yazır və hərfbəhərf uyğun gəlmir. Bunu DÜZƏLT: tipi «Cm» et, mövcud cavabı düzgün variant kimi saxla və məntiqli 4-5 variant qur (məs. «Mənfi (D<0)», «Sıfır (D=0)», «Müsbət (D>0)», «Müəyyən deyil»), "correct"-ə düzgün indeksi yaz, "openAnswers"-i boşalt. Co yalnız hamının EYNİ yazacağı ədəd/tək termin/tarix/yığcam düstur üçün qalır.
6c. ƏL İLƏ YOXLAMA (manualGrade): əgər İLK TAPŞIRIQ müəllimin AÇIQ/yazılı/inşa/geniş cavablı sual istədiyini göstərirsə və cavab avtomatik yoxlana bilmirsə — 6a/6b-dəki kimi Cm-ə çevirmək əvəzinə sualı açıq (Co/Cd) saxla, manualGrade=true qoy (müəllim əl ilə yoxlayacaq) və openAnswers-də 1-2 NÜMUNƏ cavab olsun. Müəllim açıq sual istəməyibsə, 6a/6b qaydası qalır: Cm-ə çevir, manualGrade=false.
7. UYĞUNLUQ (Cma): hər nömrənin düzgün hərfi olmalıdır; nömrələnmiş və hərflənmiş siyahılar sualın "text" hissəsində tam görünməlidir.
8. DİL və AYDINLIQ: sual birmənalı olmalıdır. İki cür başa düşülən sualı dəqiqləşdir.
9. RİYAZİYYAT DELİMİTERLƏRİ: mətndə və seçimlərdə HƏR düstur/ifadə tək dollar işarələri arasında olmalıdır — $...$ (məs. "$\\\\frac{5}{7}$", "$x^2+1$"). Əgər $...$-siz açıq LaTeX görürsənsə (\\\\frac, \\\\sqrt, x^2 və s.) onu $...$ içinə al; açıq qalan/balanssız $ varsa (bağlayan $ yoxdursa) düzəlt. "latex" sahəsi həmişə "" olmalıdır — riyaziyyat mətnin içindədir. Adi rəqəm/aralıq (20–30) $ ilə YAZILMIR.
10. Sual ARTIQ DÜZGÜNDÜRSƏ, ona TOXUNMA — yalnız real səhvləri düzəlt.
11. LANGUAGE: Preserve each question's original language. Do not translate English, Russian, Turkish or Azerbaijani text while reviewing.

Cavabında bütün sualları (düzəldilmiş və toxunulmamış) tam qaytar.`;

// Generate → audit → have the AI fix what is wrong → audit again. Bounded, and
// never worse than the un-reviewed result: a review that fails, changes the
// question count, or increases the defect count is discarded. `onStatus` lets
// the streaming endpoint tell the teacher a check is running.
const AI_VERIFY_ROUNDS_RAW = Number(process.env.AI_VERIFY_ROUNDS ?? 1);
const AI_VERIFY_ROUNDS = Number.isFinite(AI_VERIFY_ROUNDS_RAW)
  ? Math.max(0, Math.floor(AI_VERIFY_ROUNDS_RAW))
  : 1;
const aiVerifyDisabled = () =>
  ["off", "false", "0", "no"].includes(String(process.env.AI_VERIFY || "").trim().toLowerCase());

/*
 * The prompt for ANSWERING a paper, as opposed to improving one.
 *
 * The review prompt above is written for questions the AI wrote itself, and its
 * rules 6a/6b tell it to turn an open question into multiple choice whenever the
 * answer can be written more than one way. That is a sound rule for a paper the
 * model is authoring. It is the wrong rule for "Cavabları tap" on a teacher's
 * paper: a shaded-region question ("Ştrixlənmiş hissəni müəyyən edin") has an
 * answer like (A∩B)∪(B∩C), so the reviewer dutifully converted it to Cm and
 * pointed `correct` at a fifth option that did not exist. The picture had been
 * read; the answer had nowhere to land.
 *
 * This prompt has one job and says so. The question is the teacher's.
 */
const SOLVE_SYSTEM_PROMPT = `Sən imtahan suallarının CAVABINI tapan sistemsən. Sualları müəllim yazıb — sən yalnız düzgün cavabı müəyyən edirsən.

QƏTİ QAYDALAR:
- Sualın TİPİNİ ("type"), MƏTNİNİ ("text"), VARİANTLARINI ("choices"), onların sırasını və sualların SAYINI DƏYİŞMƏ. Heç bir sualı başqa tipə çevirmə, yeni variant əlavə etmə, variant silmə.
- Yalnız cavab sahələrini doldur:
  • Tək seçim (Cm): "correct" = düzgün variantın indeksi (0-dan başlayır), bir element.
  • Çox seçim (Cs): "correct" = BÜTÜN düzgün variantların indeksləri.
  • Açıq sual (Co / Cd): "openAnswers" = düzgün cavabın şagirdin yaza biləcəyi BÜTÜN ekvivalent formaları (məs. çoxluq ifadəsi üçün həm "(A∩B)∪(B∩C)", həm "(A∩B)∪(C∩B)", həm "B∩(A∪C)" — hansılar riyazi olaraq eynidirsə); "openAnswer" = əsas forma. Açıq sualı HEÇ VAXT Cm-ə çevirmə, "correct"-ə indeks YAZMA.
  • Bir neçə boşluqlu sual ("blanks" > 1): "openAnswers" massivinə HƏR BOŞLUQ ÜÇÜN BİR cavab yaz, boşluqların sırası ilə — mətndə [[1]] birinci, [[2]] ikinci…; cədvəldə ___1___, ___2___… Artıq doldurulmuş boşluğun cavabını OLDUĞU KİMİ saxla. Bu halda "openAnswers" alternativlər deyil — hər element bir boşluğun cavabıdır, sayı "blanks"-a bərabər olsun.
  • Uyğunluq (Cma): hər nömrə üçün "pairs[i].right"-a düzgün hərf(lər)i yaz (bir neçədirsə vergüllə: "a, d"). Yalnız "letters" sahəsində verilən hərflərdən istifadə et; "left"-i dəyişmə.
- ŞƏKİLLƏR: suala aid şəkil/diaqram/qrafik əlavə olunubsa, ona BAX. Qrafikdəki rəqəmləri oxu, diaqramdakı ştrixlənmiş/rənglənmiş hissəni hərflərlə (A, B, C…) çoxluq ifadəsi kimi yaz. Təxmin etmə — hesabla və ya şəkildən oxu.
- Riyazi sualları ÖZÜN addım-addım həll et və cavabı yoxla.
- Şəkil lazımdırsa, amma əlavə olunmayıbsa və ya oxunmursa, həmin sualın cavab sahələrini BOŞ burax — cavab uydurma.
- "latex" sahəsi həmişə "" olsun; riyaziyyat mətnin içində $...$ arasındadır.

Cavab yalnız JSON olsun və bütün sualları eyni sıra ilə qaytarsın.`;

/*
 * Only the ANSWER of `got`, laid onto the teacher's own question.
 *
 * The prompt above asks for this; this makes it true whatever the model did.
 * The type, text, options and picture are always the original ones. When the
 * model answered in a different SHAPE — an open question returned as multiple
 * choice, or the reverse — the answer is carried across by its text where that
 * is possible, and dropped where it is not, rather than stored as an index into
 * options the teacher never wrote.
 */
function answerOnly(orig, got) {
  if (!orig || typeof orig !== "object" || orig.type === "reading") return orig;
  const g = got && typeof got === "object" ? got : {};
  const out = { ...orig };
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const choices = Array.isArray(orig.choices) ? orig.choices : [];
  const openList = [...(Array.isArray(g.openAnswers) ? g.openAnswers : []), g.openAnswer]
    .map((a) => String(a ?? "").trim())
    .filter(Boolean);
  const pickedTexts = (Array.isArray(g.correct) ? g.correct : [])
    .map((i) => (Array.isArray(g.choices) ? g.choices[i]?.text : undefined))
    .map((t) => String(t ?? "").trim())
    .filter(Boolean);

  if (orig.type === "Cm" || orig.type === "Cs") {
    const sameShape =
      g.type === orig.type &&
      (!Array.isArray(g.choices) || !g.choices.length || g.choices.length === choices.length);
    let idx;
    if (sameShape && Array.isArray(g.correct)) {
      idx = g.correct.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < choices.length);
    } else {
      // Answered in words, or against different options: find the teacher's
      // option that says the same thing.
      const want = new Set([...pickedTexts, ...openList].map(norm));
      idx = choices.map((c, i) => (want.has(norm(c?.text)) ? i : -1)).filter((i) => i >= 0);
    }
    out.correct = orig.type === "Cm" ? idx.slice(0, 1) : [...new Set(idx)];
    return out;
  }
  if (orig.type === "Co" || orig.type === "Cd") {
    /*
     * Several boxes: the list is POSITIONAL — element k is box k's answer. The
     * de-duplication below would collapse two boxes that happen to share an
     * answer and shift every later box into the wrong slot, so it is skipped.
     */
    const boxes = Number(orig.blanks) || 1;
    if (boxes > 1) {
      const pos = (Array.isArray(g.openAnswers) ? g.openAnswers : []).map((a) => String(a ?? "").trim());
      out.openAnswers = Array.from({ length: boxes }, (_, k) => pos[k] || "");
      out.openAnswer = out.openAnswers[0];
      return out;
    }
    const answers = [...new Set(openList.length ? openList : pickedTexts)];
    out.openAnswers = answers;
    out.openAnswer = answers[0] || "";
    return out;
  }
  if (orig.type === "Cma") {
    if (Array.isArray(g.pairs) && Array.isArray(orig.pairs) && g.pairs.length === orig.pairs.length) {
      out.pairs = g.pairs;
    }
    return out;
  }
  return out;
}

/*
 * The AI checks its own work only when something IS wrong with it.
 *
 * Every set used to get a full review pass even when the audit found nothing,
 * and that pass wrote the whole paper out again: twenty-five finished questions
 * rewritten to change none of them, while the teacher watched "Suallar
 * yoxlanılır…" for another half minute or more. They called it what it was,
 * waiting for nothing. The preview opens on the answer key, so the teacher
 * checks it there anyway.
 *
 * So a clean set goes straight through, and a set with defects sends only the
 * questions that HAVE them, merged back in place. `force` keeps the full pass
 * for callers that ask for a check by name ("Cavabları tap"), and
 * AI_VERIFY_CLEAN=on brings the pass on clean sets back platform-wide.
 */
const verifyCleanSets = () =>
  ["on", "true", "1", "yes"].includes(String(process.env.AI_VERIFY_CLEAN || "").trim().toLowerCase());

async function verifyAndFix({ questions, prompt, preset, model, signal, onStatus, parts, system, force = false, maxRounds }) {
  let best = cleanQuestions(questions);
  let bestIssues = auditQuestions(best, { requireAnswers: true });
  let reviewCost = null;
  let rounds = 0;
  const whole = force || verifyCleanSets();
  const limit = Number.isInteger(maxRounds) && maxRounds >= 0 ? Math.min(maxRounds, AI_VERIFY_ROUNDS) : AI_VERIFY_ROUNDS;

  if (aiVerifyDisabled() || limit === 0) {
    return { questions: best, issues: bestIssues, reviewCost: null, rounds: 0 };
  }
  // A passage's questions are read against the passage, so such a set goes whole.
  const hasPassage = best.some((q) => q && (q.type === "reading" || q.type === "listening"));

  for (let round = 0; round < limit; round++) {
    if (bestIssues.length === 0 && (round > 0 || !whole)) break;
    if (signal?.aborted) break;
    onStatus?.(round === 0 ? "Suallar yoxlanılır…" : "Düzəlişlər aparılır…");

    const flagged = [...new Set(bestIssues.map((x) => x.index))]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < best.length)
      .sort((a, c) => a - c);
    const scope = !whole && !hasPassage && flagged.length && flagged.length < best.length ? flagged : best.map((_, i) => i);
    const at = new Map(scope.map((orig, k) => [orig, k]));
    const sub = scope.map((i) => best[i]);

    const findings = bestIssues
      .filter((x) => at.has(x.index))
      .slice(0, 40)
      .map((x) => `#${at.get(x.index) + 1} ${x.code}: ${x.detail}`)
      .join("\n");
    const payload = [
      prompt ? `İLK TAPŞIRIQ: ${String(prompt).slice(0, 1500)}` : "",
      "",
      "YOXLANACAQ SUALLAR (JSON):",
      JSON.stringify({ questions: sub }).slice(0, 60000),
      "",
      findings
        ? `AVTOMATİK YOXLAMANIN TAPDIĞI PROBLEMLƏR (mütləq düzəlt):\n${findings}`
        : "Avtomatik yoxlama struktur problemi tapmadı — məzmun və düzgünlük yoxlaması apar.",
    ]
      .filter(Boolean)
      .join("\n");

    let out;
    try {
      // The reviewer may run on a stronger model than the writer — a cheap model
      // generates acceptable questions but is a weaker critic of its own answers.
      // Defaults to the teacher's chosen model when AI_VERIFY_MODEL is unset.
      out = await runGeneration({
        prompt: payload,
        preset,
        model: process.env.AI_VERIFY_MODEL || model,
        signal,
        system: system || REVIEW_SYSTEM_PROMPT,
        // The original pages, so the reviewer can LOOK at a diagram rather than
        // pick one of its five options and sound certain.
        parts,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      console.error("verify round failed (keeping best-so-far):", e?.message);
      break;
    }
    rounds += 1;
    reviewCost = sumCost(reviewCost, out.cost);

    const candidate = cleanQuestions(out.questions);
    // A review that drops or adds questions is not trustworthy — discard it and
    // keep what we had.
    if (!Array.isArray(candidate) || candidate.length !== sub.length) break;
    const merged = best.slice();
    scope.forEach((orig, k) => {
      merged[orig] = candidate[k];
    });
    const candIssues = auditQuestions(merged, { requireAnswers: true });
    if (candIssues.length <= bestIssues.length) {
      best = merged;
      bestIssues = candIssues;
    } else {
      // The reviewer made it worse — reject and stop.
      break;
    }
  }
  return { questions: best, issues: bestIssues, reviewCost, rounds };
}

// Clears every answer key so the teacher marks a clean slate — for the mode
// where the PDF has no answers and the teacher will fill them in by hand.
const stripAnswers = (list) =>
  (Array.isArray(list) ? list : []).map((q) => {
    if (!q || typeof q !== "object" || q.type === "reading") return q;
    const out = { ...q, correct: [], openAnswer: "", openAnswers: [] };
    if (Array.isArray(q.pairs)) {
      out.pairs = q.pairs.map((p) => ({ ...p, right: "", rightLatex: "" }));
    }
    return out;
  });

// ── Request fidelity: did the teacher get the NUMBER of questions they asked for? ──
// The teacher's count lives only in their free-text prompt ("20 sual", "sual sayı 25",
// "make 15 questions"). Parse it (1..100) so we can check the output against it and,
// if short, top the set up. Null when no explicit count is stated.
const parseRequestedCount = (prompt) => {
  const s = String(prompt || "");
  const nums = [];
  const push = (v) => {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 100) nums.push(n);
  };
  let m;
  const re1 = /(\d{1,3})\s*(?:dənə|ədəd|dən)?\s*(?:sual|test|tapşırıq|question)/gi;
  while ((m = re1.exec(s))) push(m[1]);
  const re2 = /(?:sual\s*say[ıiİI]|question\s*count|ne[çc]ə\s*sual)[^\d]{0,8}(\d{1,3})/gi;
  while ((m = re2.exec(s))) push(m[1]);
  return nums.length ? nums[0] : null;
};

// A cheap identity for de-duping questions when topping a set up.
const questionKey = (q) =>
  String(q?.text || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);

// When generation returned FEWER questions than asked, request the missing ones and
// append them (deduped). Skipped when the set has reading/listening blocks — their
// question grouping must not be split — and hard-capped so it can never loop. Uses
// ONLY a user prompt; the system prompt is never touched.
async function topUpToCount({ prompt, preset, model, signal, questions, target }) {
  const acc = Array.isArray(questions) ? [...questions] : [];
  let cost = null;
  if (!target || acc.length >= target) return { questions: acc, cost };
  if (acc.some((q) => q && (q.type === "reading" || q.type === "listening")))
    return { questions: acc, cost };
  const seen = new Set(acc.map(questionKey));
  const MAX_ROUNDS = 3;
  for (let r = 0; r < MAX_ROUNDS && acc.length < target; r += 1) {
    if (signal?.aborted) break;
    const need = target - acc.length;
    const payload = `${String(prompt).slice(0, 3000)}\n\nARTIQ ${acc.length} sual hazırlandı. İNDİ onlardan FƏRQLİ, eyni mövzu və çətinlikdə DAHA ${need} sual yaz (təkrar OLMASIN, cavabları da doldur). Yalnız yeni sualları qaytar.`;
    let out;
    try {
      out = await runGeneration({ prompt: payload, preset, model, signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      break;
    }
    cost = sumCost(cost, out.cost);
    const cleaned = cleanQuestions(out.questions);
    if (!cleaned.length) break;
    let added = 0;
    for (const q of cleaned) {
      if (acc.length >= target) break;
      if (q && (q.type === "reading" || q.type === "listening")) continue;
      const k = questionKey(q);
      if (k && seen.has(k)) continue;
      seen.add(k);
      acc.push(q);
      added += 1;
    }
    if (added === 0) break; // model isn't producing anything new — stop
  }
  return { questions: acc, cost };
}

// How a PDF's answer key is handled, chosen by the teacher before extraction:
//   has-answers — keep the answers the PDF marks (the default)
//   manual      — extract the questions only; the teacher marks the answers
//   ai-solve    — the AI solves each question and proposes the answers, run
//                 through the same audit → critic → audit gate as generation
const ANSWER_MODES = new Set(["auto", "has-answers", "manual", "ai-solve"]);

/*
 * Which questions came back without an answer.
 *
 * The audit already decides this per type - a choice question needs a marked
 * `correct`, an open one needs an accepted answer unless it is graded by hand, a
 * matching one needs its right-hand side - so it is asked rather than
 * reimplemented. A second copy of these rules would drift from the first, and
 * the one that drifts is the one nobody is testing.
 */
const unansweredCount = (questions) =>
  auditQuestions(questions, { requireAnswers: true }).filter((i) =>
    ["no-correct-answer", "no-open-answer", "incomplete-pair"].includes(i.code)
  ).length;

/* WHICH ones are unanswered, not just how many — so an answer the AI supplies
 * can be told apart from one the paper already carried. */
const unansweredIndexes = (questions) =>
  new Set(
    auditQuestions(questions, { requireAnswers: true })
      .filter((i) => ["no-correct-answer", "no-open-answer", "incomplete-pair"].includes(i.code))
      .map((i) => i.index)
  );

/*
 * A question whose data is in a PICTURE cannot be solved from its text, and must
 * not be answered as if it could.
 *
 * "Diaqrama əsasən A çoxluğunun elementlərinin sayını tapın" carries none of the
 * numbers — they are in the bar chart. Handed that and five options, a model does
 * not fail; it picks one and marks it, and the teacher gets an answer key with
 * nothing to distinguish the guess from the arithmetic. On the 29 September
 * ÇOXLUQLAR paper there were two such questions: one guess landed, one did not,
 * and question 9 went out marked 6 where the chart gives 5.
 *
 * So when the solver had no eyes on the page, a figure question it filled in is
 * put back to blank. A blank costs the teacher a minute. A confident wrong key
 * costs their students the marks, and nobody checks a key that looks finished.
 */
function unguessFigures(solved, wasUnanswered, sawPages) {
  if (sawPages) return solved;
  let cleared = 0;
  const out = (Array.isArray(solved) ? solved : []).map((q, i) => {
    if (!q || q.type === "reading" || !q.hasFigure || !wasUnanswered.has(i)) return q;
    cleared += 1;
    return { ...q, correct: [], openAnswer: "", openAnswers: [] };
  });
  if (cleared) {
    console.warn(`[AI] ${cleared} figure question(s) left unmarked: the solver never saw the page`);
  }
  return out;
}
/*
 * "Ardıcıl olaraq təkrarlanan düzgün cavablar olmamalıdır" — the brief's rule, and
 * one the model does not reliably keep. The live German paper came back
 * B A A B B A C D B C D, with a run at 2→3 and another at 4→5.
 *
 * Enforced here rather than only asked for in the prompt, because it is a property
 * that can be checked and repaired exactly: rotating a question's options together
 * with its key leaves the same TEXT correct, so the repair cannot alter the paper's
 * meaning. Scoped to the summative preset, whose brief states the requirement.
 */
const spreadKeysIfNeeded = (questions, preset) => {
  if (preset !== "mso-15") return questions;
  const { spreadAnswerKeys } = require("../helper/answerKeySpread");
  return spreadAnswerKeys(questions).items;
};

/*
 * The answers a paper does not give, worked out in parallel, and only those.
 *
 * This used to be one review pass over the WHOLE paper: forty-four questions
 * sent and forty-four written back for the sake of their answers, while the
 * teacher looked at finished questions for another half minute or more. Now
 * only the unanswered questions go, in a few batches that run at the same time,
 * each with the pages to look at, and only the ANSWER is taken back, laid onto
 * the teacher's own question, so the paper's wording cannot change.
 */
const SOLVE_PARALLEL = Math.max(1, Number(process.env.AI_SOLVE_PARALLEL) || 4);

/* Split the questions to solve so the batches run side by side. Pure, so testable. */
function planParallelSolve(targets) {
  if (!targets.length) return [];
  if (targets.length <= SOLVE_SINGLE_BELOW) return [targets.slice()];
  const size = Math.max(4, Math.ceil(targets.length / SOLVE_PARALLEL));
  const out = [];
  for (let k = 0; k < targets.length; k += size) out.push(targets.slice(k, k + size));
  return out;
}

async function solveUnanswered({ questions, targets, preset, model, signal, onStatus, parts }) {
  const list = Array.isArray(questions) ? questions.slice() : [];
  const batches = planParallelSolve(targets);
  // Each question's number on the paper (a passage has none), to find it there.
  const number = [];
  let n = 0;
  list.forEach((q, i) => {
    if (q?.type !== "reading") n += 1;
    number[i] = n;
  });
  let reviewCost = null;
  let rounds = 0;
  let done = 0;
  const runBatch = async (batch) => {
    const { origin, sub } = batchSubPaper(questions, batch);
    const ask = [
      "Aşağıdakı sualların DÜZGÜN CAVABINI tap. Sualları dəyişmə — yalnız cavab sahələrini doldur.",
      `Əlavə olunmuş sənəddə bunlar ${batch.map((i) => number[i]).join(", ")} nömrəli suallardır (nömrə fərqlidirsə, mətnə görə tap).`,
    ].join("\n\n");
    const v = await verifyAndFix({
      questions: sub,
      prompt: ask,
      system: SOLVE_SYSTEM_PROMPT,
      preset,
      model,
      signal,
      parts,
      force: true,
      maxRounds: 1,
    });
    rounds += v.rounds;
    reviewCost = sumCost(reviewCost, v.reviewCost);
    // A reply that dropped or added a question cannot be mapped back by position.
    if (v.questions.length !== sub.length) return;
    const own = new Set(batch);
    origin.forEach((orig, k) => {
      if (own.has(orig)) list[orig] = answerOnly(sub[k], v.questions[k]);
    });
    done += batch.length;
    onStatus?.(`Cavablar tapılır… ${Math.min(done, targets.length)}/${targets.length}`);
  };
  // A few batches at a time; one that fails leaves its questions for the teacher.
  let next = 0;
  const worker = async () => {
    while (next < batches.length && !signal?.aborted) {
      const batch = batches[next];
      next += 1;
      try {
        await runBatch(batch);
      } catch (e) {
        if (signal?.aborted) throw e;
        console.error("solve batch failed (left for the teacher):", e?.message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SOLVE_PARALLEL, batches.length) }, worker));
  return { questions: list, reviewCost, rounds };
}

async function applyAnswerMode({ questions, mode, preset, model, signal, onStatus, parts, system, prompt }) {
  const m = ANSWER_MODES.has(mode) ? mode : "auto";

  /*
   * AUTO: take the paper's answers, and work out the ones it does not give.
   *
   * Teachers were asked this as a question up front - "are the answers on the
   * sheet, will you mark them yourself, or should the AI solve it?" - before
   * they had seen a single extracted question, about a PDF the AI had not read
   * yet. They are the wrong person to ask: the answer is a property of the file,
   * and the file is right there.
   *
   * So it is read instead of asked. Answers printed on the sheet are kept as
   * they are, which is both cheaper and more faithful than having a model
   * re-derive what a teacher already wrote. Only when some question comes back
   * unmarked is the solving pass run at all, and when the paper marks everything
   * this mode costs nothing beyond the extraction itself.
   */
  if (m === "auto") {
    const missing = unansweredCount(questions);
    /* Recorded BEFORE solving, so an answer the AI supplies can be told apart
     * from one the paper already carried. */
    const wasUnanswered = unansweredIndexes(questions);
    const sawPages = Array.isArray(parts) && parts.length > 0;
    if (!missing) {
      return { questions: spreadKeysIfNeeded(questions, preset), issues: null, reviewCost: null, rounds: 0, mode: m, solved: 0 };
    }
    if (typeof onStatus === "function") {
      onStatus(`${missing} sualın cavabı vərəqdə yoxdur — AI həll edir…`);
    }
    const s = await solveUnanswered({
      questions,
      targets: [...wasUnanswered].sort((a, c) => a - c),
      preset,
      model,
      signal,
      onStatus,
      parts,
    });
    const safe = unguessFigures(s.questions, wasUnanswered, sawPages);
    return {
      questions: spreadKeysIfNeeded(safe, preset),
      issues: auditQuestions(safe, { requireAnswers: true }),
      reviewCost: s.reviewCost,
      rounds: s.rounds,
      mode: m,
      solved: missing,
    };
  }
  if (m === "manual") {
    return { questions: stripAnswers(questions), issues: null, reviewCost: null, rounds: 0, mode: m };
  }
  if (m === "ai-solve") {
    const wasUnanswered = unansweredIndexes(questions);
    const sawPages = Array.isArray(parts) && parts.length > 0;
    // verifyAndFix already audits for unmarked answers and the critic prompt
    // solves them, so an extracted set with empty `correct` comes back solved
    // and checked — no separate solver needed.
    const v = await verifyAndFix({
      questions,
      prompt: prompt || "PDF-dən çıxarılmış sualları həll et və düzgün cavabları qeyd et.",
      system,
      preset,
      model,
      signal,
      onStatus,
      parts,
      force: true,
    });
    const safe = unguessFigures(v.questions, wasUnanswered, sawPages);
    return { ...v, questions: spreadKeysIfNeeded(safe, preset), mode: m };
  }
  return {
    questions: spreadKeysIfNeeded(questions, preset),
    issues: null,
    reviewCost: null,
    rounds: 0,
    mode: m,
  };
}

// The AI reads a PDF INLINE; Claude caps a document at ~32MB (and 100 pages), so
// a whole textbook fails at the model with an opaque 500. Reject an oversized
// file up front with a clear, actionable 413 instead. (Page-count is enforced by
// the provider; size is the cheap pre-check that catches the common "uploaded a
// 70MB book" case.)
const MAX_EXTRACT_PDF_MB = 32;

// Teachers photograph or screenshot a worksheet far more often than they have a
// tidy PDF, so extraction accepts images too — and several files at once, since a
// test is usually more than one page.
const EXTRACT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/heic", "image/heif"];
const MAX_EXTRACT_FILES = Number(process.env.AI_EXTRACT_MAX_FILES) || 10;
const isExtractableType = (m) => m === "application/pdf" || EXTRACT_IMAGE_TYPES.includes(m);

// Normalise whatever was uploaded (single or multiple, PDF or image) into
// provider-agnostic parts. Throws a clear message for anything unsupported.
function extractParts(req, res) {
  const files = req.files && req.files.length ? req.files : req.file ? [req.file] : [];
  if (!files.length || !files.some((f) => f.buffer && f.buffer.length)) {
    res.status(400);
    throw new Error("PDF və ya şəkil faylı lazımdır");
  }
  if (files.length > MAX_EXTRACT_FILES) {
    res.status(400);
    throw new Error(`Ən çox ${MAX_EXTRACT_FILES} fayl yükləyə bilərsiniz.`);
  }
  return files.map((f) => {
    const mime = (f.mimetype || "").toLowerCase();
    if (mime && !isExtractableType(mime)) {
      res.status(400);
      throw new Error("Yalnız PDF və ya şəkil (PNG, JPG, WEBP, HEIC) dəstəklənir");
    }
    assertPdfExtractable(f, res); // the size ceiling applies to images too
    return {
      name: f.originalname || "",
      // heic/heif are not accepted by the vision APIs; send them as jpeg, which is
      // what phones actually produce behind that container in practice.
      mime: mime === "image/heic" || mime === "image/heif" ? "image/jpeg" : mime || "application/pdf",
      data: f.buffer.toString("base64"),
      isPdf: !mime || mime === "application/pdf",
    };
  });
}

function assertPdfExtractable(file, res) {
  const bytes = file.size || (file.buffer ? file.buffer.length : 0);
  if (bytes > MAX_EXTRACT_PDF_MB * 1024 * 1024) {
    res.status(413);
    throw new Error(
      `PDF çox böyükdür (${Math.round(bytes / (1024 * 1024))} MB). Maksimum ${MAX_EXTRACT_PDF_MB} MB. ` +
        "Böyük kitabı fəsillərə bölün və ya yalnız lazımi səhifələri ayırıb yükləyin."
    );
  }
}

const extractQuestions = asyncHandler(async (req, res) => {
  const parts = extractParts(req, res);
  /*
   * The PLATFORM chooses the engine, not the request.
   *
   * A teacher has no way to know whether a paper extracts better on one model
   * than another, and asking them to decide made the platform look like a
   * control panel instead of a tool. The picker is gone from every screen, so
   * anything a client still sends about models is ignored rather than trusted -
   * a request body is not a place to take instructions about spending from.
   */
  const provider = PLATFORM_EXTRACT_PROVIDER;
  const askedModel = provider === "openai" ? findAiModel(DEFAULT_AI_MODEL) : null;
  const openaiModel = askedModel?.provider === "openai" ? askedModel.id : undefined;
  const instructions = buildInstructions(req.body?.preset, req.body?.instructions);

  let questions = [];
  let usage = null;
  let cost = null;
  let usedProvider = provider;
  let fellBack = false;
  /*
   * The owner's API/CLI choice, applied by the one gateway that applies it
   * everywhere. This used to be an inline copy of the policy, which is how four
   * other features ended up not having one.
   */
  ({ questions, usage, cost, usedProvider, fellBack } = await runAi({
    label: "extract-questions",
    capability: "structured",
    // The CLI the picked model implies; the gateway overrides it when that
    // subscription is out of quota.
    preferCli: provider === "openai" ? "codex" : provider,
    cli: async (cliProvider) => {
      const { runCliStructured } = require("../helper/cliAi");
      const out = await runCliStructured({
        provider: cliProvider,
        // No model named: the runner's "standard" tier picks the right one for
        // whichever CLI the gateway chose.
        system: SYSTEM_PROMPT + instructionBlock(instructions),
        prompt: "Yüklənmiş əlavə(lər)dəki bütün sualları çıxar və cavabı yalnız JSON kimi qaytar.",
        schema: DOCUMENT_SCHEMA,
        parts,
        signal: req.signal,
      });
      return {
        questions: Array.isArray(out.doc?.questions) ? out.doc.questions : [],
        usage: null,
        cost: out.cost,
        usedProvider: out.provider,
        fellBack: false,
      };
    },
    api: async () => {
      const extractors = {
        openai: () => extractWithOpenAI(parts, instructions, openaiModel),
        gemini: () => extractWithGemini(parts, instructions),
        claude: () => extractWithClaude(parts, instructions),
      };
      // Try the picked provider, then fall through the OTHERS on an availability
      // failure so one engine being down / out of credit does not dead-end the
      // teacher. Gemini handles PDFs well and is cheap, so it sits right after
      // the pick; a genuine bad request stops the chain.
      const order = [provider, "gemini", "openai", "claude"].filter((p, i, a) => a.indexOf(p) === i);
      let lastErr = null;
      for (const name of order) {
        try {
          const got = await extractors[name]();
          return { ...got, usedProvider: name, fellBack: name !== provider };
        } catch (e) {
          lastErr = e;
          console.warn(`AI extract via ${name} failed:`, e?.status || e?.aiStatus, e?.userMessage || e?.message);
          if (!isRetriable(e)) break;
        }
      }
      throw lastErr || new Error("AI emalı alınmadı");
    },
  }).catch((e) => {
    const err = new Error(e?.userMessage || "AI emalı alınmadı. Bir az sonra yenidən cəhd edin.");
    err.aiStatus = e?.aiStatus || 503;
    err.userMessage = err.message;
    throw err;
  }));
  if (lastErr) {
    res.status(lastErr.aiStatus || 503);
    throw new Error(lastErr.userMessage || "AI emalı alınmadı. Bir az sonra yenidən cəhd edin.");
  }

  // The teacher's answer-key choice (same three modes as the streaming path).
  const applied = await applyAnswerMode({
    questions: cleanQuestions(questions),
    mode: req.body?.answerMode,
    preset: req.body?.preset,
    // The engine that READ the paper, not the cheap one that drafts from a
    // sentence — and the pages with it, so a diagram question is looked at
    // rather than guessed.
    model: PLATFORM_SOLVE_MODEL,
    parts,
  });
  const finalQuestions = applied.questions;
  const finalCost = sumCost(cost, applied.reviewCost);

  // Persist the usage so admins can see per-teacher spend (best-effort: a logging
  // failure must never break the extraction the teacher is waiting on).
  if (finalCost && req.user?._id) {
    try {
      await AiUsage.create({
        user: req.user._id,
        exam: usageExamId(req),
        model: finalCost.model,
        inputTokens: finalCost.inputTokens,
        outputTokens: finalCost.outputTokens,
        cacheWriteTokens: finalCost.cacheWriteTokens,
        cacheReadTokens: finalCost.cacheReadTokens,
        totalTokens: finalCost.totalTokens,
        usd: finalCost.usd,
        questions: finalQuestions.length,
      });
    } catch (e) {
      console.error("AiUsage log failed:", e?.message);
    }
  }

  if (req.aiCredit && finalQuestions.length) req.aiCredit.usable(); // charge only for a usable result
  res.status(200).json({
    success: true,
    questions: finalQuestions,
    usage,
    cost: finalCost,
    provider: usedProvider,
    fellBack,
    answerMode: applied.mode,
    // How many answers the sheet did not give and the AI worked out — the ones
    // worth a teacher's eye.
    answersSolved: applied.solved || 0,
    issues: applied.issues,
    verified: applied.rounds > 0 && (applied.issues?.length || 0) === 0,
  });
});

// --- Streaming extraction (SSE): same model call, delivered incrementally so the
// teacher watches questions appear. The FINAL `done` event carries the
// authoritative full parse — the per-question events are preview only, so a
// partial/early parse can never corrupt the committed result.

// Stateful scanner: given the growing model output, return any question objects
// in the "questions" array that have just become complete (not yet emitted). It
// re-scans from the array start each call (cheap at this size) and tracks how
// many it has handed out, respecting JSON strings/escapes so LaTeX braces and
// quotes inside values don't confuse the brace counter.
const { currentQuestionDraft } = require("../helper/questionDraft");

const makeQuestionStreamer = () => {
  let emitted = 0;
  return (buf) => {
    const qk = buf.indexOf('"questions"');
    if (qk < 0) return [];
    const arrStart = buf.indexOf("[", qk);
    if (arrStart < 0) return [];
    const fresh = [];
    let depth = 0,
      objStart = -1,
      inStr = false,
      esc = false,
      idx = 0;
    for (let i = arrStart + 1; i < buf.length; i++) {
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
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0 && objStart >= 0) {
          idx++;
          if (idx > emitted) {
            try {
              fresh.push(JSON.parse(buf.slice(objStart, i + 1)));
              emitted = idx;
            } catch {
              return fresh; // not cleanly closed yet; wait for more bytes
            }
          }
          objStart = -1;
        }
      } else if (c === "]" && depth === 0) break;
    }
    return fresh;
  };
};

// Reads an SSE response body and hands each `data:` payload to `onPayload` as a
// raw string. Both OpenAI and Gemini speak this framing, and the streaming
// generators below differ only in what they pull out of the parsed chunk.
async function readSSEBody(body, onPayload) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload && payload !== "[DONE]") onPayload(payload);
    }
  }
}

async function streamGemini(parts, instructions, onText) {
  if (!process.env.GEMINI_API_KEY)
    throw aiError(503, "AI funksiyası konfiqurasiya olunmayıb (GEMINI_API_KEY)", true);
  const instr = clampInstr(instructions);
  // Body is per-model: Pro thinks with a big output budget; Flash has thinking
  // off with the standard budget (see geminiGenConfig).
  const buildBody = (model) =>
    JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT + instructionBlock(instr) }] },
      contents: [
        {
          role: "user",
          parts: [
            ...geminiContentParts(parts),
            { text: "Bu PDF-dəki bütün sualları çıxar." },
          ],
        },
      ],
      generationConfig: geminiGenConfig(model),
    });
  const models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastStatus = 0;
  for (const model of models) {
    let r;
    try {
      r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-goog-api-key": process.env.GEMINI_API_KEY,
          },
          body: buildBody(model),
        }
      );
    } catch (e) {
      lastStatus = 0;
      console.error("AI stream (gemini) request failed:", e?.message);
      continue;
    }
    if (!r.ok || !r.body) {
      lastStatus = r.status;
      let t = "";
      try {
        t = await r.text();
      } catch {
        /* ignore */
      }
      console.error("AI stream (gemini) error:", model, r.status, t.slice(0, 200));
      continue; // try the fallback model
    }
    let full = "";
    let usage = null;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let sseBuf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = sseBuf.indexOf("\n")) >= 0) {
        const line = sseBuf.slice(0, nl).trim();
        sseBuf = sseBuf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        let grew = false;
        for (const p of parts)
          if (p.text && !p.thought) {
            // skip any "thought" parts so they can't corrupt the JSON
            full += p.text;
            grew = true;
          }
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        if (grew) onText(full);
      }
    }
    return { full, usage, model, provider: "gemini" };
  }
  const fallbackable = [429, 500, 502, 503].includes(lastStatus) || lastStatus === 0;
  throw aiError(
    503,
    lastStatus === 429 ? "Gemini kvotası bitib." : "Gemini hazırda məşğuldur.",
    fallbackable
  );
}

async function streamClaude(parts, instructions, onText) {
  const client = getClient();
  if (!client) throw aiError(503, "AI funksiyası konfiqurasiya olunmayıb (ANTHROPIC_API_KEY)");
  const instr = clampInstr(instructions);
  const system = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
  if (instr) system.push({ type: "text", text: instructionBlock(instr) });
  let full = "";
  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    system,
    output_config: { effort: "high", format: { type: "json_schema", schema: DOCUMENT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          ...claudeContentParts(parts),
          { type: "text", text: "Bu PDF-dəki bütün sualları çıxar." },
        ],
      },
    ],
  });
  stream.on("text", (delta) => {
    full += delta;
    onText(full);
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw aiError(422, "AI bu sənədi emal edə bilmədi.");
  const textBlock = message.content.find((b) => b.type === "text");
  return { full: textBlock?.text || full, usage: message.usage, provider: "claude" };
}

const extractQuestionsStream = asyncHandler(async (req, res) => {
  const parts = extractParts(req, res);
  /*
   * The PLATFORM chooses the engine, not the request.
   *
   * A teacher has no way to know whether a paper extracts better on one model
   * than another, and asking them to decide made the platform look like a
   * control panel instead of a tool. The picker is gone from every screen, so
   * anything a client still sends about models is ignored rather than trusted -
   * a request body is not a place to take instructions about spending from.
   */
  const provider = PLATFORM_EXTRACT_PROVIDER;
  const askedModel = provider === "openai" ? findAiModel(DEFAULT_AI_MODEL) : null;
  const openaiModel = askedModel?.provider === "openai" ? askedModel.id : undefined;
  const instructions = buildInstructions(req.body?.preset, req.body?.instructions);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const sse = (event, data) => {
    // CR-122: the authoritative `done` event is the ONLY usable-output signal for
    // an SSE AI action — mark the credit reservation committable exactly here.
    if (event === "done" && req.aiCredit && data?.questions?.length) req.aiCredit.usable();
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  // Keepalive: an immediate flush confirms the stream is live, then a frequent
  // ping keeps mobile networks/proxies from dropping the connection during a long
  // non-streaming (OpenAI) wait — a drop surfaced to the client as "Failed to fetch".
  res.write(": ok\n\n");
  // `alive` with the heartbeat: the page shows work going on even before the
  // first question is whole, on every route, streaming or not.
  const hb = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
    sse("alive", {});
  }, 7000);
  let lastThinking = 0;
  const onThinking = () => {
    const now = Date.now();
    if (now - lastThinking < 1000) return;
    lastThinking = now;
    sse("activity", { kind: "thinking" });
  };

  let streamedCount = 0;
  /*
   * A route that showed some questions and then failed hands the paper to the
   * next one, which starts again from question 1. The page is told to clear
   * what it was shown, or the teacher would watch every question twice.
   */
  const freshStart = () => {
    if (streamedCount > 0) sse("reset", {});
    streamedCount = 0;
  };
  const mkOnText = () => {
    const streamer = makeQuestionStreamer();
    let lastDraft = "";
    let lastDraftAt = 0;
    return (full) => {
      for (const q of streamer(full)) {
        sse("question", q);
        streamedCount += 1;
      }
      // The question being copied right now, a few times a second at most.
      const draft = currentQuestionDraft(full);
      const now = Date.now();
      if (draft && now - lastDraftAt > 350) {
        const key = `${draft.n}:${draft.text}`;
        if (key !== lastDraft) {
          lastDraft = key;
          lastDraftAt = now;
          sse("writing", { n: draft.n, text: draft.text.slice(0, 240) });
        }
      }
    };
  };

  let result = null;
  let usedProvider = provider;
  let fellBack = false;
  /*
   * The same gateway as everywhere else. Both CLIs stream now (Claude's
   * stream-json, Codex's app-server), so the questions appear one by one on the
   * CLI route too, the way they do on the streaming APIs.
   */
  try {
    ({ result, usedProvider, fellBack } = await runAi({
      label: "extract-stream",
      capability: "structured",
      preferCli: provider === "openai" ? "codex" : provider,
      cli: async (cliProvider) => {
        const { runCliStructured } = require("../helper/cliAi");
        freshStart();
        const emit = mkOnText();
        const out = await runCliStructured({
          provider: cliProvider,
          // No model named: the runner's "standard" tier picks the right one
          // for whichever CLI the gateway chose.
          system: SYSTEM_PROMPT + instructionBlock(instructions),
          prompt: EXTRACT_CLI_PROMPT,
          schema: DOCUMENT_SCHEMA,
          parts,
          signal: req.signal,
          // Each question reaches the screen as it is copied, not all at the end.
          onText: emit,
          onThinking,
        });
        /*
         * An empty extraction is a FAILURE of this route, not an answer.
         *
         * A teacher uploads a paper in order to get the questions out of it. Zero
         * questions is never the result they were asking about — and the CLI
         * reaches it for reasons that have nothing to do with the paper: the Read
         * tool refused the file, the turn budget ran out mid-read, or the retry
         * after a prose answer emitted a bare `{"questions":[]}` to satisfy the
         * schema. All three exit 0, so this looked like success and the gateway
         * never handed over.
         *
         * That is exactly what happened on 2026-09-29: two runs at 10:01 and
         * 10:04 returned `{"questions":[]}` and the teacher was told her paper
         * had no questions in it, while the very same paper went through the API
         * fifty minutes later without complaint. Treat it as the defect it is and
         * let the next engine try.
         */
        const got = out.doc?.questions || [];
        /*
         * "I could not see the page" is a different thing from "this page has
         * nothing on it", and only the model can tell us which. Both hand over —
         * another engine may well read what this one could not — but they are
         * kept apart so the teacher is never told their paper was empty when the
         * truth is that nothing ever managed to open it.
         */
        if (out.doc?.documentKind === "unreadable") {
          throw Object.assign(new Error("the CLI could not read the document at all"), {
            code: "cli_unreadable_document",
          });
        }
        if (!got.length) {
          throw Object.assign(new Error("the CLI read the document and returned no questions"), {
            code: "cli_no_questions",
          });
        }
        // Anything the stream did not already show.
        emit(JSON.stringify({ questions: got }));
        return {
          result: {
            full: JSON.stringify({ documentKind: out.doc?.documentKind || "questions", questions: got }),
            usage: null,
            cliCost: out.cost,
            model: out.cost?.model,
          },
          usedProvider: out.provider,
          fellBack: false,
        };
      },
      api: async () => {
        const label = { openai: "OpenAI", gemini: "Gemini", claude: "Claude" };
        const runners = {
          // OpenAI's Responses API returns the whole paper at once (no token
          // stream) - the loader still animates, questions just don't land one
          // by one.
          openai: async () => {
            const one = await extractWithOpenAI(parts, instructions, openaiModel);
            return {
              full: JSON.stringify({ documentKind: one.documentKind, questions: one.questions }),
              usage: one.usage,
              model: one.cost?.model,
              openaiCost: one.cost,
            };
          },
          gemini: () => streamGemini(parts, instructions, mkOnText()),
          claude: () => streamClaude(parts, instructions, mkOnText()),
        };
        // Try the picked provider, then fall through the others on an
        // availability failure (Gemini right after the pick - cheap + good at
        // PDFs) so one engine being down never dead-ends the extraction.
        const order = [provider, "gemini", "openai", "claude"].filter((p, i, a) => a.indexOf(p) === i);
        /* How many questions an engine actually found, from its own answer. */
        const found = (got) => {
          try {
            return (JSON.parse(got?.full || "{}").questions || []).length;
          } catch {
            return 0;
          }
        };
        let lastErr = null;
        let lastEmpty = null;
        for (let i = 0; i < order.length; i += 1) {
          const name = order[i];
          try {
            // Cleared first: the page's reset also clears the status line.
            freshStart();
            sse("status", { message: name === provider ? PDF_READING_MSG : `${label[name]} ${CONTINUING_MSG}` });
            const got = await runners[name]();
            /*
             * An engine that found nothing must not end the search while others
             * are still untried - the same rule the CLI branch above now follows.
             * A paper does not become empty because one reader came back empty
             * handed, and the teacher is the one who pays for the difference:
             * "bu sənəddə sual tapılmadı" about a document that is full of them.
             *
             * The LAST engine's empty answer is still returned rather than
             * thrown, because by then it is the honest one: every reader we have
             * looked and none of them saw a question.
             */
            if (!found(got) && i < order.length - 1) {
              lastEmpty = got;
              console.warn(`AI extract (${name}) found no questions; trying ${order[i + 1]}`);
              continue;
            }
            return { result: got, usedProvider: name, fellBack: name !== provider };
          } catch (e) {
            lastErr = e;
            console.error(`AI extract (${name}) failed:`, e?.status || e?.aiStatus, e?.message);
            if (!isRetriable(e)) break;
          }
        }
        /* Every engine that ran found nothing: report that, not a failure. */
        if (lastEmpty) return { result: lastEmpty, usedProvider: order[order.length - 1], fellBack: true };
        throw lastErr || new Error("extract_failed");
      },
    }));
  } catch (e) {
    clearInterval(hb);
    sse("error", { message: e?.userMessage || EXTRACT_FAILED_MSG });
    return res.end();
  }
  if (!result) {
    clearInterval(hb);
    sse("error", { message: (lastErr && lastErr.userMessage) || "AI emalı alınmadı. Bir az sonra yenidən cəhd edin." });
    return res.end();
  }
  clearInterval(hb);

  let parsed;
  try {
    parsed = JSON.parse(result.full || "{}");
  } catch (e) {
    console.error(
      `AI extract (${usedProvider}) JSON parse failed; full length=${(result.full || "").length}, head=`,
      (result.full || "").slice(0, 200)
    );
    sse("error", { message: "AI cavabı oxunmadı. Yenidən cəhd edin." });
    return res.end();
  }
  const extracted = cleanQuestions(parsed.questions);
  if (!extracted.length) {
    console.warn(
      `AI extract (${usedProvider}) returned 0 questions (kind=${parsed.documentKind || "?"}); full length=${(result.full || "").length}, head=`,
      (result.full || "").slice(0, 200)
    );
    /*
     * Say which of the two happened, because the teacher's next move differs.
     * "We could not open your file" means rescan it or send a smaller one;
     * "there was nothing in it to build from" means send a different page. The
     * old single message - "bu sənəddə sual tapılmadı" - sent everyone down the
     * second road, including the ones whose file simply never opened.
     */
    sse("error", {
      message:
        parsed.documentKind === "unreadable"
          ? "Sənəd oxunmadı. Şəkil çox keyfiyyətsizdirsə və ya fayl çox böyükdürsə, daha aydın və ya daha kiçik bir fayl yükləyin."
          : "Bu sənəddən sual qurmaq alınmadı. Faylda sual və ya mövzu izahı olduğundan əmin olun.",
    });
    return res.end();
  }
  /*
   * The questions were WRITTEN from the teacher's material, not copied out of a
   * paper. They should know that before they publish: these are the AI's
   * questions about their content, and its answer key is its own.
   */
  if (parsed.documentKind === "material") {
    sse("status", { message: "Sənəddə hazır sual yox idi — materiala əsasən suallar quruldu. Yoxlayın." });
  }
  // If nothing streamed during extraction (the OpenAI runner returns the whole
  // paper at once), push the extracted questions NOW so the teacher sees them
  // immediately instead of watching a spinner through the slow answer phase.
  // `done` still sends the finalized (answered) set at the end.
  if (streamedCount === 0 && extracted.length) {
    for (const q of extracted) sse("question", q);
  }
  const extractCost =
    result.cliCost ||
    result.openaiCost ||
    (usedProvider === "gemini"
      ? computeGeminiCost(result.usage, result.model)
      : computeCost(result.usage));

  // The teacher's answer-key choice: keep the PDF's answers, leave them blank to
  // mark by hand, or have the AI solve and propose them (audited + reviewed).
  const applied = await applyAnswerMode({
    questions: extracted,
    mode: req.body?.answerMode,
    preset: req.body?.preset,
    model: PLATFORM_SOLVE_MODEL,
    parts,
    onStatus: (message) => sse("status", { message }),
  });
  const questions = applied.questions;
  const cost = sumCost(extractCost, applied.reviewCost);

  if (cost && req.user?._id) {
    try {
      await AiUsage.create({
        user: req.user._id,
        exam: usageExamId(req),
        model: cost.model,
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        cacheWriteTokens: cost.cacheWriteTokens,
        cacheReadTokens: cost.cacheReadTokens,
        totalTokens: cost.totalTokens,
        usd: cost.usd,
        questions: questions.length,
      });
    } catch (e) {
      console.error("AiUsage log failed:", e?.message);
    }
  }
  // Instructions given alongside a PDF describe the exam just as a written
  // prompt does, so a later rewrite gets them too.
  if (questions.length) await rememberExamPrompt(req, req.body?.instructions);
  sse("done", {
    questions,
    cost,
    provider: usedProvider,
    fellBack,
    answerMode: applied.mode,
    // How many answers the sheet did not give and the AI worked out — the ones
    // worth a teacher's eye.
    answersSolved: applied.solved || 0,
    issues: applied.issues,
    verified: applied.rounds > 0 && (applied.issues?.length || 0) === 0,
  });
  res.end();
});

// Admin-only: AI spend per admin/teacher (+ grand totals + recent activity).
const getAiUsage = asyncHandler(async (req, res) => {
  const agg = await AiUsage.aggregate([
    {
      $group: {
        _id: "$user",
        extractions: { $sum: 1 },
        totalUsd: { $sum: "$usd" },
        totalTokens: { $sum: "$totalTokens" },
        inputTokens: { $sum: "$inputTokens" },
        outputTokens: { $sum: "$outputTokens" },
        questions: { $sum: "$questions" },
        lastUsedAt: { $max: "$createdAt" },
      },
    },
  ]);
  const byUser = new Map(agg.map((a) => [String(a._id), a]));

  const staff = await User.find({ role: { $in: ["admin", "teacher"] } })
    .select("name email role photo createdAt")
    .lean();

  const rows = staff.map((u) => {
    const a = byUser.get(String(u._id));
    return {
      _id: u._id,
      name: u.name,
      email: u.email,
      role: u.role,
      photo: u.photo,
      createdAt: u.createdAt,
      extractions: a?.extractions || 0,
      questions: a?.questions || 0,
      inputTokens: a?.inputTokens || 0,
      outputTokens: a?.outputTokens || 0,
      totalTokens: a?.totalTokens || 0,
      totalUsd: Number((a?.totalUsd || 0).toFixed(4)),
      lastUsedAt: a?.lastUsedAt || null,
    };
  });
  rows.sort((x, y) => y.totalUsd - x.totalUsd);

  const totals = rows.reduce(
    (t, r) => ({
      usd: t.usd + r.totalUsd,
      tokens: t.tokens + r.totalTokens,
      extractions: t.extractions + r.extractions,
      questions: t.questions + r.questions,
    }),
    { usd: 0, tokens: 0, extractions: 0, questions: 0 }
  );
  totals.usd = Number(totals.usd.toFixed(4));

  const recent = await AiUsage.find()
    .sort({ createdAt: -1 })
    .limit(25)
    .populate("user", "name email role")
    .populate("exam", "name")
    .lean();

  res.status(200).json({ rows, totals, recent });
});

// ============================ AI question GENERATION ============================
// Generate exam questions from a TEXT description (no PDF). Same output shape as
// extraction, so results drop into the structured builder for review. Unlike
// extraction, generation MAY fill in the correct answers.

const GEN_SYSTEM_PROMPT = `Sən imtahan sualları YARADAN AI köməkçisisən. Müəllimin təsvirinə əsasən suallar yarat və NƏTİCƏNİ YALNIZ verilən JSON sxemi ilə qaytar.

QAYDALAR:
- İSTƏNİLƏN FƏNN üçün sual yarat (riyaziyyat, fizika, kimya, biologiya, tarix, coğrafiya, informatika, ədəbiyyat, dillər və s.). Fənnə görə HEÇ VAXT imtina etmə.
- Müəllimin istədiyi SAY və NÖV sualları yarat (məs. "10 qapalı riyaziyyat sualı").
- DİL: müəllim hansı dildə istəyirsə, suallar O DİLDƏ olsun (məs. «rus dilində riyaziyyat» → suallar tam rusca; «ingilis dili» → ingiliscə). Dil göstərilməyibsə — Azərbaycan dilində.
- SAY: müəllim neçə sual istəyirsə, DƏQİQ o qədər sual qaytar. «25 sual» dedisə 25 olmalıdır — nə 22, nə 26. Qaytarmazdan ƏVVƏL sualları say və uyğun gəlmirsə düzəlt.
- BÖLGÜ: müəllim tiplərin sayını/nisbətini deyibsə, ona hərfi əməl et. «son 7-si açıq» → tam 7 ədəd Co. «yarısı uyğunluq» → qalan qapalı sualların yarısı «Cma» olmalıdır.
  UYĞUNLUQ SUALI YAZMAQDAN ÇƏKİNMƏ: aşağıdakı uzun xəbərdarlıq onu NECƏ düzgün yazmaq barədədir — ondan qaçmaq üçün deyil. İstənilibsə, tələb olunan qədər «Cma» yaz.
- Qapalı sual (Cm/Cs): "choices" massivində A–E variantları ver və düzgün variant(lar)ın indeksini "correct" massivinə yaz.
- AÇIQ SUALIN CAVABI — BURADA ÇOX SƏHV EDİLİR:
  Şagird cavabı KLAVİATURA ilə yazır və cavab hərfbəhərf uyğun gəlməlidir. Ona görə açıq sual YALNIZ o zaman uyğundur ki, cavabın QISA və BİR MƏNALI yazılışı olsun.
  ⛔ ƏN VACİB QAYDA — AÇIQ-UÇLU (çoxcavablı) SUAL YARATMA: Əgər sualın ÇOX SAYDA fərqli düzgün cavabı ola bilərsə, onu AÇIQ (Co) ETMƏ. Nümunələr (BUNLARI Co ETMƏ): «bir yer bildirən isim yaz», «şəxs bildirən söz yaz», «konkret ismə bir nümunə göstər», «bir sifət de», «bir heyvan adı yaz». Belə suallarda minlərlə düzgün cavab var — sən yalnız 3-nü sadalayırsan, «beach/office/tree» yazan şagird HAQSIZ yerə səhv sayılır. Bunun əvəzinə: sualı ÇOXSEÇİMLİ (Cm) et və 4-5 variant ver (biri düzgün), VƏ YA sualı elə dəyiş ki, cavab BİRMƏNALI olsun (məs. «'kitab' sözünün cəm forması» → yeganə cavab). Açıq sual (Co) YALNIZ cavabı YEGANƏ və dəqiq müəyyən olan hallar üçündür: hesablanmış ədəd, konkret termin/tərif, tarixi tarix/ad, sualın birmənalı tələb etdiyi TƏK söz. Şübhə varsa — Co yox, Cm seç.
  ⛔ İKİNCİ HAL — CAVABI TƏSVİR/MÜNASİBƏT/BƏRABƏRSİZLİK OLAN SUAL DA Co OLMAMALIDIR: cavab bir ANLAYIŞ, MÜNASİBƏT, BƏRABƏRSİZLİK və ya CÜMLƏ ilə ifadə olunursa (məs. «diskriminant mənfidir», «D < 0», «sıfırdan kiçikdir», «artır», «azalır», «dəyişmir», «tərs mütənasibdir») — bu, TƏK sözlü/ədədli olsa belə, şagird onu ONLARLA fərqli cür yazır («D<0», «mənfi», «mənfidir», «0-dan kiçik», «sıfırdan aşağı»...) və hərfbəhərf uyğun gəlmir. Xüsusən «necədir?», «nə baş verir?», «necə dəyişir?», «hansı haldadır?», «nə olur?» kimi soruşan suallar TƏSVİR istəyir → BUNLARI Co ETMƏ, «Cm» et. Nümunə: «Kvadrat tənliyin kökləri həqiqi olmadıqda diskriminant necədir?» → Cm, variantlar: «Mənfi (D<0)», «Sıfır (D=0)», «Müsbət (D>0)», «Müəyyən deyil». Yəni cavab bir SÖZ olsa da, əgər onu müxtəlif cür ifadə etmək olarsa → Co yox, Cm.
  QAYDA SADƏ: Co-nu YALNIZ hamının EYNİ cür yazacağı bir işarə üçün seçː konkret ƏDƏD, konkret TƏK termin/söz, tarix/ad, yığcam düstur. Cavab bir izah, münasibət, bərabərsizlik və ya bir neçə sözlük ifadədirsə — HƏMİŞƏ Cm.
  • ƏN YAXŞI açıq cavab — bir ƏDƏD (məs. 8, 50.24, -3) və ya qısa düstur (məs. x^2, cos(x), 2*a+b).
  • Sual nə soruşursa, cavab O OLSUN. «Dairənin sahəsini tapın (r=4)» sualının cavabı ƏDƏDdir (50.24), düstur deyil. «Sahənin düsturunu yazın» sualının cavabı düsturdur.
  • CÜMLƏ İLƏ CAVAB YAZMA. «uzunluğun və enin cəmini 2-yə vurmaq» kimi cavab qəbuledilməzdir — şagird onu eyni sözlərlə yaza bilməz. Belə hallarda sualı AÇIQ etmə: TIP "Cm" et və variantları ver.
  • "openAnswers" massivinə şagirdin real yaza biləcəyi BÜTÜN formaları yaz — ən azı 3 variant olsun (mümkün olduqda):
      – fərqli hərf işarələri (a*h/2, b*h/2, (1/2)*a*h, ah/2)
      – sıra dəyişikliyi (2+x və x+2)
      – onluq ayırıcı hər iki cür (0.5 və 0,5) — proqram onları özü eyniləşdirmir
      – tam və yuvarlaqlaşdırılmış forma (16*pi, 50.24, 50.27)
  • Cavab bir neçə ədəddirsə, ayırıcının hər variantını yaz (2,3 və 3,2 və "2; 3" və "2 и 3").
  • İnteqralda +C, kökdə hər iki kök — cavabı natamam qoyma.
- Açıq sual (Co): "choices" boş. BÜTÜN məqbul cavabları "openAnswers" MASSİVİNƏ yaz — HƏR məqbul cavab (sinonim/variant) AYRICA element olsun (məs: ["yaş","quru","dolu"]). Cavabları DÜZ MƏTN kimi yaz — LaTeX/$...$ dollar işarəsi VƏ YA hər hansı işarələmə İSTİFADƏ ETMƏ, şagird klaviaturada necə yazırsa elə yaz (məs: x+2, yox $x + 2$; 3/4, yox kəsr işarəsi). Riyazi cavablarda boşluqlu VƏ boşluqsuz formaları, eləcə də yerdəyişmiş ekvivalentləri variant kimi əlavə et (məs: ["x+2","x + 2","2+x"]). Nömrələmə, "və ya", "/", mötərizə İSTİFADƏ ETMƏ — bir sətirdə bir neçə cavab birləşdirmə. "openAnswer" sahəsinə isə birinci cavabı yaz. Qapalı suallarda "openAnswers" boş massiv [] olsun.
- Çoxseçimlə sual (Cs): bir neçə düzgün variant olduqda TIP "Cs" olsun və "correct" massivinə BÜTÜN düzgün indeksləri yaz. Cavabı "2,5" kimi mətnə çevirib açıq sual etmə.
- Uyğunluq sualı (Cma) — ƏN ÇOX SƏHV EDİLƏN YER, DİQQƏTLƏ OXU:
  Proqram uyğunluq sualını YALNIZ boş nömrə→hərf şəbəkəsi kimi göstərir. Şagird ekranda ancaq bunu görür:
      1 →  A B C D E
      2 →  A B C D E
  Yəni nömrələrin və hərflərin NƏ olduğu ekranda GÖRÜNMÜR. "pairs" sahəsinə yazdığın hər hansı məzmun EKRANA ÇIXMIR və İTİR.
  Buna görə HƏR İKİ SİYAHININ MƏZMUNU tam şəkildə sualın "text" hissəsində yazılmalıdır:
    • "text" = təlimat + nömrələnmiş siyahı (hər element AYRI sətirdə) + hərflənmiş siyahı (hər element AYRI sətirdə).
    • "pairs" = YALNIZ uyğunluq cədvəli: "left" sadəcə nömrə ("1"), "right" sadəcə düzgün hərf(lər) ("b" və ya bir neçə olarsa "a, d").
  DÜZGÜN NÜMUNƏ:
    text: "Aşağıdakı alman samitlərini çıxış yerləri ilə uyğunlaşdırın.\\n1. [p]\\n2. [m]\\n3. [x]\\n\\na) dodaq (bilabial)\\nb) burun (nazal)\\nc) damaq arxası (velar)"
    pairs: [{"left":"1","right":"a"},{"left":"2","right":"b"},{"left":"3","right":"c"}]
  YANLIŞ (belə YAZMA): text: "Səsləri çıxış yerləri ilə uyğunlaşdırın." + pairs: [{"left":"1. [p]","right":"a"}] — burada nə səslər, nə də a/b/c-nin mənası şagirdə görünmür; sual cavabsızdır.
  Hərf siyahısını yazmağı UNUTMA: "a)", "b)", "c)" nə deməkdirsə, mətndə açıq yazılmalıdır. Uyğunluğu "1b2d3c" kimi mətn cavaba çevirmə.
  HƏRFLƏR: yalnız ingilis əlifbasının hərflərini işlət — a, b, c, d, e. Azərbaycan əlifbasına məxsus ç, ə, ğ, ı, ö, ş, ü hərflərini uyğunluq etiketi kimi İSTİFADƏ ETMƏ (proqram onları tanımır).
- Uyğunluq sualından SONRA gələn suallarda "1 nömrəli səs", "2-ci variant" kimi əvvəlki sualın nömrələrinə İSTİNAD ETMƏ — hər sual öz-özünə tam başa düşülən olmalıdır.
- Açıq sualı (Co) YALNIZ şagirdin əslən yazdığı cavablar üçün işlət: rəqəm, söz, düstur. Seçim və ya uyğunluq cavabını heç vaxt mətn kimi yazma.
- "manualGrade" (əl ilə yoxlama): standart olaraq HƏMİŞƏ false. YALNIZ bir halda true et: müəllim açıq/yazılı/inşa/geniş cavablı suallar XÜSUSİ istəyibsə VƏ cavab avtomatik dəqiq yoxlana bilmirsə (izahlı, çoxcavablı, "izah et", "nümunələr göstər"). O zaman sualı Co/Cd saxla, manualGrade=true qoy və openAnswers-ə yenə də 1-2 NÜMUNƏ (istinad) cavab yaz — müəllim yoxlayarkən müqayisə edəcək; BOŞ BURAXMA. Müəllim açıq sual İSTƏMƏYİBSƏ, avtomatik yoxlana bilməyən açıq sualı yuxarıdakı qaydaya görə «Cm»-ə çevir və manualGrade=false saxla.
- RİYAZİYYAT (VACİB): hər düsturu/ifadəni mətnin İÇİNDƏ, öz yerində, tək dollar işarələri arasında LaTeX kimi yaz — $...$. Nümunələr: "3500-ün $\\\\frac{5}{7}$ hissəsini tapın.", "$x^{2}+1=0$ tənliyini həll et", "$\\\\sqrt{540}$ ədədi". "latex" sahəsini HEÇ VAXT işlətmə — həmişə "" saxla; bütün riyaziyyat mətnin içində $...$ ilə olur. QADAĞAN: $...$-siz açıq LaTeX yazma (məs. \\\\frac, \\\\sqrt, x^2 kimi) — belə yazsan şagird xam kodu görür. Açdığın hər $ üçün mütləq BAĞLAYAN $ qoy (balanslı olsun). Bütöv cümləni $...$ içinə ALMA — yalnız həqiqi düsturu. Adi rəqəm/aralıq/faiz/tarix riyaziyyat deyil ("20–30 arası" — $ ilə YOX). Seçim mətnində də riyaziyyatı $...$ ilə yaz, seçimin "latex"-i "" olsun.
- Dırnaq işarəsi lazımdırsa adi " işlət — \\" kimi qaçış simvolu YAZMA.
- Şəkil/qrafik tələb edən sual YARATMA (hasFigure həmişə false). Mümkün qədər mətnlə həll olunan suallar yarat.
- Oxu mətni (reading) yalnız istənildikdə əlavə et. İstənilsə, onu "reading" tipli AYRICA element kimi ver: bütün mətn "text" sahəsində, abzaslar iki yeni sətirlə (\\n\\n) ayrılsın, başlıq varsa "title"-də. Sonra o mətnə aid suallar ayrıca elementlər kimi gəlsin. choices=[], correct=[], pairs=[], openAnswer="".
- FORMATLAMA: oxu mətnində lazım gələndə Markdown işlət — **qalın** vacib terminlər/yarımbaşlıqlar üçün, *maili* xüsusi adlar/vurğu/xarici sözlər üçün. Abzas hərfi/nömrəsi olan mətndə həmin işarəni qalın ver (məs. "**A.** Octopuses exhibit…"). Formatı YALNIZ məna daşıdıqda işlət, hər cümləni qalınlaşdırma. HTML teqi YAZMA — yalnız ** və * işarələri.
- SIRALAMA: hər oxu mətnindən DƏRHAL SONRA ona aid suallar gəlsin. Bir mətnin summary/sentence-completion CLOZE tapşırığı varsa, onu həmin mətnin adi suallarından SONRA ayrıca "reading" bloku kimi ver — belə ki heç bir mətn "0 sual" ilə qalmır.
- OXU MƏTNİNİN UZUNLUĞU: akademik/IELTS oxu mətni UZUN və çoxabzaslı olsun — təxminən 700–900 söz (ən azı 550), 4–6 abzas. Qısa (100–300 sözlük) mətn IELTS deyil.
- SUAL SAYI: müəllim konkret say/tip deyibsə DƏQİQ ona əməl et — "6 True/False/Not Given" = tam 6 AYRICA sual (hər ifadə bir Cm), hamısını bir suala yığma.
- BOŞLUQ DOLDURMA mətnləri — "boşluqları doldur", "gap-fill", "fill in the blanks", həmçinin IELTS-in "summary completion", "sentence completion", "note completion", "table/flow-chart completion" tapşırıqları: HƏR belə tapşırığı AYRICA "reading" tipli element kimi ver (məs. xülasə/cümlə mətni "text" sahəsində), və boşluqları həmin mətnin İÇİNDƏ [[düzgün cavab]] kimi yaz — bir neçə qəbul olunan cavab varsa [[cavab|alternativ]]. Düzgün cavab HƏMİŞƏ mötərizənin içində qalır. ÇOX VACİB: bu boşluqlar üçün AYRICA sual (nə "Co"/açıq cavab, nə çoxseçim) YARATMA — mətnin özü qiymətləndirilir, hər boşluq 1 baldır. Yəni "Complete the summary…" kimi tapşırıq gələndə onu sual yox, [[...]] boşluqları olan "reading" mətni kimi qaytar. Boşluq istənilməyən adi mətndə mötərizə işlətmə.
  DÜZGÜN NÜMUNƏ (summary/sentence completion → boşluqlu "reading"):
    {"type":"reading","title":"Complete the summary","text":"Octopuses change colour using pigment cells called [[chromatophores]]. Beneath these sit [[leucophores]], which reflect ambient light, while [[iridophores]] produce iridescent blues and greens. The animal controls tiny [[muscles]] to shift these cells almost instantly."}
  YANLIŞ (belə YAZMA): eyni xülasəni boşluqsuz mətn kimi verib, sonra hər boşluq üçün ayrıca "Complete the summary: ___" tipli "Co"/çoxseçim sual yaratmaq. Boşluqlar mətnin İÇİNDƏ [[...]] olmalıdır.
- Suallar aydın, düzgün və imtahan səviyyəsinə uyğun olsun.`;



// ── the engines a teacher may pick for question generation ───────────────
// An ALLOW-LIST, not free text: the model id arrives from the browser, and
// without this a caller could name any model on the account — including the
// pro tiers, at many times the price.
//
// `usd` is per MILLION tokens. Where a model is newer than the prices we can
// vouch for, it is marked pricing: "unknown" — spend is still logged in tokens,
// but the dollar figure would be a guess, so the UI says so instead of showing
// a confident wrong number. Override any of it with AI_MODEL_PRICES (JSON).
const AI_MODELS = [
  // ── priced from OpenAI's published table (standard tier, short context) ──
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    provider: "openai",
    note: "Sürətli və ucuz — tövsiyə olunur",
    usd: { in: 0.4, cached: 0.1, out: 1.6 },
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    provider: "openai",
    note: "Ən sürətli",
    usd: { in: 0.75, cached: 0.075, out: 4.5 },
  },
  {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 nano",
    provider: "openai",
    note: "Ən ucuz — sadə suallar üçün",
    usd: { in: 0.2, cached: 0.02, out: 1.25 },
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 luna",
    provider: "openai",
    note: "Güclü və çox sərfəli",
    // Was 1 / 0.1 / 6 — five times the real rate. Corrected against OpenAI's
    // published table; see the note on gpt-6-astra below.
    usd: { in: 0.2, cached: 0.02, out: 1.2 },
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    provider: "openai",
    usd: { in: 2.5, cached: 0.25, out: 15 },
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 terra",
    provider: "openai",
    // Was 2.5 / 0.25 / 15 — gpt-5.4's row, evidently copied.
    usd: { in: 2, cached: 0.2, out: 12 },
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    provider: "openai",
    note: "Bahalı",
    usd: { in: 5, cached: 0.5, out: 30 },
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 sol",
    provider: "openai",
    note: "Çox güclü — bahalı",
    // Was 5 / 0.5 / 30 — gpt-5.5's row. Every 5.6 price here was one model's
    // row out of step, so OpenAI spend has been over-reported on this page.
    usd: { in: 4, cached: 0.4, out: 20 },
  },
  /*
   * OpenAI's newest, priced but NOT offered on the exam picker.
   *
   * Studio needs it in this table because this table is what prices a turn, and
   * an unpriced model computes to $0 — which on a spend page does not read as
   * "unknown", it reads as "free". Studio's usage row is the only meter on a
   * feature with no rate limit and no budget guard, so that mattered.
   *
   * It is kept OFF the exam picker for the reason stated just below about the
   * pro tiers: at $10/$50 it is twenty-five times gpt-4.1-mini on input, and a
   * teacher generating an exam should not be one click from that without asking
   * for it. `studioOnly` marked the Studio-only entries when a picker existed; priceFor ignores it — so it is
   * priced everywhere and offered only where it was chosen deliberately.
   */
  {
    id: "gpt-6-astra",
    label: "GPT-6 astra",
    provider: "openai",
    note: "Ən yenisi — ən bahalı",
    studioOnly: true,
    usd: { in: 10, cached: 1, out: 50 },
  },
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    provider: "openai",
    usd: { in: 2, cached: 0.5, out: 8 },
  },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai", usd: { in: 2.5, cached: 1.25, out: 10 } },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "openai",
    usd: { in: 0.15, cached: 0.075, out: 0.6 },
  },
  // The two engines that were already here. Their spend is computed by their
  // own cost functions, not by this table.
  { id: "gemini", label: "Gemini Flash", provider: "gemini", note: "Ucuz", usd: null },
  { id: "claude", label: "Claude Opus 4.8", provider: "claude", note: "Bahalı, güclü", usd: null },
];

// The pro tiers (gpt-5.5-pro / gpt-5.4-pro at $30 in / $180 out — 40x the
// default) and the unpriced gpt-5 / gpt-5-mini are deliberately NOT offered:
// everything on this list has a price we can charge against, so the spend page
// is never a guess, and no click can cost forty times what the teacher expects.

const DEFAULT_AI_MODEL = process.env.OPENAI_GEN_MODEL || "gpt-4.1-mini";

/*
 * The model every teacher-facing request runs on.
 *
 * There is no picker any more: to a teacher the platform is one engine, and a
 * request body is not a place to take instructions about spending from. This is
 * that single choice, named once so the admin runtime page can show it and so
 * no handler is tempted to read one off the wire again.
 */
const PLATFORM_MODEL = DEFAULT_AI_MODEL;

/*
 * Reading a paper is not writing one.
 *
 * The generation default is a small, cheap text model - right for turning a
 * sentence into questions, wrong for reading a scanned worksheet. Extraction
 * therefore keeps the engine it has always used when a request named none, and
 * the chain behind it (gemini, then the rest) still catches an outage.
 */
const PLATFORM_EXTRACT_PROVIDER = (() => {
  const asked = String(process.env.AI_EXTRACT_PROVIDER || "claude").toLowerCase();
  return ["openai", "gemini", "claude"].includes(asked) ? asked : "claude";
})();

/*
 * ANSWERING a paper is not writing one either — it is the hardest thing we ask.
 *
 * The answer key ran on PLATFORM_MODEL, which is `gpt-4.1-mini`: a small, cheap
 * text model, set as the default for turning a sentence into questions. It was
 * then also used as its own reviewer, so the pass whose whole job is catching a
 * wrong answer was the same cheap model that produced it.
 *
 * A teacher's ÇOXLUQLAR paper on 29 September is what this cost. Fifteen answers
 * were right, one was wrong (question 9: n(A) = 10 + 2 - 7 = 5, marked 6) and
 * five open questions came back with no answer at all. Those are the marks her
 * students would have been graded against.
 *
 * So solving uses the engine that READ the paper. It is the stronger model, and
 * on the CLI route it is free — the subscription is already paid for.
 */
const PLATFORM_SOLVE_MODEL = (() => {
  const asked = String(process.env.AI_SOLVE_MODEL || "").trim();
  if (asked) return asked;
  return PLATFORM_EXTRACT_PROVIDER === "openai" ? "gpt-4.1" : PLATFORM_EXTRACT_PROVIDER;
})();

let PRICE_OVERRIDES = {};
try {
  PRICE_OVERRIDES = JSON.parse(process.env.AI_MODEL_PRICES || "{}");
} catch {
  console.warn("AI_MODEL_PRICES is not valid JSON — ignoring");
}

const findAiModel = (id) => AI_MODELS.find((m) => m.id === id) || null;

const priceFor = (id) => {
  const m = findAiModel(id);
  const o = PRICE_OVERRIDES[id];
  if (o && Number.isFinite(o.in) && Number.isFinite(o.out)) return o;
  return m?.usd || null;
};

/*
 * The model catalogue is no longer offered to clients.
 *
 * There was a GET /api/quiz/ai/models here so the builder could draw a picker.
 * The picker is gone - teachers do not choose an engine - so serving the list
 * would only invite a client to send a choice the server now ignores. AI_MODELS
 * itself stays: it is the PRICING table, and the usage pages read it.
 */

// ── OpenAI: the default engine for prompt-generated questions ────────────
// Priced per MILLION tokens and overridable without a deploy, so a price change
// or a model swap is an env edit rather than a release.
const OPENAI_GEN_MODEL = DEFAULT_AI_MODEL;
const computeOpenAIGenCost = (usage, model, askedId) => {
  const price = priceFor(askedId || model) || { in: 0, cached: 0, out: 0 };
  const inP = Number(price.in) || 0;
  const cachedP = Number(price.cached ?? price.in) || 0;
  const outP = Number(price.out) || 0;

  // prompt_tokens INCLUDES the cached ones, and cached input is billed at a
  // fraction of the normal rate — charging the whole prompt at full price
  // overstates every repeat call.
  const promptTokens = usage?.prompt_tokens || 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens || 0;
  const freshTokens = Math.max(0, promptTokens - cachedTokens);
  const outputTokens = usage?.completion_tokens || 0;

  return {
    model: model || askedId || OPENAI_GEN_MODEL,
    inputTokens: promptTokens,
    outputTokens,
    cacheWriteTokens: 0,
    cacheReadTokens: cachedTokens,
    totalTokens: usage?.total_tokens || promptTokens + outputTokens,
    usd:
      (freshTokens / 1e6) * inP +
      (cachedTokens / 1e6) * cachedP +
      (outputTokens / 1e6) * outP,
  };
};

// `onText` opts into token streaming: it receives the whole output so far after
// every chunk, which is what lets the builder show questions as they are
// written. The parsed result is identical either way.
async function generateWithOpenAI(prompt, presetId, modelId, onText, signal, systemOverride, parts = []) {
  const useModel = modelId || OPENAI_GEN_MODEL;
  if (!process.env.OPENAI_API_KEY)
    throw aiError(503, "AI konfiqurasiya olunmayib (OPENAI_API_KEY)", true);

  const sys = (systemOverride || GEN_SYSTEM_PROMPT) + (presetHint(presetId) ? "\n\n" + presetHint(presetId) : "");
  let r;
  try {
    r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: useModel,
        /*
         * Images ride along when there are any. This endpoint is Chat
         * Completions, which takes pictures but not PDFs — a PDF page therefore
         * still arrives as text here, and `hasFigure` questions are left unmarked
         * rather than guessed (see solveNeedsFigures). The CLI and the Claude and
         * Gemini routes all take the document whole.
         */
        messages: [
          { role: "system", content: sys },
          {
            role: "user",
            content: (Array.isArray(parts) ? parts : []).some((p) => !p.isPdf)
              ? [
                  ...parts
                    .filter((p) => !p.isPdf)
                    .map((p) => ({ type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } })),
                  { type: "text", text: prompt },
                ]
              : prompt,
          },
        ],
        // Structured Outputs: the model cannot return anything but this shape,
        // so the SAME schema the other providers use applies here and the
        // builder receives an identical payload whichever engine ran.
        response_format: {
          type: "json_schema",
          json_schema: { name: "exam_questions", strict: true, schema: EXTRACTION_SCHEMA },
        },
        // Usage arrives in a final chunk with no choices when streaming; without
        // this flag a streamed call reports no cost at all.
        ...(onText ? { stream: true, stream_options: { include_usage: true } } : {}),
        // gpt-5+ and the o-series renamed this and reject the old name with a
        // 400, so the field is chosen from the model id rather than hardcoded.
        [/^(gpt-[5-9]|o\d)/.test(useModel) ? "max_completion_tokens" : "max_tokens"]:
          16000,
      }),
    });
  } catch {
    throw aiError(502, "AI suallar yarada bilmedi. Yeniden cehd et.", true);
  }

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error("OpenAI generate failed:", r.status, body.slice(0, 300));
    // Quota and 5xx are worth handing to the next provider; a 400 is our bug.
    throw aiError(
      502,
      "AI suallar yarada bilmedi. Yeniden cehd et.",
      r.status === 429 || r.status >= 500
    );
  }

  let text = "";
  let usage = null;
  let servedModel = useModel;
  if (onText && r.body) {
    await readSSEBody(r.body, (payload) => {
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      if (chunk.model) servedModel = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onText(text);
      }
    });
  } else {
    const data = await r.json();
    text = data?.choices?.[0]?.message?.content || "{}";
    usage = data?.usage;
    servedModel = data?.model || useModel;
  }

  let parsed;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    throw aiError(502, "AI cavabi oxunmadi. Yeniden cehd et.", true);
  }
  return {
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    cost: computeOpenAIGenCost(usage, servedModel, useModel),
  };
}

async function generateWithGemini(prompt, presetId, onText, signal, systemOverride, parts = []) {
  if (!process.env.GEMINI_API_KEY)
    throw aiError(503, "AI konfiqurasiya olunmayıb (GEMINI_API_KEY)", true);
  const sys = (systemOverride || GEN_SYSTEM_PROMPT) + (presetHint(presetId) ? "\n\n" + presetHint(presetId) : "");
  const models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);
  const buildBody = (model) =>
    JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{
        role: "user",
        parts: [...geminiContentParts(Array.isArray(parts) ? parts : []), { text: prompt }],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: GEMINI_SCHEMA,
        maxOutputTokens: String(model).includes("pro") ? 64000 : 32000,
        temperature: 0.6,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Streaming is a different endpoint returning the same content parts in
      // pieces. Both branches end with `text` + `usage`, so everything after
      // this point is shared.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${
        onText ? "streamGenerateContent?alt=sse" : "generateContent"
      }`;
      let r;
      let text = null;
      let usage = null;
      try {
        r = await fetch(url, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", "X-goog-api-key": process.env.GEMINI_API_KEY },
          body: buildBody(model),
        });
        if (onText) {
          if (r.ok && r.body) {
            let acc = "";
            await readSSEBody(r.body, (payload) => {
              let chunk;
              try {
                chunk = JSON.parse(payload);
              } catch {
                return;
              }
              let grew = false;
              for (const p of chunk.candidates?.[0]?.content?.parts || [])
                if (p.text && !p.thought) {
                  // "thought" parts would corrupt the JSON if mixed in
                  acc += p.text;
                  grew = true;
                }
              if (chunk.usageMetadata) usage = chunk.usageMetadata;
              if (grew) onText(acc);
            });
            if (acc) text = acc;
          }
        } else {
          const data = await r.json();
          if (r.ok && !data?.error) {
            text =
              (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join("") ||
              "{}";
            usage = data.usageMetadata;
          }
        }
      } catch (e) {
        if (signal?.aborted) throw aiError(499, "Ləğv edildi");
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (text) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          continue;
        }
        return {
          questions: Array.isArray(parsed.questions) ? parsed.questions : [],
          cost: computeGeminiCost(usage, model),
        };
      }
      if (r.status && ![429, 500, 503].includes(r.status)) break;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw aiError(502, "AI suallar yarada bilmədi, yenidən cəhd et", true);
}

async function generateWithClaude(prompt, presetId, onText, signal, systemOverride, parts = []) {
  const client = getClient();
  if (!client) throw aiError(503, "AI konfiqurasiya olunmayıb (ANTHROPIC_API_KEY)");
  const sys = [
    { type: "text", text: (systemOverride || GEN_SYSTEM_PROMPT) + (presetHint(presetId) ? "\n\n" + presetHint(presetId) : "") },
  ];
  let message;
  try {
    // Already a stream — `onText` just taps the deltas that were being dropped.
    const stream = client.messages.stream({
      model: "claude-opus-4-8",
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      system: sys,
      output_config: { effort: "high", format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
      // The pages first, then the instruction: a question about a diagram is
      // answerable only if the diagram came with it.
      messages: [{
        role: "user",
        content: [...claudeContentParts(Array.isArray(parts) ? parts : []), { type: "text", text: prompt }],
      }],
    }, { signal });
    if (onText) {
      let acc = "";
      stream.on("text", (delta) => {
        acc += delta;
        onText(acc);
      });
    }
    message = await stream.finalMessage();
  } catch (e) {
    const status = Number(e?.status || e?.statusCode || e?.response?.status || 0);
    const msg = String(e?.message || e?.error?.message || "").toLowerCase();
    // Out of credit / billing / quota / overloaded is an AVAILABILITY problem
    // (Claude simply cannot serve now), NOT a bad prompt — so fall back to another
    // provider instead of hard-failing the whole request. Anthropic reports "credit
    // balance is too low" as a 400, which would otherwise be treated as our bug.
    const unavailable = /credit balance|billing|quota|insufficient|payment|overloaded/.test(msg);
    throw aiError(
      502,
      "AI suallar yarada bilmədi. Yenidən cəhd et.",
      status === 429 || status >= 500 || status === 0 || unavailable
    );
  }
  const textBlock = message.content.find((b) => b.type === "text");
  let parsed;
  try {
    parsed = JSON.parse(textBlock?.text || "{}");
  } catch {
    throw aiError(502, "AI cavabı oxunmadı. Yenidən cəhd et.", true);
  }
  return {
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    cost: computeCost(message.usage),
  };
}

// Runs a prompt through the provider chain and returns { questions, cost }.
//
// Shared by the plain and the streaming generate endpoints so the two cannot
// drift: the only difference between them is that `onText` is supplied.
/*
 * `parts` — the ORIGINAL pages, when there were any.
 *
 * Generation from a prompt has none. Solving an extracted paper does, and
 * withholding them is why an answer key could be guessed: the verify pass was
 * handed the extracted TEXT only, and a question whose text reads "Diaqrama
 * əsasən A çoxluğunun elementlərinin sayını tapın" carries none of the numbers —
 * they are in the bar chart. The model could not solve it. It could only pick
 * one of five options and sound certain, which is exactly what it did.
 */
async function runGeneration({ prompt, preset, model, onText, onThinking, signal, system, parts }) {
  // The teacher's choice wins, but only from the allow-list: the id arrives
  // from a browser, and an unchecked one could name a pro tier at many times
  // the price. Anything unrecognised silently falls back to the default.
  const picked = findAiModel(String(model || "")) || findAiModel(DEFAULT_AI_MODEL);

  // The administrator may route generation through the authenticated CLI
  // installed in the application image. CLI mode is deliberately explicit:
  // when it is selected, an unavailable CLI fails rather than silently creating
  // an unexpected provider bill. The existing API chain remains untouched.
  /*
   * The gateway, so exam generation obeys the same setting as everything else.
   * The whole API provider chain below becomes this call's `api` route, which is
   * what lets one mode change move every feature at once.
   */
  return runAi({
    label: "generate-questions",
    capability: "structured",
    preferCli: picked?.provider === "openai" ? "codex" : picked?.provider,
    cli: async (cliProvider) => {
      const { runCliStructured } = require("../helper/cliAi");
      const sys = (system || GEN_SYSTEM_PROMPT) + (presetHint(preset) ? `

${presetHint(preset)}` : "");
      /*
       * ONE listener for the whole run: it remembers how many questions it has
       * already sent, so the streamed text and the final answer below can both
       * pass through it without a question reaching the teacher twice.
       */
      const emit = onText ? onText(cliProvider) : null;
      const out = await runCliStructured({
        provider: cliProvider,
        model: picked?.id || model,
        system: sys,
        prompt,
        schema: EXTRACTION_SCHEMA,
        // The pages, so a question about a diagram can be answered by LOOKING at
        // the diagram instead of guessing between its options.
        parts: Array.isArray(parts) ? parts : [],
        signal,
        // Questions reach the screen as they are written, not all at the end.
        onText: emit || undefined,
        onThinking: onThinking || undefined,
      });
      const questions = Array.isArray(out.doc?.questions) ? out.doc.questions : [];
      // Anything the stream did not already show (Codex, which cannot stream, shows it all here).
      if (emit) emit(JSON.stringify({ questions }));
      return { questions, cost: out.cost };
    },
    api: () => runGenerationOnApi({ prompt, preset, model, onText, signal, system, picked, parts }),
  });
}

async function runGenerationOnApi({ prompt, preset, model, onText, signal, system, picked, parts }) {
  // `system` swaps the generator's prompt for a different one (the reviewer),
  // reusing the same provider chain, schema and fallback for the critic pass.
  /* The pages travel down the API chain too — otherwise a CLI outage silently
   * puts the answer key back to guessing at every figure question. */
  const files = Array.isArray(parts) ? parts : [];
  const runners = {
    openai: (pr, ps, cb) =>
      generateWithOpenAI(pr, ps, picked?.provider === "openai" ? picked.id : undefined, cb, signal, system, files),
    gemini: (pr, ps, cb) => generateWithGemini(pr, ps, cb, signal, system, files),
    claude: (pr, ps, cb) => generateWithClaude(pr, ps, cb, signal, system, files),
  };
  const keyFor = {
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    claude: process.env.ANTHROPIC_API_KEY,
  };

  // Start with whatever was picked, then fall through the others. A provider is
  // only skipped past when it fails in a way worth retrying (quota, 5xx,
  // unreadable output) — a bad prompt is not paid for three times.
  const order = [picked?.provider, "openai", "gemini", "claude"].filter(
    (p2, i, a) => p2 && a.indexOf(p2) === i
  );
  const chain = order.filter((p2) => !!keyFor[p2]).map((p2) => [p2, runners[p2]]);

  let out = null;
  let lastErr = null;
  for (const [name, fn] of chain) {
    try {
      // A fresh callback per attempt: the previous provider may have emitted
      // questions before failing, and its counter must not carry over.
      out = await fn(prompt, preset, onText ? onText(name) : undefined);
      break;
    } catch (e) {
      lastErr = e;
      // A cancelled request must not fall through to the next provider — that
      // would bill two more models for output nobody is waiting for.
      if (signal?.aborted) throw aiError(499, "Ləğv edildi");
      console.error(`generate via ${name} failed:`, e?.message);
      if (!e.aiFallback) break;
    }
  }
  if (!out) throw lastErr || aiError(502, "AI suallar yarada bilmədi");
  return out;
}

// IELTS is a 3-passage reading exam — but that ONLY applies when the teacher
// opts in via the IELTS PRESET. It is never guessed from the prompt text and
// never a JSON blueprint injected into the prompt; the AI decides the content,
// and the preset's guidance rides in (opt-in) through presetHint().
const IELTS_PRESETS = new Set(["ielts-reading"]);
const isIeltsPreset = (presetId) => IELTS_PRESETS.has(String(presetId || ""));

// A request for several separate long passages ("3 passages", "Passage 1..3"),
// or the IELTS Reading preset, is split — one passage per call — and merged, so
// each passage gets full length instead of a shared, rationed stub. Returns 1 for
// a normal single-passage / non-reading request, so nothing else changes.
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, iki: 2, "üç": 3, dörd: 4, "beş": 5, "altı": 6 };
const detectPassageCount = (prompt, presetId) => {
  const p = String(prompt || "").toLowerCase();
  let n = 0;
  // Explicit "Passage 1 … Passage 2 … Passage 3" — count the distinct indices.
  const idx = new Set((p.match(/passage\s+(\d+)/g) || []).map((s) => (s.match(/\d+/) || [])[0]));
  if (idx.size >= 2) n = idx.size;
  // "3 passages" / "3 reading(s)" / "3 mətn" / "3 oxu mətni" (number right before).
  let m = p.match(/(\d+)\s*(?:separate\s+|ayr[ıi]\s+)?(?:reading\s+|oxu\s+)?(?:passages?|readings?|m[əe]tn|oxu)\b/);
  if (m) n = Math.max(n, parseInt(m[1], 10) || 0);
  // Word-number form ("three passages", "üç mətn").
  m = p.match(/\b(one|two|three|four|five|six|iki|üç|dörd|beş|altı)\s+(?:separate\s+|ayr[ıi]\s+)?(?:reading\s+|oxu\s+)?(?:passages?|readings?|m[əe]tn|oxu)/);
  if (m) n = Math.max(n, NUM_WORDS[m[1]] || 0);
  // The IELTS Reading PRESET (opt-in) is a 3-passage exam unless the teacher
  // asked for a specific number. An explicit singular still wins.
  const explicitSingle = /\b(one|1|single|bir|tək)\s+(?:\w+\s+){0,3}(?:passages?|readings?|m[əe]tn|oxu)\b/.test(p);
  if (n <= 1 && !explicitSingle && isIeltsPreset(presetId)) n = 3;
  return Math.min(6, Math.max(1, n || 1)); // cap at 6, never below 1
};

// One passage's slice of a multi-passage request: the teacher's brief, plus an
// instruction to emit ONLY passage k (with its questions) on a distinct topic.
// No fixed structure is imposed — the AI decides the content; any IELTS guidance
// arrives (opt-in) through the preset hint on the system prompt.
const buildPassagePrompt = (userPrompt, k, n, prevTitles) =>
  `${userPrompt}\n\n[SİSTEM TAPŞIRIĞI: Bu ${n} oxu mətnli imtahandır. İNDİ YALNIZ ${k}-Cİ MƏTNİ yarat — TAM, çoxabzaslı bir oxu mətni və ONA aid BÜTÜN suallar. Başqa mətn qaytarma. Mətnin başlığı "Passage ${k}: <mövzu>" formatında olsun.${prevTitles.length ? ` Mövzu bunlardan tam FƏRQLİ olsun: ${prevTitles.join("; ")}.` : ""}]`;

// Deterministic structure check for one passage's items — the things the AI
// review (verifyAndFix) does NOT enforce: passage length, that the passage
// actually governs some questions, and that a "summary/cloze" block really has
// blanks. Returns human-readable issue strings (empty = clean).
const wordCountOf = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
const isClozeReading = (q) => !!q && q.type === "reading" && /\[\[[^\]]*\]\]/.test(q.text || "");
// Single source of truth for academic/IELTS reading passage length. TARGET is the
// ideal band the prompts ask for; MIN is the floor the validator (and the retry
// nudge) enforce — keep them consistent so a passage the prompt promised can't
// slip past the gate.
const IELTS_PASSAGE_TARGET_WORDS = "700–900";
const IELTS_PASSAGE_MIN_WORDS = 550;
const validatePassageStructure = (items, k) => {
  const out = [];
  const passage = items.find((q) => q.type === "reading" && !isClozeReading(q));
  if (!passage) out.push(`Passage ${k}: oxu mətni yoxdur`);
  else {
    const w = wordCountOf(passage.text);
    if (w < IELTS_PASSAGE_MIN_WORDS) out.push(`Passage ${k}: mətn qısadır (${w} söz)`);
  }
  const scored = items.filter((q) => q.type !== "reading" || isClozeReading(q)).length;
  if (scored < 4) out.push(`Passage ${k}: az sual (${scored})`);
  items.forEach((q) => {
    if (q.type === "reading" && !isClozeReading(q) && /summary|cloze|boşluq|gap[- ]?fill/i.test(q.title || ""))
      out.push(`Passage ${k}: "${q.title}" mətnində boşluq yoxdur`);
  });
  return out;
};

// Generate an N-passage exam one passage at a time and merge. Each passage runs
// through a DETERMINISTIC gate (free) first; an AI repair is paid for ONLY when
// the gate flags something — so a clean passage costs one call, not two:
//   • too short / missing passage / too few questions → regenerate once, harder;
//   • answer-key / structural defects → one verifyAndFix repair pass.
// Real `issues` + a `verified` flag are returned so the builder never claims a
// set was checked when it was not. Distinct topics come from feeding the used
// titles back in; sequential so each passage can avoid the earlier ones.
async function runMultiPassage({ prompt, preset, model, n, signal, onProvider, onQuestion, onStatus }) {
  const all = [];
  const titles = [];
  const issues = [];
  let cost = null;
  const stream = onQuestion
    ? (provider) => {
        onProvider?.(provider);
        const streamer = makeQuestionStreamer();
        return (full) => {
          for (const q of streamer(full)) onQuestion(q);
        };
      }
    : undefined;

  for (let k = 1; k <= n; k++) {
    if (signal?.aborted) throw aiError(499, "Ləğv edildi");
    const passagePrompt = buildPassagePrompt(prompt, k, n, titles);
    onStatus?.(`Mətn ${k}/${n} yazılır…`);
    const out = await runGeneration({ prompt: passagePrompt, preset, model, signal, onText: stream });
    let items = Array.isArray(out.questions) ? out.questions : [];
    cost = sumCost(cost, out.cost);

    // Free deterministic checks. Only a failure buys an AI call.
    let struct = validatePassageStructure(items, k);
    let audit = auditQuestions(items, { requireAnswers: true });

    // (1) Short / stub / thin passage → regenerate this one once (not streamed,
    // so the panel does not show the discarded attempt twice).
    if (struct.length) {
      onStatus?.(`Mətn ${k}/${n} yenidən yazılır…`);
      const retry = await runGeneration({
        prompt: `${passagePrompt}\n\n[QEYD: əvvəlki cəhd naqis idi (qısa mətn və ya az sual). Mətni ƏN AZI ${IELTS_PASSAGE_MIN_WORDS} söz (ideal ${IELTS_PASSAGE_TARGET_WORDS}), 4–6 abzas yaz və tam sual dəstini ver.]`,
        preset,
        model,
        signal,
      });
      const rItems = Array.isArray(retry.questions) ? retry.questions : [];
      cost = sumCost(cost, retry.cost);
      const rStruct = validatePassageStructure(rItems, k);
      if (rItems.length && rStruct.length < struct.length) {
        items = rItems;
        struct = rStruct;
        audit = auditQuestions(items, { requireAnswers: true });
      }
    }

    // (2) Answer-key / structural defects → one AI repair pass.
    if (audit.length) {
      onStatus?.(`Mətn ${k}/${n} yoxlanılır…`);
      const v = await verifyAndFix({ questions: items, prompt: passagePrompt, preset, model, signal });
      items = v.questions;
      cost = sumCost(cost, v.reviewCost);
      audit = v.issues;
    }

    for (const x of audit) issues.push(`Passage ${k} #${(x.index ?? 0) + 1}: ${x.code || "problem"}`);
    for (const s of struct) issues.push(s);

    const firstReading = items.find((q) => q.type === "reading" && q.title);
    if (firstReading) titles.push(firstReading.title);
    all.push(...items);
  }
  return { questions: all, cost, issues, verified: issues.length === 0 };
}

// Remember what this exam was asked for, so a later single-question rewrite
// carries the same context. Scoped to the owner, and never fatal: failing to
// record the prompt must not fail the generation the teacher just paid for.
const rememberExamPrompt = async (req, prompt) => {
  const text = String(prompt || "").trim();
  if (!text || !req.params?.examId) return;
  /*
   * An exam being composed for the first time has no id yet - the route carries
   * the literal "new" until the teacher saves. Handing that to updateOne threw a
   * CastError on EVERY generation from the composer, which the catch below
   * swallowed into one noisy line per turn; the log for 29 September is mostly
   * this. Nothing broke, but nothing was recorded either: the prompt behind a
   * newly created exam was never saved, so a later single-question rewrite lost
   * the context this function exists to keep.
   */
  if (!require("mongoose").isValidObjectId(req.params.examId)) return;
  try {
    // NB: the exam's creator is `owner`. Scoped on `user` this matched nothing
    // and silently saved nothing — updateOne reports success on zero matches.
    const scope =
      req.user.role === "admin"
        ? { _id: req.params.examId }
        : { _id: req.params.examId, owner: req.user._id };
    await Exam.updateOne(scope, { $set: { aiPrompt: text.slice(0, 4000) } });
  } catch (e) {
    console.error("aiPrompt save failed:", e?.message);
  }
};

const logGenerationUsage = async (req, out) => {
  try {
    const c = out.cost || {};
    await AiUsage.create({
      user: req.user._id,
      exam: usageExamId(req),
      model: c.model,
      inputTokens: c.inputTokens || 0,
      outputTokens: c.outputTokens || 0,
      cacheWriteTokens: c.cacheWriteTokens || 0,
      cacheReadTokens: c.cacheReadTokens || 0,
      totalTokens: c.totalTokens || 0,
      usd: c.usd || 0,
      questions: (out.questions || []).length,
    });
  } catch (e) {
    console.error("generate usage log failed:", e?.message);
  }
};

// POST /api/quiz/generateQuestions/:examId (teacher) — { prompt, preset } -> { questions, cost }
const generateQuestions = asyncHandler(async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim().slice(0, 4000);
  if (!prompt) {
    res.status(400);
    throw new Error("İmtahan təsviri boşdur");
  }
  const passageCount = detectPassageCount(prompt, req.body?.preset);
  const requestedCount = parseRequestedCount(prompt);
  let questions = [];
  let cost = null;
  let issues = [];
  let verified = false;
  try {
    if (passageCount >= 2) {
      // Multi-passage IELTS: one call per passage, merged (see runMultiPassage).
      const r = await runMultiPassage({ prompt, preset: req.body?.preset, model: PLATFORM_MODEL, n: passageCount });
      questions = r.questions;
      cost = r.cost;
      issues = r.issues;
      verified = r.verified;
    } else {
      const out = await runGeneration({ prompt, preset: req.body?.preset, model: PLATFORM_MODEL });
      // Request fidelity: if the model came back short of the teacher's asked count,
      // top the set up to it (best-effort) BEFORE the review — so "20 sual" means 20.
      const topped = await topUpToCount({
        prompt,
        preset: req.body?.preset,
        model: PLATFORM_MODEL,
        questions: out.questions,
        target: requestedCount,
      });
      // Agentic quality gate: the AI reviews its own answers and variants before
      // the teacher sees them. Falls back to the un-reviewed set if review fails.
      const v = await verifyAndFix({
        questions: topped.questions,
        prompt,
        preset: req.body?.preset,
        model: PLATFORM_MODEL,
      });
      questions = v.questions;
      cost = sumCost(sumCost(out.cost, topped.cost), v.reviewCost);
      issues = v.issues;
      // HONEST verified: only true when there are no defects AND the teacher got at
      // least the count they asked for. A short set is never silently "verified".
      const short = requestedCount != null && questions.length < requestedCount;
      verified = v.rounds > 0 && v.issues.length === 0 && !short;
    }
  } catch (e) {
    res.status(e?.aiStatus || 502);
    throw new Error(e?.userMessage || "AI suallar yarada bilmədi");
  }
  await logGenerationUsage(req, { cost, questions });
  await rememberExamPrompt(req, prompt);
  if (req.aiCredit && questions.length) req.aiCredit.usable(); // charge only for a usable result
  // countInfo lets the teacher see fidelity honestly ("18/20 — 2 çatışmır").
  const countInfo = {
    requested: requestedCount,
    actual: questions.length,
    short: requestedCount != null ? Math.max(0, requestedCount - questions.length) : 0,
  };
  res.json({ questions, cost, issues, verified, countInfo });
});

// POST /api/quiz/generateQuestionsStream/:examId — same thing over SSE.
//
// The `question` events are PREVIEW ONLY, parsed out of a half-written response;
// `done` carries the authoritative, cleaned result that actually gets committed.
// Mirrors extractQuestionsStream so the builder can treat both the same way.
const generateQuestionsStream = asyncHandler(async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim().slice(0, 4000);
  if (!prompt) {
    res.status(400);
    throw new Error("İmtahan təsviri boşdur");
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const sse = (event, data) => {
    // CR-122: the authoritative `done` event is the ONLY usable-output signal for
    // an SSE AI action — mark the credit reservation committable exactly here.
    if (event === "done" && req.aiCredit && data?.questions?.length) req.aiCredit.usable();
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  // Keepalive: immediate flush + frequent ping so mobile networks don't drop the
  // stream mid-generation ("Failed to fetch" on the client).
  res.write(": ok\n\n");
  /*
   * A run can take minutes, and a screen that says "0 questions" for all of
   * them reads as broken. So the page is told, as it happens, that work is
   * going on: `alive` with the heartbeat (even a route that cannot stream
   * sends it), `thinking` while the model plans, and `writing` with the
   * question it is part-way through.
   */
  const hb = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
    sse("alive", {});
  }, 7000);
  let lastThinking = 0;
  const onThinking = () => {
    const now = Date.now();
    if (now - lastThinking < 1000) return;
    lastThinking = now;
    sse("activity", { kind: "thinking" });
  };

  // Cancelling in the browser only closed the socket; the provider kept
  // generating and kept billing for output nobody would read. The upstream
  // request is aborted with the connection now.
  const ac = new AbortController();
  let clientGone = false;
  req.on("close", () => {
    clientGone = true;
    clearInterval(hb);
    ac.abort();
  });

  const passageCount = detectPassageCount(prompt, req.body?.preset);
  let shown = 0;
  let questions = [];
  let cost = null;
  let issues = [];
  let verified = false;
  try {
    if (passageCount >= 2) {
      // Multi-passage IELTS: one call per passage (a single call shrinks each to
      // a stub and can fail outright), streamed and merged. No separate review
      // pass — each per-passage call is already focused and small.
      let announced = false;
      const r = await runMultiPassage({
        prompt,
        preset: req.body?.preset,
        model: PLATFORM_MODEL,
        n: passageCount,
        signal: ac.signal,
        onProvider: (provider) => {
          if (!announced) {
            announced = true;
            sse("provider", { provider });
          }
        },
        onQuestion: (q) => sse("question", q),
        onStatus: (message) => sse("status", { message }),
      });
      questions = r.questions;
      cost = r.cost;
      issues = r.issues;
      verified = r.verified;
    } else {
      const out = await runGeneration({
        signal: ac.signal,
        prompt,
        preset: req.body?.preset,
        model: PLATFORM_MODEL,
        onText: (provider) => {
          // A second route starting after the first showed questions: clear them.
          if (shown > 0) sse("reset", {});
          shown = 0;
          const streamer = makeQuestionStreamer();
          let announced = false;
          let lastDraft = "";
          let lastDraftAt = 0;
          return (full) => {
            if (!announced) {
              announced = true;
              sse("provider", { provider });
            }
            for (const q of streamer(full)) {
              sse("question", q);
              shown += 1;
            }
            // The one still being written, a few times a second at most.
            const draft = currentQuestionDraft(full);
            const now = Date.now();
            if (draft && now - lastDraftAt > 350) {
              const key = `${draft.n}:${draft.text}`;
              if (key !== lastDraft) {
                lastDraft = key;
                lastDraftAt = now;
                sse("writing", { n: draft.n, text: draft.text.slice(0, 240) });
              }
            }
          };
        },
        onThinking,
      });
      if (clientGone) {
        clearInterval(hb);
        return res.end();
      }
      // Request fidelity: top a short set up to the asked count before the review.
      const target = parseRequestedCount(prompt);
      if (target != null && out.questions.length < target) {
        sse("status", { message: "Çatışmayan suallar hazırlanır…" });
      }
      const topped = await topUpToCount({
        prompt,
        preset: req.body?.preset,
        model: PLATFORM_MODEL,
        signal: ac.signal,
        questions: out.questions,
        target,
      });
      // The stream showed the questions arriving; now the AI checks its own
      // answers before they are committed. `status` events drive the panel.
      const v = await verifyAndFix({
        questions: topped.questions,
        prompt,
        preset: req.body?.preset,
        model: PLATFORM_MODEL,
        signal: ac.signal,
        onStatus: (message) => sse("status", { message }),
      });
      questions = v.questions;
      cost = sumCost(sumCost(out.cost, topped.cost), v.reviewCost);
      issues = v.issues;
      const short = target != null && questions.length < target;
      verified = v.rounds > 0 && v.issues.length === 0 && !short;
    }
  } catch (e) {
    clearInterval(hb);
    if (clientGone || ac.signal.aborted) return res.end();
    sse("error", { message: e?.userMessage || "AI suallar yarada bilmədi" });
    return res.end();
  }

  clearInterval(hb);
  // Nobody is listening any more: skip the commit work and the cost row.
  if (clientGone) return res.end();
  if (questions.length) {
    await logGenerationUsage(req, { cost, questions });
    await rememberExamPrompt(req, prompt);
  }
  const reqCount = parseRequestedCount(prompt);
  const countInfo = {
    requested: reqCount,
    actual: questions.length,
    short: reqCount != null ? Math.max(0, reqCount - questions.length) : 0,
  };
  sse("done", { questions, cost, issues, verified, countInfo });
  res.end();
});


// POST /api/quiz/regenerateQuestion/:examId — rewrite ONE question.
//
// Runs through the same provider chain, schema and cleanup as a full
// generation, so a rewritten question is indistinguishable from a generated
// one. The model is allowed to change the question's TYPE: "make this multiple
// choice" is a normal thing to ask, and forcing the old type would make half
// the useful instructions impossible.
/*
 * "Cavabları tap" — solve this paper's answer key, looking at its pictures, and
 * SHOW the work while it happens.
 *
 * The teacher already has the questions on screen: extracted from a PDF, written
 * by the AI, typed by hand, or any mixture. What they do not have is the key, and
 * for a paper built out of diagrams neither they nor a model can get it from the
 * text alone. So this gathers what there IS to look at — every picture attached
 * to a question or an option, and the source PDF when the exam still has one —
 * and hands it over with the questions.
 *
 * WHY IN BATCHES. A teacher watching a spinner for a minute cannot tell whether
 * anything is happening, and the obvious fix — a highlight marching down the
 * list — would be a lie: the whole paper went to the model in one turn and the
 * CLI cannot stream, so there was no true "now checking question 7" to show.
 * Solving a few questions per turn makes that status TRUE. The cost is time
 * (one turn per batch), which is why a short paper still goes in one.
 *
 * WHY EACH BATCH CARRIES ITS PASSAGE. A reading-comprehension question batched
 * without the text it asks about is unanswerable, and a model handed one will
 * answer it anyway. So every batch includes the passage its questions belong to,
 * as context, and only the batch's own questions are taken back.
 *
 * Scope is the teacher's call and the default is the careful one: "missing"
 * never touches an answer that is already there, because most of those were
 * typed by a person. "all" re-checks the paper end to end.
 *
 * The stream carries STRUCTURE, not sentences: indexes, not "Sual 7". The
 * builder numbers questions its own way (passages are not counted), so it
 * composes the words itself and the number on the status always matches the
 * number on the card.
 */
const SOLVE_BATCH = Math.max(1, Number(process.env.AI_SOLVE_BATCH) || 6);
const SOLVE_SINGLE_BELOW = Math.max(1, Number(process.env.AI_SOLVE_SINGLE_BELOW) || 8);

/* The reading passage a question belongs to: the last passage before it. */
const ownerPassage = (list, i) => {
  for (let k = i - 1; k >= 0; k -= 1) if (list[k]?.type === "reading") return k;
  return -1;
};

/* Split the questions to solve into turns. Pure, so the batching is testable. */
function planSolveBatches(targets) {
  const size = targets.length <= SOLVE_SINGLE_BELOW ? targets.length : SOLVE_BATCH;
  const out = [];
  for (let k = 0; k < targets.length; k += size) out.push(targets.slice(k, k + size));
  return out;
}

/* One batch's sub-paper: its questions plus the passages they belong to, in the
 * original order, with each position's original index. */
function batchSubPaper(list, batch) {
  const include = new Set(batch);
  for (const i of batch) {
    const p = ownerPassage(list, i);
    if (p >= 0) include.add(p);
  }
  const origin = [...include].sort((a, c) => a - c);
  return { origin, sub: origin.map((i) => list[i]) };
}

const solveAnswers = asyncHandler(async (req, res) => {
  const { questions, preset, scope } = req.body || {};
  const list = cleanQuestions(Array.isArray(questions) ? questions : []);
  if (!list.length) {
    res.status(400);
    throw new Error("Sual göndərilmədi");
  }
  const scorableIdx = list.map((q, i) => (q && q.type !== "reading" ? i : -1)).filter((i) => i >= 0);
  if (!scorableIdx.length) {
    res.status(400);
    throw new Error("Cavab tələb edən sual yoxdur");
  }

  const redoAll = String(scope || "missing") === "all";
  /*
   * WHICH questions to solve is the builder's call when it makes one. It knows
   * its own question shapes — a gap-fill keeps its answers inside the text, a
   * table inside its cells — and this side sees a flattened copy. Re-deriving
   * "empty" here is how a paper with one blank got told it had five. The list is
   * still checked: in range, a real question, no repeats.
   */
  const asked = Array.isArray(req.body?.targets) ? req.body.targets : null;
  const blankSet = unansweredIndexes(list);
  const targets = asked
    ? [...new Set(asked.map(Number))]
        .filter((i) => Number.isInteger(i) && i >= 0 && i < list.length && list[i]?.type !== "reading")
        .sort((a, c) => a - c)
    : redoAll
      ? scorableIdx
      : scorableIdx.filter((i) => blankSet.has(i));

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const sse = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  res.write(": ok\n\n");
  const hb = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 7000);
  const finish = () => {
    clearInterval(hb);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };

  if (!targets.length) {
    // Nothing to find. Say so rather than spending a turn to confirm it.
    sse("done", { solved: 0, blanks: 0, figures: 0, usedPdf: false, nothingToDo: true });
    return finish();
  }

  try {
    /* 1. The pictures on the questions — the ones a teacher attached. */
    const { collectFigures } = require("../helper/questionFigures");
    const withPictures = list.filter(
      (q) => q && (q.image || (q.images || []).length || (q.choices || []).some((c) => c?.image))
    ).length;
    if (withPictures) sse("phase", { key: "figures", count: withPictures });
    const { parts: figures, missing: unreachable } = await collectFigures(list, { signal: req.signal });

    /* 2. ...and the source paper, when one is still attached to the exam. */
    let pdfPart = null;
    try {
      const examId = req.params?.examId;
      if (examId && require("mongoose").isValidObjectId(examId)) {
        const exam = await Exam.findOne(
          req.user.role === "admin" ? { _id: examId } : { _id: examId, owner: req.user._id }
        )
          .select("pdf")
          .lean();
        if (exam?.pdf) {
          const Pdf = require("../models/pdfModel");
          const doc = await Pdf.findById(exam.pdf).select("key size").lean();
          const { pathForKey, isValidKey } = require("../helper/examPdfStorage");
          const { CLI_READ_MAX_BYTES } = require("../helper/cliAi");
          if (doc?.key && isValidKey(doc.key) && Number(doc.size || 0) <= CLI_READ_MAX_BYTES) {
            sse("phase", { key: "pdf" });
            const buf = await require("node:fs/promises").readFile(pathForKey(doc.key));
            pdfPart = { name: "imtahan.pdf", data: buf.toString("base64"), mime: "application/pdf", isPdf: true };
          }
        }
      }
    } catch (e) {
      // A missing or unreadable source PDF is not a reason to refuse: the
      // figures on the questions may be enough on their own.
      console.warn("solveAnswers: source PDF unavailable —", e?.message);
    }

    /* 3. Batches. A short paper goes in one turn; the status is only worth the
     *    extra turns when there is a wait long enough to need it. */
    const batches = planSolveBatches(targets);
    /* The whole plan up front, from the one place that decides it. The builder
     * draws its progress bar from THIS — one segment per question the server
     * will actually solve — rather than guessing which ones it thinks are blank
     * and finding out otherwise halfway through. */
    sse("plan", { targets, batches });

    let solved = 0;
    let charged = false;
    for (let b = 0; b < batches.length; b += 1) {
      if (req.signal?.aborted) break;
      const batch = batches[b];
      sse("batch", { batch: b + 1, batches: batches.length, indexes: batch, total: targets.length });

      const { origin, sub } = batchSubPaper(list, batch);

      // Only this batch's pictures: a model handed twenty loose images for five
      // questions has to guess which is whose.
      const own = new Set(origin.map((i) => i + 1));
      const parts = [...figures.filter((f) => own.has(f.forQuestion)), ...(pdfPart ? [pdfPart] : [])];

      let out;
      try {
        /*
         * Which picture is which question, in THIS sub-paper's numbering. On the
         * CLI the files are named after the question, but in the full paper's
         * numbering, which is not the list the model is looking at; on the API
         * the pictures arrive in order with no names at all. Either way the model
         * would otherwise have to guess the pairing.
         */
        const pictureMap = parts
          .filter((p) => !p.isPdf)
          .map((p, k) => {
            const pos = origin.indexOf(p.forQuestion - 1) + 1;
            return pos > 0 ? `${k + 1}-ci şəkil (${p.name}) → siyahıdakı №${pos} sual` : null;
          })
          .filter(Boolean);
        const ask = [
          "Aşağıdakı sualların DÜZGÜN CAVABINI tap. Sualları dəyişmə — yalnız cavab sahələrini doldur.",
          pictureMap.length ? `Əlavə olunmuş şəkillər:\n${pictureMap.join("\n")}` : "",
          pdfPart ? "İmtahanın mənbə PDF-i də əlavə olunub." : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        out = await applyAnswerMode({
          questions: sub,
          mode: "ai-solve",
          preset,
          model: PLATFORM_SOLVE_MODEL,
          parts,
          system: SOLVE_SYSTEM_PROMPT,
          prompt: ask,
          signal: req.signal,
          onStatus: () => sse("phase", { key: "checking", batch: b + 1 }),
        });
      } catch (e) {
        if (req.signal?.aborted) break;
        // One bad batch must not throw away the batches that worked — report it
        // and carry on with the rest of the paper.
        sse("batchError", { batch: b + 1, indexes: batch, message: e?.userMessage || "Bu hissənin cavabları tapılmadı" });
        continue;
      }

      const got = out?.questions || [];
      if (got.length !== sub.length) {
        // A reply that dropped or added a question is not an answer key for THIS
        // paper; mapping it back by position would scramble the answers.
        sse("batchError", { batch: b + 1, indexes: batch, message: "AI sualların sayını dəyişdi — bu hissə tətbiq edilmədi" });
        continue;
      }
      const inBatch = new Set(batch);
      origin.forEach((orig, pos) => {
        if (!inBatch.has(orig)) return; // a passage carried only as context
        // The teacher's question with only the answer laid on it. Whatever
        // shape the model answered in, the card keeps the type they chose.
        const q = answerOnly(sub[pos], got[pos]);
        // Every box filled, for a question with several; otherwise the usual
        // audit. (The builder makes its own call for the card; this one decides
        // whether anything usable was produced — and so whether it is billed.)
        const found =
          (Number(q?.blanks) || 1) > 1
            ? (q.openAnswers || []).every((a) => String(a || "").trim())
            : !unansweredIndexes([q]).size;
        if (found) solved += 1;
        sse("answer", { index: orig, question: q, found });
      });
      // CR-122: a usable result is the ONLY point the reservation commits, so a
      // run that found nothing is free — and one that found something is not.
      if (solved > 0 && !charged && req.aiCredit) {
        req.aiCredit.usable();
        charged = true;
      }
    }

    await logGenerationUsage(req, { cost: null, questions: list }).catch(() => {});
    sse("done", {
      solved,
      blanks: Math.max(0, targets.length - solved),
      figures: figures.length,
      usedPdf: !!pdfPart,
      unreachableFigures: unreachable,
    });
  } catch (e) {
    console.error("solveAnswers failed:", e?.message);
    sse("error", { message: e?.userMessage || "Cavablar tapılmadı. Bir az sonra yenidən cəhd edin." });
  } finally {
    finish();
  }
});

const regenerateQuestion = asyncHandler(async (req, res) => {
  const { question, instructions, examPrompt } = req.body || {};
  if (!question || typeof question !== "object") {
    res.status(400);
    throw new Error("Sual göndərilmədi");
  }

  const hasInstr = !!(instructions && String(instructions).trim());
  // The MODEL decides how to treat the instruction — we don't keyword-match it.
  // It reads the teacher's request and chooses: apply a specific edit surgically,
  // OR (for a vague "find and fix / improve / check") diagnose and fix the
  // problems itself. With no instruction it writes a fresh variant.
  const ask = [
    hasInstr
      ? [
          "Aşağıdakı imtahan sualını müəllimin istəyinə uyğun yenidən işlə. Müəllimin istəyini ÖZÜN oxu və qərar ver:",
          "• Müəllim çox vaxt telefonda tələsik yazır: yazı səhvlərini MƏNACA oxu, hərfi mənaya ilişmə (məs. «fərqi sal soruş» çox güman «fərqli sual soruş» deməkdir; «sual dəyişsin» = sualı dəyiş).",
          "• Müəllim SUALIN ÖZÜNÜN dəyişməsini istəyirsə («dəyiş», «dəyişsin», «başqa», «fərqli», «yeni», «əvəz et», «məsələ tipində ver» və s.) → eyni mövzuda MƏZMUNCA YENİ sual yaz: başqa ədədlər/verilənlər, başqa vəziyyət və ya kontekst, yeni variantlar. Köhnə sualı bir-iki sözünü dəyişib və ya variantlarını qarışdırıb qaytarmaq QADAĞANDIR.",
          "• Müəllim KONKRET kiçik bir dəyişiklik deyibsə (məs. «6-nı 8 et», «tək seçim et», «C variantını dəyiş») → YALNIZ onu tətbiq et, sualın qalan hissəsini (mətn, variantlar, düzgün cavab, tip) OLDUĞU KİMİ saxla.",
          "• Müəllim ÜMUMİ bir şey deyibsə (məs. «problemi tap və düzəlt», «yoxla», «yaxşılaşdır», «bu düzgün deyil») → sualdakı problem(lər)i ÖZÜN müəyyən et və düzəlt (səhv/işarələnməmiş cavab; çoxmənalı açıq sualı Cm et; zəif variantlar; məzmuna uyğun olmayan tip). Mövzunu saxla.",
          "• İki cür başa düşmək mümkündürsə — kiçik hərfi düzəliş, yoxsa yeni sual — müəllimin sualı GÖRÜNƏCƏK dərəcədə dəyişmək istədiyini qəbul et: düyməni ona görə basıb.",
          "YALNIZ BİR sual qaytar.",
        ].join("\n")
      : "Aşağıdakı imtahan sualının yerinə eyni mövzuda, eyni çətinlikdə YENİ, FƏRQLİ bir sual yaz. YALNIZ BİR sual qaytar.",
    "",
    "MÖVCUD SUAL (JSON):",
    JSON.stringify(question).slice(0, 4000),
    "",
    examPrompt ? `İMTAHANIN ÜMUMİ TƏSVİRİ: ${String(examPrompt).slice(0, 500)}` : "",
    "",
    hasInstr
      ? `MÜƏLLİMİN İSTƏYİ: ${String(instructions).trim().slice(0, 1000)}`
      : "GÖSTƏRİŞ YOXDUR: eyni mövzuda, eyni çətinlikdə, TAMAMİLƏ BAŞQA bir sual yaz.",
    "",
    "QAYDALAR:",
    "- Dəqiq 1 sual qaytar (questions massivində bir element).",
    "- RİYAZİYYAT: mətndə və seçimlərdə hər düsturu tək dollar işarələri arasında yaz — $...$ (məs. \"$\\\\frac{5}{7}$\", \"$x^2$\"). $...$-siz açıq LaTeX (\\\\frac, \\\\sqrt, x^2) YAZMA və hər $ üçün bağlayan $ qoy; \"latex\" sahəsi \"\" olsun. Adi rəqəm/aralıq $ ilə yazılmır.",
    // A rewritten question must always be COMPLETE and self-consistent.
    "- ⛔ SUAL TAM VƏ DÜZGÜN OLMALIDIR: sən sualın müəllifisən — DÜZGÜN CAVABI BİLİRSƏN və MÜTLƏQ qeyd et. Tək/çox seçim (Cm/Cs) → 'correct' massivinə düzgün variant(lar)ın indeksini yaz (BOŞ BURAXMA). Açıq (Co/Cd) → 'openAnswers'-i doldur. Uyğunluq (Cma) → 'pairs' düzgün olsun. TİPİ DƏYİŞƏNDƏ (məs. açıq → tək seçim) yeni tipin BÜTÜN sahələrini tam doldur, düzgün cavabı İŞARƏLƏMƏDƏN sual qaytarma. Tək seçimə çevirəndə məntiqli 4 variant qur (biri düzgün) və düzgün olanın indeksini 'correct'-ə yaz.",
    "- Açıq (Co) YALNIZ birmənalı, hamının eyni yazacağı qısa cavab üçündür (ədəd, tək termin, düstur). Cavab çoxmənalı / təsvir / münasibətdirsə → 'Cm' et və düzgün variantı işarələ.",
    ...(hasInstr
      ? []
      : [
          "- Köhnə sualı təkrarlama — yeni sual fərqli olsun.",
          "- Verilən element OXU MƏTNİDİRSƏ (type=\"reading\"): dəqiq 1 \"reading\" elementi qaytar — mətni yenidən yaz, məqsədini və uzunluğunu təxminən saxla, abzasları \\n\\n ilə ayır. Mətndə [[cavab]] boşluqları varsa, cloze formatını saxla və boşluqları yenə [[cavab]] (və ya [[cavab|alternativ]]) kimi mətnin içində ver.",
        ]),
    // The rewrite panel is the one place a teacher explicitly asks for a
    // matching question, so the rule it is easiest to break gets repeated here.
    "- UYĞUNLUQ (Cma) yazırsansa: nömrələnmiş və hərflənmiş siyahıların MƏTNİ mütləq \"text\" içində olsun (hər element ayrı sətirdə); \"pairs\" yalnız uyğunluğu saxlayır (\"left\"=\"1\", \"right\"=\"b\"). Şagird ekranda yalnız boş 1/2/3 → A/B/C şəbəkəsini görür; \"pairs\" içindəki məzmun GÖRÜNMÜR.",
  ]
    .filter(Boolean)
    .join("\n");

  let out = null;
  try {
    out = await runGeneration({ prompt: ask, preset: req.body?.preset, model: PLATFORM_MODEL });
  } catch (e) {
    res.status(e?.aiStatus || 502);
    throw new Error(e?.userMessage || "Sual yenidən yazıla bilmədi");
  }

  const generated = cleanQuestions(out.questions || []);
  if (generated.length !== 1) {
    res.status(502);
    throw new Error("AI dəqiq bir sual qaytarmadı");
  }

  // A SURGICAL edit must not be second-guessed by the AI reviewer — it would
  // rewrite exactly the parts the teacher asked to keep. Fresh variants AND
  // audit ("find and fix") requests get the review/answer-audit pass, which
  // catches an unmarked correct answer or an un-guessable open question.
  let fresh = generated[0];
  let issues = [];
  let verified = false;
  let reviewCost = null;
  if (!hasInstr) {
    // Fresh variant: full correctness review (may improve the content freely).
    const v = await verifyAndFix({ questions: generated, prompt: ask, preset: req.body?.preset, model: PLATFORM_MODEL });
    fresh = (v.questions || [])[0] || fresh;
    issues = v.issues;
    verified = v.rounds > 0 && v.issues.length === 0;
    reviewCost = v.reviewCost;
  } else {
    // Instructed edit: the model already decided how to act. We DON'T re-review
    // the content (that would undo a surgical edit) — but we DO run the
    // deterministic STRUCTURAL check, and only if the result is actually invalid
    // (e.g. a type change that left no correct answer) do we let the reviewer
    // repair it. This is validity enforcement, not intent-guessing.
    const structIssues = auditQuestions(generated, { requireAnswers: true });
    if (structIssues.length) {
      const v = await verifyAndFix({ questions: generated, prompt: ask, preset: req.body?.preset, model: PLATFORM_MODEL });
      fresh = (v.questions || [])[0] || fresh;
      issues = v.issues;
      verified = v.issues.length === 0;
      reviewCost = v.reviewCost;
    }
  }
  if (!fresh) {
    res.status(502);
    throw new Error("AI yeni sual qaytarmadı");
  }

  /*
   * Did it actually change? A teacher who asked for the question to change and
   * got the same stem back was being told "Sual yeniləndi" about nothing (see
   * helper/questionSimilarity). Measured against the original; when the request
   * was plainly "change the question" and the result still reads the same, one
   * firmer retry. Whatever comes back, the page is told how close it is, so it
   * can say so instead of announcing a change that did not happen.
   */
  const SIM = require("../helper/questionSimilarity");
  let similarity = SIM.stemSimilarity(question.text, fresh.text);
  let retryCost = null;
  if (hasInstr && similarity >= SIM.SIMILAR_AT && SIM.asksForNewQuestion(instructions)) {
    try {
      const again = await runGeneration({
        prompt: `${ask}\n\nDİQQƏT: əvvəlki cavabın köhnə sualla demək olar EYNİ idi. Müəllim sualın özünün dəyişməsini istəyir. Eyni mövzuda, başqa verilənlərlə, məzmunca YENİ sual yaz.`,
        preset: req.body?.preset,
        model: PLATFORM_MODEL,
      });
      const [next] = cleanQuestions(again.questions || []);
      retryCost = again.cost;
      if (next && !auditQuestions([next], { requireAnswers: true }).length) {
        const s2 = SIM.stemSimilarity(question.text, next.text);
        if (s2 < similarity) {
          fresh = next;
          similarity = s2;
          issues = [];
        }
      }
    } catch (e) {
      console.warn("regenerate retry failed (keeping the first answer):", e?.message);
    }
  }
  const similar = similarity >= SIM.SIMILAR_AT;

  const cost = sumCost(sumCost(out.cost, reviewCost), retryCost);
  await logGenerationUsage(req, { ...out, cost, questions: [fresh] });

  // An edited description sent from the rewrite panel becomes the exam's
  // description from here on.
  await rememberExamPrompt(req, examPrompt);
  if (req.aiCredit) req.aiCredit.usable(); // CR-122
  res.json({ question: fresh, cost, issues, verified, similarity: Math.round(similarity * 100) / 100, similar });
});

// ============================ Teacher chat assistant ============================
// A lightweight in-dashboard helper for TEACHERS: answers "how do I do X in
// Examopia" in Azerbaijani. Uses Gemini Flash (cheap) with a Claude fallback.
// The knowledge base is baked into the system prompt for now (RAG can come later).

const CHAT_SYSTEM_PROMPT = `Sən "Examopia" platformasının köməkçisisən. Examopia müəllimlər üçün bütöv bir dərs platformasıdır: onlayn imtahan/sınaq, tapşırıq (ev işi), dərs cədvəli və davamiyyət, dərs materialları, dərs planları, dərs studiyası, lövhə, ödəniş qeydiyyatı və valideyn hesabı. İmtahanları İSTƏNİLƏN FƏNN üçün yaratmaq olar — riyaziyyat, fizika, kimya, biologiya, tarix, coğrafiya, informatika, ədəbiyyat, Azərbaycan dili, İngilis dili, rus dili və digərləri. Riyaziyyat, Azərbaycan dili və İngilis dili üçün əlavə olaraq HAZIR DİM presetləri var; digər fənlər üçün "Fərdi (sıfırdan)" preseti ilə eyni şəkildə imtahan yaradılır.
MÜHÜM: Heç vaxt "bu fənn üçün imtahan yarada bilmərəm" DEMƏ — istənilən fənn dəstəklənir.
Səninlə söhbət edən HƏMİŞƏ müəllim (və ya admin) hesabıdır — şagird və valideyn bu söhbəti görmür.

QAYDALAR:
- Cavabları HƏMİŞƏ Azərbaycan dilində, qısa, aydın və mümkünsə addım-addım ver.
- ÜSLUB — İNSANİ VƏ İSTİ: Köməksevər, enerjili bir həmkar kimi danış. Quru/robot olma; "sən" deyə müraciət et, təbii, canlı cümlələr qur, yerində 1 emoji işlət (çox yox). Müəllimin işini dəyərləndir və ruhlandır.
- SATIŞ/İTƏLƏYİCİ OL: Hər cavabın sonunda növbəti addımı FƏAL təklif et və hərəkətə ruhlandır — məs: "Gəl indi yaradaq? 💪", "Cəmi 2 dəqiqəlik işdir!", "Hazırsan, başlayaq?". İstifadəçi bir iş görməli olanda onu yumşaq itələ, sonra "Alındı? 😊" / "İşlədi?" kimi izlə. Təzyiq etmə — bir aydın çağırış kifayətdir.
- FORMAT: Cavabı oxunaqlı et. Sadə suala 1-2 cümlə ilə cavab ver — siyahı işlətmə. LAKİN bir neçə element sadalayanda (siniflər, imtahanlar, addımlar) Markdown istifadə et: nömrəli siyahı (1. 2. 3.) və ya "- " ilə tire siyahı, vacib sözlər üçün **qalın**. Hər elementi ayrı sətirdə yaz. Cədvəl istifadə etmə.
- Yalnız Examopia və müəllim işləri ilə bağlı suallara kömək et. Mövzudan kənar suallarda nəzakətlə platformaya yönləndir.
- Dəqiq bilmədiyin funksiyanı UYDURMA — düzgün bölməyə yönləndir və ya dəstəklə əlaqə saxlamağı təklif et.
- HAZIR OLMAYAN: yalnız "Dərs yolu" adlı funksiya hələ açıq deyil — soruşulsa qısaca "hələ hazır deyil, tezliklə əlavə olunacaq 🙂" de. "Yeniliklər" bölməsi ARTIQ YOXDUR, onu təklif etmə. Aşağıda sadalanan hər şey isə CANLI işləyir — onlardan sərbəst danış.
- QİYMƏT/PULSUZLUQ SUALLARI (VACİB): Qiymət, "pulsuzdur?", ödəniş və ya paket soruşulanda DÜZGÜN cavab ver — aşağıdakı "PAKETLƏR, KREDİT VƏ QİYMƏT" bölməsinə əsaslan. Başlamaq və əl ilə əsas istifadə pulsuzdur, LAKİN AI ilə imtahan/material yaratmaq kredit yeyir və Pulsuz paketdə limitlər var (Pro/Premium ödənişlidir). ƏSLA "hər şey tamamilə pulsuzdur", "ödənişli funksiya yoxdur" kimi SƏHV məlumat vermə. İstifadəçi "artıq pulsuz imtahan yarada bilmirəm" deyirsə, onu düzəlt: Pulsuz paketdə limit dolub və ya AI krediti bitib ola bilər — "Planım" səhifəsindən paketi yüksəlt və ya kredit al.

SOL MENYU — DƏQİQ ADLAR (uydurma ad işlətmə):
- Yuxarıda **İcmal**. Sonra gündəlik işlər açıq görünür: **Siniflər**, **Tapşırıqlar**, **Dərs cədvəli**, **Şagird nəticələri**, **Şagirdlərim**, **Canlı imtahan**.
- Qalanı YIĞILMIŞ qruplardadır — üstünə basıb açmaq lazımdır:
  - **Tədris materialları** qrupu: **Dərs materialları**, **Dərs planları**, **Dərs studiyası**, **Lövhə**, **Nailiyyətlərimiz**.
  - **Hesab** qrupu: **Ödənişlər**, **Valideynlər**, **Planım**, **Bağlantılar**, **Profil**, **Zibil qutusu**.
- **Gözləyən şagirdlər** sətri yalnız kimsə gözlədikdə görünür.
- Admin üçün əlavə **İdarəetmə** qrupu: **Analitika**, **Paket idarəetməsi**, **AI xərcləri**, **Sistem sağlamlığı** (adminin menyusunda "Şagirdlərim" → **İstifadəçilər**, "Şagird nəticələri" → **Nəticələr** adlanır).
- Şagird öz hesabında bunları görür: İcmal, Siniflər, Tapşırıqlar, Dərslərim, İmtahanlarım, Nəticələrim, Dərs materialları, Lövhə, Nailiyyətlərimiz, Valideynlərim, Profil.
- Valideyn öz hesabında: İcmal, Canlı imtahan, Nəticələr, Tapşırıqlar, Davamiyyət, Profil.
- Yeni iş başlamaq üçün İcmal səhifəsinin yuxarısında **Yarat** düyməsi var: **İmtahan**, **Tapşırıq**, **Dərs**, **Material**.

PLATFORMA BİLİKLƏRİ:
- SİNİF: "Siniflər" bölməsindən yeni sinif yaradılır. Hər sinfin qoşulma kodu (join code) olur; şagirdlər həmin kodla və ya paylaşılan linklə qoşulur. Sinif limiti dolu olanda yeni şagird "gözləmə siyahısına" düşür və paket yüksələndə avtomatik əlavə olunur.
- İMTAHAN YARATMAQ (YENİ ARDICILLIQ — ƏVVƏL TƏSVİR, SONDA AD):
  1. Sinfin içində **İmtahan əlavə et** və ya İcmal səhifəsində **Yarat → İmtahan**. Forma yoxdur — heç nə soruşulmur.
  2. Dərhal imtahan redaktoru açılır və üstündə **"İmtahanını təsvir et"** AI pəncərəsi çıxır. Burada nə istədiyini öz sözlərinlə yaz (mövzu, sinif səviyyəsi, sual sayı, çətinlik); istəsən hazır nümunələrdən birinə bas, "Sual strukturu"nu seç (DİM presetləri və ya "Fərdi"), sancaq düyməsi ilə PDF/şəkil əlavə et, yaxud AI mühərrikini dəyiş. AD, MÜDDƏT və TARİX BU MƏRHƏLƏDƏ SORUŞULMUR.
  3. **Sualları hazırla** bas — AI sualları yazır (PDF əlavə etmisənsə, sualları PDF-dən çıxarır). Sual yazmaq istəmirsənsə **Əl ilə yazacağam** seç.
  4. Suallar gələndə yoxla: "Redaktə et", "Sual əlavə et", "AI ilə düzəlt". Önizləmə cavab açarı ilə açılır — düzgün cavablar yaşıl görünür.
  5. Hazır olanda **Təsdiq et və nəşr et** bas. YALNIZ İNDİ ad, müddət (dəqiqə), başlama və bitmə vaxtı, həmçinin "Nəzarət rejimi" soruşulur; doldurub **Nəşr et** ilə təsdiqlə.
  6. Ən azı bir düzgün qurulmuş sual olmadan nəşr etmək mümkün deyil. Sual saxlanana qədər imtahan heç yerdə görünmür — yarımçıq qalan imtahan siyahıları zibilləmir.
- İMTAHAN PARAMETRLƏRİ: preset imtahanın balını və sual strukturunu qurur (Riyaziyyat — Buraxılış, Blok 1 və 2-ci qrup; Azərbaycan dili — 9, 11; İngilis dili — 9, 11; və ya "Fərdi (sıfırdan)"). Nəşrdən sonra imtahanı "Redaktə et" ilə açıb "Ətraflı parametrlər"dən dəyişmək olar: video həll, cəhd limiti, parol, neqativ qiymətləndirmə, nəzarət rejimi (tam ekran), sualların və variantların qarışdırılması, səhifədə sual sayı, geriyə qayıtmanın bağlanması, həll şəkilləri, ümumi/keçid balı və nəticə görünüşü (bal və düzgün cavablar dərhal, yoxsa imtahandan sonra görünsün). İngilis dili imtahanlarına dinləmə (mp3) faylı əlavə etmək olar. İmtahanlar həmişə şagirdlər üçün pulsuzdur.
- CANLI İMTAHAN: "Canlı imtahan" bölməsində imtahanı yazan şagirdləri real vaxtda izləmək olar — kim başlayıb, neçə sual cavablayıb, tam ekrandan çıxıb-çıxmayıb. Bütün paketlərdə pulsuzdur.
- NƏTİCƏLƏR: "Şagird nəticələri" bölməsində nəticələr görünür, imtahan üzrə ayrıca cədvəl və Excel ixracı var; hər işi açıb şagirdin cavablarını görmək olar.
- TAPŞIRIQLAR (ev işi): "Tapşırıqlar" bölməsindən sinfə tapşırıq verilir — mətn, son tarix və fayl. Şagird istənilən formatda (şəkil, PDF, Word) iş yükləyir; müəllim işi açıb üstündə işarələyir və qiymət yazır. Gecikənlər ayrıca görünür.
- DƏRS CƏDVƏLİ və DAVAMİYYƏT: "Dərs cədvəli" bölməsində dərslər təqvimə yazılır (vaxt, sinif, mövzu). Hər dərsin QR kodu olur — şagird QR-i oxudub dərsə qeydiyyatdan keçir, davamiyyət avtomatik yığılır. Valideyn davamiyyəti öz hesabında görür.
- ÖDƏNİŞLƏR: "Ödənişlər" bölməsi müəllimin şagirdlərdən aldığı dərs haqqını qeyd etmək üçündür — kim ödəyib, kim borcludur, sinif üzrə. Bu, Examopia paketinin ödənişi DEYİL (o, "Planım"dadır).
- DƏRS MATERİALLARI: "Dərs materialları" kitabxanadır — sənəd (PDF, Word, şəkil) və video yerləşdirmək olar. Video ya YouTube linki, ya da birbaşa yüklənən MP4/WebM olur (video yükləmə yalnız Premium paketdə). Materialı sinfə paylaşmaq və ya link ilə göndərmək olar.
- DƏRS PLANLARI: "Dərs planları" bölməsi dərsin gedişatını hazırlayır — məqsəd, mərhələlər, çalışmalar. AI dərsliyin PDF-inə istinadla plan təklif edir; təklif AVTOMATİK YAZILMIR, sən oxuyub qəbul edirsən.
- DƏRS STUDİYASI: "Dərs studiyası"nda AI ilə söhbət edərək iş vərəqi və ya material yazırsan, sonra Word və ya PDF kimi yükləyirsən.
- LÖVHƏ: "Lövhə" bölməsi dərsdə çəkmək üçün rəqəmsal lövhədir; lövhələr yadda qalır və sonra açılır. Bir lövhəni həddən artıq şişirtməmək üçün hər mövzuya yeni lövhə açmaq daha yaxşıdır.
- VALİDEYN: "Valideynlər" bölməsindən şagirdin valideyni hesaba bağlanır. Valideyn öz hesabından övladının nəticələrini, tapşırıqlarını, davamiyyətini və canlı imtahanını görür; WhatsApp bildirişləri platformanın nömrəsindən gedir (Pro və Premium).
- BAĞLANTILAR: "Bağlantılar" bölməsində müəllim ÖZ WhatsApp nömrəsini qoşur (yalnız Premium) — bildirişlər onda müəllimin nömrəsindən gedir.
- ZİBİL QUTUSU: silinmiş və ya arxivlənmiş imtahanlar burada qalır və geri qaytarıla bilər.
- BƏLƏDÇİ: İcmal səhifəsindəki **Bələdçini izlə** düyməsi addım-addım video dərsliklər qalereyasını açır.
- PROFİL: şifrə və hesab məlumatları burada. Etibarlı cihaz aktivdirsə, növbəti dəfə giriş səhifəsində hesabın üstünə basmaqla şifrəsiz daxil olmaq olar.

PAKETLƏR, KREDİT VƏ QİYMƏT (VACİB — DÜZGÜN MƏLUMAT VER, UYDURMA):
- Hesab açmaq və başlamaq PULSUZDUR. Şagirddən heç vaxt pul alınmır. LAKİN müəllimlər üçün paketlər və AI kreditləri var.
- 3 paket:
  - **Pulsuz** — 1 sinif, 10 şagird, ömürlük cəmi 3 imtahan yaratma, 2 aktiv tapşırıq, 5 material. 60 xoş gəldin krediti və ayda 20 kredit.
  - **Pro** (15 ₼/ay) — 5 sinif, 40 şagird, limitsiz imtahan, 30 tapşırıq, 50 material, ayda 350 kredit, tam analitika, PDF ixracı, valideyn WhatsApp bildirişləri.
  - **Premium** (20 ₼/ay) — limitsiz sinif, şagird, imtahan, tapşırıq və material, ayda 2000 kredit, video yükləmə və öz WhatsApp nömrəni qoşmaq.
- Paketi "Planım" səhifəsindən yüksəltmək olar; ödəniş kartdan-karta (m10/bank) aparılır, "Ödədim" düyməsi basılır, komanda yoxlayıb aktivləşdirir.
- AI KREDİTLƏRİ (dəqiq qiymətlər): AI ilə imtahan yaratmaq və ya PDF-dən sual çıxarmaq **10 kredit**; bir sualı AI ilə dəyişmək **2 kredit**; dərs planı hazırlamaq **6 kredit**; Dərs studiyasında yeni material yaratmaq **6 kredit**, mövcud materialı dəyişmək **2 kredit**. Mənimlə söhbət, ƏL İLƏ imtahan/tapşırıq yaratmaq, redaktə, paylaşma, qiymətləndirmə, davamiyyət və lövhə PULSUZDUR (kredit yemir).
- Balans yuxarıda başlıqda görünür; kredit bitəndə "Planım" səhifəsindən kredit al: +100 kredit 5 ₼, +300 kredit 12 ₼.
- LİMİTLƏR: Pulsuz paketdə limitə çatanda YENİ yaratmaq üçün paketi yüksəltmək lazımdır — MÖVCUD siniflər, imtahanlar, tapşırıqlar və şagirdlər qalır, itmir. Tapşırıq və material limiti "eyni vaxtda" sayılır: birini silsən, yer boşalır.

İMTAHAN YARATMA NİYYƏTİ: Əgər istifadəçi YENİ imtahan və ya sınaq YARATMAQ/açmaq/hazırlamaq istəyirsə (yazılış səhv olsa belə, məs. "imtnana yaratmaq isteyirem"), UZUN addım-addım izahat VERMƏ. Bunun əvəzinə YALNIZ qısa bir cümlə yaz (məs: "Əla, imtahan formasını açıram 👇") və cavabın ƏN SONUNDA ayrıca sətirdə tam olaraq bu markeri əlavə et:
<<CREATE_EXAM>>{"description":"<istifadəçi hansı mövzu/sualları istəyirsə qısa yaz; detal deməyibsə boş string>"}
Marker JSON düzgün olmalıdır. Əgər istifadəçi sadəcə "necə yaradılır?" kimi izah istəyirsə (yaratmaq yox), markeri YAZMA — normal izah ver.

HESABA BAXMAQ (AGENTİK — ÇOX VACİB): Sən əsl agentsən. Siniflər, imtahanlar, tarixlər, saylar haqqında İSTƏNİLƏN sual üçün əvvəlcə "get_account_overview" alətini çağır — bu, BÜTÜN sinifləri və hər sinfin İÇİNDƏ olan imtahanları (id, ad, tarix, bal, parametrlər) tam qaytarır. Sonra həmin strukturu ÖZÜN oxuyub cavab ver. Cavab verməzdən əvvəl HƏMİŞƏ tam mənzərəni gör. ƏSLA "platformaya daxil ol / görə bilmirəm" DEMƏ.
- SAYLARI özün sayma — hazır rəqəmləri işlət: ümumi sinif sayı = "classCount", ümumi imtahan sayı = "totalExams", bir sinfin imtahan sayı = həmin sinfin "examCount"-u. Siyahını nömrələyəndə ardıcıl artır (1, 2, 3, …), hər dəfə "1." yazma.
- Bir sinfin imtahanlarını sadalayanda YALNIZ həmin sinfin "exams" massivindəki imtahanları göstər — başqa siniflərinkini qarışdırma.
- Ad uyğunluğunu özün müəyyən et: yazılış/böyük-kiçik hərf/ə-e/ı-i/ş-s fərqinə fikir vermə ("Buraxılış"="Buraxilis"). Sinfi adı VƏ YA qoşulma kodu ilə tanı; eyni adlı iki sinifi kodları ilə fərqləndir.

İMTAHANI DƏYİŞMƏK: Əvvəlcə get_account_overview ilə düzgün imtahanı (və onun id-sini) tap, sonra "update_exam" alətini həmin id ilə çağır, qısa təsdiqlə. Nisbi tarixləri (sabah, bu gün) yuxarıdakı BUGÜN sətrinə görə hesabla və tarixləri həmin sətirdəki UTC ofseti ilə ISO formatda ver. Bir neçə uyğun imtahan varsa hansını nəzərdə tutduğunu SORUŞ.`;

// Sanitise the client-sent history: keep only user/assistant text turns, cap it.
function cleanChatMessages(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 4000) }));
}

async function chatWithGemini(messages) {
  if (!process.env.GEMINI_API_KEY)
    throw aiError(503, "AI köməkçisi konfiqurasiya olunmayıb (GEMINI_API_KEY)", true);
  const model = process.env.GEMINI_CHAT_MODEL || GEMINI_MODEL;
  const body = {
    systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  let r, data;
  try {
    r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify(body),
      }
    );
    data = await r.json();
  } catch (e) {
    throw aiError(502, "AI köməkçisi cavab vermədi, bir azdan yenidən cəhd edin", true);
  }
  if (!r.ok || data?.error) {
    throw aiError(r.status || 502, "AI köməkçisi hazırda əlçatan deyil", true);
  }
  const text =
    (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text)
      .filter(Boolean)
      .join("") || "";
  return { text, cost: computeGeminiCost(data.usageMetadata, model) };
}

async function chatWithClaude(messages) {
  const client = getClient();
  if (!client) throw aiError(503, "AI köməkçisi konfiqurasiya olunmayıb");
  const model = process.env.CLAUDE_CHAT_MODEL || "claude-haiku-4-5-20251001";
  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    system: CHAT_SYSTEM_PROMPT,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  const text = (msg.content || [])
    .map((b) => b.text)
    .filter(Boolean)
    .join("");
  const u = msg.usage || {};
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  // Haiku pricing (approx USD / 1M): far cheaper than Opus extraction.
  const usd = (input * 1 + output * 5) / 1e6;
  return {
    text,
    cost: {
      model,
      inputTokens: input,
      outputTokens: output,
      cacheWriteTokens: u.cache_creation_input_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      totalTokens: input + output,
      usd: Number(usd.toFixed(4)),
    },
  };
}

function computeOpenAiCost(u, model) {
  const input = u?.prompt_tokens || 0;
  const output = u?.completion_tokens || 0;
  // gpt-4o-mini default pricing (USD / 1M): 0.15 in / 0.60 out. Env-overridable.
  const inP = Number(process.env.OPENAI_PRICE_IN || 0.15);
  const outP = Number(process.env.OPENAI_PRICE_OUT || 0.6);
  return {
    model,
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: 0,
    cacheReadTokens: u?.prompt_tokens_details?.cached_tokens || 0,
    totalTokens: u?.total_tokens || input + output,
    usd: Number(((input * inP + output * outP) / 1e6).toFixed(4)),
  };
}

async function chatWithOpenAI(messages) {
  if (!process.env.OPENAI_API_KEY)
    throw aiError(503, "AI köməkçisi konfiqurasiya olunmayıb (OPENAI_API_KEY)", true);
  const model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
  let r, data;
  try {
    r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: CHAT_SYSTEM_PROMPT }, ...messages],
        max_tokens: 1024,
        temperature: 0.4,
      }),
    });
    data = await r.json();
  } catch (e) {
    throw aiError(502, "AI köməkçisi cavab vermədi, bir azdan yenidən cəhd et", true);
  }
  if (!r.ok || data?.error) {
    throw aiError(r.status || 502, "AI köməkçisi hazırda əlçatan deyil", true);
  }
  const text = data.choices?.[0]?.message?.content || "";
  return { text, cost: computeOpenAiCost(data.usage, model) };
}

// Provider dispatch for the chat assistant. Order = AI_CHAT_PROVIDER first (if
// set), then the rest as fallbacks. Unconfigured providers are skipped; a
// transient error (aiFallback) rolls on to the next provider.
async function runChat(messages) {
  /*
   * The chat obeys the setting too. It was the clearest omission in the first
   * version: an admin could set CLI, watch the chat keep answering, and have no
   * idea it was still on the API the whole time.
   */
  return runAi({
    label: "chat",
    capability: "structured",
    cli: async (cliProvider) => {
      const { runCliChat } = require("../helper/cliAi");
      return runCliChat({ provider: cliProvider, messages, model: process.env.AI_CHAT_CLI_MODEL });
    },
    api: () => runChatOnApi(messages),
  });
}

async function runChatOnApi(messages) {
  const order = [];
  if (process.env.AI_CHAT_PROVIDER) order.push(process.env.AI_CHAT_PROVIDER);
  ["openai", "gemini", "claude"].forEach((p) => order.includes(p) || order.push(p));
  let lastErr;
  for (const p of order) {
    try {
      if (p === "openai" && process.env.OPENAI_API_KEY) return await chatWithOpenAI(messages);
      if (p === "gemini" && process.env.GEMINI_API_KEY) return await chatWithGemini(messages);
      if (p === "claude" && getClient()) return await chatWithClaude(messages);
    } catch (e) {
      lastErr = e;
      if (!e.aiFallback) throw e; // hard error → stop
    }
  }
  throw lastErr || aiError(503, "AI köməkçisi konfiqurasiya olunmayıb");
}

// ---- Tool-calling agent: lets the assistant find + edit the teacher's exams ----
const escapeRegex = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// UTC offset (e.g. "+04:00") of a timezone at a given moment — DST-aware.
function tzOffset(tz, date = new Date()) {
  try {
    const local = new Date(date.toLocaleString("en-US", { timeZone: tz }));
    const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
    const mins = Math.round((local - utc) / 60000);
    const sign = mins >= 0 ? "+" : "-";
    const a = Math.abs(mins);
    return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
  } catch {
    return "+00:00";
  }
}

// Current date/time hint in the USER's timezone so the model resolves "tomorrow"
// / "today" correctly wherever they are. Falls back to Asia/Baku.
function azDateHint(tz) {
  const zone = tz || "Asia/Baku";
  try {
    const now = new Date();
    const s = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(now);
    const off = tzOffset(zone, now);
    return `BUGÜN (istifadəçinin saat qurşağı: ${zone}, UTC${off}): ${s}. "Sabah" = bir gün sonra, "bu gün" = həmin gün. Nisbi tarixləri bu vaxta görə hesabla və tarixləri ISO formatda ${off} ofseti ilə ver.`;
  } catch {
    return "";
  }
}

const EXAM_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_account_overview",
      description:
        "Returns the FULL picture of the account: every class the user can see (id, name, join code, student count) with ITS exams nested inside (each exam's id, name, dates, duration, marks, and all settings). Call this FIRST for ANY question about classes, exams, counts, dates, or before editing. You then read this structure and answer/act — no name searching needed.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_exam",
      description:
        "Update settings of ONE exam the teacher owns. Only include the fields to change. Dates must be ISO with the user's UTC offset (from the BUGÜN line in the system prompt). Send password:'' to remove a password.",
      parameters: {
        type: "object",
        properties: {
          examId: { type: "string" },
          startDate: { type: "string", description: "ISO datetime with the user's offset, or '' to clear" },
          endDate: { type: "string", description: "ISO datetime with the user's offset, or '' to clear" },
          durationMinutes: { type: "number" },
          totalMarks: { type: "number" },
          passingMarks: { type: "number" },
          negativeMarking: { type: "boolean" },
          antiCheat: { type: "boolean" },
          password: { type: "string" },
          maxTry: { type: "number", description: "0 = unlimited" },
          showScore: { type: "boolean" },
          showCorrectAnswers: { type: "boolean" },
          revealAfterEnd: { type: "boolean", description: "true = show answers only after end date" },
        },
        required: ["examId"],
      },
    },
  },
];

async function toolOverview(user) {
  const isAdmin = user.role === "admin";
  const scope = isAdmin ? {} : { owner: user._id };
  // Admin scope is the ENTIRE platform — cap it so a large account can't blow up
  // the model context (token cost + prompt-injection surface). Teachers are
  // naturally bounded to their own data.
  const CAP = isAdmin ? Number(process.env.AI_OVERVIEW_MAX || 200) : 0;
  const cQ = Class.find(scope).sort({ createdAt: -1 });
  const eQ = Exam.find(scope).sort({ createdAt: -1 });
  if (CAP) {
    cQ.limit(CAP);
    eQ.limit(CAP);
  }
  const [classes, exams] = await Promise.all([cQ.lean(), eQ.lean()]);
  const ids = classes.map((c) => c._id);
  const enr = ids.length
    ? await Enrollment.aggregate([
        { $match: { class: { $in: ids }, status: "approved" } },
        { $group: { _id: "$class", n: { $sum: 1 } } },
      ])
    : [];
  const stu = {};
  enr.forEach((e) => (stu[String(e._id)] = e.n));
  const byClass = {};
  exams.forEach((e) => {
    const k = String(e.class || "unassigned");
    (byClass[k] = byClass[k] || []).push(e);
  });
  const fmt = (e) => ({
    id: String(e._id),
    name: e.name,
    mode: e.mode,
    startDate: e.startDate,
    endDate: e.endDate,
    durationMinutes: Math.round((e.duration || 0) / 60),
    totalMarks: e.totalMarks,
    passingMarks: e.passingMarks,
    negativeMarking: !!e.negativeMarking,
    antiCheat: !!e.antiCheat,
    hasPassword: !!e.password,
    maxTry: e.maxTry,
    showScore: e.showScore,
    showCorrectAnswers: e.showCorrectAnswers,
    revealAfterEnd: e.revealAfterEnd,
  });
  return {
    classCount: classes.length,
    totalExams: exams.length,
    truncated: CAP ? classes.length >= CAP || exams.length >= CAP : false,
    classes: classes.map((c) => ({
      id: String(c._id),
      name: c.name,
      joinCode: c.joinCode,
      students: stu[String(c._id)] || 0,
      examCount: (byClass[String(c._id)] || []).length,
      exams: (byClass[String(c._id)] || []).map(fmt),
    })),
    unassignedExams: (byClass["unassigned"] || []).map(fmt),
  };
}

async function toolUpdateExam(args, user) {
  const exam = await Exam.findById(args.examId);
  if (!exam) return { error: "İmtahan tapılmadı" };
  if (user.role !== "admin" && String(exam.owner) !== String(user._id))
    return { error: "Bu imtahanı dəyişməyə icazən yoxdur" };
  const applied = {};
  const set = (k, v) => {
    exam[k] = v;
    applied[k] = v;
  };
  if (args.durationMinutes != null) set("duration", Math.max(0, Math.round(Number(args.durationMinutes) || 0)) * 60);
  if (args.startDate !== undefined) set("startDate", args.startDate ? new Date(args.startDate) : null);
  if (args.endDate !== undefined) set("endDate", args.endDate ? new Date(args.endDate) : null);
  if (args.totalMarks != null) set("totalMarks", Number(args.totalMarks));
  if (args.passingMarks != null) set("passingMarks", Number(args.passingMarks));
  if (args.negativeMarking != null) set("negativeMarking", !!args.negativeMarking);
  if (args.antiCheat != null) set("antiCheat", !!args.antiCheat);
  if (args.password !== undefined) set("password", String(args.password || ""));
  if (args.maxTry != null) set("maxTry", Math.max(0, Number(args.maxTry) || 0));
  if (args.showScore != null) set("showScore", !!args.showScore);
  if (args.showCorrectAnswers != null) set("showCorrectAnswers", !!args.showCorrectAnswers);
  if (args.revealAfterEnd != null) set("revealAfterEnd", !!args.revealAfterEnd);
  if (!Object.keys(applied).length) return { error: "Dəyişiləcək sahə göstərilmədi" };

  // Consistency guard: the AI (or a misheard voice command) must not be able to
  // leave the exam in an impossible state.
  const errs = [];
  if (Number(exam.totalMarks) < 0) errs.push("ümumi bal mənfi ola bilməz");
  if (Number(exam.passingMarks) < 0) errs.push("keçid balı mənfi ola bilməz");
  if (
    exam.totalMarks != null &&
    exam.passingMarks != null &&
    Number(exam.passingMarks) > Number(exam.totalMarks)
  )
    errs.push("keçid balı ümumi baldan çox ola bilməz");
  if (
    exam.startDate &&
    exam.endDate &&
    new Date(exam.startDate).getTime() >= new Date(exam.endDate).getTime()
  )
    errs.push("başlama tarixi bitmə tarixindən əvvəl olmalıdır");
  if (Number(exam.maxTry) < 0) errs.push("cəhd limiti mənfi ola bilməz");
  if (errs.length) return { error: "Dəyişiklik tətbiq olunmadı: " + errs.join(", ") };

  await exam.save();
  // Audit trail: the AI just mutated a live exam — record WHO changed WHAT so an
  // unexpected (e.g. prompt-injected) edit is traceable in the server logs.
  console.info(
    `[AI_EXAM_EDIT] user=${user._id} role=${user.role} exam=${exam._id} applied=${JSON.stringify(applied)}`
  );
  return { ok: true, examId: String(exam._id), name: exam.name, applied };
}

async function execTool(name, args, user) {
  try {
    if (name === "get_account_overview") return await toolOverview(user);
    if (name === "update_exam") return await toolUpdateExam(args, user);
  } catch (e) {
    return { error: e.message || "Əməliyyat alınmadı" };
  }
  return { error: "unknown tool" };
}

// OpenAI chat WITH tools — runs the tool loop so the assistant can act (edit
// exams). Returns the final text + accumulated cost. `changed` flags whether any
// exam was mutated (so the client can refresh).
async function runChatAgent(messages, user, tz) {
  /*
   * The agent calls OUR tools between turns - the same reason the lesson-document
   * agent is API-only. Declared, not skipped: the setting is applied here, and
   * the capability says why the answer is always the API.
   */
  return runAi({
    label: "chat-agent",
    capability: "tools",
    api: () => runChatAgentOnApi(messages, user, tz),
  });
}

async function runChatAgentOnApi(messages, user, tz) {
  const model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
  const convo = [{ role: "system", content: `${CHAT_SYSTEM_PROMPT}\n\n${azDateHint(tz)}` }, ...messages];
  let inTok = 0;
  let outTok = 0;
  let changed = false;
  for (let step = 0; step < 6; step++) {
    let r, data;
    try {
      r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model, messages: convo, tools: EXAM_TOOLS, tool_choice: "auto", temperature: 0.3, max_tokens: 1024 }),
      });
      data = await r.json();
    } catch (e) {
      throw aiError(502, "AI köməkçisi cavab vermədi", true);
    }
    if (!r.ok || data?.error) throw aiError(r.status || 502, data?.error?.message || "AI köməkçisi əlçatan deyil", true);
    const u = data.usage || {};
    inTok += u.prompt_tokens || 0;
    outTok += u.completion_tokens || 0;
    const msg = data.choices?.[0]?.message;
    // No message in the response → don't push undefined into the next request
    // (that itself 400s at OpenAI). Fall back to the tool-less chat instead.
    if (!msg) throw aiError(502, "AI köməkçisi cavab vermədi", true);
    convo.push(msg);
    if (msg?.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let a = {};
        try {
          a = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* bad args */
        }
        const result = await execTool(tc.function.name, a, user);
        if (tc.function.name === "update_exam" && result?.ok) changed = true;
        convo.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }
    const inP = Number(process.env.OPENAI_PRICE_IN || 0.15);
    const outP = Number(process.env.OPENAI_PRICE_OUT || 0.6);
    return {
      text: msg?.content || "",
      changed,
      cost: {
        model,
        inputTokens: inTok,
        outputTokens: outTok,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: inTok + outTok,
        usd: Number(((inTok * inP + outTok * outP) / 1e6).toFixed(4)),
      },
    };
  }
  return { text: "Bağışla, əməliyyatı tamamlaya bilmədim — yenidən cəhd et.", changed, cost: { model } };
}

// POST /api/quiz/chat  (teacher-only) — { messages:[{role,content}] } -> { reply, cost }
const chatAssistant = asyncHandler(async (req, res) => {
  const messages = cleanChatMessages(req.body?.messages);
  if (!messages.length) {
    res.status(400);
    throw new Error("Mesaj boşdur");
  }

  let out;
  try {
    // With OpenAI, use the tool-calling agent (can find + edit exams). Otherwise
    // fall back to the plain multi-provider chat.
    const tz = typeof req.body?.timezone === "string" ? req.body.timezone : undefined;
    out = process.env.OPENAI_API_KEY
      ? await runChatAgent(messages, req.user, tz)
      : await runChat(messages);
  } catch (e) {
    if (e.aiFallback) {
      try {
        out = await runChat(messages);
      } catch (e2) {
        res.status(e2.aiStatus || 502);
        throw new Error(e2.userMessage || "AI köməkçisi cavab vermədi");
      }
    } else {
      res.status(e.aiStatus || 502);
      throw new Error(e.userMessage || "AI köməkçisi cavab vermədi");
    }
  }

  // Log spend so it shows in the admin AI usage dashboard (best-effort).
  try {
    const c = out.cost || {};
    await AiUsage.create({
      user: req.user._id,
      model: c.model,
      inputTokens: c.inputTokens || 0,
      outputTokens: c.outputTokens || 0,
      cacheWriteTokens: c.cacheWriteTokens || 0,
      cacheReadTokens: c.cacheReadTokens || 0,
      totalTokens: c.totalTokens || 0,
      usd: c.usd || 0,
      questions: 0,
    });
  } catch (e) {
    console.error("chat usage log failed:", e?.message);
  }

  if (req.aiCredit) req.aiCredit.usable(); // CR-122
  res.json({ reply: out.text, cost: out.cost, changed: !!out.changed });
});

// POST /api/quiz/transcribe (teacher) — audio file -> { text }. OpenAI Whisper
// with language=az so Azerbaijani speech is transcribed correctly.
const transcribeAudio = asyncHandler(async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    res.status(503);
    throw new Error("Səs tanıma konfiqurasiya olunmayıb (OPENAI_API_KEY)");
  }
  if (!req.file || !req.file.buffer?.length) {
    res.status(400);
    throw new Error("Səs faylı yoxdur");
  }
  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" }),
    req.file.originalname || "audio.webm"
  );
  fd.append("model", model);
  fd.append("language", "az"); // Azerbaijani

  let r, data;
  try {
    r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });
    data = await r.json();
  } catch (e) {
    res.status(502);
    throw new Error("Səs tanınmadı, yenidən cəhd et");
  }
  if (!r.ok || data?.error) {
    res.status(r.status || 502);
    throw new Error(data?.error?.message || "Səs tanınmadı");
  }
  if (req.aiCredit) req.aiCredit.usable(); // CR-122
  res.json({ text: data.text || "" });
});

// POST /api/quiz/realtime-token (teacher) — mints a short-lived ephemeral token
// for an OpenAI Realtime TRANSCRIPTION session (Azerbaijian, gpt-4o-transcribe),
// so the browser can stream mic audio directly to OpenAI and get live captions.
const realtimeToken = asyncHandler(async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    res.status(503);
    throw new Error("Realtime konfiqurasiya olunmayıb (OPENAI_API_KEY)");
  }
  const model = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
  let r, data;
  try {
    r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model, language: "az" },
              turn_detection: { type: "server_vad" },
            },
          },
        },
      }),
    });
    data = await r.json();
  } catch (e) {
    res.status(502);
    throw new Error("Realtime sessiya yaradıla bilmədi");
  }
  if (!r.ok || data?.error) {
    res.status(r.status || 502);
    throw new Error(data?.error?.message || "Realtime sessiya alınmadı");
  }
  if (req.aiCredit) req.aiCredit.usable(); // CR-122: usable realtime session token
  res.json({ token: data?.value, expires_at: data?.expires_at });
});

module.exports = {
  regenerateQuestion,
  solveAnswers,
  planSolveBatches,
  answerOnly,
  SOLVE_SYSTEM_PROMPT,
  batchSubPaper,
  // exported for tests / benchmarking
  GEN_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  EXTRACT_CLI_PROMPT,
  EXTRACTION_SCHEMA,
  DOCUMENT_SCHEMA,
  PLATFORM_SOLVE_MODEL,
  unguessFigures,
  runGeneration,
  runMultiPassage,
  detectPassageCount,
  extractWithGemini,
  extractWithOpenAI,
  // exported for helper/aiDocument.js (the parallel document path) and its tests
  claudeContentParts,
  openaiContentParts,
  geminiContentParts,
  computeCost,
  computeGeminiCost,
  computeOpenAIGenCost,
  findAiModel,
  DEFAULT_AI_MODEL,
  GEMINI_DOC_MODEL,
  GEMINI_SCHEMA,
  // exported for tests
  cleanQuestions,
  auditQuestions,
  parseRequestedCount,
  hasMathLeak,
  stripAnswers,
  applyAnswerMode,
  verifyAndFix,
  planParallelSolve,
  sumCost,
  extractQuestions,
  extractQuestionsStream,
  getAiUsage,
  chatAssistant,
  generateQuestions,
  generateQuestionsStream,
  transcribeAudio,
  realtimeToken,
};
