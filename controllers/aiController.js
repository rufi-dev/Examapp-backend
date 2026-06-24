const asyncHandler = require("express-async-handler");
const AnthropicPkg = require("@anthropic-ai/sdk");
// CJS interop: the constructor is the default export on recent builds.
const Anthropic = AnthropicPkg.default || AnthropicPkg;
const AiUsage = require("../models/aiUsageModel");
const User = require("../models/userModel");

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
          type: { type: "string", enum: ["Cm", "Cs", "Co", "Cma"] },
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
          "explanation",
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

Rules:
- "text": the FULL question statement, with every mathematical formula written INLINE, at the EXACT position it appears, as LaTeX wrapped in single dollar signs ($...$). Keep the math in the same order and place as the document — do NOT move formulas to the end. Examples:
  - "3500-ün $\\\\frac{5}{7}$ hissəsini tapın."
  - "$\\\\begin{cases}x^{2}y-xy^{2}=12\\\\\\\\xy=6\\\\end{cases}$ tənliklər sistemindən $x^{2}+y^{2}$-nın cəmini tapın."
  - "$\\\\sqrt{3}=a$ və $\\\\sqrt{5}=b$ olarsa, $\\\\sqrt{540}$ ədədini $a$ və $b$ ilə əvəz edin."
  Use $$...$$ only for a big standalone display formula. Write a literal dollar sign as \\\\$.
- PRESERVE LINE BREAKS inside "text": keep the document's line structure. Put each line that is on its own line in the PDF on its own line using a real newline (\\n). In particular, put each numbered item (1., 2., 3., …) and each lettered option (a., b., c., …) on a SEPARATE line, and keep a blank line between distinct groups (e.g. between the numbered list and the lettered list). NEVER collapse a multi-line question into a single line.
- "latex": ALWAYS return an empty string "". All math now lives inline inside the text fields, never in a separate field.
- "choices": for Cm/Cs, one object per option in the order shown (drop the A/B/C labels — they are implicit by position). Put each option's text in "text" with any math inline via $...$ (e.g. "$9ab$", "2500"). Set the choice "latex" to "". For Co/Cma, use an empty array.
- "correct": indices (0-based) into "choices" of the correct option(s) — ONLY if the PDF itself marks/states the correct answer (e.g. an answer key, a highlighted option, or a stated solution). If the correct answer is NOT given in the PDF, return an EMPTY array. NEVER guess or solve the question to fill this — leave it empty for the teacher to mark.
- "pairs": for Cma matching, one object per LEFT item (e.g. one per number 1, 2, 3 …) in order. Put math inline in "left"/"right" via $...$ and set "leftLatex"/"rightLatex" to "". Empty array otherwise. For a numbers→letters correspondence, "left" is the number/item and "right" is its correct letter(s): if ONE left matches SEVERAL letters, list them comma-separated in that one right value (e.g. "a, d"). A letter may repeat across different lefts. The app turns this into a grid where each letter is selected individually.
- "openAnswer": for Co, the correct answer text (math inline via $...$) ONLY if the PDF states it; otherwise "".
- "hasFigure": true if the question depends on a diagram, graph, geometric figure, or image that cannot be represented as text/LaTeX (the teacher will add the image). Still extract the surrounding text.
- "explanation": a worked solution/explanation (math inline via $...$) ONLY if the PDF provides one; otherwise "".

Transcribe faithfully. Do not invent questions, options, or answers. If the PDF is a question bank with no answer key, every "correct" array is empty and that is correct.`;

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
          type: { type: "STRING", enum: ["Cm", "Cs", "Co", "Cma"] },
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
          explanation: { type: "STRING" },
        },
        required: [
          "type", "text", "latex", "choices", "correct",
          "pairs", "hasFigure", "openAnswer", "explanation",
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

async function extractWithClaude(base64) {
  const client = getClient();
  if (!client) throw aiError(503, "AI funksiyası konfiqurasiya olunmayıb (ANTHROPIC_API_KEY)");
  let message;
  try {
    message = await client.messages
      .stream({
        model: "claude-opus-4-8",
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
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

async function extractWithGemini(base64) {
  if (!process.env.GEMINI_API_KEY) throw aiError(503, "AI funksiyası konfiqurasiya olunmayıb (GEMINI_API_KEY)");
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
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

  let questions = [];
  let usage = null;
  let cost = null;
  let usedProvider = provider;
  let fellBack = false;
  try {
    ({ questions, usage, cost } =
      provider === "gemini" ? await extractWithGemini(base64) : await extractWithClaude(base64));
  } catch (e) {
    // If Gemini is busy / out of quota, automatically retry on Claude so the
    // teacher isn't dead-ended — they still get their questions (slightly pricier).
    if (provider === "gemini" && e.aiFallback) {
      try {
        ({ questions, usage, cost } = await extractWithClaude(base64));
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

module.exports = { extractQuestions, getAiUsage };
