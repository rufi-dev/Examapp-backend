/*
 * The AI DOCUMENT path — one arbitrary JSON document from a custom system prompt,
 * optionally with uploaded files attached.
 *
 * Why this exists: nothing in the exam pipeline can do it. The file-reading
 * functions (extractWithX and streamX) hard-code SYSTEM_PROMPT + EXTRACTION_SCHEMA and
 * return `parsed.questions`; the custom-prompt functions (generateWith*) accept a
 * systemOverride but take ONLY text — no `parts` argument exists anywhere.
 *
 * Why it is a PARALLEL path and not a refactor of those six: there is no test net
 * on the exam path (tests/ai-request-fidelity.test.js asserts two pure string
 * functions; nothing mocks a provider or asserts a request body), and the six
 * differ in ways a unification would silently flatten — extraction sets
 * cache_control:ephemeral on the system block while generation deliberately does
 * not; extraction runs temperature 0.2 + thinkingBudget -1 against generation's
 * 0.6 + 0; extraction uses the OpenAI *Responses* API while generation uses
 * chat/completions; the retry topologies were tuned against real proxy timeouts.
 * Converging them belongs behind a recorded-fixture harness, later.
 *
 * Deliberate differences from the extract functions, both wanted:
 *   - documentWithOpenAI PASSES the abort signal (extractWithOpenAI does not, so a
 *     cancelled extraction keeps billing);
 *   - these return the WHOLE parsed object, not `parsed.questions`.
 *
 * NO PRESET EVER. presetHint() is appended unconditionally by all three exam
 * generators even when a systemOverride is set, so routing a document through them
 * would leak "This is an IELTS Academic Reading exam — write EVERYTHING in
 * English" into a lesson plan. Nothing here takes a preset.
 */
const AnthropicPkg = require("@anthropic-ai/sdk");

const Anthropic = AnthropicPkg.default || AnthropicPkg;

const DOC_MAX_TOKENS = 8000;

let _client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic();
  return _client;
}

function docError(status, userMessage, fallback = false) {
  const e = new Error(userMessage);
  e.aiStatus = status;
  e.userMessage = userMessage;
  e.aiFallback = fallback;
  return e;
}

function parseDoc(text) {
  let parsed;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    throw docError(502, "AI cavabı oxunmadı. Yenidən cəhd edin.", true);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw docError(502, "AI gözlənilən sənəd formatını qaytarmadı.", true);
  }
  return parsed;
}

async function documentWithClaude({ prompt, parts = [], system, schema, signal, maxTokens = DOC_MAX_TOKENS }) {
  const { claudeContentParts, computeCost } = require("../controllers/aiController");
  const client = anthropic();
  if (!client) throw docError(503, "AI funksiyası konfiqurasiya olunmayıb (ANTHROPIC_API_KEY)", true);
  let message;
  try {
    message = await client.messages
      .stream({
        model: "claude-opus-4-8",
        max_tokens: maxTokens,
        system: [{ type: "text", text: system }],
        output_config: { effort: "high", format: { type: "json_schema", schema } },
        messages: [
          {
            role: "user",
            // Every block carries real text — an empty text block is rejected by
            // the API (the defect this module's sibling fix removed upstream).
            content: [...claudeContentParts(parts), { type: "text", text: prompt }],
          },
        ],
      })
      .finalMessage();
  } catch (e) {
    console.error("AI document (claude) error:", e?.status, e?.message);
    throw docError(502, "AI sənədi hazırlaya bilmədi. Bir az sonra yenidən cəhd edin.", true);
  }
  if (message.stop_reason === "refusal") throw docError(422, "AI bu sorğunu emal edə bilmədi.");
  const textBlock = message.content.find((b) => b.type === "text");
  return { doc: parseDoc(textBlock?.text), cost: computeCost(message.usage), usage: message.usage };
}

