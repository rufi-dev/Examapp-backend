const asyncHandler = require("express-async-handler");
const AnthropicPkg = require("@anthropic-ai/sdk");
// CJS interop: the constructor is the default export on recent builds.
const Anthropic = AnthropicPkg.default || AnthropicPkg;
const AiUsage = require("../models/aiUsageModel");
const User = require("../models/userModel");
const { aiExecution, cliOrder, isCoolingDown, standDown, runCliStructured, fixJsonEscapes } = require("../helper/cliAi");
const {
  cleanQuestions,
  auditQuestions,
  unansweredIndexes,
  answerOnly,
  parseRequestedCount,
  questionKey,
  REVIEW_SYSTEM_PROMPT,
  SOLVE_SYSTEM_PROMPT,
} = require("../helper/aiQuality");

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
          // Cm = single-choice, Cs = multi-select, Co = open, Cma = matching.
          type: { type: "string", enum: ["Cm", "Cs", "Co", "Cd", "Cma"] },
          text: { type: "string" },
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
          // Open (Co): EVERY acceptable answer as its own array item (variants,
          // synonyms, spaced/unspaced forms). Empty for non-open questions.
          openAnswers: { type: "array", items: { type: "string" } },
          explanation: { type: "string" },
        },
        required: [
          "type",
          "text",
          "latex",
          "choices",
          "correct",
          "pairs",
          "hasFigure",
          "openAnswer",
          "openAnswers",
          "explanation",
        ],
      },
    },
  },
  required: ["questions"],
};

// The extraction rules: Examopia's (ported 2026-11-08) without its reading-passage,
// text-formatting, manual-grading and Az-dili-paper rules, plus an explicit
// "never correct the teacher's spelling" and BunkerMath's explanation field.
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
- FAITHFUL TEXT: reproduce the wording EXACTLY as printed — same words, same order, same punctuation. Do NOT correct spelling, grammar or typos and never reword, shorten or drop a word — copy it exactly as printed, even where it looks wrong. Keep every special symbol/marker exactly where it appears in the line: paragraph icons/bullets (▲ ■ ● ► ◆ ★ • ♦), Roman-numeral paragraph labels (I, II, III, IV …), and footnote/superscript numbers. Never drop, move, or normalize any of these.
- PRESERVE LINE BREAKS inside "text": keep the document's line structure for the question STATEMENT. Put each numbered statement item that is PART OF THE QUESTION (e.g. 1., 2., 3., … or I., II., III. sub-statements) on its own line using a real newline (\\n), and keep a blank line between distinct statement groups. NEVER collapse a multi-line question into a single line. Do NOT put the answer options (the A/B/C/D/E choices) in "text" at all — they belong ONLY in "choices".
- TABLES & DIAGRAMS → PHOTO (do NOT reproduce them): if a question contains a TABLE/grid (Doğrudur/Yanlışdır, Səbəb/Nəticə, Müddəa/Faktlar, "cədvəli tamamlayın", müqayisə cədvəli, any column grid), a Venn/Euler diagram, a chart/graph, or a syntactic-analysis scheme, set "hasFigure": true and DO NOT try to rebuild it as text or markdown — the teacher will add a photo of it from the PDF. Still extract the question's instruction text (and the A–E "choices" if the question has them). This keeps extraction simple and accurate.
- "latex": ALWAYS return an empty string "". All math now lives inline inside the text fields, never in a separate field.
- "choices": for Cm/Cs, one object per option in the order shown (drop the A/B/C labels — they are implicit by position). Put each option's text in "text" with any math inline via $...$ (e.g. "$9ab$", "2500"). Set the choice "latex" to "". The options live ONLY here — never repeat them inside the question "text". For Co/Cma, use an empty array.
- OPTION CONTENT (important): each answer option's FULL text goes in its "choices" entry EXACTLY as printed — even if the option is long or spans several lines (e.g. a poem couplet, a whole sentence). NEVER replace an option with just its letter, and NEVER dump the list of options into the question "text". The question "text" holds only the instruction (+ any numbered items the question asks about).
- DIAGRAM / SCHEME OPTIONS: if the answer options THEMSELVES are pictures (e.g. the A–E syntactic-analysis line/arc schemes under a sentence), you cannot transcribe them — set "hasFigure": true and output each choice as JUST its letter ("A", "B", "C", "D", "E") so the teacher can add the picture of the options.
- "correct": indices (0-based) into "choices" of the correct option(s) — ONLY if the PDF itself marks/states the correct answer (e.g. an answer key, a highlighted option, or a stated solution). If the correct answer is NOT given in the PDF, return an EMPTY array. NEVER guess or solve the question to fill this — leave it empty for the teacher to mark.
- NEVER PACK A SET OR A PAIRING INTO AN OPEN ANSWER. If the correct answer can only be written as a list of item numbers ("2,5"), or as a number–letter sequence ("1b2d3c", "1-b, 2-d"), the question is NOT open (Co/Cd). Pick the structured type instead — the app marks those automatically, while an open answer forces the student to type the exact string:
  • A numbered list (1., 2., 3. …) that the student must pick from, with NO uppercase A–E answer variants → "Cs", NOT "Cm". Each numbered item becomes its own "choices" entry, IN ORDER, WITHOUT its number; "correct" holds the 0-based indexes (answer "2,5" over five items → correct: [1, 4]). Do not leave the items in "text". Use "Cs" even when you cannot tell how many are correct: the paper only shows A–E variants when exactly one answer is wanted, so a bare numbered list means "select every one that applies". "Cm" REQUIRES uppercase A–E variants to choose between.
  • A numbered list PLUS a separate lettered list (a., b., c. …) with NO uppercase A–E answer variants → "Cma", one "pairs" entry per number (answer "1b2d3c" → pairs 1→b, 2→d, 3→c).
  Reserve Co/Cd for answers a student genuinely writes out: a number, a word, a formula.
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
- SCOPE / FILTER: the teacher's extra instructions (provided separately) take priority over plain document order. If they ask for only a specific subject, section, page range, or question range, extract ONLY what they ask for and SKIP everything else in the PDF — even content that appears in between. If they give no such limit, extract every question in document order as usual.

- "explanation": a worked solution/explanation (math inline via $...$) ONLY if the PDF provides one; otherwise "".

