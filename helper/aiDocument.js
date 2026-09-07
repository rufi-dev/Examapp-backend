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

/*
 * 32K, not 8K. An edit reproduces the WHOLE document verbatim plus whatever is
 * new — the older, lower ceiling was tuned for a first draft and never revisited
 * as documents grew. A 40-block handout plus a request to add a section from an
 * attached textbook page routinely needs more than 8K output tokens; hitting the
 * ceiling mid-response doesn't shorten the document, it TRUNCATES it — the
 * response stops mid-JSON and the whole turn used to fail outright, discarding
 * every block already streamed to the teacher. Claude Opus supports up to 128K
 * output tokens; 32K is generous headroom without inviting multi-minute turns.
 * parseDoc's truncation repair below is the second, independent line of defence
 * for whatever ceiling is chosen — this number reduces how often it is needed,
 * it does not replace it.
 */
const DOC_MAX_TOKENS = 32000;

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

/*
 * The provider says this in prose, in a 400, with no machine-readable marker —
 * so matching the words is the only thing available. Kept narrow: a 400 that is
 * not about credit still reads as a normal failure.
 */
const isOutOfCredit = (e) =>
  e?.status === 400 && /credit balance is too low|purchase credits/i.test(String(e?.message || ""));

/*
 * The agentic path: the model ACTS through tools instead of describing an action.
 *
 * WHY THIS EXISTS, and why the previous design kept failing the same way.
 *
 * Every turn used to be one structured answer — `{title, reply, blocks}` — which
 * meant the model had exactly one thing it could produce: document content. So
 * every request that was NOT about content still had to come out as content. Asked
 * to add page numbers, it wrote "Səhifə 1" and "Səhifə 2" into the middle of the
 * document as text, because writing text was the only capability it had. The
 * numbers were wrong the moment they were written — a block cannot know which page
 * it lands on — and stale after the next edit.
 *
 * The instinctive fix is a rule: "never write page markers". That is the wrong
 * shape of fix, and it scales the wrong way: the prompt grows by one prohibition
 * per discovered mistake, every rule is one the model may forget, and the
 * underlying gap — no way to express the thing that was actually asked for — is
 * still there. A prohibition tells the model what not to do INSTEAD of the job. A
 * tool lets it do the job.
 *
 * So: a request that changes how the document PRINTS calls a settings tool and
 * touches no content at all — which is also why it is instant and cannot mangle
 * the document. A request that changes what the document SAYS calls the writing
 * tool. The model chooses, the same way it would choose between two functions.
 *
 * Fallback providers stay on the structured-output path below. They run only when
 * Claude is unavailable, and a degraded turn that can still write the document is
 * better than a turn that cannot run at all.
 */
async function documentWithTools({
  prompt,
  parts = [],
  system,
  tools,
  signal,
  maxTokens = DOC_MAX_TOKENS,
  onText,
  validate,
  fetchSource,
  look,
  gridOf,
  model,
  provider = "claude",
}) {
  const { runToolLoop } = require("./aiDocDrivers");
  const { claudeAdapter, openaiAdapter, geminiAdapter } = require("./aiDocAdapters");

  /*
   * Which provider, and can it actually run? A missing key is a configuration
   * fault the owner can fix, and saying so beats a generic failure that sends
   * everyone looking at the model instead of the environment.
   */
  let adapter;
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw docError(503, "OpenAI konfiqurasiya olunmayıb (OPENAI_API_KEY)", true);
    adapter = openaiAdapter({ model, tools, maxTokens });
  } else if (provider === "gemini") {
    if (!process.env.GEMINI_API_KEY) throw docError(503, "Gemini konfiqurasiya olunmayıb (GEMINI_API_KEY)", true);
    adapter = geminiAdapter({ model, tools, maxTokens });
  } else {
    const client = anthropic();
    if (!client) throw docError(503, "AI funksiyası konfiqurasiya olunmayıb (ANTHROPIC_API_KEY)", true);
    adapter = claudeAdapter({ client, model: model || "claude-opus-4-8", tools, maxTokens, onText });
  }

  const out = await runToolLoop(adapter, {
    prompt,
    parts,
    system,
    signal,
    validate,
    fetchSource,
    look,
    gridOf,
  });

  // Nothing said and nothing done is not an answer; it is a turn that failed
  // quietly, and the teacher would be left looking at an unchanged document.
  if (!out.calls.length && !out.said) throw docError(502, "AI cavabı oxunmadı. Yenidən cəhd edin.", true);
  return out;
}