async function documentWithOpenAI({
  prompt,
  parts = [],
  system,
  schema,
  schemaName = "document",
  model,
  signal,
  maxTokens = DOC_MAX_TOKENS,
}) {
  const { openaiContentParts, findAiModel, DEFAULT_AI_MODEL, computeOpenAIGenCost } = require("../controllers/aiController");
  if (!process.env.OPENAI_API_KEY) throw docError(503, "AI funksiyası konfiqurasiya olunmayıb (OPENAI_API_KEY)", true);
  // The Responses API is the only OpenAI endpoint that accepts a PDF, and it
  // behaves identically with parts = [] — so one function covers both cases.
  const picked = findAiModel(String(model || "")) || findAiModel(DEFAULT_AI_MODEL);
  const modelId = picked ? picked.id : DEFAULT_AI_MODEL;
  let r;
  try {
    r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: modelId,
        input: [
          { role: "system", content: [{ type: "input_text", text: system }] },
          { role: "user", content: [...openaiContentParts(parts, "source"), { type: "input_text", text: prompt }] },
        ],
        text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
        max_output_tokens: maxTokens,
      }),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw docError(499, "Ləğv edildi");
    throw docError(502, "AI sənədi hazırlaya bilmədi. Yenidən cəhd et.", true);
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error("OpenAI document failed:", r.status, body.slice(0, 400));
    throw docError(r.status === 400 ? 422 : 502, "AI sənədi hazırlaya bilmədi.", r.status !== 400);
  }
  const data = await r.json().catch(() => null);
  const text =
    data?.output_text ||
    (Array.isArray(data?.output)
      ? data.output
          .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
          .map((c) => c.text || "")
          .join("")
      : "");
  return { doc: parseDoc(text), cost: computeOpenAIGenCost(data?.usage, modelId, modelId), usage: data?.usage };
}

async function documentWithGemini({ prompt, parts = [], system, schema, signal, maxTokens = DOC_MAX_TOKENS }) {
  const { geminiContentParts, computeGeminiCost, GEMINI_DOC_MODEL } = require("../controllers/aiController");
  if (!process.env.GEMINI_API_KEY) throw docError(503, "AI funksiyası konfiqurasiya olunmayıb (GEMINI_API_KEY)", true);
  const model = GEMINI_DOC_MODEL;
  let r;
  try {
    r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [...geminiContentParts(parts), { text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
            maxOutputTokens: maxTokens,
            temperature: 0.4,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal,
      }
    );
  } catch (e) {
    if (signal?.aborted) throw docError(499, "Ləğv edildi");
    throw docError(502, "AI sənədi hazırlaya bilmədi. Yenidən cəhd et.", true);
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error("Gemini document failed:", r.status, body.slice(0, 400));
    throw docError(r.status === 400 ? 422 : 502, "AI sənədi hazırlaya bilmədi.", r.status !== 400);
  }
  const data = await r.json().catch(() => null);
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  return { doc: parseDoc(text), cost: computeGeminiCost(data?.usageMetadata, model), usage: data?.usageMetadata };
}

/*
 * Provider fallback, mirroring runGeneration: start with the caller's model, then
 * fall through the rest; advance ONLY on e.aiFallback (a bad prompt is not paid
 * for three times); and on an aborted signal throw 499 immediately rather than
 * billing two more providers for output nobody is waiting for.
 */
async function runDocument({ prompt, parts = [], system, schema, geminiSchema, model, signal, maxTokens }) {
  const { findAiModel, DEFAULT_AI_MODEL } = require("../controllers/aiController");
  const picked = findAiModel(String(model || "")) || findAiModel(DEFAULT_AI_MODEL);
  const runners = {
    openai: () => documentWithOpenAI({ prompt, parts, system, schema, model: picked?.id, signal, maxTokens }),
    gemini: () => documentWithGemini({ prompt, parts, system, schema: geminiSchema || schema, signal, maxTokens }),
    claude: () => documentWithClaude({ prompt, parts, system, schema, signal, maxTokens }),
  };
  const keyFor = {
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    claude: process.env.ANTHROPIC_API_KEY,
  };
  const order = [picked?.provider, "openai", "gemini", "claude"].filter((p, i, a) => p && a.indexOf(p) === i);
  const chain = order.filter((p) => !!keyFor[p]);

  let lastErr = null;
  for (const name of chain) {
    try {
      const out = await runners[name]();
      return { ...out, provider: name, fellBack: name !== order[0] };
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw docError(499, "Ləğv edildi");
      console.error(`document via ${name} failed:`, e?.message);
      if (!e.aiFallback) break;
    }
  }
  throw lastErr || docError(502, "AI sənədi hazırlaya bilmədi");
}

module.exports = {
  DOC_MAX_TOKENS,
  documentWithClaude,
  documentWithOpenAI,
  documentWithGemini,
  runDocument,
  parseDoc,
  docError,
};
