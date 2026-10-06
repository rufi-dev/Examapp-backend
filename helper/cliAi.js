const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CLI_TIMEOUT_MS = Math.max(30_000, Number(process.env.AI_CLI_TIMEOUT_MS) || 15 * 60_000);
const ROOT = process.env.AI_CLI_WORK_DIR || path.join(os.tmpdir(), "examopia-ai");
const MAX_OUTPUT_BYTES = Math.max(64 * 1024, Number(process.env.AI_CLI_MAX_OUTPUT_BYTES) || 16 * 1024 * 1024);
/* How much of a CLI's stderr to keep. The tail, because that is where a
 * refusal states itself - see the capture in runProcess. */
const STDERR_KEEP = Math.max(4 * 1024, Number(process.env.AI_CLI_STDERR_KEEP) || 16 * 1024);

const safeModel = (model) => {
  const value = String(model || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(value)) throw new Error("invalid_cli_model");
  return value;
};

/*
 * The extension is what tells a CLI's reader what it is holding.
 *
 * An uploaded paper arrives with a MIME type and, on some routes, no file name
 * at all. It used to be written as `attachment-1.bin` then, and a `.bin` is not
 * a PDF or a photo to either CLI: both answered "unreadable" for every paper a
 * teacher uploaded, and the API (which reads by MIME type) did the work instead.
 * So a name without an extension takes one from the MIME type.
 */
const EXT_BY_MIME = Object.freeze({
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
});
const safeName = (name, i, mime) => {
  const fromName = path.extname(String(name || "")).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 8);
  const ext = (fromName && fromName !== "." ? fromName : "") || EXT_BY_MIME[String(mime || "").toLowerCase()] || ".bin";
  return `attachment-${i + 1}${ext}`;
};

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/*
 * Codex sees pictures only when they are ATTACHED to the message.
 *
 * Its sandbox cannot run a command on this box (bubblewrap needs user
 * namespaces the container does not grant), so a PDF that is merely named in
 * the prompt is a file it can never open: every upload came back "unreadable".
 * Attached as an image, the same page is read at once. So the pages are drawn
 * to PNG here, with Ghostscript, which the image already carries.
 */
const CODEX_MAX_PAGES = Math.max(1, Number(process.env.AI_CLI_CODEX_MAX_PAGES) || 20);
const CODEX_PAGE_DPI = Math.max(72, Number(process.env.AI_CLI_CODEX_PAGE_DPI) || 130);

function pdfToPages(pdfFile, dir, prefix, signal) {
  return new Promise((resolve) => {
    execFile(
      process.env.GS_BIN || "gs",
      [
        "-q", "-dSAFER", "-dBATCH", "-dNOPAUSE",
        "-sDEVICE=png16m", `-r${CODEX_PAGE_DPI}`,
        "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4",
        "-dFirstPage=1", `-dLastPage=${CODEX_MAX_PAGES}`,
        `-sOutputFile=${path.join(dir, `${prefix}-%02d.png`)}`,
        pdfFile,
      ],
      { timeout: 90_000, signal, windowsHide: true },
      async () => {
        // Whatever pages were drawn are used, even if a later page failed.
        const names = await fs.readdir(dir).catch(() => []);
        resolve(names.filter((n) => n.startsWith(`${prefix}-`) && n.endsWith(".png")).sort());
      }
    );
  });
}

/* The files Codex is shown, as pictures: photos as they are, PDFs page by page. */
async function codexImages(job, files, signal) {
  const out = [];
  for (const file of files) {
    if (IMAGE_EXT.test(file)) out.push(file);
    else if (/\.pdf$/i.test(file)) out.push(...(await pdfToPages(path.join(job, file), job, file.replace(/\.pdf$/i, ""), signal)));
  }
  return out;
}

function cliBinary(provider) {
  if (provider === "claude") return process.env.CLAUDE_CLI_BIN || "claude";
  if (provider === "codex") return process.env.CODEX_CLI_BIN || "codex";
  throw new Error("unsupported_cli_provider");
}