/*
 * Recover a document from JSON that was cut off mid-write.
 *
 * A response that hits its token ceiling stops in the middle of a string, a
 * number, or a half-open object — the model does not get to close its own
 * brackets. The old behaviour treated that exactly like garbage output: the
 * whole turn failed with "AI cavabı oxunmadı", discarding every block that had
 * already streamed to the teacher and had already been shown on screen. That is
 * real, already-generated content being thrown away for the crime of being
 * followed by more content that didn't arrive in time.
 *
 * This walks the text as real JSON (tracking the container stack and string/
 * escape state, not schema field names — a lesson document and a lesson plan use
 * this same repair), and remembers the LAST point at which everything closed so
 * far — the end of a complete string, number, literal, or nested container —
 * along with the stack needed to close from there. It then truncates to that
 * point and appends the matching closers. A value cut mid-way (a half-written
 * sentence, a number with no digits yet) is dropped rather than guessed at;
 * everything before it survives intact.
 */
function repairTruncatedJson(text) {
  const src = String(text || "");
  const n = src.length;
  const stack = []; // 'obj' | 'arr', outermost first
  // start | obj-key | obj-colon | obj-value | obj-comma | arr-value | arr-comma | done
  let state = "start";
  let safeEnd = -1;
  let safeStack = [];

  const afterValue = () => {
    const top = stack[stack.length - 1];
    return top === "obj" ? "obj-comma" : top === "arr" ? "arr-comma" : "done";
  };
  const markSafe = (end) => {
    safeEnd = end;
    safeStack = stack.slice();
  };
  const canStartValue = () => state === "start" || state === "obj-value" || state === "arr-value";

  let i = 0;
  while (i < n && state !== "done") {
    const c = src[i];
    if (c === " " || c === "\n" || c === "\t" || c === "\r") {
      i += 1;
      continue;
    }

    if (c === '"') {
      const isKey = state === "obj-key";
      if (!isKey && !canStartValue()) break;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) break; // truncated mid-string — nothing more to salvage here
      if (isKey) {
        state = "obj-colon";
      } else {
        markSafe(j + 1);
        state = afterValue();
      }
      i = j + 1;
      continue;
    }

    if (c === "{" || c === "[") {
      if (!canStartValue()) break;
      stack.push(c === "{" ? "obj" : "arr");
      state = c === "{" ? "obj-key" : "arr-value";
      i += 1;
      continue;
    }
    if (c === "}" || c === "]") {
      const want = c === "}" ? "obj" : "arr";
      if (stack[stack.length - 1] !== want) break;
      stack.pop();
      markSafe(i + 1);
      state = afterValue();
      i += 1;
      continue;
    }
    if (c === ":") {
      if (state !== "obj-colon") break;
      state = "obj-value";
      i += 1;
      continue;
    }
    if (c === ",") {
      if (state === "obj-comma") state = "obj-key";
      else if (state === "arr-comma") state = "arr-value";
      else break;
      i += 1;
      continue;
    }

    if (c === "-" || (c >= "0" && c <= "9")) {
      if (!canStartValue()) break;
      let j = c === "-" ? i + 1 : i;
      while (j < n && src[j] >= "0" && src[j] <= "9") j += 1;
      if (j < n && src[j] === ".") {
        j += 1;
        while (j < n && src[j] >= "0" && src[j] <= "9") j += 1;
      }
      if (j < n && (src[j] === "e" || src[j] === "E")) {
        let k = j + 1;
        if (k < n && (src[k] === "+" || src[k] === "-")) k += 1;
        if (k < n && src[k] >= "0" && src[k] <= "9") {
          j = k;
          while (j < n && src[j] >= "0" && src[j] <= "9") j += 1;
        }
      }
      // A number at the very end of the buffer might be one digit short of what
      // the model meant to write — an acceptable approximation for a value we are
      // salvaging, never a structural problem for the JSON around it.
      markSafe(j);
      state = afterValue();
      i = j;
      continue;
    }

    const lit = ["true", "false", "null"].find((w) => src.startsWith(w, i));
    if (lit && canStartValue()) {
      markSafe(i + lit.length);
      state = afterValue();
      i += lit.length;
      continue;
    }

    break; // a half-written keyword or a stray byte — stop, nothing more to read
  }

  if (safeEnd < 0) return null;
  let repaired = src.slice(0, safeEnd);
  for (let k = safeStack.length - 1; k >= 0; k -= 1) repaired += safeStack[k] === "obj" ? "}" : "]";
  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