Transcribe faithfully. Do not invent questions, options, or answers. If the PDF is a question bank with no answer key, every "correct" array is empty and that is correct.`;

// Optional per-extraction instructions the teacher typed. We bound the length so
// a runaway paste can't blow the context, and frame them as ADDITIONS that must
// not override the schema/output contract above.
const clampInstr = (s) => String(s ?? "").trim().slice(0, 4000);
const instructionBlock = (instr) =>
  instr
    ? `\n\n--- MÜƏLLİMİN ƏLAVƏ TƏLİMATLARI (bunlara əməl et, amma yuxarıdakı JSON sxemini və qaydaları POZMA) ---\n${instr}`
    : "";

// ---- Subscription CLIs (Claude Code, Codex) before any paid API ----
//
// The API can REQUIRE the schema; a CLI turn can only be SHOWN it, so what comes
// back is checked and reshaped here into exactly what the API path returns - the
// builder cannot tell which route produced the questions.

// A model writing JSON by hand must double every LaTeX backslash. When it
// doesn't, JSON.parse turns `\frac` into a form-feed + "rac" and `\begin` into a
// backspace + "egin" without complaint. Those control characters never belong in
// a question, so they are put back. Only the unambiguous ones are touched; a raw
// newline is restored to `\n...` only INSIDE a $...$ math segment.
const repairLatexEscapes = (s) => {
  if (typeof s !== "string" || !/[\u0008\u0009\u000c\u000d\n]/.test(s)) return s;
  let out = s
    .replace(/\u000c/g, "\\f")
    .replace(/\u0008/g, "\\b")
    .replace(/\u0009(?=[A-Za-z])/g, "\\t")
    .replace(/\u000d(?=[A-Za-z])/g, "\\r");
  out = out.replace(/\$[^$]*\$/g, (seg) => seg.replace(/\n(?=[A-Za-z])/g, "\\n"));
  return out;
};
const cliStr = (v) => repairLatexEscapes(typeof v === "string" ? v : v == null ? "" : String(v));
const Q_TYPES = new Set(["Cm", "Cs", "Co", "Cd", "Cma"]);
const choiceIndex = (v, n) => {
  // "B" / "b" → 1 (a model may answer with the letter); numbers as given.
  const i = typeof v === "string" && /^\s*[A-Ja-j]\s*$/.test(v) ? v.trim().toUpperCase().charCodeAt(0) - 65 : Number(v);
  return Number.isInteger(i) && i >= 0 && i < n ? i : null;
};
function normalizeCliQuestion(q) {
  const o = q && typeof q === "object" ? q : {};
  const choices = Array.isArray(o.choices)
    ? o.choices.map((c) => (typeof c === "string" ? { text: cliStr(c), latex: "" } : { text: cliStr(c?.text), latex: cliStr(c?.latex) }))
    : [];
  const type = Q_TYPES.has(o.type) ? o.type : choices.length ? "Cm" : "Co";
  const correct = Array.isArray(o.correct)
    ? [...new Set(o.correct.map((v) => choiceIndex(v, choices.length)).filter((v) => v !== null))]
    : [];
  return {
    type,
    text: cliStr(o.text),
    latex: cliStr(o.latex),
    choices,
    correct,
    pairs: Array.isArray(o.pairs)
      ? o.pairs.map((p) => ({ left: cliStr(p?.left), leftLatex: cliStr(p?.leftLatex), right: cliStr(p?.right), rightLatex: cliStr(p?.rightLatex) }))
      : [],
    hasFigure: o.hasFigure === true,
    openAnswer: cliStr(o.openAnswer),
    openAnswers: Array.isArray(o.openAnswers) ? o.openAnswers.map(cliStr).filter(Boolean) : [],
    explanation: cliStr(o.explanation),
  };
}

const CLI_EXTRACT_RULE =
  "JSON YAZARKƏN: LaTeX-dakı hər tərs xətti İKİ dəfə yaz (məs. \"$\\\\frac{1}{2}$\", \"$\\\\sqrt{x}$\") — " +
  "əks halda JSON pozulur. Sətir sonu üçün \\n yaz.";

/*
 * Which model does what (all on the subscriptions):
 *   reading a file   CLAUDE_CLI_MODEL       (default sonnet: copying is quick work)
 *   writing / review CLAUDE_CLI_GEN_MODEL   (default opus: it must solve its own key)
 *   solving answers  CLAUDE_CLI_SOLVE_MODEL (default = the writing model)
 * Effort: CLAUDE_CLI_GEN_EFFORT for writing / review / solving; Codex runs at
 * CODEX_CLI_EFFORT (default medium — its own default, "none", is careless at maths).
 */
const READ_MODEL = () => process.env.CLAUDE_CLI_MODEL || "sonnet";
const GEN_MODEL = () => process.env.CLAUDE_CLI_GEN_MODEL || "opus";
const GEN_EFFORT = () => process.env.CLAUDE_CLI_GEN_EFFORT || "high";
const SOLVE_MODEL = () => process.env.CLAUDE_CLI_SOLVE_MODEL || GEN_MODEL();
const CODEX_EFFORT = () => process.env.CODEX_CLI_EFFORT || "medium";

// Extraction also says WHAT the document is (Examopia's documentKind): a paper to
// copy, teaching material to write questions from, or something it could not read
// — which must never be answered with invented questions.
const DOCUMENT_SCHEMA = {
  ...EXTRACTION_SCHEMA,
  properties: {
    documentKind: { type: "string", enum: ["questions", "material", "unreadable"] },
    ...EXTRACTION_SCHEMA.properties,
  },
  required: ["documentKind", "questions"],
};

/*
 * One structured turn on the first subscription CLI that can do it (AI_CLI_ORDER,
 * skipping a stood-down plan). `accept(doc)` returns a reason to try the next
 * route instead ("" = keep). Returns { doc, provider, model } or null.
 */
async function cliTurn({ label, system, prompt, files = [], schema = EXTRACTION_SCHEMA, model, effort, onText, signal, validate, accept }) {
  if (aiExecution() === "api") return null;
  for (const cli of cliOrder()) {
    if (signal?.aborted) return null;
    if (isCoolingDown(cli)) continue;
    const started = Date.now();
    try {
      const out = await runCliStructured({
        provider: cli,
        system,
        prompt,
        schema,
        files,
        model: cli === "claude" ? model : undefined,
        effort: cli === "claude" ? effort : effort || CODEX_EFFORT(),
        validate,
        // The live preview parses the same hand-written JSON, so it gets the same
        // stray-backslash repair (else one `\sqrt` stalls the preview).
        onText:
          typeof onText === "function"
            ? (() => {
                const emit = onText();
                return (full) => emit(fixJsonEscapes(full));
              })()
            : undefined,
        signal,
      });
      const secs = Math.round((Date.now() - started) / 1000);
      const why = typeof accept === "function" ? accept(out.doc) : "";
      if (why) {
        console.warn(`[AI-CLI] ${cli} ${label}: ${why} (${secs}s) — trying the next route`);
        continue;
      }
      console.log(`[AI-CLI] ${cli} ${label}: ok in ${secs}s (${out.model})`);
      return { doc: out.doc, provider: out.provider, model: out.model };
    } catch (e) {
      if (e?.code === "cli_cancelled") return null;
      if (e?.code === "cli_limit_reached" || e?.code === "cli_unavailable") standDown(cli, e);
      console.warn(
        `[AI-CLI] ${cli} ${label} failed after ${Math.round((Date.now() - started) / 1000)}s: ${e?.code || ""} ${String(e?.message || "").slice(0, 200)}` +
          (e?.stderr ? ` | stderr: ${String(e.stderr).slice(-300).replace(/\s+/g, " ")}` : "")
      );
    }
  }
  return null;
}

const cliCost = (out) => ({
  model: `${out.provider}:${out.model}`,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  usd: 0,
  cli: true,
});

// The API's exact question shape, then Examopia's clean-up (LaTeX escapes,
// prose wrapped in $, θ-for-Ə, matching items / letters).
const shapeQuestions = (list) =>
  cleanQuestions(
    (Array.isArray(list) ? list : [])
      .map(normalizeCliQuestion)
      .filter((q) => q.text.trim() || q.choices.length || q.pairs.length)
  );

/* A CLI turn that must produce questions. Returns { questions, provider, cost, doc } or null. */
async function questionsViaCli({ label, system, prompt, files = [], schema, model, effort, onText, signal, accept }) {
  const out = await cliTurn({
    label,
    system,
    prompt,
    files,
    schema,
    model,
    effort,
    onText,
    signal,
    validate: (d) => !!d && Array.isArray(d.questions),
    accept: (d) => {
      const why = typeof accept === "function" ? accept(d) : "";
      if (why) return why;
      return shapeQuestions(d.questions).length ? "" : "no questions";
    },
  });
  if (!out) return null;
  return { questions: shapeQuestions(out.doc.questions), provider: out.provider, cost: cliCost(out), doc: out.doc };
}

/* Questions out of the teacher's files (a PDF, or photos of a worksheet). */
async function extractWithCli(parts, instructions, opts = {}) {
  const several = parts.length > 1 || parts.some((p) => p.mime !== "application/pdf");
  const r = await questionsViaCli({
    label: "extract",
    system: `${SYSTEM_PROMPT}\n\n${CLI_EXTRACT_RULE}${instructionBlock(instructions)}`,
    prompt: several
      ? "Əlavə olunmuş fayllardakı (PDF səhifələri və/və ya şəkillər) BÜTÜN sualları, sırası ilə, sxemə uyğun JSON-a çıxar."
      : "Bu PDF-dəki BÜTÜN sualları, sənəddəki sırası ilə, sxemə uyğun JSON-a çıxar.",
    files: parts,
    schema: DOCUMENT_SCHEMA,
    model: READ_MODEL(),
    // Unreadable is a failure to pass on (another engine may read it), never a
    // licence to write questions about a guessed topic.
    accept: (d) => (d && d.documentKind === "unreadable" ? "could not read the document" : ""),
    ...opts,
  });
  if (!r) return null;
  return { ...r, documentKind: r.doc && r.doc.documentKind === "material" ? "material" : "questions" };
}

/* New questions from the teacher's request. */
function generateWithCli(prompt, instructions, opts = {}) {
  return questionsViaCli({
    label: "generate",
    system: `${GEN_SYSTEM_PROMPT}\n\n${CLI_EXTRACT_RULE}${instructionBlock(instructions)}`,
    prompt: `MÜƏLLİMİN İSTƏYİ:\n${prompt}\n\nBu istəyə uyğun sualları YARAT.`,
    files: [],
    model: GEN_MODEL(),
    effort: GEN_EFFORT(),
    ...opts,
  });
}

/*
 * Request fidelity: "20 sual" means 20. When the set came back short, the
 * missing ones are asked for (twice at most), de-duplicated by text.
 */
async function topUpGenerated({ prompt, questions, target, signal }) {
  const acc = [...questions];
  const seen = new Set(acc.map(questionKey));
  for (let r = 0; r < 2 && acc.length < target; r += 1) {
    if (signal?.aborted) break;
    const need = target - acc.length;
    const more = await generateWithCli(
      `${String(prompt).slice(0, 3000)}\n\nARTIQ ${acc.length} sual hazırlandı. İNDİ onlardan FƏRQLİ, eyni mövzu və çətinlikdə DAHA ${need} sual yaz (təkrar OLMASIN, cavabları da doldur). Yalnız yeni sualları qaytar.`,
      "",
      { signal }
    );
    if (!more) break;
    let added = 0;
    for (const q of more.questions) {
      if (acc.length >= target) break;
      const k = questionKey(q);
      if (k && seen.has(k)) continue;
      seen.add(k);
      acc.push(q);
      added += 1;
    }
    if (!added) break;
  }
  return acc;
}

/*
 * The AI checks its own work only where the rules found something wrong
 * (Examopia's "light" review): the flagged questions go to a reviewer with the
 * findings and come back in place. Discarded if it changes the count or makes
 * the audit worse, so it can never leave the set worse than it was.
 */
async function reviewGenerated({ questions, prompt, signal, onStatus }) {
  let best = questions;
  let bestIssues = auditQuestions(best, { requireAnswers: true });
  const off = ["off", "false", "0", "no"].includes(String(process.env.AI_VERIFY || "").trim().toLowerCase());
  if (!bestIssues.length || off || signal?.aborted) return { questions: best, issues: bestIssues, rounds: 0 };
  onStatus?.("Suallar yoxlanılır…");
  const flagged = [...new Set(bestIssues.map((x) => x.index))]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < best.length)
    .sort((x, y) => x - y);
  const at = new Map(flagged.map((orig, k) => [orig, k]));
  const sub = flagged.map((i) => best[i]);
  const findings = bestIssues
    .filter((x) => at.has(x.index))
    .slice(0, 40)
    .map((x) => `#${at.get(x.index) + 1} ${x.code}: ${x.detail}`)
    .join("\n");
  const payload = [
    `İLK TAPŞIRIQ: ${String(prompt).slice(0, 1500)}`,
    "",
    "YOXLANACAQ SUALLAR (JSON):",
    JSON.stringify({ questions: sub }).slice(0, 60000),
    "",
    `AVTOMATİK YOXLAMANIN TAPDIĞI PROBLEMLƏR (mütləq düzəlt):\n${findings}`,
  ].join("\n");
  const out = await questionsViaCli({
    label: "review",
    system: `${REVIEW_SYSTEM_PROMPT}\n\n${CLI_EXTRACT_RULE}`,
    prompt: payload,
    model: GEN_MODEL(),
    effort: GEN_EFFORT(),
    signal,
  });
  if (!out || out.questions.length !== sub.length) return { questions: best, issues: bestIssues, rounds: out ? 1 : 0 };
  const merged = best.slice();
  flagged.forEach((orig, k) => {
    merged[orig] = out.questions[k];
  });
  const candIssues = auditQuestions(merged, { requireAnswers: true });
  if (candIssues.length <= bestIssues.length) {
    best = merged;
    bestIssues = candIssues;
  }
  return { questions: best, issues: bestIssues, rounds: 1 };
}

