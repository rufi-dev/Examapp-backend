/*
 * AI on the owner's SUBSCRIPTIONS - the Claude Code CLI and the Codex CLI -
 * instead of the paid APIs.
 *
 * Ported from Examopia's helper/cliAi.js, which found every trap below the hard
 * way, and trimmed to what BunkerMath uses: one PDF in, structured questions out.
 *
 *   AI_EXECUTION   cli_then_api (default) | cli | api
 *   AI_CLI_ORDER   claude,codex (default)
 *   CLAUDE_CLI_MODEL  sonnet (default) - the model alias `claude --model` takes
 *   CODEX_CLI_MODEL   unset = the binary's own default
 *
 * Claude logs in with CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`);
 * Codex with its own ChatGPT login kept in the cli_codex volume.
 */
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CLI_TIMEOUT_MS = Math.max(30_000, Number(process.env.AI_CLI_TIMEOUT_MS) || 10 * 60_000);
const ROOT = process.env.AI_CLI_WORK_DIR || path.join(os.tmpdir(), "examapp-ai");
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// The END of stderr is kept: a refusal is the last thing a CLI prints, after
// Codex has echoed the whole prompt.
const STDERR_KEEP = 16 * 1024;
// Claude's Read tool refuses a PDF over 20MB, and says so only to the model,
// which then reports "no questions" - so a bigger file skips the Claude CLI.
const CLI_READ_MAX_BYTES = 20 * 1024 * 1024;
// Codex's sandbox cannot run commands, so it sees a PDF only as attached
// page images, drawn here with Ghostscript.
const CODEX_MAX_PAGES = Math.max(1, Number(process.env.AI_CLI_CODEX_MAX_PAGES) || 30);
const CODEX_PAGE_DPI = Math.max(72, Number(process.env.AI_CLI_CODEX_PAGE_DPI) || 130);

const MIN = 60_000;

/* ---------- which routes run, and in what order ---------- */

function aiExecution() {
  const v = String(process.env.AI_EXECUTION || "cli_then_api").trim().toLowerCase();
  return ["api", "cli", "cli_then_api"].includes(v) ? v : "cli_then_api";
}

function cliOrder() {
  const list = String(process.env.AI_CLI_ORDER || "claude,codex")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((p) => p === "claude" || p === "codex");
  return [...new Set(list)];
}

/*
 * A spent plan is remembered, so the next teacher does not wait for the same
 * refusal. In memory: BunkerMath runs one backend process. The reset time is
 * read out of the refusal when it says one, bounded to 7 days.
 */
const cooldown = new Map();

function resetFromText(text) {
  const t = String(text || "");
  const epoch = t.match(/\|(\d{10})\b/); // claude: "usage limit reached|1730000000"
  if (epoch) return Number(epoch[1]) * 1000;
  const mins = t.match(/in (\d{1,4}) minutes?/i);
  if (mins) return Date.now() + Number(mins[1]) * MIN;
  const hrs = t.match(/in (\d{1,3}) hours?/i);
  if (hrs) return Date.now() + Number(hrs[1]) * 60 * MIN;
  // codex: "Try again at Oct 3rd, 2026 5:19 PM"
  const at = t.match(/try again at ([A-Za-z]{3,9} \d{1,2}(?:st|nd|rd|th)?,? \d{4},? \d{1,2}:\d{2}\s*[AP]M)/i);
  if (at) {
    const d = Date.parse(at[1].replace(/(\d)(st|nd|rd|th)/i, "$1").replace(/,/g, ""));
    if (!Number.isNaN(d)) return d;
  }
  return null;
}

function standDown(provider, err) {
  let until;
  if (err.code === "cli_limit_reached") {
    const r = resetFromText(`${err.message} ${err.stdout || ""} ${err.stderr || ""}`);
    until = r ? Math.max(r, Date.now() + MIN) : Date.now() + 30 * MIN;
  } else {
    until = Date.now() + 10 * MIN; // not logged in / not installed
  }
  until = Math.min(until, Date.now() + 7 * 24 * 60 * MIN);
  cooldown.set(provider, { until, reason: err.code });
  console.warn(`[AI-CLI] ${provider} stood down until ${new Date(until).toISOString()} (${err.code})`);
}

function isCoolingDown(provider) {
  const c = cooldown.get(provider);
  if (!c) return false;
  if (c.until <= Date.now()) {
    cooldown.delete(provider);
    return false;
  }
  return true;
}

/* ---------- process plumbing ---------- */

function cliBinary(provider) {
  if (provider === "claude") return process.env.CLAUDE_CLI_BIN || "claude";
  if (provider === "codex") return process.env.CODEX_CLI_BIN || "codex";
  throw new Error("unsupported_cli_provider");
}