function readModelMap() {
  try {
    const value = JSON.parse(process.env.AI_CLI_MODEL_MAP || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    console.warn("AI_CLI_MODEL_MAP is not valid JSON — ignoring");
    return {};
  }
}

/*
 * Does this model name belong to this binary?
 *
 * It matters because of the CLI-to-CLI switch. A teacher picks "claude-opus-5";
 * Claude's subscription is out of quota; the gateway runs the same work on
 * Codex. Passing the name along would mean `codex --model claude-opus-5`, which
 * fails on a model that provider has never heard of - and it would fail as an
 * ordinary error, so the platform would report a broken request instead of
 * using the CLI that was available. A name that belongs to the other provider
 * is therefore dropped, and the chosen binary uses its own default.
 */
const MODEL_OWNER = [
  [/^(claude|sonnet|opus|haiku|fable)/i, "claude"],
  [/^(gpt|o[0-9]|codex|chatgpt)/i, "codex"],
];

/* The model names Codex accepts on a subscription login: its own families. */
const CODEX_OWN_MODEL = /^(gpt-5|codex)/i;

function modelBelongsTo(provider, model) {
  const name = String(model || "").trim();
  if (!name) return true;
  for (const [pattern, owner] of MODEL_OWNER) {
    if (pattern.test(name)) return owner === provider;
  }
  return true; // an unrecognised name is nobody's to claim
}

/*
 * What KIND of model a piece of work needs, per provider.
 *
 * Call sites say what the work is, not which model to run, for two reasons.
 * A name cannot survive the CLI-to-CLI switch - "haiku" means nothing to Codex -
 * and, more importantly, leaving the choice out is not neutral: asked for no
 * model at all, `claude` runs **claude-opus-5-5**, the strongest and the fastest
 * way to spend a subscription's quota. Naming a model is therefore not a
 * preference but a cost control.
 *
 * `light` exists because a chat reply is not an exam. Running conversations on
 * the same model as a forty-question paper spends the plan on small talk, and
 * haiku answers a chat perfectly well.
 */
const CLI_TIERS = Object.freeze({
  standard: {
    claude: () => process.env.CLAUDE_CLI_DEFAULT_MODEL || "sonnet",
    codex: () => process.env.CODEX_CLI_DEFAULT_MODEL || "",
  },
  light: {
    claude: () => process.env.CLAUDE_CLI_LIGHT_MODEL || "haiku",
    codex: () => process.env.CODEX_CLI_LIGHT_MODEL || "",
  },
});

/* The model for a tier on a provider, or "" to let the binary decide (Codex,
 * whose model names we have no business guessing - that has cost us once). */
function tierModel(provider, tier = "standard") {
  const pick = CLI_TIERS[tier] || CLI_TIERS.standard;
  const fn = pick[provider];
  return typeof fn === "function" ? String(fn() || "") : "";
}

function cliModel(provider, model) {
  const requested = modelBelongsTo(provider, model) ? String(model || "").trim() : "";
  const mapped = requested ? readModelMap()[requested] : null;
  if (mapped) return safeModel(mapped);

  // The picker uses stable product names while the CLIs accept their own
  // aliases. These are explicit compatibility aliases, not a silent provider
  // fallback; an unknown model remains the teacher's requested model.
  if (provider === "claude") {
    const aliases = {
      claude: process.env.CLAUDE_CLI_DEFAULT_MODEL || "sonnet",
      "claude-opus-4-8": process.env.CLAUDE_CLI_OPUS_MODEL || "opus",
      "claude-opus-5": process.env.CLAUDE_CLI_OPUS_MODEL || "opus",
      "claude-sonnet-5": process.env.CLAUDE_CLI_SONNET_MODEL || "sonnet",
      "claude-fable-5-1": process.env.CLAUDE_CLI_FABLE_MODEL || "fable",
    };
    if (aliases[requested]) return safeModel(aliases[requested]);
  }
  /*
   * No mapping, and nothing configured: say nothing.
   *
   * This used to fall back to a hard-coded Codex model name, which was a guess -
   * the installed binary's own default turned out to be a different model
   * entirely, so the guess would have forced every request onto a model the
   * owner never chose (or one that does not exist). Returning null makes the
   * caller omit the flag, and the CLI uses whatever it is configured with.
   */
  /*
   * An OpenAI API model name is not a Codex model. The platform model is an API
   * name (gpt-4.1-mini), and handed to `codex --model` on a ChatGPT account it
   * fails: "The 'gpt-4.1-mini' model is not supported when using Codex with a
   * ChatGPT account". That cost every generation a whole failed attempt before
   * Claude took over. Only Codex's own families are passed through; anything
   * else lets the binary use its configured model.
   */
  if (requested && provider === "codex" && !CODEX_OWN_MODEL.test(requested)) {
    return process.env.CODEX_CLI_DEFAULT_MODEL ? safeModel(process.env.CODEX_CLI_DEFAULT_MODEL) : null;
  }
  if (requested) return safeModel(requested);
  if (provider === "claude") return safeModel(process.env.CLAUDE_CLI_DEFAULT_MODEL || "sonnet");
  return process.env.CODEX_CLI_DEFAULT_MODEL ? safeModel(process.env.CODEX_CLI_DEFAULT_MODEL) : null;
}

/* `--model X`, or nothing at all when we have no business choosing one. */
function modelArgs(provider, model) {
  const m = cliModel(provider, model);
  return m ? ["--model", m] : [];
}

/*
 * The flags every `claude` turn takes.
 *
 * NOTE: `--bare` is deliberately NOT here, and must never be added.
 *
 * It is tempting - it skips hooks, plugin sync, LSP, auto-memory and CLAUDE.md
 * discovery, which is everything a one-shot backend turn does not want. But its
 * own help says the rest of the bargain: "Anthropic auth is strictly
 * ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth ... excluded)".
 *
 * The whole point of CLI mode is to run on the owner's SUBSCRIPTION, which is
 * OAuth. With --bare the binary ignores the stored login entirely and reports
 * "Not logged in - Please run /login" - while `claude auth status` in the same
 * environment cheerfully reports a valid Max subscription, because that command
 * does read the file. It cost an afternoon to find. Setting
 * CLAUDE_CODE_SIMPLE=1 by hand carries the same restriction, so there is no
 * version of this that keeps both.
 *
 * Nothing is lost on this server: there is no CLAUDE.md anywhere above the
 * sandbox the turn runs in, no settings.json and no hooks.
 */
const CLAUDE_BASE_ARGS = Object.freeze([
  "-p",
  "--output-format",
  "json",
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
  "--no-session-persistence",
  /*
   * No MCP servers. Without this the CLI loads the ACCOUNT's claude.ai
   * connectors (Google Drive, Docs) into every exam turn: tools a teacher's
   * paper has no business reaching, and a connection made on every run.
   */
  "--strict-mcp-config",
]);

/*
 * How many turns a request is allowed, which is not a matter of taste.
 *
 * A prompt with no attachment is answered in one turn. A prompt WITH one is not:
 * the model calls Read, our side answers, and only then can it write the JSON -
 * two turns at the very least. With `--max-turns 1` that second step never
 * happens and the binary exits with **no result at all**: not an error, not a
 * partial answer, an empty string. Every PDF extraction on the CLI route would
 * have come back empty, and an empty extraction looks exactly like a PDF the
 * model could not read.
 *
 * Those minimums were right and still too tight, which cost a day of the CLI
 * route being quietly dead. Production kept printing `error_max_turns` — "Reached
 * maximum number of turns (1)" having used 2, "(3)" having used 4 — on every
 * generate and every extraction, so each one exited non-zero, handed over, and
 * the platform ran on the paid API while the admin page said CLI.
 *
 * The minimum is not the budget. A model that needs one extra turn to re-read a
 * page or finish a long answer is doing the job, not misbehaving, and the ceiling
 * is not what keeps a turn affordable — the prompt and the model do that. It is
 * only a stop for a runaway loop, so it is set where a runaway is unmistakable.
 *
 * Measured on this box before changing it: an unused allowance costs nothing.
 * The same generate ran in 15s at a cap of 1 and 16s at 6; the same extraction
 * in 37s at 3 and 31s at 12. The cap is free until it bites, and when it bites
 * it takes the whole route down.
 */
const TURNS_NO_FILES = 4;
const TURNS_PER_FILE = 2;
const TURNS_MAX = 20;

/*
 * The ceiling the CLI's Read tool puts on a single file. Not ours to choose, and
 * not something it fails loudly about - see the refusal in runCliStructured.
 */
const CLI_READ_MAX_BYTES = Number(process.env.AI_CLI_READ_MAX_BYTES) || 20 * 1024 * 1024;

function claudeTurns(fileCount) {
  const configured = Number(process.env.AI_CLI_MAX_TURNS);
  if (Number.isFinite(configured) && configured >= 1) return Math.min(configured, TURNS_MAX);
  if (!fileCount) return TURNS_NO_FILES;
  return Math.min(TURNS_NO_FILES + TURNS_PER_FILE * fileCount, TURNS_MAX);
}

/*
 * The prompt is a POSITIONAL argument, and it has to be fenced off.
 *
 * `--add-dir <directories...>` and `--tools <tools...>` are both variadic, so a
 * prompt that simply follows them is eaten as one more directory or one more tool
 * name - and the binary then refuses with "Input must be provided either through
 * stdin or as a prompt argument", which reads like our bug rather than an
 * argument-parsing one. `--` ends option parsing, so whatever comes after it is
 * the prompt and nothing else.
 */
/*
 * The streamed shape of the same answer, for a caller that shows the work as it
 * is written (question generation). `json` prints one envelope when the turn is
 * over, so a teacher watched nothing for a minute and then saw twenty-five
 * questions at once; `stream-json` with partial messages prints every text
 * delta as it arrives and ends with the same `result` envelope `json` would
 * have printed, which is what the answer is still read from.
 */
const streamedArgs = (args) => {
  const out = [...args];
  const at = out.indexOf("--output-format");
  if (at >= 0) out[at + 1] = "stream-json";
  return [...out, "--verbose", "--include-partial-messages"];
};

/*
 * Reads `claude -p --output-format stream-json` as it arrives: hands the text
 * written so far to `onText` after every delta, and keeps the closing `result`
 * line, which carries the same envelope `--output-format json` prints.
 */
function claudeStreamReader(onText, onThinking) {
  let pending = "";
  let text = "";
  let result = "";
  const line = (raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let j;
    try {
      j = JSON.parse(trimmed);
    } catch {
      return; // not one of the CLI's lines; the envelope check below catches a real failure
    }
    if (j?.type === "result") {
      result = trimmed;
      return;
    }
    const e = j?.type === "stream_event" ? j.event : null;
    // The model planning before it writes: not text, but proof of work.
    if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta" && typeof onThinking === "function") {
      try {
        onThinking();
      } catch {
        /* a broken listener must never stop the turn */
      }
      return;
    }
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") {
      text += e.delta.text;
      try {
        onText(text);
      } catch {
        /* a slow or broken listener must never stop the turn */
      }
    }
  };
  return {
    push(chunk) {
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        line(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
    },
    // What to parse as the answer: the result envelope, or (if the CLI never
    // printed one) the text it streamed, which then fails or succeeds as JSON.
    finish() {
      if (pending) line(pending);
      pending = "";
      return result || text;
    },
    get text() {
      return text;
    },
  };
}