/*
 * The answers a paper does not give, worked out by the AI WITH the pages to look
 * at (Examopia's "auto" mode): only the unanswered questions go, in a few
 * parallel batches, and only the ANSWER comes back onto the teacher's own
 * question, so the paper's wording cannot change. A paper that marks every
 * answer costs nothing extra.
 */
const SOLVE_PARALLEL = () => Math.max(1, Number(process.env.AI_SOLVE_PARALLEL) || 3);
async function solveMissingAnswers({ questions, parts, signal, onStatus }) {
  const list = questions.slice();
  const targets = [...unansweredIndexes(list)].sort((x, y) => x - y);
  if (!targets.length || aiExecution() === "api" || signal?.aborted) return { questions: list, solved: 0, missing: targets.length };
  onStatus?.(`${targets.length} sualın cavabı vərəqdə yoxdur — AI həll edir…`);
  const size = targets.length <= 8 ? targets.length : Math.max(4, Math.ceil(targets.length / SOLVE_PARALLEL()));
  const batches = [];
  for (let k = 0; k < targets.length; k += size) batches.push(targets.slice(k, k + size));
  let next = 0;
  let done = 0;
  const runBatch = async (batch) => {
    const sub = batch.map((i) => questions[i]);
    const ask = [
      "Aşağıdakı sualların DÜZGÜN CAVABINI tap. Sualları dəyişmə — yalnız cavab sahələrini doldur.",
      `Əlavə olunmuş sənəddə bunlar ${batch.map((i) => i + 1).join(", ")} nömrəli suallardır (nömrə fərqlidirsə, mətnə görə tap).`,
      "",
      "SUALLAR (JSON):",
      JSON.stringify({ questions: sub }).slice(0, 60000),
    ].join("\n");
    const out = await questionsViaCli({
      label: "solve",
      system: `${SOLVE_SYSTEM_PROMPT}\n\n${CLI_EXTRACT_RULE}`,
      prompt: ask,
      files: parts || [],
      model: SOLVE_MODEL(),
      effort: GEN_EFFORT(),
      signal,
    });
    // A reply that dropped or added a question cannot be mapped back by position.
    if (!out || out.questions.length !== sub.length) return;
    batch.forEach((orig, k) => {
      list[orig] = answerOnly(questions[orig], out.questions[k]);
    });
    done += batch.length;
    onStatus?.(`Cavablar tapılır… ${Math.min(done, targets.length)}/${targets.length}`);
  };
  const worker = async () => {
    while (next < batches.length && !signal?.aborted) {
      const batch = batches[next];
      next += 1;
      try {
        await runBatch(batch);
      } catch (e) {
        console.error("[AI-CLI] solve batch failed (left for the teacher):", e?.message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SOLVE_PARALLEL(), batches.length) }, worker));
  const still = unansweredIndexes(list);
  return { questions: list, solved: targets.filter((i) => !still.has(i)).length, missing: still.size };
}

