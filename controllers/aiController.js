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
          type: { type: "string", enum: ["Cm", "Cs", "Co", "Cma", "reading"] },
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

const SYSTEM_PROMPT = `You extract exam questions from a PDF into structured data for a math exam platform. The exam content is in Azerbaijani; keep all text in its original language.

Output one item per question, in document order, using these types:
- "Cm": single correct answer among options.
- "Cs": multiple correct answers among options (only when the question clearly allows more than one).
- "Co": open / free-text answer (no options).
- "Cma": matching (left column items paired with right column items).
- "reading": a reading-comprehension PASSAGE (a "mətn" / text the student must read), NOT a question. When the PDF contains a passage that several following questions refer to, emit it as ONE separate "reading" item placed IMMEDIATELY BEFORE those questions, then continue with the questions as normal types. Never inline the passage into each question and never duplicate it.

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
- "title": ONLY for a "reading" item — its real heading/name if the passage has one (e.g. a story title like "Yeni ada"). Do NOT use a section label such as "Mətn (37–46-cı suallar üçün)" or "Mətn 1" as the title — those are labels, not titles; if there is only such a label and no real title, return "". For every normal (non-reading) question return "". For a "reading" item, put the FULL passage body in "text" and SEPARATE EACH PARAGRAPH WITH A BLANK LINE (two newlines \\n\\n) so paragraph spacing is preserved; use a single \\n only for a forced line break. Keep Roman-numeral paragraph labels (I, II, III …) and any ▲/● markers at the start of the lines where they appear. Do NOT write the HTML tag <br>. Set choices=[], correct=[], pairs=[], hasFigure=false, openAnswer="". Then the questions about that passage follow as their own items.
- "latex": ALWAYS return an empty string "". All math now lives inline inside the text fields, never in a separate field.
- "choices": for Cm/Cs, one object per option in the order shown (drop the A/B/C labels — they are implicit by position). Put each option's text in "text" with any math inline via $...$ (e.g. "$9ab$", "2500"). Set the choice "latex" to "". The options live ONLY here — never repeat them inside the question "text". For Co/Cma, use an empty array.
- OPTION CONTENT (important): each answer option's FULL text goes in its "choices" entry EXACTLY as printed — even if the option is long or spans several lines (e.g. a poem couplet, a whole sentence). NEVER replace an option with just its letter, and NEVER dump the list of options into the question "text". The question "text" holds only the instruction (+ any numbered items the question asks about).
- DIAGRAM / SCHEME OPTIONS: if the answer options THEMSELVES are pictures (e.g. the A–E syntactic-analysis line/arc schemes under a sentence), you cannot transcribe them — set "hasFigure": true and output each choice as JUST its letter ("A", "B", "C", "D", "E") so the teacher can add the picture of the options.
- "correct": indices (0-based) into "choices" of the correct option(s) — ONLY if the PDF itself marks/states the correct answer (e.g. an answer key, a highlighted option, or a stated solution). If the correct answer is NOT given in the PDF, return an EMPTY array. NEVER guess or solve the question to fill this — leave it empty for the teacher to mark.
- MATCHING WITH ANSWER VARIANTS → CLOSED, NOT Cma: a question may say "Uyğunluğu müəyyən(ləşdir)in" yet PROVIDE lettered answer variants A–E that each encode a pairing (e.g. "A) 1 – a, b; 2 – d"  "B) 1 – a, c; 2 – b, e"). That is a CLOSED single-choice question: use type "Cm". Put the items being matched (the 1., 2., … list AND the a., b., c., … list) in "text", and put each A–E variant as a "choices" entry with its exact text (e.g. "1 – a, b; 2 – d"). Do NOT output "Cma"/pairs for these. Use "Cma" ONLY when the question gives NO answer variants and the student must build the pairing themselves. (The lowercase a., b., c. items belong in "text" — they are content to match, NOT the answer choices; only the uppercase A–E variants are choices.)
- "pairs": for Cma matching, one object per LEFT item (e.g. one per number 1, 2, 3 …) in order. Put math inline in "left"/"right" via $...$ and set "leftLatex"/"rightLatex" to "". Empty array otherwise. For a numbers→letters correspondence, "left" is the number/item and "right" is its correct letter(s): if ONE left matches SEVERAL letters, list them comma-separated in that one right value (e.g. "a, d"). A letter may repeat across different lefts. The app turns this into a grid where each letter is selected individually.
- "openAnswer": for Co, the correct answer text (math inline via $...$) ONLY if the PDF states it; otherwise "".
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
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
// Stable fallback tried if the primary model stays overloaded (503). NOTE: keep
// this a model the key actually has quota for — gemini-2.0-flash returns 429
// "limit: 0" on free-tier keys, which is useless. gemini-2.5-flash has quota.
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash";
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
          type: { type: "STRING", enum: ["Cm", "Cs", "Co", "Cma", "reading"] },
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
  const provider =
    String(req.body?.provider || "").toLowerCase() === "gemini" ? "gemini" : "claude";
  const instructions = buildInstructions(req.body?.preset, req.body?.instructions);

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

  res.status(200).json({ success: true, questions, usage, cost, provider: usedProvider, fellBack });
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
  const provider =
    String(req.body?.provider || "").toLowerCase() === "gemini" ? "gemini" : "claude";
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

  let result;
  let usedProvider = provider;
  let fellBack = false;
  try {
    result =
      provider === "gemini"
        ? await streamGemini(base64, instructions, mkOnText())
        : await streamClaude(base64, instructions, mkOnText());
  } catch (e) {
    console.error(`AI extract (${provider}) failed:`, e?.status, e?.message);
    if (provider === "gemini" && e.aiFallback) {
      sse("status", { message: "Gemini əlçatan deyil — Claude ilə davam edilir…" });
      try {
        result = await streamClaude(base64, instructions, mkOnText());
        usedProvider = "claude";
        fellBack = true;
      } catch (e2) {
        console.error("AI extract (claude fallback) failed:", e2?.status, e2?.message);
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
  } catch (e) {
    console.error(
      `AI extract (${usedProvider}) JSON parse failed; full length=${(result.full || "").length}, head=`,
      (result.full || "").slice(0, 200)
    );
    sse("error", { message: "AI cavabı oxunmadı. Yenidən cəhd edin." });
    return res.end();
  }
  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  if (!questions.length) {
    console.warn(
      `AI extract (${usedProvider}) returned 0 questions; full length=${(result.full || "").length}, head=`,
      (result.full || "").slice(0, 200)
    );
  }
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

// ============================ AI question GENERATION ============================
// Generate exam questions from a TEXT description (no PDF). Same output shape as
// extraction, so results drop into the structured builder for review. Unlike
// extraction, generation MAY fill in the correct answers.

const GEN_SYSTEM_PROMPT = `Sən imtahan sualları YARADAN AI köməkçisisən. Müəllimin təsvirinə əsasən suallar yarat və NƏTİCƏNİ YALNIZ verilən JSON sxemi ilə qaytar.

