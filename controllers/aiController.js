const asyncHandler = require("express-async-handler");
const AnthropicPkg = require("@anthropic-ai/sdk");
// CJS interop: the constructor is the default export on recent builds.
const Anthropic = AnthropicPkg.default || AnthropicPkg;
const AiUsage = require("../models/aiUsageModel");
const User = require("../models/userModel");
const Exam = require("../models/examModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");

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
          // Cm = single-choice, Cs = multi-select, Co = open, Cma = matching,
          // reading = a passage block (not a question) shown before its questions.
          type: { type: "string", enum: ["Cm", "Cs", "Co", "Cd", "Cma", "reading"] },
          text: { type: "string" },
          // Reading passage heading (e.g. "Mətn 1"); "" for normal questions.
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
        ],
      },
    },
  },
  required: ["questions"],
};

const SYSTEM_PROMPT = `You extract exam questions from a PDF into structured data for an exam platform used for ANY school subject (maths, physics, chemistry, biology, history, geography, IT, literature, languages, …). The exam content is in Azerbaijani; keep all text in its original language.

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
  if (p === "ielts-reading") {
    return "SUBJECT: This is an IELTS Academic Reading exam — write EVERYTHING in English. Each reading passage must be a LONG, multi-paragraph academic text (~700–900 words) on a real academic topic, extracted as a reading block. For each passage use a realistic IELTS question mix — choose the appropriate ones from: True/False/Not Given, Yes/No/Not Given, Matching Headings to paragraphs, Matching Information to paragraphs, Multiple Choice, Sentence Completion, Summary Completion, Short Answer (no more than three words). For sentence/summary completion, write the sentence(s) as a reading block with the gaps inline as [[answer]] (do NOT make separate questions for those gaps). Each statement is a SEPARATE question. Aim for a realistic full IELTS test — roughly 13 questions per passage. You decide the topics and the exact question mix.";
  }
  return "";
};

// Combine the preset subject hint with the teacher's typed instructions.
const buildInstructions = (presetId, typed) =>
  clampInstr([presetHint(presetId), clampInstr(typed)].filter(Boolean).join("\n\n"));

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
        },
        required: [
          "type", "text", "title", "latex", "choices", "correct",
          "pairs", "hasFigure", "openAnswer", "openAnswers",
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
async function extractWithOpenAI(base64, instructions = "", modelId) {
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
              {
                type: "input_file",
                filename: "exam.pdf",
                file_data: `data:application/pdf;base64,${base64}`,
              },
              { type: "input_text", text: "Bu PDF-dəki bütün sualları çıxar." },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "exam_questions",
            strict: true,
            schema: EXTRACTION_SCHEMA,
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
    usage,
    cost: computeOpenAIGenCost(usage, data?.model, model),
  };
}

async function extractWithGemini(base64, instructions = "") {
  if (!process.env.GEMINI_API_KEY) throw aiError(503, "AI funksiyası konfiqurasiya olunmayıb (GEMINI_API_KEY)");
  const instr = clampInstr(instructions);
  const buildBody = (model) =>
    JSON.stringify({
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
const cleanText = (t) => (typeof t === "string" ? stripProseMath(fixMathEscapes(unescapeQuotes(t))) : t);

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

    const choices = Array.isArray(q.choices) ? q.choices : [];
    const texts = choices.map((c) => AUDIT_STRIP(c?.text ?? c));
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
      if (requireAnswers && !answers.length) add(i, "no-open-answer", "no accepted answer");
      if (choices.length) add(i, "open-with-choices", "open question should have no choices");
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
7. UYĞUNLUQ (Cma): hər nömrənin düzgün hərfi olmalıdır; nömrələnmiş və hərflənmiş siyahılar sualın "text" hissəsində tam görünməlidir.
8. DİL və AYDINLIQ: sual birmənalı olmalıdır. İki cür başa düşülən sualı dəqiqləşdir.
9. Sual ARTIQ DÜZGÜNDÜRSƏ, ona TOXUNMA — yalnız real səhvləri düzəlt.
10. LANGUAGE: Preserve each question's original language. Do not translate English, Russian, Turkish or Azerbaijani text while reviewing.

Cavabında bütün sualları (düzəldilmiş və toxunulmamış) tam qaytar.`;