/*
 * The teacher's upload: one PDF, or up to 10 pages as PDFs/photos (a worksheet is
 * screenshotted far more often than exported). The CLIs read all of them; the
 * paid API fallback only takes a single PDF, so `pdfOnly` is its input or null.
 */
const AI_FILE_OK = (m) => m === "application/pdf" || /^image\/(png|jpe?g|webp|gif)$/.test(m);
function uploadedParts(req) {
  const list = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];
  const files = list.filter((f) => f && f.buffer && f.buffer.length);
  if (!files.length) return { error: "PDF və ya şəkil faylı lazımdır" };
  if (files.length > 10) return { error: "Ən çox 10 fayl" };
  if (files.some((f) => !AI_FILE_OK(String(f.mimetype || "").toLowerCase()))) {
    return { error: "Yalnız PDF və ya şəkil (PNG, JPG, WEBP) faylları dəstəklənir" };
  }
  const parts = files.map((f) => ({
    name: f.originalname || "",
    mime: String(f.mimetype).toLowerCase(),
    data: f.buffer.toString("base64"),
  }));
  return { parts, pdfOnly: parts.length === 1 && parts[0].mime === "application/pdf" ? parts[0].data : null };
}
const API_NEEDS_ONE_PDF =
  "Şəkilləri və bir neçə faylı yalnız Claude / ChatGPT oxuya bilir, onlar isə hazırda əlçatan deyil. Bir az sonra yenidən cəhd edin və ya tək PDF yükləyin.";

// Writing questions from the teacher's request: Examopia's generation rules
// (helper text ported 2026-11-08), without its reading-passage / gap-fill /
// manual-grading rules - BunkerMath has no such question types.
const GEN_SYSTEM_PROMPT = `Sən imtahan sualları YARADAN AI köməkçisisən. Müəllimin təsvirinə əsasən suallar yarat və NƏTİCƏNİ YALNIZ verilən JSON sxemi ilə qaytar.

QAYDALAR:
- İSTƏNİLƏN FƏNN üçün sual yarat (riyaziyyat, fizika, kimya, biologiya, tarix, coğrafiya, informatika, ədəbiyyat, dillər və s.). Fənnə görə HEÇ VAXT imtina etmə.
- Müəllimin istədiyi SAY və NÖV sualları yarat (məs. "10 qapalı riyaziyyat sualı").
- DİL: müəllim hansı dildə istəyirsə, suallar O DİLDƏ olsun (məs. «rus dilində riyaziyyat» → suallar tam rusca; «ingilis dili» → ingiliscə). Dil göstərilməyibsə — Azərbaycan dilində.
- SAY: müəllim neçə sual istəyirsə, DƏQİQ o qədər sual qaytar. «25 sual» dedisə 25 olmalıdır — nə 22, nə 26. Qaytarmazdan ƏVVƏL sualları say və uyğun gəlmirsə düzəlt.
- BÖLGÜ: müəllim tiplərin sayını/nisbətini deyibsə, ona hərfi əməl et. «son 7-si açıq» → tam 7 ədəd Co. «yarısı uyğunluq» → qalan qapalı sualların yarısı «Cma» olmalıdır.
  UYĞUNLUQ SUALI YAZMAQDAN ÇƏKİNMƏ: aşağıdakı uzun xəbərdarlıq onu NECƏ düzgün yazmaq barədədir — ondan qaçmaq üçün deyil. İstənilibsə, tələb olunan qədər «Cma» yaz.
- Qapalı sual (Cm/Cs): "choices" massivində A–E variantları ver və düzgün variant(lar)ın indeksini "correct" massivinə yaz.
- ⛔ TƏK SEÇİM (Cm) — YALNIZ BİR VARİANT DÜZGÜN OLA BİLƏR. Qaytarmazdan ƏVVƏL hər variantı ayrıca yoxla: «bu da sualın şərtinə uyğundurmu?». İkinci variant da uyğun gəlirsə — ya sualı dəqiqləşdir, ya həmin variantı açıq-aşkar yanlış biri ilə əvəz et, ya da tipi «Cs» et və BÜTÜN düzgünləri "correct"-ə yaz. Bu səhv ən çox qrammatikada olur (cümlə üzvləri, nitq hissələri, hallar, söz quruluşu), eləcə də «hansı doğrudur / hansı deyil» suallarında. Nümunə: «"Müəllim şagirdlərə tapşırıq verdi" cümləsində tamamlıq hansıdır?» tək seçimli ola BİLMƏZ — həm «şagirdlərə» (vasitəli tamamlıq), həm «tapşırıq» (vasitəsiz tamamlıq) düzgündür. Düzgün yazılış: «...cümləsində vasitəsiz tamamlıq hansıdır?» (yeganə cavab: tapşırıq) və ya Cs.
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
- RİYAZİYYAT (VACİB): hər düsturu/ifadəni mətnin İÇİNDƏ, öz yerində, tək dollar işarələri arasında LaTeX kimi yaz — $...$. Nümunələr: "3500-ün $\\\\frac{5}{7}$ hissəsini tapın.", "$x^{2}+1=0$ tənliyini həll et", "$\\\\sqrt{540}$ ədədi". "latex" sahəsini HEÇ VAXT işlətmə — həmişə "" saxla; bütün riyaziyyat mətnin içində $...$ ilə olur. QADAĞAN: $...$-siz açıq LaTeX yazma (məs. \\\\frac, \\\\sqrt, x^2 kimi) — belə yazsan şagird xam kodu görür. Açdığın hər $ üçün mütləq BAĞLAYAN $ qoy (balanslı olsun). Bütöv cümləni $...$ içinə ALMA — yalnız həqiqi düsturu. Adi rəqəm/aralıq/faiz/tarix riyaziyyat deyil ("20–30 arası" — $ ilə YOX). Seçim mətnində də riyaziyyatı $...$ ilə yaz, seçimin "latex"-i "" olsun.
- Dırnaq işarəsi lazımdırsa adi " işlət — \\" kimi qaçış simvolu YAZMA.
- Şəkil/qrafik tələb edən sual YARATMA (hasFigure həmişə false). Mümkün qədər mətnlə həll olunan suallar yarat.
- Suallar aydın, düzgün və imtahan səviyyəsinə uyğun olsun.
- HƏLLİ TƏLƏB OLUNAN AÇIQ SUAL (Cd): müəllim «həlli tələb olunan», «ətraflı yazın», «həllini yaz» kimi suallar istəyirsə, tipi "Cd" et; "choices" boş, yekun cavabı "openAnswer"/"openAnswers"-ə yaz (Co kimi).
- CAVAB AÇARI SƏNİN İŞİNDİR: yaratdığın HƏR qapalı sualın (Cm/Cs) "correct" massivi DOLU olmalıdır, hər açıq sualın (Co/Cd) "openAnswers"-i də. Cavabı qaytarmazdan əvvəl özün həll edib yoxla.
- "explanation": qısa həll yolu yaz (1–3 cümlə; riyaziyyat $...$ ilə). "latex" və variantların "latex"-i həmişə "".
- "pairs" yalnız Cma üçündür (left = nömrə, right = hərf); başqa tiplərdə boş massiv. "hasFigure" həmişə false.`;