/*
 * Reads one Codex app-server turn: hands the agent's text so far to `onText`
 * after every `item/agentMessage/delta`, remembers the finished message, and
 * says how the turn ended. `handle` returns null while the turn runs, then
 * { result } or { error }.
 */
function codexTurnReader(onText, onThinking) {
  let text = "";
  let itemId = null;
  let finalText = "";
  let lastError = "";
  return {
    handle(m) {
      const p = (m && m.params) || {};
      switch (m && m.method) {
        case "item/agentMessage/delta":
          // A new message starts over; the question streamer dedupes by position.
          if (p.itemId !== itemId) {
            itemId = p.itemId;
            text = "";
          }
          text += String(p.delta || "");
          try {
            onText(text);
          } catch {
            /* a broken listener must never stop the turn */
          }
          return null;
        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta":
          if (typeof onThinking === "function") {
            try {
              onThinking();
            } catch {
              /* a broken listener must never stop the turn */
            }
          }
          return null;
        case "item/completed":
          if (p.item && p.item.type === "agentMessage") finalText = String(p.item.text || "");
          return null;
        case "error":
          if (p.error && p.error.message) lastError = String(p.error.message);
          return null;
        case "turn/completed": {
          const turn = p.turn || {};
          if (turn.status === "completed" && !turn.error) return { result: finalText || text };
          return { error: String((turn.error && turn.error.message) || lastError || `turn ${turn.status || "failed"}`) };
        }
        default:
          return null;
      }
    },
    get text() {
      return text;
    },
  };
}

