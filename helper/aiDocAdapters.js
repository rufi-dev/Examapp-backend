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

/*
 * The account cannot be used — as opposed to the service having a bad minute.
 *
 * Every provider says this in prose, in a status that is otherwise ordinary, with
 * no machine-readable marker, so the words are what there is to match. The
 * distinction is the whole point: "try again shortly" is right about a timeout
 * and a false promise about a balance at zero or a deactivated key. A teacher
 * told to wait will retry, wait, retry, and conclude the feature is broken; it is
 * not broken, and the only person who can act is the owner.
 */
const OUT_OF_CREDIT =
  /credit balance is too low|credit_balance_exhausted|no credits remaining|purchase credits|add credits|insufficient[_ ]quota|billing hard limit|exceeded your current quota|RESOURCE_EXHAUSTED|account_deactivated|has been deactivated|billing_not_active|API key not valid/i;

/*
 * Which provider, and what the person reading this can do about it.
 *
 * The old text said "contact the administrator", which the administrator also
 * read — the owner hit it on their own platform and could not tell whether it
 * meant their Examopia account, their role, or something else entirely. It meant
 * none of those: it meant an outside API account.
 *
 * Naming the provider is what makes it diagnosable, and the second sentence is
 * the part that was missing: three providers are on the picker, so a teacher
 * blocked on one can switch to another and carry on. That is advice they can act
 * on without anybody's help, which "contact the administrator" never was.
 */
const PROVIDER_LABEL = { claude: "Claude (Anthropic)", openai: "OpenAI", gemini: "Gemini (Google)" };

/*
 * Add one turn's spend to the running total for the whole turn.
 *
 * WHY THIS EXISTS. Each adapter used to do `cost + computeXCost(...)`, starting
 * from the driver's `cost = 0`. The Claude branch added an OBJECT to a number,
 * so the total became the string "0[object Object]"; the other two added a bare
 * `.usd` number, so the token breakdown was thrown away. Either way the row
 * written by logStudioUsage read `c.usd`, `c.inputTokens` and `c.model` off a
 * value that had none of them, and recorded a real $0.28 turn as $0 with zero
 * tokens — 19 of the 32 rows in production. Studio has no rate limit and no
 * budget guard BY DECISION, which makes that row the only meter there is, and
 * it was reading zero on the one surface with no ceiling.
 *
 * A turn is several provider calls (a fix, a fetched source, a look at the
 * render), so these accumulate. The model name comes from the first call that
 * reported one and is not overwritten: one turn runs on one model.
 */
const EMPTY_COST = {
  model: "",
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  usd: 0,
};

const sumCost = (acc, next) => {
  if (!next) return acc;
  const a = acc || EMPTY_COST;
  return {
    model: a.model || next.model || "",
    inputTokens: a.inputTokens + (next.inputTokens || 0),
    outputTokens: a.outputTokens + (next.outputTokens || 0),
    cacheWriteTokens: a.cacheWriteTokens + (next.cacheWriteTokens || 0),
    cacheReadTokens: a.cacheReadTokens + (next.cacheReadTokens || 0),
    totalTokens: a.totalTokens + (next.totalTokens || 0),
    // Six places: a cheap turn on a cheap model is worth a fraction of a cent,
    // and rounding it to zero is how a meter stops meaning anything.
    usd: Number((a.usd + (next.usd || 0)).toFixed(6)),
  };
};

const billingError = (provider) => {
  const label = PROVIDER_LABEL[provider] || "AI";
  console.error(`[AI BILLING] ${label} refuses this account (credit or key) — Studio is down on this provider's models until it is fixed.`);
  return docError(
    402,
    `${label} hesabında kredit bitib və ya hesab aktiv deyil. Söhbətdəki model siyahısından başqa model seçib davam edə bilərsiniz.`
  );
};

/* ------------------------------------------------------------------ Claude -- */

const EPHEMERAL = { type: "ephemeral" };