QAYDALAR:
- Müəllimin istədiyi SAY və NÖV sualları yarat (məs. "10 qapalı riyaziyyat sualı").
- Dil: mövzuya uyğun — İngilis dili mövzusu deyilsə, suallar Azərbaycan dilində olsun.
- Qapalı sual (Cm/Cs): "choices" massivində A–E variantları ver və düzgün variant(lar)ın indeksini "correct" massivinə yaz.
- Açıq sual (Co): "choices" boş. BÜTÜN məqbul cavabları "openAnswers" MASSİVİNƏ yaz — HƏR məqbul cavab (sinonim/variant) AYRICA element olsun (məs: ["yaş","quru","dolu"]). Nömrələmə, "və ya", "/", mötərizə İSTİFADƏ ETMƏ — bir sətirdə bir neçə cavab birləşdirmə. "openAnswer" sahəsinə isə birinci cavabı yaz. Qapalı suallarda "openAnswers" boş massiv [] olsun.
- Riyazi ifadələr üçün "latex" sahəsindən istifadə et.
- Şəkil/qrafik tələb edən sual YARATMA (hasFigure həmişə false). Mümkün qədər mətnlə həll olunan suallar yarat.
- Xahiş olunmayıbsa oxu mətni (reading) əlavə etmə.
- Suallar aydın, düzgün və imtahan səviyyəsinə uyğun olsun.`;

async function generateWithGemini(prompt, presetId) {
  if (!process.env.GEMINI_API_KEY)
    throw aiError(503, "AI konfiqurasiya olunmayıb (GEMINI_API_KEY)", true);
  const sys = GEN_SYSTEM_PROMPT + (presetHint(presetId) ? "\n\n" + presetHint(presetId) : "");
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
      let r, data;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-goog-api-key": process.env.GEMINI_API_KEY },
            body: buildBody(model),
          }
        );
        data = await r.json();
      } catch (e) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (r.ok && !data?.error) {
        const text =
          (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join("") || "{}";
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          continue;
        }
        return {
          questions: Array.isArray(parsed.questions) ? parsed.questions : [],
          cost: computeGeminiCost(data.usageMetadata, model),
        };
      }
      if (r.status && ![429, 500, 503].includes(r.status)) break;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw aiError(502, "AI suallar yarada bilmədi, yenidən cəhd et", true);
}

async function generateWithClaude(prompt, presetId) {
  const client = getClient();
  if (!client) throw aiError(503, "AI konfiqurasiya olunmayıb (ANTHROPIC_API_KEY)");
  const sys = [
    { type: "text", text: GEN_SYSTEM_PROMPT + (presetHint(presetId) ? "\n\n" + presetHint(presetId) : "") },
  ];
  let message;
  try {
    message = await client.messages
      .stream({
        model: "claude-opus-4-8",
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        system: sys,
        output_config: { effort: "high", format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      })
      .finalMessage();
  } catch (e) {
    throw aiError(502, "AI suallar yarada bilmədi. Yenidən cəhd et.");
  }
  const textBlock = message.content.find((b) => b.type === "text");
  let parsed;
  try {
    parsed = JSON.parse(textBlock?.text || "{}");
  } catch {
    throw aiError(502, "AI cavabı oxunmadı. Yenidən cəhd et.");
  }
  return {
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    cost: computeCost(message.usage),
  };
}

// POST /api/quiz/generateQuestions/:examId (teacher) — { prompt, preset } -> { questions, cost }
const generateQuestions = asyncHandler(async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim().slice(0, 4000);
  const preset = req.body?.preset;
  if (!prompt) {
    res.status(400);
    throw new Error("İmtahan təsviri boşdur");
  }
  let out;
  try {
    out = process.env.GEMINI_API_KEY
      ? await generateWithGemini(prompt, preset)
      : await generateWithClaude(prompt, preset);
  } catch (e) {
    if (e.aiFallback && getClient()) out = await generateWithClaude(prompt, preset);
    else {
      res.status(e.aiStatus || 502);
      throw new Error(e.userMessage || "AI suallar yarada bilmədi");
    }
  }
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
  res.json({ questions: out.questions || [], cost: out.cost });
});

// ============================ Teacher chat assistant ============================
// A lightweight in-dashboard helper for TEACHERS: answers "how do I do X in
// Examopia" in Azerbaijani. Uses Gemini Flash (cheap) with a Claude fallback.
// The knowledge base is baked into the system prompt for now (RAG can come later).

const CHAT_SYSTEM_PROMPT = `Sən "Examopia" platformasının köməkçisisən. Examopia müəllimlər üçün onlayn imtahan/sınaq platformasıdır (riyaziyyat, Azərbaycan dili, İngilis dili — DİM formatı).