const safeModel = (model) => {
  const value = String(model || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(value)) throw new Error("invalid_cli_model");
  return value;
};

/* The model for a job: the caller's choice (a Claude alias such as "opus" or
 * "sonnet" means nothing to Codex, so it is never passed there), else the env
 * default. Codex keeps its own account default unless CODEX_CLI_MODEL is set. */
function cliModel(provider, wanted) {
  if (provider === "claude") return safeModel(wanted || process.env.CLAUDE_CLI_MODEL || "sonnet");
  return process.env.CODEX_CLI_MODEL ? safeModel(process.env.CODEX_CLI_MODEL) : null;
}

/*
 * How hard the model thinks. Claude takes low|medium|high|xhigh|max directly
 * (`--effort`); Codex's scale stops at high, so xhigh/max become high there.
 * Codex's own default on a ChatGPT account is "none", which is quick but
 * careless on the maths a paper's answer key depends on.
 */
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
function effortArgs(provider, effort) {
  const e = String(effort || "").toLowerCase();
  if (!EFFORTS.has(e)) return [];
  if (provider === "claude") return ["--effort", e];
  return ["-c", `model_reasoning_effort="${e === "xhigh" || e === "max" ? "high" : e}"`];
}

/*
 * What a CLI child may see: its own credentials, never another provider's.
 *
 * Above all, the Claude CLI must NOT see ANTHROPIC_API_KEY: with it present it
 * bills the API (whose balance may be empty) instead of the subscription. An
 * empty variable is removed too - "defined but empty" sends a CLI down a
 * credential path that has nothing on it.
 */
function childEnv(provider) {
  const env = { ...process.env, CI: "1", NO_COLOR: "1" };
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "CODEX_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    if (env[key] !== undefined && String(env[key]).trim() === "") delete env[key];
  }
  delete env.GEMINI_API_KEY;
  if (provider === "claude") {
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  } else {
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  return env;
}

function runProcess(command, args, { cwd, signal, provider, timeoutMs, stdin, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnv(provider),
      // No stdin means /dev/null: `codex exec` otherwise waits on stdin forever.
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // The prompt goes in on stdin: a long prompt as an argument hits E2BIG.
    if (stdin !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(String(stdin));
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let tooLarge = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Number(timeoutMs) > 0 ? Number(timeoutMs) : CLI_TIMEOUT_MS);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString();
      else tooLarge = true;
      if (onStdout) {
        try {
          onStdout(chunk.toString());
        } catch {
          /* a listener's trouble is not the turn's */
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > STDERR_KEEP) stderr = stderr.slice(-STDERR_KEEP);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error.code = error.code || "cli_spawn_failed";
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(Object.assign(new Error("cli_cancelled"), { code: "cli_cancelled" }));
      if (timedOut) return reject(Object.assign(new Error("cli_timeout"), { code: "cli_timeout" }));
      if (tooLarge) return reject(Object.assign(new Error("cli_output_too_large"), { code: "cli_output_too_large" }));
      if (code !== 0) {
        // stdout rides on the error too: a refusal may be printed on either stream.
        return reject(Object.assign(new Error("cli_failed"), {
          code: "cli_failed",
          exitCode: code,
          stderr: stderr.slice(-STDERR_KEEP),
          stdout: stdout.slice(-4000),
        }));
      }
      resolve({ stdout, stderr });
    });
  });
}

/* ---------- reading what a CLI said ---------- */

const LIMIT_PHRASES =
  /usage limit reached|hit your usage limit|limit reached|out of (?:credit|quota)|quota exceeded|upgrade your plan|plan limit|rate limit/i;
const UNAVAILABLE_PHRASES = /not logged in|please run \/login|invalid api key|no credentials|unauthorized|oauth session expired|could not be refreshed/i;

/*
 * A spent plan or a missing login, stated as text. Only SHORT text counts: these
 * phrases can appear inside an exam, but not inside an answer a few hundred
 * characters long, which is what a refusal looks like.
 */
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

/* A failed run, re-read: was it really a spent plan or a missing login? */
function classify(e, provider) {
  if (!e || e.code !== "cli_failed") {
    if (e && e.code === "ENOENT") return Object.assign(e, { code: "cli_unavailable" });
    return e;
  }
  const texts = [];
  // claude: the closing result envelope carries the reason in `result`
  for (const line of String(e.stdout || "").split("\n").reverse()) {
    try {
      const j = JSON.parse(line);
      if (j && j.type === "result" && typeof j.result === "string") texts.push(j.result);
      break;
    } catch {
      /* not a JSON line */
    }
  }
  texts.push(String(e.stdout || "").slice(-600), String(e.stderr || "").slice(-600), String(e.stderr || "").slice(-200));
  for (const t of texts) {
    const l = limitFromText(t, provider);
    if (l) return l;
  }
  return e;
}

