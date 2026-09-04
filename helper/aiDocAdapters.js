/*
 * What each provider needs, and nothing about what a studio turn is.
 *
 * The loop in aiDocDrivers asks four questions of an adapter: how do I open the
 * conversation, how do I send it, what came back, and how do I hand results — and
 * sometimes a file or a picture — back into it. Everything provider-shaped lives
 * here; everything turn-shaped lives there.
 *
 * The three differ in ways that matter and are stated rather than smoothed over:
 * Claude streams the document as it is written, so live progress is real; OpenAI
 * and Gemini do not stream tool arguments in a shape worth counting, so a turn on
 * them reports its phase and no running count. All three read PDFs and images,
 * take tools, and can be shown a render of their own draft.
 */

const docError = (status, userMessage, fallback = false) => {
  const e = new Error(userMessage);
  e.aiStatus = status;
  e.userMessage = userMessage;
  e.aiFallback = fallback;
  return e;
};

// The provider reports an exhausted account in prose inside a 400, with no
// machine-readable marker, so the words are what there is to match.
const OUT_OF_CREDIT = /credit balance is too low|purchase credits|insufficient[_ ]quota|billing hard limit|exceeded your current quota/i;

const billingError = () => {
  console.error("[AI BILLING] provider reports the account cannot be charged — Studio is down until it is topped up.");
  return docError(402, "AI xidməti dayandırılıb — hesab balansı bitib. Administratorla əlaqə saxlayın.");
};

/* ------------------------------------------------------------------ Claude -- */

function claudeAdapter({ client, model, tools, maxTokens, onText }) {
  const { claudeContentParts, computeCost } = require("../controllers/aiController");

  return {
    name: "claude",
    cancelled: () => docError(499, "Ləğv edildi"),

    start: ({ parts, prompt }) => [
      { role: "user", content: [...claudeContentParts(parts), { type: "text", text: prompt }] },
    ],

    async send(history, { system, signal }) {
      let message;
      try {
        const run = client.messages.stream(
          {
            model,
            max_tokens: maxTokens,
            system: [{ type: "text", text: system }],
            output_config: { effort: "high" },
            tools,
            messages: history,
          },
          signal ? { signal } : undefined
        );
        /*
         * Progress from the real response. With a tool call the document arrives
         * as the tool's INPUT rather than as text, so this reads `inputJson` —
         * the same partial walk, the same honest count of parts that have closed.
         */
        if (typeof onText === "function") {
          run.on("inputJson", (_p, snapshot) => {
            try {
              onText(typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot || {}));
            } catch {
              /* progress is decoration; the document is not */
            }
          });
        }
        message = await run.finalMessage();
      } catch (e) {
        if (signal?.aborted) throw docError(499, "Ləğv edildi");
        console.error("AI document tools (claude) error:", e?.status, e?.message);
        if (e?.status === 400 && OUT_OF_CREDIT.test(String(e?.message || ""))) throw billingError();
        throw docError(502, "AI sənədi hazırlaya bilmədi. Bir az sonra yenidən cəhd edin.", true);
      }

      if (message.stop_reason === "refusal") throw docError(422, "AI bu sorğunu emal edə bilmədi.");

      return {
        raw: message,
        usage: message.usage,
        calls: (message.content || [])
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
        said: (message.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim(),
      };
    },

    addCost: (cost, turn) => cost + (computeCost(turn.usage) || 0),

    reply(history, turn, results, { parts = [], images = [] }) {
      history.push({ role: "assistant", content: turn.raw.content });
      history.push({
        role: "user",
        content: [
          // Tool results lead; the file or the picture follows in the same turn.
          ...results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.call.id,
            ...(r.isError ? { is_error: true } : {}),
            content: r.text,
          })),
          ...claudeContentParts(parts),
          ...images.map((b) => ({
            type: "image",
            source: { type: "base64", media_type: "image/png", data: b.toString("base64") },
          })),
        ],
      });
    },
  };
}

/* ------------------------------------------------------------------ OpenAI -- */