QAYDALAR:
- Cavabları HƏMİŞƏ Azərbaycan dilində, qısa, aydın və mümkünsə addım-addım ver.
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

HESABI GÖRMƏK (ÇOX VACİB): Sənin bu müəllimin ÖZ hesabına baxmaq üçün alətlərin var. İstifadəçi öz sinifləri, imtahanları, şagird sayı və ya imtahan sayı haqqında soruşanda ("Azərbaycan dili sinfində neçə imtahan var?", "neçə sinfim var?", "hansı imtahanlarım var?") ƏSLA "platformaya daxil ol / mən görə bilmirəm" DEMƏ. Bunun əvəzinə "list_classes" və ya "find_exams" alətini çağır və CAVABI birbaşa, dəqiq rəqəmlərlə ver (məs: "Azərbaycan dili sinfində 3 imtahanın var.").

MÖVCUD İMTAHANI DƏYİŞMƏK: İstifadəçi imtahanı dəyişmək istəyirsə (tarix, müddət, bal, keçid balı, parol aç/bağla, neqativ qiymətləndirmə, anti-cheat, cəhd limiti, nəticə görünüşü), "find_exams" ilə tap (lazım olsa className ilə filtrlə). Bir neçə uyğun varsa hansını nəzərdə tutduğunu SORUŞ. Sonra "update_exam" ilə tətbiq et və qısa təsdiqlə. Tarixləri Azərbaycan vaxtı (UTC+4) kimi anla və ISO +04:00 ofset ilə ötür (məs: 2026-07-05T14:00:00+04:00). Yalnız istifadəçinin sahib olduğu sinif/imtahanları görə və dəyişə bilərsən.`;

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

const EXAM_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_classes",
      description:
        "List the current teacher's OWN classes with their join code, number of students, and how many exams each class has. Use this to answer questions about classes, exam counts per class, or student counts.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "find_exams",
      description:
        "Find the current teacher's exams by (partial) name and/or class name, returning each exam's id, class, and current settings. Empty query + empty className = recent exams.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "part of the exam name, or empty" },
          className: { type: "string", description: "part of a class name to filter by, or empty" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_exam",
      description:
        "Update settings of ONE exam the teacher owns. Only include the fields to change. Dates must be ISO with the +04:00 (Azerbaijan) offset. Send password:'' to remove a password.",
      parameters: {
        type: "object",
        properties: {
          examId: { type: "string" },
          startDate: { type: "string", description: "ISO datetime with +04:00, or '' to clear" },
          endDate: { type: "string", description: "ISO datetime with +04:00, or '' to clear" },
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

async function toolListClasses(userId) {
  const classes = await Class.find({ owner: userId }).sort({ createdAt: -1 }).lean();
  if (!classes.length) return { classes: [] };
  const ids = classes.map((c) => c._id);
  const examCounts = await Exam.aggregate([
    { $match: { owner: userId } },
    { $group: { _id: "$class", n: { $sum: 1 } } },
  ]);
  const examMap = {};
  examCounts.forEach((c) => (examMap[String(c._id)] = c.n));
  const enr = await Enrollment.aggregate([
    { $match: { class: { $in: ids }, status: "approved" } },
    { $group: { _id: "$class", n: { $sum: 1 } } },
  ]);
  const stuMap = {};
  enr.forEach((e) => (stuMap[String(e._id)] = e.n));
  return {
    classes: classes.map((c) => ({
      id: String(c._id),
      name: c.name,
      joinCode: c.joinCode,
      students: stuMap[String(c._id)] || 0,
      exams: examMap[String(c._id)] || 0,
    })),
  };
}

async function toolFindExams(query, userId, className) {
  const filter = { owner: userId };
  if (query && query.trim()) filter.name = new RegExp(escapeRegex(query.trim()), "i");
  if (className && className.trim()) {
    const cls = await Class.find({
      owner: userId,
      name: new RegExp(escapeRegex(className.trim()), "i"),
    })
      .select("_id")
      .lean();
    filter.class = { $in: cls.map((c) => c._id) };
  }
  const exams = await Exam.find(filter)
    .sort({ createdAt: -1 })
    .limit(20)
    .populate("class", "name")
    .lean();
  return exams.map((e) => ({
    id: String(e._id),
    name: e.name,
    className: e.class?.name || null,
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
  }));
}

async function toolUpdateExam(args, userId) {
  const exam = await Exam.findById(args.examId);
  if (!exam) return { error: "İmtahan tapılmadı" };
  if (String(exam.owner) !== String(userId)) return { error: "Bu imtahanı dəyişməyə icazən yoxdur" };
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
  await exam.save();
  return { ok: true, examId: String(exam._id), name: exam.name, applied };
}

async function execTool(name, args, userId) {
  try {
    if (name === "list_classes") return await toolListClasses(userId);
    if (name === "find_exams") return await toolFindExams(args.query, userId, args.className);
    if (name === "update_exam") return await toolUpdateExam(args, userId);
  } catch (e) {
    return { error: e.message || "Əməliyyat alınmadı" };
  }
  return { error: "unknown tool" };
}

// OpenAI chat WITH tools — runs the tool loop so the assistant can act (edit
// exams). Returns the final text + accumulated cost. `changed` flags whether any
// exam was mutated (so the client can refresh).
async function runChatAgent(messages, userId) {
  const model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
  const convo = [{ role: "system", content: CHAT_SYSTEM_PROMPT }, ...messages];
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
    convo.push(msg);
    if (msg?.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let a = {};
        try {
          a = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* bad args */
        }
        const result = await execTool(tc.function.name, a, userId);
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
    out = process.env.OPENAI_API_KEY
      ? await runChatAgent(messages, req.user._id)
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
  extractQuestions,
  extractQuestionsStream,
  getAiUsage,
  chatAssistant,
  generateQuestions,
  transcribeAudio,
  realtimeToken,
};