/*
 * `claude -p` wraps the reply in an envelope and states failure inside it, and
 * can report a spent plan as its ANSWER with exit code 0.
 */
function claudeEnvelope(raw) {
  const text = String(raw || "");
  let parsed = null;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return text;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const inner = typeof parsed.result === "string" ? parsed.result : null;
    if (parsed.is_error === true || parsed.subtype === "error_during_execution" || parsed.subtype === "error_max_turns") {
      const message = inner || String(parsed.error || parsed.subtype || "cli_failed");
      throw limitFromText(message, "claude") || Object.assign(new Error(message.slice(0, 400)), { code: "cli_failed", stdout: message.slice(0, 600) });
    }
    if (inner !== null) return inner;
  }
  return text;
}

function jsonSample(text) {
  const t = String(text || "");
  return t.length <= 600 ? t : `${t.slice(0, 300)} …[${t.length} chars]… ${t.slice(-300)}`;
}

/*
 * Inside a JSON string a backslash may only start \" \\ \/ \b \f \n \r \t or
 * \uXXXX. A model writing LaTeX by hand often leaves `\sqrt`, `\end`, `\cdot`
 * single, and one of those makes the WHOLE answer unparseable. Every backslash
 * that does not start a valid escape is doubled. (The valid-looking ones - \frac
 * read as a form-feed - parse, and are put back after parsing, in the controller.)
 */
function fixJsonEscapes(text) {
  return String(text).replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m, ok) => (ok ? m : "\\\\"));
}

/* The answer as JSON: bare, inside a ```json fence, or between the outer braces -
 * each as written first, then with its stray LaTeX backslashes doubled. */
function parseJsonText(raw) {
  const text = String(raw || "").trim();
  if (!text) throw Object.assign(new Error("cli_empty_output"), { code: "cli_invalid_json" });
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidates.push(fenced[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    for (const v of [c, fixJsonEscapes(c)]) {
      try {
        return JSON.parse(v);
      } catch {
        /* next */
      }
    }
  }
  throw Object.assign(new Error("cli_invalid_json"), { code: "cli_invalid_json", sample: jsonSample(text) });
}

/*
 * The schema handed back instead of filled in.
 *
 * The API can REQUIRE a schema; a CLI turn can only be SHOWN one, and a model
 * shown a schema sometimes returns the schema itself - valid JSON, so it passes
 * the parser, and the teacher gets an empty exam with no explanation. Examopia
 * saw it in production. It is not an answer: one pointed retry, then the next
 * route.
 */
function isSchemaEcho(doc, schema) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  if (typeof doc.type !== "string" || !doc.properties || typeof doc.properties !== "object") return false;
  const wanted = Array.isArray(schema?.required) ? schema.required : [];
  return !wanted.some((k) => k !== "type" && k !== "properties" && Object.prototype.hasOwnProperty.call(doc, k));
}

/* ---------- prompts ---------- */

/*
 * The output contract as a SYSTEM prompt that REPLACES Claude Code's own
 * (`--system-prompt`): by default `claude -p` is a coding assistant, and a
 * coding assistant answers a vague request with a question, which a backend
 * cannot parse.
 */