function openaiAdapter({ model, tools, maxTokens }) {
  const { openaiContentParts, computeOpenAIGenCost } = require("../controllers/aiController");

  // The Responses API is the only OpenAI endpoint that takes a PDF, and it is
  // also the one that carries tools — so the whole turn lives on it.
  const declared = tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));

  return {
    name: "openai",
    cancelled: () => docError(499, "Ləğv edildi"),

    start: ({ parts, prompt, system }) => [
      { role: "system", content: [{ type: "input_text", text: system }] },
      { role: "user", content: [...openaiContentParts(parts, "source"), { type: "input_text", text: prompt }] },
    ],

    async send(history, { signal }) {
      let r;
      try {
        r = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model, input: history, tools: declared, max_output_tokens: maxTokens }),
          signal,
        });
      } catch (e) {
        if (signal?.aborted) throw docError(499, "Ləğv edildi");
        throw docError(502, "AI sənədi hazırlaya bilmədi. Bir az sonra yenidən cəhd edin.", true);
      }
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        console.error("AI document tools (openai) error:", r.status, body.slice(0, 400));
        if (OUT_OF_CREDIT.test(body)) throw billingError();
        throw docError(502, "AI sənədi hazırlaya bilmədi. Bir az sonra yenidən cəhd edin.", true);
      }
      const data = await r.json().catch(() => null);
      const output = Array.isArray(data?.output) ? data.output : [];

      return {
        raw: output,
        // Mapped to the shape the loop counts in; the Responses API reports
        // input/output where the cost function reads prompt/completion.
        usage: { input_tokens: data?.usage?.input_tokens || 0, output_tokens: data?.usage?.output_tokens || 0 },
        model: data?.model,
        calls: output
          .filter((o) => o.type === "function_call")
          .map((o) => ({
            id: o.call_id,
            name: o.name,
            // Arguments arrive as a JSON STRING here, not an object. Parsed once,
            // and a malformed one is an empty call rather than a thrown turn.
            input: safeJson(o.arguments),
          })),
        said: output
          .filter((o) => o.type === "message")
          .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
          .map((c) => c.text || "")
          .join(" ")
          .trim(),
      };
    },

    addCost: (cost, turn) =>
      cost +
      (computeOpenAIGenCost(
        {
          prompt_tokens: turn.usage.input_tokens,
          completion_tokens: turn.usage.output_tokens,
          total_tokens: turn.usage.input_tokens + turn.usage.output_tokens,
          prompt_tokens_details: { cached_tokens: 0 },
        },
        turn.model,
        model
      )?.usd || 0),

    reply(history, turn, results, { parts = [], images = [] }) {
      // The calls it made must be replayed into the input before their outputs,
      // or the API has nothing to attach the outputs to.
      history.push(...turn.raw.filter((o) => o.type === "function_call"));
      results.forEach((r) => {
        history.push({ type: "function_call_output", call_id: r.call.id, output: r.text });
      });
      const extra = [
        ...openaiContentParts(parts, "source"),
        ...images.map((b) => ({ type: "input_image", image_url: `data:image/png;base64,${b.toString("base64")}` })),
      ];
      if (extra.length) history.push({ role: "user", content: extra });
    },
  };
}

/* ------------------------------------------------------------------ Gemini -- */

function geminiAdapter({ model, tools, maxTokens }) {
  const { geminiContentParts, computeGeminiCost } = require("../controllers/aiController");
  const { toGeminiSchema } = require("./curriculumSchema");

  const declared = [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Gemini rejects the JSON-Schema keywords the other two accept, and this
        // converter already exists for exactly that reason.
        parameters: toGeminiSchema(t.input_schema),
      })),
    },
  ];

  return {
    name: "gemini",
    cancelled: () => docError(499, "Ləğv edildi"),

    start: ({ parts, prompt }) => [
      { role: "user", parts: [...geminiContentParts(parts), { text: prompt }] },
    ],

    async send(history, { system, signal }) {
      const key = process.env.GEMINI_API_KEY;
      let r;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: history,
              tools: declared,
              systemInstruction: { parts: [{ text: system }] },
              generationConfig: { maxOutputTokens: maxTokens },
            }),
            signal,
          }
        );
      } catch (e) {
        if (signal?.aborted) throw docError(499, "Ləğv edildi");
        throw docError(502, "AI sənədi hazırlaya bilmədi. Bir az sonra yenidən cəhd edin.", true);
      }
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        console.error("AI document tools (gemini) error:", r.status, body.slice(0, 400));
        if (OUT_OF_CREDIT.test(body)) throw billingError();
        throw docError(502, "AI sənədi hazırlaya bilmədi. Bir az sonra yenidən cəhd edin.", true);
      }
      const data = await r.json().catch(() => null);
      const content = data?.candidates?.[0]?.content;
      const parts = Array.isArray(content?.parts) ? content.parts : [];

      return {
        raw: content || { role: "model", parts: [] },
        usage: {
          input_tokens: data?.usageMetadata?.promptTokenCount || 0,
          output_tokens: data?.usageMetadata?.candidatesTokenCount || 0,
        },
        calls: parts
          .filter((p) => p.functionCall)
          // Gemini has no call ids: a result is matched back by NAME, which is why
          // the reply below carries the name rather than an id.
          .map((p) => ({ id: p.functionCall.name, name: p.functionCall.name, input: p.functionCall.args || {} })),
        said: parts.map((p) => p.text || "").join(" ").trim(),
      };
    },

    addCost: (cost, turn) =>
      cost +
      (computeGeminiCost
        ? computeGeminiCost({ promptTokenCount: turn.usage.input_tokens, candidatesTokenCount: turn.usage.output_tokens }, model)?.usd || 0
        : 0),

    reply(history, turn, results, { parts = [], images = [] }) {
      history.push(turn.raw);
      history.push({
        role: "user",
        parts: [
          ...results.map((r) => ({
            functionResponse: { name: r.call.name, response: { result: r.text, error: r.isError || undefined } },
          })),
          ...geminiContentParts(parts),
          ...images.map((b) => ({ inline_data: { mime_type: "image/png", data: b.toString("base64") } })),
        ],
      });
    },
  };
}

const safeJson = (text) => {
  try {
    const v = JSON.parse(String(text || "{}"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

module.exports = { claudeAdapter, openaiAdapter, geminiAdapter, docError, OUT_OF_CREDIT, billingError };
