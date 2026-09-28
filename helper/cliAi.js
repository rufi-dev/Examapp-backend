const { spawn } = require("node:child_process");
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

const safeName = (name, i) => {
  const ext = path.extname(String(name || "")).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 8) || ".bin";
  return `attachment-${i + 1}${ext}`;
};

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
 */
function claudeTurns(fileCount) {
  if (!fileCount) return 1;
  const configured = Number(process.env.AI_CLI_MAX_TURNS);
  if (Number.isFinite(configured) && configured >= 2) return Math.min(configured, 20);
  return Math.min(2 + fileCount, 10);
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
function claudeArgs({ model, fileCount = 0, extra = [], prompt }) {
  return [
    ...CLAUDE_BASE_ARGS,
    "--max-turns",
    String(claudeTurns(fileCount)),
    ...modelArgs("claude", model),
    ...extra,
    "--",
    prompt,
  ];
}

function parseJsonText(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("cli_empty_output");
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("cli_invalid_json");
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

function runProcess(command, args, { cwd, signal, provider, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
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
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
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

function buildPrompt({ system, prompt, schema, files }) {
  return [
    "SƏN STRUCTURED JSON CAVABI VERƏN BACKEND MODELİSƏN.",
    "YALNIZ bir JSON obyekt qaytar. Markdown, izah, kod çəpəri və əlavə mətn qaytarma.",
    "JSON bu sxemə uyğun olmalıdır:",
    JSON.stringify(schema || {}),
    system ? `SYSTEM:\n${system}` : "",
    files.length ? `ƏLAVƏLƏR (iş qovluğunda oxu):\n${files.map((f) => `- ${f}`).join("\n")}` : "",
    `TAPŞIRIQ:\n${prompt}`,
  ].filter(Boolean).join("\n\n");
}

async function runCliStructured({ provider, model, system, prompt, schema, parts = [], signal, tier = "standard" }) {
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
      const file = safeName(part.name, i);
      await fs.writeFile(path.join(job, file), Buffer.from(String(part.data), "base64"), { mode: 0o600 });
      files.push(file);
    }
    const answerFile = path.join(job, "answer.json");
    const fullPrompt = buildPrompt({ system, prompt, schema, files });
    let args;
    if (chosen === "claude") {
      args = claudeArgs({
        model: wanted,
        fileCount: files.length,
        // Read, and only Read: the model may look at the attachments written into
        // this turn's sandbox and at nothing else on the machine.
        extra: files.length ? ["--tools", "Read", "--add-dir", job] : ["--tools", ""],
        prompt: fullPrompt,
      });
    } else {
      args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check",
        ...modelArgs("codex", wanted), "--output-last-message", answerFile, fullPrompt];
    }
    const result = await runProcess(cliBinary(chosen), args, { cwd: job, signal, provider: chosen });
    const raw = chosen === "codex" ? await fs.readFile(answerFile, "utf8").catch(() => result.stdout) : result.stdout;
    const limited = limitFromText(raw, chosen);
    if (limited) throw limited;
    const doc = chosen === "claude" ? claudeResult(raw) : parseJsonText(raw);
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
      args = claudeArgs({ model: wanted, extra: ["--tools", ""], prompt: full });
    } else {
      args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check",
        ...modelArgs("codex", wanted), "--output-last-message", answerFile, full];
    }
    const out = await runProcess(cliBinary(chosen), args, { cwd: job, signal, provider: chosen });
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
};