function buildSystemPrompt({ system, insist }) {
  const again =
    insist === "echo"
      ? "ÖNCƏKİ CAVABDA SXEMİN ÖZÜNÜ QAYTARDIN. Sxemi təkrarlama — ona uyğun, DOLU məzmunlu JSON qaytar."
      : insist
        ? "ÖNCƏKİ CAVAB JSON DEYİLDİ. Bu dəfə yalnız JSON qaytar, başqa heç nə."
        : "";
  return [
    "SƏN STRUCTURED JSON CAVABI VERƏN BACKEND MODELİSƏN — söhbət yoldaşı deyilsən.",
    "Cavabın YALNIZ bir JSON obyekt olmalıdır: ilk simvol { , son simvol }. Markdown, izah, " +
      "kod çəpəri, giriş və ya yekun cümləsi YAZMA.",
    "HEÇ VAXT sual vermə və aydınlaşdırma istəmə. Tapşırıq qeyri-dəqiqdirsə, ən məntiqli " +
      "fərziyyəni et və yenə də tam JSON qaytar — müəllim nəticəni özü redaktə edəcək.",
    again,
    system || "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/* The user turn: the shape (as a FORM to fill, never to repeat), what to read, the task. */
function buildPrompt({ prompt, schema, files, attached }) {
  return [
    "JSON bu sxemə uyğun olmalıdır (bu, cavabın FORMASIDIR — onu təkrarlama, onu məzmunla DOLDUR):",
    JSON.stringify(schema || {}),
    files.length
      ? attached
        ? `ƏLAVƏLƏR: səhifələr bu mesaja ŞƏKİL kimi əlavə olunub, sırası ilə:\n${files.map((f) => `- ${f}`).join("\n")}`
        : `ƏLAVƏLƏR (iş qovluğunda Read alətilə oxu, BÜTÜN səhifələri):\n${files.map((f) => `- ${f}`).join("\n")}`
      : "",
    `TAPŞIRIQ:\n${prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/* ---------- claude ---------- */

/*
 * Flags every `claude` turn takes. NEVER add `--bare`: it disables OAuth, so a
 * valid subscription reports "Not logged in". `--strict-mcp-config` keeps the
 * account's claude.ai connectors (Drive, Docs) out of an exam turn.
 */
const CLAUDE_BASE_ARGS = Object.freeze([
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
  "--no-session-persistence",
  "--strict-mcp-config",
]);

/*
 * Turns: reading a file costs turns (call Read, get the pages, then answer), and
 * `--max-turns` too low returns NOTHING - not an error, an empty answer. An
 * unused allowance costs nothing, so the ceiling only stops a runaway loop.
 */
function claudeTurns(fileCount) {
  const configured = Number(process.env.AI_CLI_MAX_TURNS);
  if (Number.isFinite(configured) && configured >= 1) return Math.min(configured, 30);
  return Math.min(4 + 8 * fileCount, 30);
}

/*
 * Reads `--output-format stream-json`: hands the text so far to onText after
 * every delta (questions appear live), and keeps the closing `result` line,
 * which is what the answer is parsed from.
 */
function claudeStreamReader(onText) {
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
      return;
    }
    if (j?.type === "result") {
      result = trimmed;
      return;
    }
    const e = j?.type === "stream_event" ? j.event : null;
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") {
      text += e.delta.text;
      if (typeof onText === "function") {
        try {
          onText(text);
        } catch {
          /* a broken listener must never stop the turn */
        }
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
    finish() {
      if (pending) line(pending);
      pending = "";
      return result || text;
    },
  };
}

/* ---------- codex ---------- */

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
      { timeout: 120_000, signal, windowsHide: true },
      async () => {
        const names = await fs.readdir(dir).catch(() => []);
        resolve(names.filter((n) => n.startsWith(`${prefix}-`) && n.endsWith(".png")).sort());
      }
    );
  });
}

/* ---------- the one entry point ---------- */

/*
 * Run one structured turn on a CLI. `files` are { name, mime, data(base64) }.
 * `validate(doc)` returns false for an answer that is JSON but not the answer
 * (that earns the same single retry as prose). Returns { doc, provider, model }.
 */
async function runCliStructured({ provider, system, prompt, schema, files: parts = [], validate, onText, signal, model: wantedModel, effort }) {
  if (provider !== "claude" && provider !== "codex") {
    throw Object.assign(new Error("cli_provider_unavailable"), { code: "cli_provider_unavailable" });
  }
  await fs.mkdir(ROOT, { recursive: true });
  const job = await fs.mkdtemp(path.join(ROOT, "turn-"));
  try {
    const files = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part?.data) continue;
      const file = `attachment-${i + 1}${part.mime === "application/pdf" ? ".pdf" : path.extname(String(part.name || "")) || ".bin"}`;
      const bytes = Buffer.from(String(part.data), "base64");
      if (provider === "claude" && bytes.length > CLI_READ_MAX_BYTES) {
        throw Object.assign(new Error(`attachment is ${Math.round(bytes.length / 1048576)}MB; Claude's Read tool stops at 20MB`), { code: "cli_input_too_large" });
      }
      await fs.writeFile(path.join(job, file), bytes, { mode: 0o600 });
      files.push(file);
    }

    let images = [];
    if (provider === "codex" && files.length) {
      for (const f of files) {
        if (/\.pdf$/i.test(f)) images.push(...(await pdfToPages(path.join(job, f), job, f.replace(/\.pdf$/i, ""), signal)));
        else if (/\.(png|jpe?g|webp|gif)$/i.test(f)) images.push(f);
      }
      if (!images.length) throw Object.assign(new Error("no page could be drawn for codex"), { code: "cli_unreadable_document" });
    }

    const model = cliModel(provider, wantedModel);
    const answerFile = path.join(job, "answer.json");

    const attempt = async (insist) => {
      const systemPrompt = buildSystemPrompt({ system, insist });
      const userPrompt = buildPrompt({ prompt, schema, files: provider === "codex" ? images : files, attached: provider === "codex" });
      let raw;
      if (provider === "claude") {
        const reader = claudeStreamReader(onText);
        const args = [
          ...CLAUDE_BASE_ARGS,
          "--max-turns", String(claudeTurns(files.length)),
          ...(model ? ["--model", model] : []),
          ...effortArgs("claude", effort),
          "--system-prompt", systemPrompt,
          // Read, and only Read, inside this turn's own folder.
          ...(files.length ? ["--tools", "Read", "--add-dir", job] : ["--tools", ""]),
        ];
        await runProcess(cliBinary("claude"), args, {
          cwd: job,
          signal,
          provider: "claude",
          stdin: userPrompt,
          onStdout: (chunk) => reader.push(chunk),
        });
        raw = claudeEnvelope(reader.finish());
      } else {
        // `--image` is variadic, so it goes first; Codex takes no system prompt,
        // so the contract rides in the message.
        const args = [
          "exec",
          ...(images.length ? ["--image", images.join(",")] : []),
          "--sandbox", "read-only",
          "--skip-git-repo-check",
          ...(model ? ["--model", model] : []),
          ...effortArgs("codex", effort),
          "--output-last-message", answerFile,
          `${systemPrompt}\n\n${userPrompt}`,
        ];
        const result = await runProcess(cliBinary("codex"), args, { cwd: job, signal, provider: "codex" });
        raw = await fs.readFile(answerFile, "utf8").catch(() => result.stdout);
      }
      const limited = limitFromText(raw, provider);
      if (limited) throw limited;
      const doc = parseJsonText(raw);
      if (isSchemaEcho(doc, schema)) {
        throw Object.assign(new Error("cli_invalid_json"), { code: "cli_invalid_json", echo: true, sample: "the schema itself" });
      }
      if (typeof validate === "function" && !validate(doc)) {
        throw Object.assign(new Error("cli_invalid_json"), { code: "cli_invalid_json", sample: jsonSample(JSON.stringify(doc)) });
      }
      return doc;
    };

    let doc;
    try {
      doc = await attempt(false);
    } catch (e0) {
      const e = classify(e0, provider);
      // One more try, and only for prose / the schema echoed back. A spent plan,
      // a timeout or a cancel fail at once - retrying just doubles the wait.
      if (e?.code !== "cli_invalid_json" || signal?.aborted) throw e;
      console.warn(`[AI-CLI] ${provider} ${e.echo ? "returned the schema instead of an answer" : "did not answer with the JSON"}; asking once more (${e.sample || ""})`);
      try {
        doc = await attempt(e.echo ? "echo" : true);
      } catch (e1) {
        throw classify(e1, provider);
      }
    }
    return { doc, provider: `${provider}-cli`, model: model || `${provider}-default` };
  } finally {
    await fs.rm(job, { recursive: true, force: true }).catch(() => {});
  }
}

