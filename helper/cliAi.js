const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CLI_TIMEOUT_MS = Math.max(30_000, Number(process.env.AI_CLI_TIMEOUT_MS) || 15 * 60_000);
const ROOT = process.env.AI_CLI_WORK_DIR || path.join(os.tmpdir(), "examopia-ai");
const MAX_OUTPUT_BYTES = Math.max(64 * 1024, Number(process.env.AI_CLI_MAX_OUTPUT_BYTES) || 16 * 1024 * 1024);

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

function cliModel(provider, model) {
  const requested = String(model || "").trim();
  const mapped = readModelMap()[requested];
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
  return safeModel(requested || (provider === "claude" ? "sonnet" : process.env.CODEX_CLI_DEFAULT_MODEL || "gpt-5.6-luna"));
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

function claudeResult(raw) {
  const parsed = parseJsonText(raw);
  if (typeof parsed === "object" && parsed && typeof parsed.result === "string") return parseJsonText(parsed.result);
  return parsed;
}

function runProcess(command, args, { cwd, signal, provider }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CI: "1", NO_COLOR: "1" };
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
    }, CLI_TIMEOUT_MS);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString();
      else outputTooLarge = true;
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 8 * 1024) stderr += chunk.toString();
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
        return reject(Object.assign(new Error("cli_failed"), { code: "cli_failed", exitCode: code, signal: sig, stderr: stderr.slice(-2000) }));
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

async function runCliStructured({ provider, model, system, prompt, schema, parts = [], signal }) {
  const chosen = provider === "openai" ? "codex" : provider;
  if (chosen !== "claude" && chosen !== "codex") throw Object.assign(new Error("cli_provider_unavailable"), { code: "cli_provider_unavailable" });
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
      args = [
        "-p", "--output-format", "json", "--max-turns", "1",
        "--model", cliModel("claude", model),
        "--permission-mode", "dontAsk", "--permission-prompts", "none",
        "--tools", "Read", "--no-session-persistence", "--bare",
        "--add-dir", job, fullPrompt,
      ];
    } else {
      args = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--model", cliModel("codex", model), "--output-last-message", answerFile, fullPrompt];
    }
    const result = await runProcess(cliBinary(chosen), args, { cwd: job, signal, provider: chosen });
    const raw = chosen === "codex" ? await fs.readFile(answerFile, "utf8").catch(() => result.stdout) : result.stdout;
    const doc = chosen === "claude" ? claudeResult(raw) : parseJsonText(raw);
    return { doc, provider: `${chosen}-cli`, cost: { model, cliModel: cliModel(chosen, model), usd: 0, inputTokens: 0, outputTokens: 0, cli: true } };
  } finally {
    await fs.rm(job, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runCliStructured, parseJsonText, cliModel };