/*
 * Codex, streamed.
 *
 * `codex exec` gives its answer only when the turn is over - `--json` prints the
 * agent message once, finished - so on the Codex route questions appeared all at
 * once. Its app-server (the JSON-RPC protocol the editor extensions speak, over
 * stdio) sends `item/agentMessage/delta` as the model writes: measured on this
 * server, a small turn arrived in 51 pieces. One thread, one turn, then the
 * process is closed.
 *
 * Upstream marks the app-server experimental. Anything wrong with the PROTOCOL
 * (a renamed method, a refused handshake, an early exit) is reported as
 * `codex_stream_unavailable`, and the caller runs `codex exec` instead, so an
 * update can only cost the streaming, never the answer. A failure of the TURN
 * (a spent plan, a refusal) is reported as what it is.
 */
function runCodexStreamed({ cwd, model, prompt, images = [], onText, onThinking, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const reader = codexTurnReader(onText, onThinking);
    let child;
    try {
      child = spawn(cliBinary("codex"), ["app-server"], { cwd, env: childEnv("codex"), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      reject(Object.assign(new Error(`codex app-server: ${e.message}`), { code: "codex_stream_unavailable" }));
      return;
    }
    let buf = "";
    let stderr = "";
    let nextId = 0;
    let started = false;
    let settled = false;
    const waiting = new Map();
    const protocolError = (why) =>
      Object.assign(new Error(`codex app-server: ${String(why).slice(0, 300)}`), { code: "codex_stream_unavailable", stderr: stderr.slice(-STDERR_KEEP) });
    const timer = setTimeout(
      () => finish(Object.assign(new Error("cli_timeout"), { code: "cli_timeout" })),
      Number(timeoutMs) > 0 ? Number(timeoutMs) : CLI_TIMEOUT_MS
    );
    const abort = () => finish(Object.assign(new Error("cli_cancelled"), { code: "cli_cancelled" }));
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      if (err) reject(err);
      else resolve(value);
    }
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    const write = (obj) => {
      try {
        child.stdin.write(`${JSON.stringify(obj)}\n`);
      } catch {
        /* the close handler reports it */
      }
    };
    const call = (method, params) =>
      new Promise((res, rej) => {
        nextId += 1;
        waiting.set(nextId, { res, rej });
        write({ id: nextId, method, params });
      });

    child.stdin.on("error", () => {});
    child.stderr.on("data", (c) => {
      stderr += c.toString();
      if (stderr.length > STDERR_KEEP) stderr = stderr.slice(-STDERR_KEEP);
    });
    child.on("error", (e) => finish(started ? Object.assign(e, { code: e.code || "cli_spawn_failed" }) : protocolError(e.message)));
    child.on("close", (code) => {
      if (settled) return;
      if (!started) return finish(protocolError(`exited ${code} before the turn began`));
      const limited = limitFromText(stderr.slice(-600), "codex");
      finish(limited || Object.assign(new Error("cli_failed"), { code: "cli_failed", exitCode: code, stderr: stderr.slice(-STDERR_KEEP), stdout: reader.text.slice(-2000) }));
    });
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id != null && !m.method) {
          const w = waiting.get(m.id);
          if (w) {
            waiting.delete(m.id);
            if (m.error) w.rej(new Error(m.error.message || JSON.stringify(m.error)));
            else w.res(m.result);
          }
          continue;
        }
        // The server asking us something (an approval): never granted.
        if (m.id != null && m.method) {
          write({ id: m.id, error: { code: -32601, message: "not supported by this client" } });
          continue;
        }
        const end = reader.handle(m);
        if (end && end.error) {
          const limited = limitFromText(end.error, "codex");
          return finish(limited || Object.assign(new Error(end.error.slice(0, 400)), { code: "cli_failed", stderr: end.error, stdout: end.error.slice(0, 600) }));
        }
        if (end) return finish(null, end.result);
      }
    });

    (async () => {
      try {
        await call("initialize", { clientInfo: { name: "examopia", version: "1" } });
        write({ method: "initialized", params: {} });
        const th = await call("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never", ephemeral: true, model: model || null });
        const threadId = th && th.thread && th.thread.id;
        if (!threadId) throw new Error("thread/start returned no thread");
        await call("turn/start", {
          threadId,
          input: [
            { type: "text", text: prompt, text_elements: [] },
            ...images.map((f) => ({ type: "localImage", path: path.resolve(cwd, f) })),
          ],
        });
        started = true;
      } catch (e) {
        finish(protocolError(e && e.message));
      }
    })();
  });
}

function claudeArgs({ model, fileCount = 0, extra = [], systemPrompt }) {
  return [
    ...CLAUDE_BASE_ARGS,
    "--max-turns",
    String(claudeTurns(fileCount)),
    ...modelArgs("claude", model),
    /*
     * REPLACE the default system prompt, do not append to it.
     *
     * `claude -p` is a coding agent by default, and its system prompt says so —
     * which is why a vague brief got a thoughtful clarifying question instead of
     * an exam. That is the right instinct for an assistant sitting in a
     * terminal and the wrong one for something whose entire output contract is
     * "one JSON object". Production showed it five times in three hours.
     *
     * The contract also belongs HERE rather than buried at the end of a long
     * user message. The model said as much when it refused: "the actual request
     * buried at the end". A system prompt is the one place an instruction is
     * not competing with the content it governs.
     */
    ...(systemPrompt ? ["--system-prompt", systemPrompt] : []),
    ...extra,
  ];
}

/*
 * A parse failure has to say what it could not parse.
 *
 * "cli_invalid_json" on its own is undiagnosable in production: it cannot
 * distinguish a model that wrote an apology from one whose JSON was cut off
 * mid-array by an output limit, and those want opposite fixes. The sample is
 * bounded and carries the head AND the tail, because truncation only shows at
 * the end.
 */