const CLI_ONLY_UNAVAILABLE = "Abunə AI-ları (Claude / Codex) hazırda əlçatan deyil. Bir az sonra yenidən cəhd edin.";

async function logAiUsage(req, cost, questions) {
  if (!cost || !req.user?._id) return;
  try {
    await AiUsage.create({
      user: req.user._id,
      exam: req.params.examId,
      model: cost.model,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      cacheWriteTokens: cost.cacheWriteTokens,
      cacheReadTokens: cost.cacheReadTokens,
      totalTokens: cost.totalTokens,
      usd: cost.usd,
      questions,
    });
  } catch (e) {
    console.error("AiUsage log failed:", e?.message);
  }
}

// Claude Opus 4.8 pricing (USD per 1M tokens). Cache write (5-min ephemeral) is
// 1.25x base input; cache read is 0.1x base input. Output includes thinking.
const PRICE_PER_MTOK = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

// Turn an Anthropic usage object into a token breakdown + USD cost for THIS call,
// so the teacher can see (and tally) what each extraction cost.
function computeCost(u) {
  if (!u) return null;
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const usd =
    (input * PRICE_PER_MTOK.input +
      output * PRICE_PER_MTOK.output +
      cacheWrite * PRICE_PER_MTOK.cacheWrite +
      cacheRead * PRICE_PER_MTOK.cacheRead) /
    1e6;
  return {
    model: "claude-opus-4-8",
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
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
// Stable fallback tried if the primary model stays overloaded (503). NOTE: keep
// this a model the key actually has quota for — gemini-2.0-flash returns 429
// "limit: 0" on free-tier keys, which is useless. gemini-2.5-flash has quota.
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash";
// Approx USD per 1M tokens for the chosen Gemini model (env-overridable). Gemini
// Flash is dramatically cheaper than Claude Opus (5 / 25).
const GEMINI_PRICE = {
  input: Number(process.env.GEMINI_PRICE_IN || 0.3),
  output: Number(process.env.GEMINI_PRICE_OUT || 2.5),
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
          type: { type: "STRING", enum: ["Cm", "Cs", "Co", "Cd", "Cma"] },
          text: { type: "STRING" },
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
          explanation: { type: "STRING" },
        },
        required: [
          "type", "text", "latex", "choices", "correct",
          "pairs", "hasFigure", "openAnswer", "openAnswers", "explanation",
        ],
      },
    },
  },
  required: ["questions"],
};

function computeGeminiCost(u, model) {
  const input = u?.promptTokenCount || 0;
  const output = u?.candidatesTokenCount || 0;
  const usd = (input * GEMINI_PRICE.input + output * GEMINI_PRICE.output) / 1e6;
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

// Build an error carrying an HTTP status + Azerbaijani user message.
function aiError(status, userMessage, fallback = false) {
  const e = new Error(userMessage);
  e.aiStatus = status;
  e.userMessage = userMessage;
  e.aiFallback = fallback; // true → caller may retry with another provider (Claude)
  return e;
}

async function extractWithClaude(base64, instructions = "") {
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
          format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: base64 },
              },
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