/*
 * Cache breakpoints, and why a studio turn cannot afford to skip them.
 *
 * A turn is NOT one request. The model reads a source, gets a finding back, is
 * shown a render of its own draft, corrects it — and every one of those steps is
 * a fresh API call that re-sends the ENTIRE conversation, attached PDFs and all.
 * A teacher's 10 MB scanned test bank was therefore billed at full input price
 * on all seven steps of one turn: 267,264 input tokens, $1.34 of a $2.94 turn,
 * with cache_read_input_tokens sitting at exactly 0.
 *
 * Caching is a PREFIX match, so the breakpoints go where the prefix stops being
 * stable. Three of them, under the limit of four:
 *   1. the system block — fixed for the whole turn, and it sits after `tools`,
 *      so one breakpoint there covers the tool definitions too;
 *   2. the first user message — the one carrying the files. Once attached they
 *      never change, and they are the expensive part;
 *   3. the newest user message — a moving breakpoint that extends the cache as
 *      the loop grows, so step five reads steps one-to-four instead of paying
 *      for them again.
 *
 * A write costs 1.25x and a read 0.1x, so the first call is slightly dearer and
 * every call after it is a tenth of the price. On a seven-step turn that is not
 * a marginal saving.
 *
 * (There is a note in aiDocument.js saying generation "deliberately does not"
 * cache. That was written when generation was a single call, where a cache write
 * pays for itself never. It predates the tool loop.)
 */
const setCache = (msg) => {
  const blocks = msg && Array.isArray(msg.content) ? msg.content : null;
  if (!blocks || !blocks.length) return;
  const last = blocks[blocks.length - 1];
  if (last && typeof last === "object") last.cache_control = EPHEMERAL;
};

const clearCache = (msg) => {
  const blocks = msg && Array.isArray(msg.content) ? msg.content : null;
  if (!blocks) return;
  for (const b of blocks) if (b && typeof b === "object" && b.cache_control) delete b.cache_control;
};

/*
 * Re-place the moving breakpoint. Every user turn except the first is cleared
 * and the newest one is marked, which keeps the count at three no matter how
 * long the loop runs — a fourth stale breakpoint would be spent on a prefix
 * nothing reads again.
 */
const markCachePoints = (history) => {
  const users = [];
  for (let i = 0; i < history.length; i += 1) if (history[i] && history[i].role === "user") users.push(i);
  if (!users.length) return;
  setCache(history[users[0]]); // the files
  for (let i = 1; i < users.length - 1; i += 1) clearCache(history[users[i]]);
  if (users.length > 1) setCache(history[users[users.length - 1]]); // the growing tail
};