function jsonSample(text) {
  const t = String(text || "");
  if (t.length <= 600) return t;
  return `${t.slice(0, 300)} …[${t.length} chars]… ${t.slice(-300)}`;
}

function parseJsonText(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("cli_empty_output");
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        /* a fenced block that is itself broken falls through to the brace slice */
      }
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through with the sample below */
      }
    }
    throw Object.assign(new Error("cli_invalid_json"), {
      code: "cli_invalid_json",
      sample: jsonSample(text),
      // An answer that ends without its closing brace was cut off, not malformed.
      truncated: start >= 0 && end < start,
    });
  }
}

/*
 * A limit is not always an error exit.
 *
 * `claude -p` reports a spent subscription as its ANSWER - exit code 0, and the
 * text "Claude AI usage limit reached|<epoch>" where the reply should be. Read
 * naively that is a model that failed to produce JSON, which is an ordinary
 * failure: no switch to the other CLI, no cooldown, and an owner watching an
 * exhausted plan be retried all evening. So the output is examined before it is
 * parsed.
 *
 * The length bound is deliberate. These phrases could in principle appear inside
 * generated material; they cannot appear inside generated material that is only
 * a few hundred characters long, which is what a refusal looks like.
 */
const LIMIT_PHRASES =
  /usage limit reached|hit your usage limit|limit reached|out of (?:credit|quota)|quota exceeded|upgrade your plan|plan limit|rate limit/i;
/*
 * The other way a CLI declines to work: it is there, and it is not logged in.
 * "Not logged in - Please run /login" is what the deployed binary actually
 * prints, inside the same JSON envelope it uses for an answer. Treated as an
 * ordinary failure it would look like a model that could not produce JSON; it is
 * really a route that is unavailable, which means use the other one and tell the
 * owner which login to fix.
 */
const UNAVAILABLE_PHRASES = /not logged in|please run \/login|invalid api key|no credentials|unauthorized/i;

function limitFromText(raw, provider) {
  const text = String(raw || "").trim();
  if (!text || text.length > 600) return null;
  const limited = LIMIT_PHRASES.test(text);
  if (!limited && !UNAVAILABLE_PHRASES.test(text)) return null;
  return Object.assign(new Error(text.slice(0, 400)), {
    code: limited ? "cli_limit_reached" : "cli_unavailable",
    provider,
    stdout: text.slice(0, 600),
  });
}

/*
 * Claude's `--output-format json` wraps the reply in an envelope, and states
 * failure inside it rather than only by exit code.
 */
function claudeEnvelope(raw) {
  const text = String(raw || "");
  let parsed = null;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return text; // not the envelope; hand the text back untouched
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const inner = typeof parsed.result === "string" ? parsed.result : null;
    if (parsed.is_error === true || parsed.subtype === "error_during_execution") {
      const message = inner || String(parsed.error || parsed.subtype || "cli_failed");
      throw Object.assign(new Error(message.slice(0, 400)), { code: "cli_failed", stdout: message.slice(0, 600) });
    }
    if (inner !== null) return inner;
  }
  return text;
}

function claudeResult(raw) {
  const inner = claudeEnvelope(raw);
  const parsed = parseJsonText(inner);
  if (typeof parsed === "object" && parsed && typeof parsed.result === "string") return parseJsonText(parsed.result);
  return parsed;
}

/* What a CLI child may see: its own credentials, never another provider's. */
function childEnv(provider) {
  const env = { ...process.env, CI: "1", NO_COLOR: "1" };
  /*
   * A variable that is defined but empty is not a credential, and compose
   * defines CLAUDE_CODE_OAUTH_TOKEN as "" whenever the owner has not set one.
   * A CLI that keys off "is this variable present" would then pick the token
   * path and find nothing there, which fails as "not logged in" - true, and
   * impossible to explain. Absent is clearer than empty.
   */
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "CODEX_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    if (env[key] !== undefined && String(env[key]).trim() === "") delete env[key];
  }
  const useProviderApiKeys = String(process.env.AI_CLI_USE_API_KEYS || "").toLowerCase() === "true";
  // Do not let one provider's secret accidentally select another provider's
  // authentication path. The relevant CLI login volume or provider key is
  // preserved; unrelated keys are removed from the child environment.
  if (provider === "claude") {
    delete env.OPENAI_API_KEY;
    delete env.GEMINI_API_KEY;
    delete env.CODEX_API_KEY;
    if (!useProviderApiKeys) delete env.ANTHROPIC_API_KEY;
  } else if (provider === "codex") {
    delete env.ANTHROPIC_API_KEY;
    // Claude's subscription token is a credential like any other: Codex's
    // process has no use for it and should never be handed it.
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.GEMINI_API_KEY;
    if (!useProviderApiKeys) {
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
    }
  }
  return env;
}