function parseDoc(text) {
  const raw = text || "{}";
  let parsed;
  let truncated = false;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = repairTruncatedJson(raw);
    if (!parsed) throw docError(502, "AI cavabı oxunmadı. Yenidən cəhd edin.", true);
    truncated = true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw docError(502, "AI gözlənilən sənəd formatını qaytarmadı.", true);
  }
  return { value: parsed, truncated };
}

async function documentWithClaude({ prompt, parts = [], system, schema, signal, maxTokens = DOC_MAX_TOKENS, onText }) {
  const { claudeContentParts, computeCost } = require("../controllers/aiController");
  const client = anthropic();
  if (!client) throw docError(503, "AI funksiyası konfiqurasiya olunmayıb (ANTHROPIC_API_KEY)", true);
  let message;
  try {
    /*
     * The stream was already here and its text was being thrown away — only
     * .finalMessage() was used. Listening to it costs nothing and is the ONLY
     * source of real progress: the document's blocks arrive one at a time, so a
     * caller can report what has actually been written instead of animating a
     * guess.
     */
    const run = client.messages.stream(
      {
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
      },
      // Cancelling in the browser only closed the socket before this existed; the
      // request kept generating (and billing) for output nobody would read. This is
      // the same signal the controller aborts on the client's disconnect.
      signal ? { signal } : undefined
    );
    if (typeof onText === "function") {
      // Never let a reporting callback take down the generation it is reporting on.
      run.on("text", (_delta, snapshot) => {
        try {
          onText(snapshot);
        } catch {
          /* progress is decoration; the document is not */
        }
      });
    }
    message = await run.finalMessage();
  } catch (e) {
    if (signal?.aborted) throw docError(499, "Ləğv edildi");
    console.error("AI document (claude) error:", e?.status, e?.message);
    throw docError(502, "AI sənədi hazırlaya bilmədi. Bir az sonra yenidən cəhd edin.", true);
  }
  if (message.stop_reason === "refusal") throw docError(422, "AI bu sorğunu emal edə bilmədi.");
  const textBlock = message.content.find((b) => b.type === "text");
  /*
   * Note: `stop_reason === "max_tokens"` is NOT treated as truncation on its own —
   * strict JSON-schema mode cannot close the top-level object until every required
   * field is filled, so the rare case where the token ceiling lands exactly on the
   * closing brace is a genuinely complete document, not a cut one. Only a JSON
   * parse that actually needed repair counts.
   */
  const parsed = parseDoc(textBlock?.text);
  return { doc: parsed.value, truncated: parsed.truncated, cost: computeCost(message.usage), usage: message.usage };
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
  /*
   * The Responses API reports usage as input_tokens/output_tokens; computeOpenAIGenCost
   * reads the chat/completions shape (prompt_tokens/completion_tokens). Without this
   * mapping every document costs $0 — invisible on the admin AI-cost page and, worse,
   * not counted against aiBudgetGuard daily USD cap. extractWithOpenAI already maps it
   * the same way; this mirrors it rather than changing the shared cost function.
   */
  const usage = {
    prompt_tokens: data?.usage?.input_tokens || 0,
    completion_tokens: data?.usage?.output_tokens || 0,
    total_tokens: data?.usage?.total_tokens || 0,
    prompt_tokens_details: { cached_tokens: data?.usage?.input_tokens_details?.cached_tokens || 0 },
  };
  const parsed = parseDoc(text);
  return { doc: parsed.value, truncated: parsed.truncated, cost: computeOpenAIGenCost(usage, data?.model, modelId), usage };
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
  const parsed = parseDoc(text);
  return { doc: parsed.value, truncated: parsed.truncated, cost: computeGeminiCost(data?.usageMetadata, model), usage: data?.usageMetadata };
}