async function extractWithGemini(base64, instructions = "") {
  if (!process.env.GEMINI_API_KEY) throw aiError(503, "AI funksiyası konfiqurasiya olunmayıb (GEMINI_API_KEY)");
  const instr = clampInstr(instructions);
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT + instructionBlock(instr) }] },
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: "application/pdf", data: base64 } },
          { text: "Bu PDF-dəki bütün sualları çıxar." },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: GEMINI_SCHEMA,
      maxOutputTokens: 32000,
      temperature: 0.2,
    },
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
            body,
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
const extractQuestions = asyncHandler(async (req, res) => {
  const up = uploadedParts(req);
  if (up.error) {
    res.status(400);
    throw new Error(up.error);
  }
  const base64 = up.pdfOnly;
  const provider =
    String(req.body?.provider || "").toLowerCase() === "gemini" ? "gemini" : "claude";
  const instructions = clampInstr(req.body?.instructions);

  // The owner's subscriptions first; the paid API only if neither can do it.
  const viaCli = await extractWithCli(up.parts, instructions);
  if (viaCli) {
    const solved = await solveMissingAnswers({ questions: viaCli.questions, parts: up.parts });
    await logAiUsage(req, viaCli.cost, solved.questions.length);
    return res.status(200).json({
      success: true,
      questions: solved.questions,
      usage: null,
      cost: { model: viaCli.cost.model, cli: true },
      provider: viaCli.provider,
      fellBack: false,
      documentKind: viaCli.documentKind,
      answersSolved: solved.solved,
      answersMissing: solved.missing,
    });
  }
  if (aiExecution() === "cli") {
    res.status(503);
    throw new Error(CLI_ONLY_UNAVAILABLE);
  }
  if (!base64) {
    res.status(503);
    throw new Error(API_NEEDS_ONE_PDF);
  }

  let questions = [];
  let usage = null;
  let cost = null;
  let usedProvider = provider;
  let fellBack = false;
  try {
    ({ questions, usage, cost } =
      provider === "gemini"
        ? await extractWithGemini(base64, instructions)
        : await extractWithClaude(base64, instructions));
  } catch (e) {
    // If Gemini is busy / out of quota, automatically retry on Claude so the
    // teacher isn't dead-ended — they still get their questions (slightly pricier).
    if (provider === "gemini" && e.aiFallback) {
      try {
        ({ questions, usage, cost } = await extractWithClaude(base64, instructions));
        usedProvider = "claude";
        fellBack = true;
        console.warn("AI extract: Gemini unavailable, fell back to Claude.");
      } catch (e2) {
        res.status(e2.aiStatus || 503);
        throw new Error(e2.userMessage || "AI emalı alınmadı. Bir az sonra yenidən cəhd edin.");
      }
    } else {
      res.status(e.aiStatus || 503);
      throw new Error(e.userMessage || "AI emalı alınmadı. Bir az sonra yenidən cəhd edin.");
    }
  }

  // Persist the usage so admins can see per-teacher spend (best-effort: a logging
  // failure must never break the extraction the teacher is waiting on).
  if (cost && req.user?._id) {
    try {
      await AiUsage.create({
        user: req.user._id,
        exam: req.params.examId,
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

  res.status(200).json({ success: true, questions: cleanQuestions(questions), usage, cost, provider: usedProvider, fellBack });
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

async function streamGemini(base64, instructions, onText) {
  if (!process.env.GEMINI_API_KEY)
    throw aiError(503, "AI funksiyası konfiqurasiya olunmayıb (GEMINI_API_KEY)", true);
  const instr = clampInstr(instructions);
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT + instructionBlock(instr) }] },
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: "application/pdf", data: base64 } },
          { text: "Bu PDF-dəki bütün sualları çıxar." },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: GEMINI_SCHEMA,
      maxOutputTokens: 32000,
      temperature: 0.2,
    },
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
          body,
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
          if (p.text) {
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

async function streamClaude(base64, instructions, onText) {
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
    output_config: { effort: "high", format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
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
  const up = uploadedParts(req);
  if (up.error) {
    res.status(400);
    throw new Error(up.error);
  }
  const base64 = up.pdfOnly;
  const provider =
    String(req.body?.provider || "").toLowerCase() === "gemini" ? "gemini" : "claude";
  const instructions = clampInstr(req.body?.instructions);

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
  const hb = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 15000);

  const mkOnText = () => {
    const streamer = makeQuestionStreamer();
    return (full) => {
      for (const q of streamer(full)) sse("question", q);
    };
  };

  // A teacher who closes the page stops the CLI turn too (no ten-minute orphan).
  const cliAbort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) cliAbort.abort();
  });

  // The owner's subscriptions first (questions stream live from Claude); the
  // paid API below runs only if neither CLI produced questions.
  const viaCli = await extractWithCli(up.parts, instructions, { onText: mkOnText, signal: cliAbort.signal });
  if (viaCli) {
    // The answers the paper does not give, solved with the pages in view.
    const solved = await solveMissingAnswers({
      questions: viaCli.questions,
      parts: up.parts,
      signal: cliAbort.signal,
      onStatus: (message) => sse("status", { message }),
    });
    clearInterval(hb);
    if (cliAbort.signal.aborted) return res.end();
    await logAiUsage(req, viaCli.cost, solved.questions.length);
    sse("done", {
      questions: solved.questions,
      cost: { model: viaCli.cost.model, cli: true },
      provider: viaCli.provider,
      fellBack: false,
      documentKind: viaCli.documentKind,
      answersSolved: solved.solved,
      answersMissing: solved.missing,
    });
    return res.end();
  }
  if (cliAbort.signal.aborted) {
    clearInterval(hb);
    return res.end();
  }
  if (aiExecution() === "cli") {
    clearInterval(hb);
    sse("error", { message: CLI_ONLY_UNAVAILABLE });
    return res.end();
  }
  if (!base64) {
    clearInterval(hb);
    sse("error", { message: API_NEEDS_ONE_PDF });
    return res.end();
  }

  let result;
  let usedProvider = provider;
  let fellBack = false;
  try {
    result =
      provider === "gemini"
        ? await streamGemini(base64, instructions, mkOnText())
        : await streamClaude(base64, instructions, mkOnText());
  } catch (e) {
    if (provider === "gemini" && e.aiFallback) {
      sse("status", { message: "Gemini əlçatan deyil — Claude ilə davam edilir…" });
      try {
        result = await streamClaude(base64, instructions, mkOnText());
        usedProvider = "claude";
        fellBack = true;
      } catch (e2) {
        clearInterval(hb);
        sse("error", { message: e2.userMessage || "AI emalı alınmadı. Bir az sonra yenidən cəhd edin." });
        return res.end();
      }
    } else {
      clearInterval(hb);
      sse("error", { message: e.userMessage || "AI emalı alınmadı. Bir az sonra yenidən cəhd edin." });
      return res.end();
    }
  }
  clearInterval(hb);

  let parsed;
  try {
    parsed = JSON.parse(result.full || "{}");
  } catch {
    sse("error", { message: "AI cavabı oxunmadı. Yenidən cəhd edin." });
    return res.end();
  }
  const questions = cleanQuestions(Array.isArray(parsed.questions) ? parsed.questions : []);
  const cost =
    usedProvider === "gemini"
      ? computeGeminiCost(result.usage, result.model)
      : computeCost(result.usage);
  if (cost && req.user?._id) {
    try {
      await AiUsage.create({
        user: req.user._id,
        exam: req.params.examId,
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
  sse("done", { questions, cost, provider: usedProvider, fellBack });
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

// ---- Paper exams: read a photographed answer card ---------------------------
// Standalone module on purpose: requiring it from helper/paperReader would close
// a require cycle (paperReader already imports this controller).
const { readCapped } = require("../helper/fetchLimit");
// Claude transcribes ONLY what the student marked or wrote — it never grades or
// solves; the server scores the reviewed selections against the key. Used by the
// teacher grading workspace and by student self-upload (quizController).

const PAPER_READ_MODEL = process.env.PAPER_READ_MODEL || "claude-opus-4-8";
const PAPER_READ_EFFORT = process.env.PAPER_READ_EFFORT || "medium";
const PAPER_MAX_IMAGES = 6;
const SHEET_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
// Sheets are uploaded to Cloudinary by the browser first; only those URLs are
// fetched, so these endpoints can't make the server request arbitrary hosts.
const SHEET_IMAGE_HOST = /(^|\.)res\.cloudinary\.com$/i;

const SHEET_ITEM = {
  type: "object",
  additionalProperties: false,
  properties: {
    printed: { type: "string" },
    answer: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    note: { type: "string" },
  },
  required: ["printed", "answer", "confidence", "note"],
};

const SHEET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    student: {
      type: "object",
      additionalProperties: false,
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        fatherName: { type: "string" },
        className: { type: "string" },
      },
      required: ["firstName", "lastName", "fatherName", "className"],
    },
    closed: { type: "array", items: SHEET_ITEM },
    open: { type: "array", items: SHEET_ITEM },
    matching: { type: "array", items: SHEET_ITEM },
  },
  required: ["student", "closed", "open", "matching"],
};

const SHEET_PROMPT = `You transcribe a student's PAPER answer card ("CAVAB KARTI") for a math exam platform in Azerbaijan. The images are photos of ONE student's card — possibly several pages, taken at an angle, with shadows or glare. You do NOT grade and you do NOT solve anything: you only report what is marked or written.

The standard card:
- Header boxes: "Ad" (first name), "Soyad" (last name), "Ata adı" (father's name), "Sinif" (class), "Gün" (date, on newer cards), "Dərs saatı" (lesson hour).
- Two columns:
  - "QAPALI SUALLAR" (closed, e.g. "(1 – 13)"): a table of numbered rows ("№"), each with bubbles A B C D E. The student fills, shades, circles or crosses one bubble per row. Bubbles and their letters may be PRINTED in red — printed rings/letters are never marks; only the student's pen or pencil counts.
  - "AÇIQ SUALLAR" (open, e.g. "(14 – 25)"): numbered boxes (labels like "14.") where the student writes a short answer.
- Some exams add a matching grid (numbers × letters).
Other card designs may appear; read them with the same meaning.

Report:
- "student": the header boxes exactly as handwritten, keeping Azerbaijani letters (ə ı ö ü ğ ş ç). "" for an empty or missing box. Ignore "Gün" and "Dərs saatı".
- "closed": ONE item per closed row, in reading order (top to bottom, then the next column or page), INCLUDING rows with no mark.
  "printed" = the row number printed on the card, exactly as printed, even if it repeats or skips.
  "answer" = the marked letter in lowercase (e.g. "c"); "" when no bubble is marked.
- "open": ONE item per open answer box, in reading order, INCLUDING empty boxes.
  "printed" = the printed number; "answer" = the final written answer as plain keyboard text with no LaTeX (e.g. 12, -3/4, x=5, 0.25, 2√3); "" when empty.
- "matching": only when the card has a matching grid — ONE item per matching question: "printed" = its number, "answer" = every number of the grid with its marked letters in lowercase: "1:a,c;2:b;3:". Otherwise an empty array.

Rules:
- Never invent rows or boxes that are not on the card, and never skip one that is.
- When a correction is clear (an answer crossed out and another marked), report the corrected answer. When two or more bubbles look marked or the final choice is unclear, report your best reading with confidence "low".
- "confidence": "high" = clear; "medium" = readable but faint or partly hidden; "low" = ambiguous, unreadable, or not visible.
- "note": "" when confidence is "high"; otherwise a very short reason in Azerbaijani (e.g. "iki variant işarələnib", "oxunmur", "şəkildə görünmür").`;

const sheetLetter = (i) => String.fromCharCode(97 + i);

// [1,2,3,5] → "1–3, 5"
function numberRanges(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}–${nums[j]}`);
    i = j;
  }
  return out.join(", ");
}

// The exam's key → which question numbers the model should expect in each section.
function sheetLayout(key) {
  const closed = [];
  const open = [];
  const matching = [];
  key.forEach((q, i) => {
    const n = i + 1;
    if (q.type === "Cm" || q.type === "Cs") closed.push(n);
    else if (q.type === "Cmu" || q.type === "Cma") {
      const rows = Number(q.leftCount) || 0;
      const cols = Number(q.rightCount) || 1;
      matching.push(`${n} (numbers 1-${rows}, letters a-${sheetLetter(Math.max(0, cols - 1))})`);
    } else open.push(n);
  });
  const lines = [];
  if (closed.length) lines.push(`Closed questions (bubbles): ${numberRanges(closed)}`);
  if (open.length) lines.push(`Open questions (written): ${numberRanges(open)}`);
  if (matching.length) lines.push(`Matching questions: ${matching.join("; ")}`);
  return lines.join("\n");
}

// Fetch one uploaded sheet image as base64 (Cloudinary-hosted HTTPS only).
async function fetchSheetImage(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw aiError(400, "Şəkil ünvanı yanlışdır");
  }
  if (u.protocol !== "https:" || !SHEET_IMAGE_HOST.test(u.hostname)) {
    throw aiError(400, "Yalnız platformaya yüklənmiş şəkillər qəbul olunur");
  }
  let r;
  try {
    r = await fetch(u.toString());
  } catch {
    throw aiError(502, "Şəkil yüklənmədi. Yenidən cəhd edin.");
  }
  if (!r.ok) throw aiError(400, "Şəkil tapılmadı");
  const media = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!SHEET_IMAGE_TYPES.includes(media)) throw aiError(400, "Dəstəklənməyən şəkil formatı");
  // Capped while streaming: buffering first and measuring after would let an
  // oversized response occupy memory before it is rejected.
  const buf = await readCapped(r, 8 * 1024 * 1024);
  if (!buf) throw aiError(400, "Şəkil çox böyükdür (maks. 8MB)");
  return { media, data: buf.toString("base64") };
}

// Assign one card section's rows to the key's questions of that type. A row whose
// printed number names one of those questions takes it; rows the card numbers
// wrongly (repeated or skipped numbers) fall back to their position in the
// section, and those answers are marked less certain so they get checked.
function alignSection(questions, items) {
  const rows = (Array.isArray(items) ? items : []).map((it, pos) => {
    const n = parseInt(String(it?.printed ?? "").replace(/[^\d]/g, ""), 10);
    return { it, pos, num: Number.isInteger(n) ? n : null };
  });
  const repeats = new Map();
  rows.forEach((r) => {
    if (r.num != null) repeats.set(r.num, (repeats.get(r.num) || 0) + 1);
  });
  const out = new Map();
  // Printed numbers are trusted only when they're consistent: every row numbered,
  // no repeats, each one a question of this section. Otherwise (a card with
  // numbering typos, or numbered differently from the exam) rows go by position.
  const wanted = new Set(questions.map((q) => q.number));
  const byNumber =
    rows.length > 0 && rows.every((r) => r.num != null && repeats.get(r.num) === 1 && wanted.has(r.num));
  if (byNumber) {
    questions.forEach((q) => {
      const r = rows.find((x) => x.num === q.number);
      if (r) out.set(q.index, { item: r.it, doubtful: false });
    });
    return out;
  }
  questions.forEach((q, k) => {
    const r = rows[k];
    if (r) out.set(q.index, { item: r.it, doubtful: r.num == null || repeats.get(r.num) > 1 || r.num !== q.number });
  });
  return out;
}

// One raw reading → the scorer's answer shape for this question type, using only
// the key's layout (option letters, grid size) — never its answers.
function parseSheetAnswer(q, raw) {
  if (q.type === "Cm" || q.type === "Cs") {
    const opts = (Array.isArray(q.options) && q.options.length ? q.options : ["a", "b", "c", "d", "e"]).map((o) =>
      String(o).trim().toLowerCase()
    );
    const letter = raw.toLowerCase().replace(/[^a-z]/g, "");
    const ok = opts.includes(letter);
    return { answer: ok ? letter : "", invalid: !!letter && !ok };
  }
  if (q.type === "Cmu" || q.type === "Cma") {
    const nCount = Number(q.leftCount) || 0;
    const mCount = Number(q.rightCount) || 0;
    const map = {};
    raw.split(";").forEach((part) => {
      const m = part.match(/^\s*(\d+)\s*:\s*(.*)$/);
      if (!m) return;
      const k = Number(m[1]) - 1;
      if (k < 0 || k >= nCount) return;
      const idx = m[2]
        .toLowerCase()
        .split(/[,\s]+/)
        .map((s) => s.replace(/[^a-z]/g, ""))
        .filter(Boolean)
        .map((s) => s.charCodeAt(0) - 97)
        .filter((v) => v >= 0 && v < mCount);
      if (idx.length) map[k] = [...new Set(idx)].sort((a, b) => a - b);
    });
    return { answer: map, invalid: false };
  }
  return { answer: raw.slice(0, 300), invalid: false };
}

// Model output → one { type, answer, confidence, note } per key question.
function sheetSelections(key, parsed) {
  const pick = (types) =>
    key.map((q, i) => ({ q, index: i, number: i + 1 })).filter((x) => types.includes(x.q.type));
  const found = new Map([
    ...alignSection(pick(["Cm", "Cs"]), parsed?.closed),
    ...alignSection(pick(["Cmu", "Cma"]), parsed?.matching),
    ...alignSection(pick(["Co", "Cd"]), parsed?.open),
  ]);
  return key.map((q, i) => {
    const hit = found.get(i);
    if (!hit) {
      return {
        type: q.type,
        answer: q.type === "Cmu" || q.type === "Cma" ? {} : "",
        confidence: "low",
        note: "vərəqdə tapılmadı",
      };
    }
    const raw = String(hit.item?.answer ?? "").trim();
    const { answer, invalid } = parseSheetAnswer(q, raw);
    let confidence = ["high", "medium", "low"].includes(hit.item?.confidence) ? hit.item.confidence : "low";
    let note = String(hit.item?.note || "").slice(0, 120);
    if (invalid) {
      confidence = "low";
      note = note || `oxunan: ${raw.slice(0, 20)}`;
    } else if (hit.doubtful && confidence === "high") {
      confidence = "medium";
      note = note || "kartdakı nömrə aydın deyil";
    }
    return { type: q.type, answer, confidence, note };
  });
}

const cleanSheetStudent = (s) => {
  const f = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    firstName: f(s?.firstName),
    lastName: f(s?.lastName),
    fatherName: f(s?.fatherName),
    className: f(s?.className),
  };
};

// Read a student's sheet photos against an exam key.
// → { answers: [{ type, answer, confidence, note }], student, cost }
// Throws aiError (aiStatus + userMessage) for the caller to turn into a response.
async function readSheetImages(key, images, { focus = [] } = {}) {
  const list = (Array.isArray(images) ? images : [])
    .filter((s) => typeof s === "string" && s)
    .slice(0, PAPER_MAX_IMAGES);
  if (!list.length) throw aiError(400, "Ən azı bir şəkil lazımdır");
  if (!Array.isArray(key) || !key.length) throw aiError(400, "Əvvəlcə cavab açarını daxil edin");
  const client = getClient();
  if (!client) throw aiError(503, "AI funksiyası konfiqurasiya olunmayıb (ANTHROPIC_API_KEY)");

  const fetched = await Promise.all(list.map(fetchSheetImage));

  let message;
  try {
    message = await client.messages
      .stream({
        model: PAPER_READ_MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: SHEET_PROMPT, cache_control: { type: "ephemeral" } }],
        output_config: {
          effort: PAPER_READ_EFFORT,
          format: { type: "json_schema", schema: SHEET_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              ...fetched.map((im) => ({
                type: "image",
                source: { type: "base64", media_type: im.media, data: im.data },
              })),
              {
                type: "text",
                text: `İmtahanın strukturu (${key.length} sual):\n${sheetLayout(key)}\n\nBu cavab kartında şagirdin məlumatlarını və hər cavabını oxu.${
                  focus.length
                    ? `\nPlatforma bu sualları dəqiq oxuya bilmədi — onlara xüsusi diqqət et: ${numberRanges(
                        focus.map((i) => i + 1)
                      )}.`
                    : ""
                }`,
              },
            ],
          },
        ],
      })
      .finalMessage();
  } catch (e) {
    console.error("Paper sheet read error:", e?.status, e?.message);
    if (/credit balance/i.test(String(e?.message || ""))) {
      throw aiError(402, "AI balansı bitib — bu cavabları vərəqlə müqayisə edib əl ilə doldurun.");
    }
    throw aiError(502, "AI vərəqi oxuya bilmədi. Yenidən cəhd edin.");
  }
  if (message.stop_reason === "refusal") throw aiError(422, "AI bu şəkli emal edə bilmədi.");

  let parsed;
  try {
    parsed = JSON.parse(message.content.find((b) => b.type === "text")?.text || "{}");
  } catch {
    throw aiError(502, "AI cavabı oxunmadı. Yenidən cəhd edin.");
  }

  const cost = computeCost(message.usage);
  if (cost) cost.model = PAPER_READ_MODEL;
  return { answers: sheetSelections(key, parsed), student: cleanSheetStudent(parsed.student), cost };
}

// Best-effort spend log for a sheet read (never breaks the request).
async function logPaperAiUsage(userId, examId, cost, questions) {
  if (!cost || !userId) return;
  try {
    await AiUsage.create({
      user: userId,
      exam: examId,
      model: cost.model,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      cacheWriteTokens: cost.cacheWriteTokens,
      cacheReadTokens: cost.cacheReadTokens,
      totalTokens: cost.totalTokens,
      usd: cost.usd,
      questions,
    });
  } catch (e) {
    console.error("AiUsage log failed:", e?.message);
  }
}

// POST /api/quiz/generateQuestionsStream/:examId  { prompt, instructions? }
// The teacher's request -> new questions, over SSE like extraction. Runs on the
// subscription CLIs only: there is no paid generation route to fall back to.
const generateQuestionsStream = asyncHandler(async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim().slice(0, 4000);
  if (prompt.length < 5) {
    res.status(400);
    throw new Error("Bir neçə söz yazın — nə haqqında imtahan olsun?");
  }
  const instructions = clampInstr(req.body?.instructions);

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
  const hb = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 15000);
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const mkOnText = () => {
    const streamer = makeQuestionStreamer();
    return (full) => {
      for (const q of streamer(full)) sse("question", q);
    };
  };

  const status = (message) => sse("status", { message });
  const viaCli = await generateWithCli(prompt, instructions, { onText: mkOnText, signal: abort.signal });
  if (viaCli) {
    // "20 sual" means 20: top a short set up, then let the AI fix what the rules flag.
    const target = parseRequestedCount(prompt);
    let qs = viaCli.questions;
    if (target && qs.length < target && !abort.signal.aborted) {
      status("Çatışmayan suallar hazırlanır…");
      qs = await topUpGenerated({ prompt, questions: qs, target, signal: abort.signal });
    }
    const reviewed = await reviewGenerated({ questions: qs, prompt, signal: abort.signal, onStatus: status });
    clearInterval(hb);
    if (abort.signal.aborted) return res.end();
    const short = target ? Math.max(0, target - reviewed.questions.length) : 0;
    await logAiUsage(req, viaCli.cost, reviewed.questions.length);
    sse("done", {
      questions: reviewed.questions,
      cost: { model: viaCli.cost.model, cli: true },
      provider: viaCli.provider,
      generated: true,
      issues: reviewed.issues.length,
      // Only claim "checked" when a review actually ran and left nothing flagged.
      verified: reviewed.rounds > 0 && reviewed.issues.length === 0 && !short,
      countInfo: target ? { requested: target, actual: reviewed.questions.length, short } : null,
    });
    return res.end();
  }
  clearInterval(hb);
  if (!abort.signal.aborted) {
    sse("error", { message: "AI hazırda sual yarada bilmədi. Bir az sonra yenidən cəhd edin və ya təsviri dəqiqləşdirin." });
  }
  return res.end();
});

module.exports = {
  generateQuestionsStream,
  extractQuestions,
  extractQuestionsStream,
  getAiUsage,
  readSheetImages,
  logPaperAiUsage,
  alignSection,
  parseSheetAnswer,
};