/* Installed? Logged in? For checks and the health log - never prints a secret. */
async function cliStatus(provider) {
  const args = provider === "claude" ? ["auth", "status"] : ["login", "status"];
  try {
    const out = await runProcess(cliBinary(provider), args, { provider, timeoutMs: 20_000 });
    const text = `${out.stdout || ""}${out.stderr || ""}`;
    if (provider === "claude") {
      try {
        const j = JSON.parse(String(out.stdout || "").trim());
        return { installed: true, loggedIn: !!j.loggedIn && j.authMethod !== "api_key", method: String(j.authMethod || "") };
      } catch {
        /* older builds print prose */
      }
    }
    return { installed: true, loggedIn: /logged in/i.test(text) && !/not logged in/i.test(text), method: /chatgpt/i.test(text) ? "chatgpt" : "" };
  } catch (e) {
    const missing = /enoent|not found|spawn/i.test(`${e?.code || ""} ${e?.message || ""}`);
    return { installed: !missing, loggedIn: false, method: "", detail: String(e?.stdout || e?.stderr || e?.message || "").slice(0, 160) };
  }
}

module.exports = {
  aiExecution,
  cliOrder,
  isCoolingDown,
  standDown,
  runCliStructured,
  cliStatus,
  // exported for tests
  classify,
  limitFromText,
  claudeEnvelope,
  parseJsonText,
  fixJsonEscapes,
  isSchemaEcho,
  resetFromText,
  childEnv,
  claudeStreamReader,
  buildPrompt,
  buildSystemPrompt,
};