function claudeAdapter({ client, model, tools, maxTokens, onText, effort = "high" }) {
  const { claudeContentParts, computeCost } = require("../controllers/aiController");

  return {
    name: "claude",
    cancelled: () => docError(499, "Ləğv edildi"),

    start: ({ parts, prompt }) => [
      { role: "user", content: [...claudeContentParts(parts), { type: "text", text: prompt }] },
    ],

    async send(history, { system, signal }) {
      let message;
      // Before every call, not just the first: the breakpoint has to follow the
      // end of the conversation as the loop appends to it.
      markCachePoints(history);
      try {
        const run = client.messages.stream(
          {
            model,
            max_tokens: maxTokens,
            system: [{ type: "text", text: system, cache_control: EPHEMERAL }],
            /*
             * Creation gets the full effort; an edit does not need to re-reason
             * its way to a document that already exists. Thinking is billed as
             * output at the output rate, and on the turn that prompted this it
             * was the larger half of the bill — 64,100 output tokens, $1.60.
             */
            output_config: { effort },
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
        if (OUT_OF_CREDIT.test(String(e?.message || ""))) throw billingError("claude");
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

    // Priced at the model the teacher actually picked — the tiers span 10x.
    addCost: (cost, turn) => sumCost(cost, computeCost(turn.usage, model)),

    /*
     * Say something when there is no call to answer.
     *
     * `reply` attaches a tool_result to a call. When the model made NO call —
     * when it described the work in prose instead of doing it — there is nothing
     * to attach to, and the turn would otherwise end with a description and an
     * unchanged document.
     */
    nudge(history, turn, text) {
      history.push({ role: "assistant", content: turn.raw.content });
      history.push({ role: "user", content: [{ type: "text", text }] });
    },


    reply(history, turn, results, { parts = [], images = [] }) {
      history.push({ role: "assistant", content: turn.raw.content });
      /*
       * EVERY tool_use in the assistant turn gets a tool_result, not only the
       * ones the loop had something to say about.
       *
       * The API refuses the whole conversation otherwise — "tool_use ids were
       * found without tool_result blocks" — and that is exactly what happened
       * to "copy this PDF": the model called set_print_options for the page's
       * accent colour AND write_material in one response, the render check
       * replied to the write alone, and the next call was a 400 that surfaced
       * as "AI sənədi hazırlaya bilmədi", three times in a row. The loop has
       * several reply paths and each answered only its own concern; making the
       * contract hold HERE means none of them can break it. A call nobody had a
       * finding about is simply acknowledged, which is what the OpenAI adapter
       * has done for its replays all along.
       */
      const answered = new Set(results.map((r) => r.call.id));
      const unanswered = (turn.raw.content || [])
        .filter((b) => b.type === "tool_use" && !answered.has(b.id))
        .map((b) => ({ type: "tool_result", tool_use_id: b.id, content: "Qəbul edildi." }));
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
          ...unanswered,
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
        if (OUT_OF_CREDIT.test(body)) throw billingError("openai");
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
      sumCost(
        cost,
        computeOpenAIGenCost(
          {
            prompt_tokens: turn.usage.input_tokens,
            completion_tokens: turn.usage.output_tokens,
            total_tokens: turn.usage.input_tokens + turn.usage.output_tokens,
            prompt_tokens_details: { cached_tokens: 0 },
          },
          turn.model,
          model
        )
      ),

    // Nothing to attach a result to: the model answered in prose rather than
    // acting. Same shape as any other user turn on this API.
    nudge(history, turn, text) {
      history.push(...turn.raw);
      history.push({ role: "user", content: [{ type: "input_text", text }] });
    },

    reply(history, turn, results, { parts = [], images = [] }) {
      /*
       * The WHOLE output goes back, not just the calls.
       *
       * The calls have to be replayed before their outputs or the API has
       * nothing to attach the outputs to — but filtering to function_call items
       * breaks a reasoning model outright: gpt-5.6-sol emits a `reasoning` item
       * that its call belongs to, and replaying the call without it is refused
       * with "provided without its required 'reasoning' item". The model's turn
       * is a unit; the adapter has no business deciding which parts of its own
       * output it may keep.
       */
      history.push(...turn.raw);

      /*
       * EVERY replayed call needs an output, not just the ones we had something
       * to say about.
       *
       * The loop answers the calls it has a finding for — a short table row, a
       * source to hand over, "you changed a setting but wrote no document" — and
       * leaves the rest alone. Claude and Gemini accept that; OpenAI refuses the
       * whole request: "No tool output found for function call call_…". So a turn
       * where the model did two things and we replied about one died with a 400
       * and the teacher got "AI sənədi hazırlaya bilmədi".
       *
       * The ones we answered get the answer; the rest get an acknowledgement,
       * which is true — they were accepted, there was simply nothing to say.
       */
      const answered = new Set(results.map((r) => r.call.id));
      results.forEach((r) => {
        history.push({ type: "function_call_output", call_id: r.call.id, output: r.text });
      });
      turn.raw
        .filter((o) => o.type === "function_call" && !answered.has(o.call_id))
        .forEach((o) => {
          history.push({ type: "function_call_output", call_id: o.call_id, output: "Qəbul edildi." });
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
        if (OUT_OF_CREDIT.test(body)) throw billingError("gemini");
        throw docError(502, "AI sənədi hazırlaya bilmədi. Bir az sonra yenidən cəhd edin.", true);
      }
      const data = await r.json().catch(() => null);
      const candidate = data?.candidates?.[0];
      const content = candidate?.content;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      /*
       * A 200 with nothing in it is the shape a Gemini failure takes, and it is
       * silent unless someone writes it down: a safety stop, a malformed call, or
       * a thinking budget spent without producing an answer all arrive as an empty
       * parts array with a 200. The reason is in the response and nowhere else.
       */
      if (!parts.length) {
        console.error(
          "[LESSON DOC] gemini returned no parts:",
          candidate?.finishReason || "no finishReason",
          JSON.stringify(data?.usageMetadata || {}).slice(0, 200)
        );
      }

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
      sumCost(
        cost,
        computeGeminiCost
          ? computeGeminiCost(
              { promptTokenCount: turn.usage.input_tokens, candidatesTokenCount: turn.usage.output_tokens },
              model
            )
          : null
      ),

    nudge(history, turn, text) {
      history.push(turn.raw);
      history.push({ role: "user", parts: [{ text }] });
    },

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