function runProcess(command, args, { cwd, signal, provider, timeoutMs, stdin, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const env = childEnv(provider);
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    /*
     * The prompt goes IN, not alongside.
     *
     * argv is a hard ceiling: 131,072 bytes for a single argument on Linux. The
     * review pass alone sends up to 60,000 characters of question JSON, plus a
     * schema, plus a system prompt — so passing the prompt as an argument was
     * not a crash waiting for a big exam so much as one waiting for a slightly
     * bigger exam, and it fails as E2BIG before the model is ever reached.
     * Measured on this server: 200 KB as an argument is E2BIG, 200 KB on stdin
     * is fine.
     */
    if (stdin !== undefined) {
      child.stdin.on("error", () => {
        /* the child can exit before it has read everything; that is its business */
      });
      child.stdin.end(String(stdin));
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTooLarge = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // A generation may legitimately take minutes; a status check must not.
    }, Number(timeoutMs) > 0 ? Number(timeoutMs) : CLI_TIMEOUT_MS);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString();
      else outputTooLarge = true;
      if (onStdout) {
        try {
          onStdout(chunk.toString());
        } catch {
          /* the listener's trouble is not the turn's */
        }
      }
    });
    /*
     * Keep the END of stderr, not the beginning.
     *
     * A refusal is the LAST thing a CLI prints. Codex echoes the entire prompt -
     * system text, JSON schema and all - to stderr before it says anything about
     * itself, so a real generation puts tens of kilobytes between the banner and
     * the reason it stopped. Keeping the first 8 KB captured the banner and threw
     * the reason away, which is how "You've hit your usage limit. Try again at
     * Oct 3rd" reached the gateway as nothing but "Reading additional input from
     * stdin...".
     *
     * The consequence was the whole feature, silently: with no limit text to
     * read, isRouteExhausted classified a spent subscription as an ordinary
     * failure, so the work never moved to the other CLI and the teacher got
     * "AI suallar yarada bilmədi". The probes missed it because a short test
     * prompt leaves the refusal inside the first 8 KB.
     */
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderr += chunk.toString();
      if (stderr.length > STDERR_KEEP) stderr = stderr.slice(-STDERR_KEEP);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error.code = error.code || "cli_spawn_failed";
      reject(error);
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(Object.assign(new Error("cli_cancelled"), { code: "cli_cancelled" }));
      if (timedOut) return reject(Object.assign(new Error("cli_timeout"), { code: "cli_timeout" }));
      if (outputTooLarge) return reject(Object.assign(new Error("cli_output_too_large"), { code: "cli_output_too_large" }));
      if (code !== 0) {
        /*
         * stdout is carried on the error too. When a CLI refuses, the reason may
         * be on either stream - Codex prints its usage-limit notice where it
         * likes - and the gateway decides whether to switch to the other
         * subscription by READING that reason. A refusal we cannot read is
         * classified as an ordinary failure, which means no switch, no cooldown,
         * and a teacher told the request is broken when in truth one plan was
         * simply spent.
         */
        return reject(Object.assign(new Error("cli_failed"), {
          code: "cli_failed",
          exitCode: code,
          signal: sig,
          stderr: stderr.slice(-STDERR_KEEP),
          stdout: stdout.slice(-2000),
        }));
      }
      resolve({ stdout, stderr });
    });
  });
}

/*
 * The instruction that has to survive a vague request.
 *
 * The API route can REQUIRE a schema; a CLI turn cannot, so the only thing
 * standing between a teacher and a parse error is the wording here. A real
 * failure: a teacher typed "change all make english exam grammar" and the model
 * — reasonably — answered in prose asking which questions to change and how,
 * ending with "let me know if you specifically need the raw JSON with zero
 * surrounding text". Perfectly sensible from an assistant, and unusable from a
 * backend: the parser saw an essay, called it invalid JSON, and the teacher got
 * an error instead of an exam.
 *
 * So the turn is told, in as many words, not to ask. A vague brief becomes a
 * reasonable assumption and a paper the teacher can edit — which is what the
 * API route would have given them, and what they can actually use.
 */
/*
 * The output contract, as a SYSTEM prompt.
 *
 * It used to be the first three lines of the user message, ahead of the app's
 * own instructions, a JSON schema and the task — and the model told us plainly
 * what that felt like from the other side: "the actual request buried at the
 * end". An instruction competing with the content it governs loses.
 */
function buildSystemPrompt({ system, insist }) {
  return [
    "SƏN STRUCTURED JSON CAVABI VERƏN BACKEND MODELİSƏN — söhbət yoldaşı deyilsən.",
    "Cavabın YALNIZ bir JSON obyekt olmalıdır: ilk simvol { , son simvol }. Markdown, izah, " +
      "kod çəpəri, giriş və ya yekun cümləsi YAZMA.",
    "HEÇ VAXT sual vermə və aydınlaşdırma istəmə. Tapşırıq qeyri-dəqiqdirsə, ən məntiqli " +
      "fərziyyəni et və yenə də tam JSON qaytar — müəllim nəticəni özü redaktə edəcək.",
    insist
      ? "ÖNCƏKİ CAVAB JSON DEYİLDİ. Bu dəfə yalnız JSON qaytar, başqa heç nə."
      : "",
    system || "",
  ].filter(Boolean).join("\n\n");
}

/* The user turn: the shape asked for, what to read, and the task itself. */
function buildPrompt({ prompt, schema, files, attached = false }) {
  return [
    "JSON bu sxemə uyğun olmalıdır:",
    JSON.stringify(schema || {}),
    files.length
      ? attached
        ? `ƏLAVƏLƏR: səhifələr bu mesaja ŞƏKİL kimi əlavə olunub, sırası ilə:\n${files.map((f) => `- ${f}`).join("\n")}`
        : `ƏLAVƏLƏR (iş qovluğunda oxu):\n${files.map((f) => `- ${f}`).join("\n")}`
      : "",
    `TAPŞIRIQ:\n${prompt}`,
  ].filter(Boolean).join("\n\n");
}