/*
 * Provider fallback, mirroring runGeneration: start with the caller's model, then
 * fall through the rest; advance ONLY on e.aiFallback (a bad prompt is not paid
 * for three times); and on an aborted signal throw 499 immediately rather than
 * billing two more providers for output nobody is waiting for.
 */
async function runDocument({ prompt, parts = [], system, schema, geminiSchema, model, provider, signal, maxTokens, onText }) {
  const { findAiModel, DEFAULT_AI_MODEL } = require("../controllers/aiController");
  const picked = findAiModel(String(model || "")) || findAiModel(DEFAULT_AI_MODEL);
  const runners = {
    openai: () => documentWithOpenAI({ prompt, parts, system, schema, model: picked?.id, signal, maxTokens }),
    gemini: () => documentWithGemini({ prompt, parts, system, schema: geminiSchema || schema, signal, maxTokens }),
    // Only Claude streams today. The others simply do not call back, so a caller
    // sees no per-block progress on a fallback — which is the truth, and better
    // than inventing motion for a request that is not reporting any.
    claude: () => documentWithClaude({ prompt, parts, system, schema, signal, maxTokens, onText }),
  };
  const keyFor = {
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    claude: process.env.ANTHROPIC_API_KEY,
  };
  /*
   * An explicit provider wins over one inferred from a model id.
   *
   * findAiModel only knows the ids in the exam-generation price table, and the
   * studio picker's ids are mostly not in it — "gemini-2.5-pro" and
   * "claude-opus-4-8" both fell through to the default, which is an OpenAI
   * model. So a teacher who chose Gemini had this pass run on OpenAI and pay for
   * it, and a turn could be planned by one company and written by another with
   * nothing saying so. The fallback chain behind it is unchanged: if the chosen
   * provider is down, the work still gets done somewhere.
   */
  const order = [provider, picked?.provider, "openai", "gemini", "claude"].filter(
    (p, i, a) => p && a.indexOf(p) === i
  );
  const chain = order.filter((p) => !!keyFor[p]);

  let lastErr = null;
  for (const name of chain) {
    try {
      const out = await runners[name]();
      return { ...out, provider: name, fellBack: name !== order[0] };
    } catch (e) {
      lastErr = e;
      // Which provider was actually running when this failed. The caller needs it
      // to record honest provenance on a salvaged partial document — before this,
      // one path recorded a hard-coded brand and could name the wrong one.
      e.provider = name;
      if (signal?.aborted) {
        const abort = docError(499, "Ləğv edildi");
        abort.provider = name;
        throw abort;
      }
      console.error(`document via ${name} failed:`, e?.message);
      if (!e.aiFallback) break;
    }
  }
  throw lastErr || docError(502, "AI sənədi hazırlaya bilmədi");
}

module.exports = {
  DOC_MAX_TOKENS,
  documentWithTools,
  documentWithClaude,
  documentWithOpenAI,
  documentWithGemini,
  runDocument,
  parseDoc,
  repairTruncatedJson,
  docError,
};