// Generate → audit → have the AI fix what is wrong → audit again. Bounded, and
// never worse than the un-reviewed result: a review that fails, changes the
// question count, or increases the defect count is discarded. `onStatus` lets
// the streaming endpoint tell the teacher a check is running.
const AI_VERIFY_ROUNDS_RAW = Number(process.env.AI_VERIFY_ROUNDS ?? 2);
const AI_VERIFY_ROUNDS = Number.isFinite(AI_VERIFY_ROUNDS_RAW)
  ? Math.max(0, Math.floor(AI_VERIFY_ROUNDS_RAW))
  : 2;
const aiVerifyDisabled = () =>
  ["off", "false", "0", "no"].includes(String(process.env.AI_VERIFY || "").trim().toLowerCase());

async function verifyAndFix({ questions, prompt, preset, model, signal, onStatus }) {
  let best = cleanQuestions(questions);
  let bestIssues = auditQuestions(best, { requireAnswers: true });
  let reviewCost = null;
  let rounds = 0;

  if (aiVerifyDisabled() || AI_VERIFY_ROUNDS === 0) {
    return { questions: best, issues: bestIssues, reviewCost: null, rounds: 0 };
  }

  for (let round = 0; round < AI_VERIFY_ROUNDS; round++) {
    // Round 0 always runs (a correctness pass even on a structurally clean set);
    // later rounds only if defects remain.
    if (round > 0 && bestIssues.length === 0) break;
    if (signal?.aborted) break;
    onStatus?.(round === 0 ? "Suallar yoxlanılır…" : "Düzəlişlər aparılır…");

    const findings = bestIssues
      .slice(0, 40)
      .map((x) => `#${x.index + 1} ${x.code}: ${x.detail}`)
      .join("\n");
    const payload = [
      prompt ? `İLK TAPŞIRIQ: ${String(prompt).slice(0, 1500)}` : "",
      "",
      "YOXLANACAQ SUALLAR (JSON):",
      JSON.stringify({ questions: best }).slice(0, 60000),
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
        system: REVIEW_SYSTEM_PROMPT,
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
    if (!Array.isArray(candidate) || candidate.length !== best.length) break;
    const candIssues = auditQuestions(candidate, { requireAnswers: true });
    if (candIssues.length <= bestIssues.length) {
      best = candidate;
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

// How a PDF's answer key is handled, chosen by the teacher before extraction:
//   has-answers — keep the answers the PDF marks (the default)
//   manual      — extract the questions only; the teacher marks the answers
//   ai-solve    — the AI solves each question and proposes the answers, run
//                 through the same audit → critic → audit gate as generation
const ANSWER_MODES = new Set(["has-answers", "manual", "ai-solve"]);
async function applyAnswerMode({ questions, mode, preset, model, signal, onStatus }) {
  const m = ANSWER_MODES.has(mode) ? mode : "has-answers";
  if (m === "manual") {
    return { questions: stripAnswers(questions), issues: null, reviewCost: null, rounds: 0, mode: m };
  }
  if (m === "ai-solve") {
    // verifyAndFix already audits for unmarked answers and the critic prompt
    // solves them, so an extracted set with empty `correct` comes back solved
    // and checked — no separate solver needed.
    const v = await verifyAndFix({
      questions,
      prompt: "PDF-dən çıxarılmış sualları həll et və düzgün cavabları qeyd et.",
      preset,
      model,
      signal,
      onStatus,
    });
    return { ...v, mode: m };
  }
  return { questions, issues: null, reviewCost: null, rounds: 0, mode: m };
}

const extractQuestions = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    res.status(400);
    throw new Error("PDF fayl lazımdır");
  }
  if (req.file.mimetype && req.file.mimetype !== "application/pdf") {
    res.status(400);
    throw new Error("Yalnız PDF fayl dəstəklənir");
  }

  const base64 = req.file.buffer.toString("base64");
  // The builder sends the model id it picked. An OpenAI id routes to OpenAI;
  // "gemini"/"claude" keep working as the plain provider names they always were.
  const asked = String(req.body?.provider || "").toLowerCase();
  const askedModel = findAiModel(String(req.body?.model || asked));
  const provider =
    askedModel?.provider === "openai"
      ? "openai"
      : asked === "gemini" || askedModel?.provider === "gemini"
      ? "gemini"
      : "claude";
  const openaiModel = askedModel?.provider === "openai" ? askedModel.id : undefined;
  const instructions = buildInstructions(req.body?.preset, req.body?.instructions);

  let questions = [];
  let usage = null;
  let cost = null;
  let usedProvider = provider;
  let fellBack = false;
  const extractors = {
    openai: () => extractWithOpenAI(base64, instructions, openaiModel),
    gemini: () => extractWithGemini(base64, instructions),
    claude: () => extractWithClaude(base64, instructions),
  };
  // Try the picked provider, then fall through the OTHERS on an availability
  // failure so one engine being down / out of credit does not dead-end the
  // teacher. Gemini handles PDFs well and is cheap, so it sits right after the
  // pick; a genuine bad request stops the chain.
  const order = [provider, "gemini", "openai", "claude"].filter((p, i, a) => a.indexOf(p) === i);
  let lastErr = null;
  for (const name of order) {
    try {
      ({ questions, usage, cost } = await extractors[name]());
      usedProvider = name;
      fellBack = name !== provider;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`AI extract via ${name} failed:`, e?.status || e?.aiStatus, e?.userMessage || e?.message);
      if (!isRetriable(e)) break;
    }
  }
  if (lastErr) {
    res.status(lastErr.aiStatus || 503);
    throw new Error(lastErr.userMessage || "AI emalı alınmadı. Bir az sonra yenidən cəhd edin.");
  }

  // The teacher's answer-key choice (same three modes as the streaming path).
  const applied = await applyAnswerMode({
    questions: cleanQuestions(questions),
    mode: req.body?.answerMode,
    preset: req.body?.preset,
    model: req.body?.model,
  });
  const finalQuestions = applied.questions;
  const finalCost = sumCost(cost, applied.reviewCost);

  // Persist the usage so admins can see per-teacher spend (best-effort: a logging
  // failure must never break the extraction the teacher is waiting on).
  if (finalCost && req.user?._id) {
    try {
      await AiUsage.create({
        user: req.user._id,
        exam: req.params.examId,
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

  res.status(200).json({
    success: true,
    questions: finalQuestions,
    usage,
    cost: finalCost,
    provider: usedProvider,
    fellBack,
    answerMode: applied.mode,
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

async function streamGemini(base64, instructions, onText) {
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
            { inline_data: { mime_type: "application/pdf", data: base64 } },
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
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    res.status(400);
    throw new Error("PDF fayl lazımdır");
  }
  if (req.file.mimetype && req.file.mimetype !== "application/pdf") {
    res.status(400);
    throw new Error("Yalnız PDF fayl dəstəklənir");
  }
  const base64 = req.file.buffer.toString("base64");
  // The builder sends the model id it picked. An OpenAI id routes to OpenAI;
  // "gemini"/"claude" keep working as the plain provider names they always were.
  const asked = String(req.body?.provider || "").toLowerCase();
  const askedModel = findAiModel(String(req.body?.model || asked));
  const provider =
    askedModel?.provider === "openai"
      ? "openai"
      : asked === "gemini" || askedModel?.provider === "gemini"
      ? "gemini"
      : "claude";
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

  let result = null;
  let usedProvider = provider;
  let fellBack = false;
  const label = { openai: "OpenAI", gemini: "Gemini", claude: "Claude" };
  const runners = {
    // OpenAI's Responses API returns the whole paper at once (no token stream) —
    // the loader still animates, questions just don't land one by one.
    openai: async () => {
      const one = await extractWithOpenAI(base64, instructions, openaiModel);
      return { full: JSON.stringify({ questions: one.questions }), usage: one.usage, model: one.cost?.model, openaiCost: one.cost };
    },
    gemini: () => streamGemini(base64, instructions, mkOnText()),
    claude: () => streamClaude(base64, instructions, mkOnText()),
  };
  // Try the picked provider, then fall through the others on an availability
  // failure (Gemini right after the pick — cheap + good at PDFs) so one engine
  // being down or out of credit never dead-ends the extraction.
  const order = [provider, "gemini", "openai", "claude"].filter((p, i, a) => a.indexOf(p) === i);
  let lastErr = null;
  for (const name of order) {
    try {
      sse("status", { message: name === provider ? "PDF oxunur…" : `${label[name]} ilə davam edilir…` });
      result = await runners[name]();
      usedProvider = name;
      fellBack = name !== provider;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.error(`AI extract (${name}) failed:`, e?.status || e?.aiStatus, e?.message);
      if (!isRetriable(e)) break;
    }
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
      `AI extract (${usedProvider}) returned 0 questions; full length=${(result.full || "").length}, head=`,
      (result.full || "").slice(0, 200)
    );
  }
  const extractCost =
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
    model: req.body?.model,
    onStatus: (message) => sse("status", { message }),
  });
  const questions = applied.questions;
  const cost = sumCost(extractCost, applied.reviewCost);

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
  // Instructions given alongside a PDF describe the exam just as a written
  // prompt does, so a later rewrite gets them too.
  if (questions.length) await rememberExamPrompt(req, req.body?.instructions);
  sse("done", {
    questions,
    cost,
    provider: usedProvider,
    fellBack,
    answerMode: applied.mode,
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
- Riyazi ifadələr üçün "latex" sahəsindən istifadə et. Sual mətnini BÜTÖVLÜKDƏ $...$ içinə ALMA — yalnız həqiqi düstur/ifadə $...$ ilə yazılır; adi cümlə heç vaxt.
- Dırnaq işarəsi lazımdırsa adi " işlət — \\" kimi qaçış simvolu YAZMA.
- Şəkil/qrafik tələb edən sual YARATMA (hasFigure həmişə false). Mümkün qədər mətnlə həll olunan suallar yarat.
- Oxu mətni (reading) yalnız istənildikdə əlavə et. İstənilsə, onu "reading" tipli AYRICA element kimi ver: bütün mətn "text" sahəsində, abzaslar iki yeni sətirlə (\\n\\n) ayrılsın, başlıq varsa "title"-də. Sonra o mətnə aid suallar ayrıca elementlər kimi gəlsin. choices=[], correct=[], pairs=[], openAnswer="".
- FORMATLAMA: oxu mətnində lazım gələndə Markdown işlət — **qalın** vacib terminlər/yarımbaşlıqlar üçün, *maili* xüsusi adlar/vurğu/xarici sözlər üçün. Abzas hərfi/nömrəsi olan mətndə həmin işarəni qalın ver (məs. "**A.** Octopuses exhibit…"). Formatı YALNIZ məna daşıdıqda işlət, hər cümləni qalınlaşdırma. HTML teqi YAZMA — yalnız ** və * işarələri.
- SIRALAMA: hər oxu mətnindən DƏRHAL SONRA ona aid suallar gəlsin. Bir mətnin summary/sentence-completion CLOZE tapşırığı varsa, onu həmin mətnin adi suallarından SONRA ayrıca "reading" bloku kimi ver — belə ki heç bir mətn "0 sual" ilə qalmır.
- OXU MƏTNİNİN UZUNLUĞU: akademik/IELTS oxu mətni UZUN və çoxabzaslı olsun — təxminən 700–900 söz (ən azı 500), 4–6 abzas. Qısa (100–300 sözlük) mətn IELTS deyil.
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
    note: "Güclü, orta qiymət",
    usd: { in: 1, cached: 0.1, out: 6 },
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
    usd: { in: 2.5, cached: 0.25, out: 15 },
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
    note: "Ən güclü — bahalı",
    usd: { in: 5, cached: 0.5, out: 30 },
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

// GET /api/quiz/ai/models — what the picker offers, and which one is preselected.
const listAiModels = asyncHandler(async (req, res) => {
  const available = AI_MODELS.filter((m) => {
    if (m.provider === "openai") return !!process.env.OPENAI_API_KEY;
    if (m.provider === "gemini") return !!process.env.GEMINI_API_KEY;
    if (m.provider === "claude") return !!process.env.ANTHROPIC_API_KEY;
    return false;
  }).map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    note: m.note || "",
    // Every OpenAI engine on the list carries a real price; the other two
    // providers price themselves.
    priceKnown: m.provider !== "openai" ? true : !!priceFor(m.id),
    usd: m.usd || null,
  }));
  const fallback = available.find((m) => m.id === DEFAULT_AI_MODEL) || available[0];
  res.json({ models: available, default: fallback?.id || DEFAULT_AI_MODEL });
});

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
async function generateWithOpenAI(prompt, presetId, modelId, onText, signal, systemOverride) {
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
        messages: [
          { role: "system", content: sys },
          { role: "user", content: prompt },
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

async function generateWithGemini(prompt, presetId, onText, signal, systemOverride) {
  if (!process.env.GEMINI_API_KEY)
    throw aiError(503, "AI konfiqurasiya olunmayıb (GEMINI_API_KEY)", true);
  const sys = (systemOverride || GEN_SYSTEM_PROMPT) + (presetHint(presetId) ? "\n\n" + presetHint(presetId) : "");
  const models = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);
  const buildBody = (model) =>
    JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
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

async function generateWithClaude(prompt, presetId, onText, signal, systemOverride) {
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
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
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
async function runGeneration({ prompt, preset, model, onText, signal, system }) {
  // The teacher's choice wins, but only from the allow-list: the id arrives
  // from a browser, and an unchecked one could name a pro tier at many times
  // the price. Anything unrecognised silently falls back to the default.
  const picked = findAiModel(String(model || "")) || findAiModel(DEFAULT_AI_MODEL);

  // `system` swaps the generator's prompt for a different one (the reviewer),
  // reusing the same provider chain, schema and fallback for the critic pass.
  const runners = {
    openai: (pr, ps, cb) =>
      generateWithOpenAI(pr, ps, picked?.provider === "openai" ? picked.id : undefined, cb, signal, system),
    gemini: (pr, ps, cb) => generateWithGemini(pr, ps, cb, signal, system),
    claude: (pr, ps, cb) => generateWithClaude(pr, ps, cb, signal, system),
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
const validatePassageStructure = (items, k) => {
  const out = [];
  const passage = items.find((q) => q.type === "reading" && !isClozeReading(q));
  if (!passage) out.push(`Passage ${k}: oxu mətni yoxdur`);
  else {
    const w = wordCountOf(passage.text);
    if (w < 450) out.push(`Passage ${k}: mətn qısadır (${w} söz)`);
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
        prompt: `${passagePrompt}\n\n[QEYD: əvvəlki cəhd naqis idi (qısa mətn və ya az sual). Mətni ƏN AZI 700 söz, 4–6 abzas yaz və tam sual dəstini ver.]`,
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
      exam: req.params.examId,
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
  let questions = [];
  let cost = null;
  let issues = [];
  let verified = false;
  try {
    if (passageCount >= 2) {
      // Multi-passage IELTS: one call per passage, merged (see runMultiPassage).
      const r = await runMultiPassage({ prompt, preset: req.body?.preset, model: req.body?.model, n: passageCount });
      questions = r.questions;
      cost = r.cost;
      issues = r.issues;
      verified = r.verified;
    } else {
      const out = await runGeneration({ prompt, preset: req.body?.preset, model: req.body?.model });
      // Agentic quality gate: the AI reviews its own answers and variants before
      // the teacher sees them. Falls back to the un-reviewed set if review fails.
      const v = await verifyAndFix({
        questions: out.questions,
        prompt,
        preset: req.body?.preset,
        model: req.body?.model,
      });
      questions = v.questions;
      cost = sumCost(out.cost, v.reviewCost);
      issues = v.issues;
      verified = v.rounds > 0 && v.issues.length === 0;
    }
  } catch (e) {
    res.status(e?.aiStatus || 502);
    throw new Error(e?.userMessage || "AI suallar yarada bilmədi");
  }
  await logGenerationUsage(req, { cost, questions });
  await rememberExamPrompt(req, prompt);
  res.json({ questions, cost, issues, verified });
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
        model: req.body?.model,
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
        model: req.body?.model,
        onText: (provider) => {
          const streamer = makeQuestionStreamer();
          let announced = false;
          return (full) => {
            if (!announced) {
              announced = true;
              sse("provider", { provider });
            }
            for (const q of streamer(full)) sse("question", q);
          };
        },
      });
      if (clientGone) {
        clearInterval(hb);
        return res.end();
      }
      // The stream showed the questions arriving; now the AI checks its own
      // answers before they are committed. `status` events drive the panel.
      const v = await verifyAndFix({
        questions: out.questions,
        prompt,
        preset: req.body?.preset,
        model: req.body?.model,
        signal: ac.signal,
        onStatus: (message) => sse("status", { message }),
      });
      questions = v.questions;
      cost = sumCost(out.cost, v.reviewCost);
      issues = v.issues;
      verified = v.rounds > 0 && v.issues.length === 0;
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
  sse("done", { questions, cost, issues, verified });
  res.end();
});


// POST /api/quiz/regenerateQuestion/:examId — rewrite ONE question.
//
// Runs through the same provider chain, schema and cleanup as a full
// generation, so a rewritten question is indistinguishable from a generated
// one. The model is allowed to change the question's TYPE: "make this multiple
// choice" is a normal thing to ask, and forcing the old type would make half
// the useful instructions impossible.
const regenerateQuestion = asyncHandler(async (req, res) => {
  const { question, instructions, examPrompt } = req.body || {};
  if (!question || typeof question !== "object") {
    res.status(400);
    throw new Error("Sual göndərilmədi");
  }

  // Everything the model needs to rewrite this one item, and nothing else.
  const ask = [
    "Aşağıdakı imtahan sualını YENİDƏN yaz. YALNIZ BİR sual qaytar.",
    "",
    "MÖVCUD SUAL (JSON):",
    JSON.stringify(question).slice(0, 4000),
    "",
    examPrompt ? `İMTAHANIN ÜMUMİ TƏSVİRİ: ${String(examPrompt).slice(0, 500)}` : "",
    "",
    instructions && String(instructions).trim()
      ? `MÜƏLLİMİN GÖSTƏRİŞİ: ${String(instructions).trim().slice(0, 1000)}`
      : "GÖSTƏRİŞ YOXDUR: eyni mövzuda, eyni çətinlikdə, TAMAMİLƏ BAŞQA bir sual yaz.",
    "",
    "QAYDALAR:",
    "- Dəqiq 1 sual qaytar (questions massivində bir element).",
    "- Göstəriş tələb edirsə sualın TİPİNİ dəyişə bilərsən (məs. açıq → çox seçim).",
    "- Göstərişdə başqa cür deyilməyibsə, mövzu və fənn eyni qalsın.",
    "- Köhnə sualı təkrarlama — yeni sual fərqli olsun.",
    // The rewrite panel is the one place a teacher explicitly asks for a
    // matching question, so the rule it is easiest to break gets repeated here.
    "- UYĞUNLUQ (Cma) yazırsansa: nömrələnmiş və hərflənmiş siyahıların MƏTNİ mütləq \"text\" içində olsun (hər element ayrı sətirdə); \"pairs\" yalnız uyğunluğu saxlayır (\"left\"=\"1\", \"right\"=\"b\"). Şagird ekranda yalnız boş 1/2/3 → A/B/C şəbəkəsini görür; \"pairs\" içindəki məzmun GÖRÜNMÜR.",
    "- Verilən element OXU MƏTNİDİRSƏ (type=\"reading\"): dəqiq 1 \"reading\" elementi qaytar — mətni yenidən yaz, məqsədini və uzunluğunu təxminən saxla, abzasları \\n\\n ilə ayır. Mətndə [[cavab]] boşluqları varsa, cloze formatını saxla və boşluqları yenə [[cavab]] (və ya [[cavab|alternativ]]) kimi mətnin içində ver.",
  ]
    .filter(Boolean)
    .join("\n");

  let out = null;
  try {
    out = await runGeneration({
      prompt: ask,
      preset: req.body?.preset,
      model: req.body?.model,
    });
  } catch (e) {
    res.status(e?.aiStatus || 502);
    throw new Error(e?.userMessage || "Sual yenidən yazıla bilmədi");
  }

  const generated = cleanQuestions(out.questions || []);
  if (generated.length !== 1) {
    res.status(502);
    throw new Error("AI dəqiq bir sual qaytarmadı");
  }

  const v = await verifyAndFix({
    questions: generated,
    prompt: ask,
    preset: req.body?.preset,
    model: req.body?.model,
  });
  const [fresh] = v.questions || [];
  if (!fresh) {
    res.status(502);
    throw new Error("AI yeni sual qaytarmadı");
  }
  const cost = sumCost(out.cost, v.reviewCost);
  await logGenerationUsage(req, { ...out, cost, questions: [fresh] });

  // An edited description sent from the rewrite panel becomes the exam's
  // description from here on.
  await rememberExamPrompt(req, examPrompt);
  res.json({
    question: fresh,
    cost,
    issues: v.issues,
    verified: v.rounds > 0 && v.issues.length === 0,
  });
});

// ============================ Teacher chat assistant ============================
// A lightweight in-dashboard helper for TEACHERS: answers "how do I do X in
// Examopia" in Azerbaijani. Uses Gemini Flash (cheap) with a Claude fallback.
// The knowledge base is baked into the system prompt for now (RAG can come later).

const CHAT_SYSTEM_PROMPT = `Sən "Examopia" platformasının köməkçisisən. Examopia müəllimlər üçün onlayn imtahan/sınaq platformasıdır və İSTƏNİLƏN FƏNN üçün imtahan yaratmağa imkan verir — riyaziyyat, fizika, kimya, biologiya, tarix, coğrafiya, informatika, ədəbiyyat, Azərbaycan dili, İngilis dili, rus dili və digərləri. Riyaziyyat, Azərbaycan dili və İngilis dili üçün əlavə olaraq HAZIR DİM presetləri var; digər fənlər üçün "Fərdi (sıfırdan)" preseti ilə eyni şəkildə imtahan yaradılır.
MÜHÜM: Heç vaxt "bu fənn üçün imtahan yarada bilmərəm" DEMƏ — istənilən fənn dəstəklənir.

QAYDALAR:
- Cavabları HƏMİŞƏ Azərbaycan dilində, qısa, aydın və mümkünsə addım-addım ver.
- FORMAT: Cavabı oxunaqlı et. Sadə suala 1-2 cümlə ilə cavab ver — siyahı işlətmə. LAKİN bir neçə element sadalayanda (siniflər, imtahanlar, addımlar) Markdown istifadə et: nömrəli siyahı (1. 2. 3.) və ya "- " ilə tire siyahı, vacib sözlər üçün **qalın**. Hər elementi ayrı sətirdə yaz. Cədvəl istifadə etmə.
- Yalnız Examopia və müəllim işləri ilə bağlı suallara kömək et. Mövzudan kənar suallarda nəzakətlə platformaya yönləndir.
- Dəqiq bilmədiyin funksiyanı UYDURMA — düzgün bölməyə yönləndir və ya dəstəklə əlaqə saxlamağı təklif et.

PLATFORMA BİLİKLƏRİ:
- Sinif: "Siniflər" bölməsindən yeni sinif yaradılır. Hər sinifin qoşulma kodu (join code) olur; şagirdlər həmin kodla qoşulur.
- İmtahan yaratmaq: sinifin içində "İmtahan əlavə et". İki yol var: (1) "PDF yüklə" — hazır PDF-dən suallar; (2) "Özüm yazım / AI ilə" — struktur builder-də əl ilə və ya AI ilə PDF-dən avtomatik çıxarış.
- Preset: imtahanın balını və sual strukturunu avtomatik qurur — Riyaziyyat (Buraxılış, Blok 1 və 2-ci qrup), Azərbaycan dili (9, 11), İngilis dili (9, 11), və ya "Fərdi (sıfırdan)" — heç bir hazır struktur olmadan sıfırdan.
- Müddət DƏQİQƏ ilə təyin olunur; başlanma və bitmə tarixini seçmək olar. "Ümumi bal" və "Keçid balı" ayrıca yazılır.
- "Ətraflı parametrlər": video həll, ödənişli imtahan, cəhd limiti, parol, neqativ qiymətləndirmə, anti-cheat, həll şəkilləri və nəticə görünüşü buradadır.
- Nəticə görünüşü: balın və düzgün cavabların şagirdə nə vaxt (dərhal / imtahandan sonra) göstərilməsini idarə etmək olar.
- İngilis dili imtahanlarına dinləmə (mp3) faylı əlavə etmək olar.
- WhatsApp: müəllim öz nömrəsini bağlayıb yeni imtahan bildirişini öz qrupuna göndərə bilər (qoşulma kodu ilə birlikdə).
- Nəticələr: "Nəticələr" bölməsində şagird nəticələri görünür.

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
  res.json({ token: data?.value, expires_at: data?.expires_at });
});

module.exports = {
  regenerateQuestion,
  listAiModels,
  // exported for tests / benchmarking
  GEN_SYSTEM_PROMPT,
  EXTRACTION_SCHEMA,
  runGeneration,
  runMultiPassage,
  detectPassageCount,
  extractWithGemini,
  extractWithOpenAI,
  // exported for tests
  cleanQuestions,
  auditQuestions,
  stripAnswers,
  applyAnswerMode,
  verifyAndFix,
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