async function runCliStructured({ provider, model, system, prompt, schema, parts = [], signal, tier = "standard", onText, onThinking }) {
  const chosen = provider === "openai" ? "codex" : provider;
  if (chosen !== "claude" && chosen !== "codex") throw Object.assign(new Error("cli_provider_unavailable"), { code: "cli_provider_unavailable" });
  // The tier is resolved AFTER the provider is known, so a failover to the other
  // CLI asks that binary for its own model of the same kind.
  const wanted = modelBelongsTo(chosen, model) && String(model || "").trim() ? model : tierModel(chosen, tier);
  await fs.mkdir(ROOT, { recursive: true });
  const job = await fs.mkdtemp(path.join(ROOT, "turn-"));
  try {
    const files = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part?.data) continue;
      const file = safeName(part.name, i, part.mime);
      const bytes = Buffer.from(String(part.data), "base64");
      /*
       * The CLI's Read tool refuses a PDF over 20MB — "PDF file exceeds maximum
       * allowed size of 20MB" — and that refusal reaches the model as a tool
       * error, not a crash. The model then does the sane thing and reports no
       * questions, the run exits 0, and the teacher is told their paper is empty.
       *
       * We accept uploads up to 100MB, so this is a gap we opened ourselves, and
       * it is silent in the one direction that matters. Refuse the route here
       * instead: `cli_input_too_large` is a DEFECT, so the gateway hands the work
       * to the API — which reads the file as a document and has no such ceiling —
       * without standing the subscription down for a file it never saw.
       */
      if (chosen === "claude" && bytes.length > CLI_READ_MAX_BYTES) {
        throw Object.assign(
          new Error(
            `attachment ${file} is ${Math.round(bytes.length / 1024 / 1024)}MB; the CLI Read tool stops at ${Math.round(CLI_READ_MAX_BYTES / 1024 / 1024)}MB`
          ),
          { code: "cli_input_too_large" }
        );
      }
      await fs.writeFile(path.join(job, file), bytes, { mode: 0o600 });
      files.push(file);
    }
    const answerFile = path.join(job, "answer.json");
    // Codex is shown the pages as pictures (see codexImages); nothing to show
    // means nothing it could read, which another engine may still manage.
    const images = chosen === "codex" && files.length ? await codexImages(job, files, signal) : [];
    if (chosen === "codex" && files.length && !images.length) {
      throw Object.assign(new Error("no page of the attachment could be drawn for codex"), { code: "cli_unreadable_document" });
    }

    const attempt = async (insist) => {
      const fullPrompt = buildPrompt({ prompt, schema, files: chosen === "codex" ? images : files, attached: chosen === "codex" });
      const systemPrompt = buildSystemPrompt({ system, insist });
      let args;
      // Only Claude can stream here; Codex writes its answer to a file at the end.
      const reader = chosen === "claude" && typeof onText === "function" ? claudeStreamReader(onText, onThinking) : null;
      if (chosen === "claude") {
        args = claudeArgs({
          model: wanted,
          systemPrompt,
          fileCount: files.length,
          // Read, and only Read: the model may look at the attachments written into
          // this turn's sandbox and at nothing else on the machine.
          extra: files.length ? ["--tools", "Read", "--add-dir", job] : ["--tools", ""],
        });
        if (reader) args = streamedArgs(args);
      } else {
        // Codex takes no system prompt, so its contract rides in the message.
        // `--image` takes several values, so it goes first: the next flag ends it,
        // where the prompt after it would have been swallowed as one more image.
        args = ["exec", ...(images.length ? ["--image", images.join(",")] : []),
          "--sandbox", "read-only", "--skip-git-repo-check",
          ...modelArgs("codex", wanted), "--output-last-message", answerFile,
          `${systemPrompt}

${fullPrompt}`];
      }
      // Codex streams through its app-server; if that route is unavailable, exec.
      let streamed = null;
      if (chosen === "codex" && typeof onText === "function") {
        try {
          streamed = await runCodexStreamed({ cwd: job, model: cliModel("codex", wanted), prompt: `${systemPrompt}\n\n${fullPrompt}`, images, onText, onThinking, signal });
        } catch (e) {
          if (e.code !== "codex_stream_unavailable") throw e;
          console.warn(`[cli] codex streaming unavailable, using exec: ${e.message}`);
        }
      }
      let raw = streamed;
      if (raw == null) {
        const result = await runProcess(cliBinary(chosen), args, {
          cwd: job,
          signal,
          provider: chosen,
          // claude reads the prompt from stdin; codex still takes it as an argument.
          ...(chosen === "claude" ? { stdin: fullPrompt } : {}),
          ...(reader ? { onStdout: (chunk) => reader.push(chunk) } : {}),
        });
        raw =
          chosen === "codex"
            ? await fs.readFile(answerFile, "utf8").catch(() => result.stdout)
            : reader
              ? reader.finish()
              : result.stdout;
      }
      const limited = limitFromText(raw, chosen);
      if (limited) throw limited;
      return chosen === "claude" ? claudeResult(raw) : parseJsonText(raw);
    };

    let doc;
    try {
      doc = await attempt(false);
    } catch (e) {
      /*
       * One more try, and only for prose.
       *
       * A model that answered a vague brief with a question has not failed at
       * the task — it has failed to be a backend, and telling it so once fixes
       * it. That is worth another turn: the alternative is handing the teacher
       * "AI suallar yarada bilmədi" for a request the model understood well
       * enough to ask a sensible question about.
       *
       * Strictly one retry, and strictly for unparseable output. A spent plan, a
       * cancelled request or a timeout all fail immediately — retrying those
       * just makes the teacher wait twice for the same answer.
       */
      if (e?.code !== "cli_invalid_json" || signal?.aborted) throw e;
      console.warn(`[AI] ${chosen} answered in prose instead of JSON; asking once more`);
      doc = await attempt(true);
    }
    return { doc, provider: `${chosen}-cli`, cost: { model: wanted || model, cliModel: cliModel(chosen, wanted), usd: 0, inputTokens: 0, outputTokens: 0, cli: true } };
  } finally {
    await fs.rm(job, { recursive: true, force: true }).catch(() => {});
  }
}

/*
 * A plain-text turn, for the chat.
 *
 * The structured runner above forces a JSON object, which is right for an exam
 * or a lesson and wrong for a conversation: a chat reply is prose, and asking
 * the model to wrap prose in JSON only gives it a way to fail. This shares the
 * process handling, the sandbox and the environment scrubbing, and differs only
 * in asking for the answer directly.
 */
async function runCliChat({ messages = [], model, system, signal, provider = "claude", tier = "light" }) {
  const chosen = provider === "openai" ? "codex" : provider;
  if (chosen !== "claude" && chosen !== "codex") {
    throw Object.assign(new Error("cli_provider_unavailable"), { code: "cli_provider_unavailable" });
  }
  const wanted = modelBelongsTo(chosen, model) && String(model || "").trim() ? model : tierModel(chosen, tier);
  await fs.mkdir(ROOT, { recursive: true });
  const job = await fs.mkdtemp(path.join(ROOT, "chat-"));
  try {
    const transcript = (Array.isArray(messages) ? messages : [])
      .map((m) => `${String(m?.role || "user").toUpperCase()}: ${String(m?.content ?? m?.text ?? "")}`)
      .filter((l) => l.trim().length > 6)
      .join("\n\n");
    const full = [system ? `SYSTEM:\n${system}` : "", transcript].filter(Boolean).join("\n\n");

    let args;
    const answerFile = path.join(job, "answer.txt");
    if (chosen === "claude") {
      // A chat turn reads nothing, so it gets no tools and one turn.
      /*
       * The chat's instructions belong in the system prompt for the same reason
       * the JSON contract does — and replacing Claude Code's default matters
       * more here, not less: its default is a CODING agent, and a teacher asking
       * about their class should not be answered by one.
       */
      args = claudeArgs({
        model: wanted,
        systemPrompt: system || "",
        extra: ["--tools", ""],
      });
    } else {
      args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check",
        ...modelArgs("codex", wanted), "--output-last-message", answerFile, full];
    }
    const out = await runProcess(cliBinary(chosen), args, {
      cwd: job,
      signal,
      provider: chosen,
      ...(chosen === "claude" ? { stdin: transcript } : {}),
    });
    let text;
    if (chosen === "codex") {
      text = await fs.readFile(answerFile, "utf8").catch(() => out.stdout);
    } else {
      text = claudeEnvelope(out.stdout);
    }
    const spent = limitFromText(text, chosen);
    if (spent) throw spent;
    text = String(text || "").trim();
    if (!text) throw Object.assign(new Error("cli_empty_output"), { code: "cli_empty_output" });
    return {
      text,
      cost: { model: cliModel(chosen, wanted), usd: 0, inputTokens: 0, outputTokens: 0, cli: true },
      provider: `${chosen}-cli`,
    };
  } finally {
    await fs.rm(job, { recursive: true, force: true }).catch(() => {});
  }
}

/*
 * Is this CLI installed and signed in? — asked for FREE.
 *
 * There are two different questions behind "is Codex usable", and only one of
 * them is cheap. Whether the binary is there and logged in is answered locally,
 * by the binary itself, with no request to anyone. Whether the SUBSCRIPTION has
 * allowance left cannot be answered without spending some of it, because the
 * only way to ask is to try.
 *
 * Reporting the cheap answer as though it were the expensive one is how the
 * admin page came to say "Hazırdır" about a plan that had been out of quota for
 * days. So this returns exactly what it knows, and the quota question is asked
 * separately and only when someone asks for it.
 *
 * The environment is scrubbed the way a real turn scrubs it: with an API key in
 * scope `claude auth status` cheerfully reports a working api_key login, which
 * is not the credential the platform uses.
 */
async function cliStatus(provider) {
  const chosen = provider === "openai" ? "codex" : provider;
  if (chosen !== "claude" && chosen !== "codex") {
    return { installed: false, loggedIn: false, method: "", detail: "unsupported_cli_provider" };
  }
  const args = chosen === "claude" ? ["auth", "status"] : ["login", "status"];
  try {
    const out = await runProcess(cliBinary(chosen), args, { provider: chosen, timeoutMs: 20_000 });
    const text = `${out.stdout || ""}${out.stderr || ""}`;
    if (chosen === "claude") {
      let parsed = null;
      try {
        parsed = JSON.parse(String(out.stdout || "").trim());
      } catch {
        /* older builds print prose; fall through to the text test below */
      }
      if (parsed && typeof parsed === "object") {
        const method = String(parsed.authMethod || "");
        return {
          installed: true,
          // An api_key login is not a subscription: CLI mode exists to use the
          // plan, and the runner strips that key before every turn.
          loggedIn: !!parsed.loggedIn && method !== "api_key",
          method,
          detail: [parsed.email, parsed.subscriptionType].filter(Boolean).join(" · ") || method,
        };
      }
      return { installed: true, loggedIn: /logged in/i.test(text) && !/not logged in/i.test(text), method: "", detail: text.trim().slice(0, 120) };
    }
    const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
    return {
      installed: true,
      loggedIn,
      method: /chatgpt/i.test(text) ? "chatgpt" : /api key/i.test(text) ? "api_key" : "",
      detail: text.replace(/\s+/g, " ").trim().slice(0, 120),
    };
  } catch (e) {
    const missing = /enoent|not found|spawn/i.test(`${e?.code || ""} ${e?.message || ""}`);
    return {
      installed: !missing,
      loggedIn: false,
      method: "",
      detail: missing ? "quraşdırılmayıb" : String(e?.message || e).slice(0, 120),
    };
  }
}

module.exports = {
  cliStatus,
  CLAUDE_BASE_ARGS,
  CLI_TIERS,
  CLI_READ_MAX_BYTES,
  tierModel,
  claudeArgs,
  claudeTurns,
  runCliStructured,
  runCliChat,
  parseJsonText,
  cliModel,
  modelArgs,
  modelBelongsTo,
  limitFromText,
  claudeEnvelope,
  claudeStreamReader,
  claudeResult,
  codexTurnReader,
  streamedArgs,
  safeName,
  codexImages,
};
