/* eslint-env node */
/*
 * One CLI runs out; the work carries on.
 *
 * The CLIs run on subscriptions, and a subscription's limit is a wall that
 * stands for hours or days: "You've hit your usage limit. Try again at Oct 3rd,
 * 2026 5:19 PM." Two things have to be true for that to be survivable.
 *
 * First, the work has to move to the OTHER subscription rather than to the API -
 * a paid route should be reached only when every free one is genuinely out.
 * Second, the wall has to be REMEMBERED until the reset time it states, because
 * otherwise every AI request for the next five days begins by spawning a process
 * and waiting for it to refuse. That is a minute of a teacher's time, per
 * request, for information we already had.
 *
 * So this tests the chain (CLI -> the other CLI -> API), the memory (a CLI that
 * is resting is skipped, and stops being skipped when it works again), and the
 * one judgement everything rests on: a plan limit is a reason to switch, a bad
 * prompt is not.
 */
process.env.NODE_ENV = "test";
process.env.AI_CLI_ORDER = "claude,codex";

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log("  ✓", label);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", label, extra ? `- ${extra}` : "");
  }
};

/* Kept quiet: the gateway narrates every switch, and that is 60 lines here. */
const realWarn = console.warn;
const realLog = console.log;
const hush = () => {
  console.warn = () => {};
  console.log = () => {};
};
const speak = () => {
  console.warn = realWarn;
  console.log = realLog;
};

const cliHealth = require("../helper/cliHealth");

/* runAi reads the stored mode, so the test controls it by stubbing that read.
 * The health state is in-memory here: with no database connected, cliHealth
 * keeps what this process has learned and never queries. */
const aiExecution = require("../config/aiExecution");
let CURRENT = "api";
aiExecution.getAiExecution = async () => ({ mode: CURRENT });
const { runAi, isRouteExhausted } = require("../helper/aiRuntime");

/* The refusals the real binaries print, near enough to be the same thing. */
const CODEX_LIMIT = "ERROR: You've hit your usage limit. Try again at Oct 3rd, 2026 5:19 PM.";
const claudeLimit = (epochSeconds) => `Claude AI usage limit reached|${epochSeconds}`;

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

/*
 * One request. `fail` says which routes refuse and how; everything else works.
 * Returns the routes that were actually attempted, in order.
 */
const call = async (mode, { fail = {}, prefer, capability = "structured" } = {}) => {
  CURRENT = mode;
  const ran = [];
  try {
    const got = await runAi({
      capability,
      preferCli: prefer,
      cli: async (provider) => {
        ran.push(`cli:${provider}`);
        if (typeof provider !== "string" || !["claude", "codex"].includes(provider)) {
          throw err(`the gateway handed the call site a bad provider: ${provider}`);
        }
        if (fail[provider]) throw fail[provider]();
        return `${provider}-result`;
      },
      api: async () => {
        ran.push("api");
        if (fail.api) throw fail.api();
        return "api-result";
      },
    });
    return { ran: ran.join(" -> "), got, error: null };
  } catch (e) {
    return { ran: ran.join(" -> "), got: null, error: e };
  }
};

const restingNow = async () => (await cliHealth.snapshot()).filter((p) => p.state === "resting").map((p) => p.id);

async function main() {
  console.log("CLI to CLI, then the API");

  // -- reading the wall's own reset time ----------------------------------
  console.log("\nwhen a CLI says when it will be back, that is when it is tried again:");
  const sep28 = new Date(2026, 8, 28, 12, 0, 0, 0).getTime();

  ok(
    "Codex's prose date (\"Try again at Oct 3rd, 2026 5:19 PM\")",
    cliHealth.parseResetAt(err(CODEX_LIMIT), sep28) === new Date(2026, 9, 3, 17, 19, 0, 0).getTime(),
    new Date(cliHealth.parseResetAt(err(CODEX_LIMIT), sep28) || 0).toString()
  );

  const epoch = Math.floor(sep28 / 1000) + 3 * 3600;
  ok(
    "Claude's machine-readable form (\"...limit reached|<epoch>\")",
    cliHealth.parseResetAt(err(claudeLimit(epoch)), sep28) === epoch * 1000
  );
  ok(
    "a five-hour limit that states an hour (\"resets 3am\")",
    cliHealth.parseResetAt(err("5-hour limit reached - resets 3am"), sep28) ===
      new Date(2026, 8, 29, 3, 0, 0, 0).getTime()
  );
  ok(
    "a duration (\"try again in 42 minutes\")",
    cliHealth.parseResetAt(err("try again in 42 minutes"), sep28) === sep28 + 42 * 60_000
  );
  ok("an ISO timestamp", cliHealth.parseResetAt(err("retry after 2026-10-01T09:30:00Z"), sep28) === Date.parse("2026-10-01T09:30:00Z"));
  ok("and a refusal that states nothing states nothing", cliHealth.parseResetAt(err("cli_failed"), sep28) === null);

  console.log("\nand the guessed cooldowns are bounded:");
  ok(
    "no stated time means the default, not forever",
    cliHealth.cooldownUntil(err("usage limit reached"), sep28) === sep28 + cliHealth.DEFAULT_COOLDOWN_MS
  );
  ok(
    "a CLI that is not logged in is retried sooner - an admin can fix that",
    cliHealth.cooldownUntil(err("not logged in"), sep28) === sep28 + cliHealth.AUTH_COOLDOWN_MS
  );
  ok(
    "a stated time in the PAST means the limit already lifted",
    cliHealth.cooldownUntil(err("try again at Jan 1st, 2020 1:00 AM"), sep28) === sep28 + 60_000
  );
  ok(
    "and a misread date can never rest a CLI for longer than a week",
    cliHealth.cooldownUntil(err("try again at Oct 3rd, 2099 5:19 PM"), sep28) === sep28 + cliHealth.MAX_COOLDOWN_MS
  );

  /*
   * The refusal has to SURVIVE the capture.
   *
   * This is the one that got through to production. Codex echoes the entire
   * prompt - system text, JSON schema and all - to stderr before it says
   * anything about itself, so on a real generation the reason it stopped sits
   * tens of kilobytes after the banner. The runner kept the FIRST 8 KB, so the
   * gateway was handed "Reading additional input from stdin..." and nothing
   * else: a spent subscription read as an ordinary failure, the work never
   * moved to the other CLI, and the teacher got "AI suallar yarada bilmədi".
   *
   * Every probe missed it because a short test prompt leaves the refusal inside
   * the first 8 KB. So this asserts on a refusal shaped like a real one.
   */
  console.log("\na refusal buried under a real prompt is still a refusal:");
  const echoed =
    "Reading additional input from stdin...\nOpenAI Codex v0.159.0\n" +
    "user\n" +
    "SƏN STRUCTURED JSON CAVABI VERƏN BACKEND MODELİSƏN. ".repeat(900) + // ~45 KB, as a real one is
    "\nERROR: You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
    "to purchase more credits or try again at Oct 3rd, 2026 5:19 PM.";
  const buried = Object.assign(new Error("cli_failed"), { code: "cli_failed", stderr: echoed });
  ok("the prompt echo is longer than any fixed head window", echoed.length > 40000);
  ok("it is recognised as a reason to switch", isRouteExhausted(buried) === true);
  ok(
    "...and its reset date still reads",
    cliHealth.parseResetAt(buried, sep28) === new Date(2026, 9, 3, 17, 19, 0, 0).getTime()
  );
  /* The runner keeps the tail for exactly this reason. */
  const runnerSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "helper", "cliAi.js"), "utf8");
  ok(
    "the runner keeps the END of stderr, not the beginning",
    /stderr = stderr\.slice\(-STDERR_KEEP\)/.test(runnerSrc) && !/if \(stderrBytes <= 8 \* 1024\)/.test(runnerSrc)
  );

  // -- the chain ----------------------------------------------------------
  console.log("\nthe chain, in CLI-only mode:");
  cliHealth._reset();
  hush();
  let r = await call("cli");
  speak();
  ok("with both CLIs up, the first one does the work", r.ran === "cli:claude" && r.got === "claude-result");

  cliHealth._reset();
  hush();
  r = await call("cli", { fail: { claude: () => err(claudeLimit(Math.floor(Date.now() / 1000) + 3600)) } });
  speak();
  ok("when Claude hits its limit, Codex finishes the SAME request", r.ran === "cli:claude -> cli:codex" && r.got === "codex-result");
  ok("...and Claude is stood down, not just skipped once", (await restingNow()).join() === "claude");

  hush();
  r = await call("cli");
  speak();
  ok("so the next request does not spawn Claude at all", r.ran === "cli:codex" && r.got === "codex-result");

  console.log("\nthe other direction is the same:");
  cliHealth._reset();
  hush();
  r = await call("cli", { fail: { codex: () => err(CODEX_LIMIT) }, prefer: "codex" });
  speak();
  ok("Codex out of quota moves the work to Claude", r.ran === "cli:codex -> cli:claude" && r.got === "claude-result");
  ok("...and Codex rests until the date it named", (await restingNow()).join() === "codex");

  // -- the API is the last resort, not the second ------------------------
  console.log("\nthe API is reached only when every subscription is out:");
  cliHealth._reset();
  hush();
  r = await call("cli_then_api", { fail: { claude: () => err("usage limit reached"), codex: () => err(CODEX_LIMIT) } });
  speak();
  ok(
    "both CLIs are tried before a single token is paid for",
    r.ran === "cli:claude -> cli:codex -> api" && r.got === "api-result"
  );
  ok("...and now both are resting", (await restingNow()).sort().join() === "claude,codex");

  hush();
  r = await call("cli_then_api");
  speak();
  ok(
    "the next request goes straight to the API - no spawning a CLI to be refused",
    r.ran === "api" && r.got === "api-result"
  );

  console.log("\nbut CLI-only mode never silently starts billing:");
  hush();
  r = await call("cli", { fail: { claude: () => err("usage limit reached"), codex: () => err(CODEX_LIMIT) } });
  speak();
  /* Claude's refusal named no reset time, so it took the default half hour;
   * Codex named a date days away. The one nearest coming back is the only one
   * with anything new to say, so it is the only one asked. */
  ok("with both resting and no API route, the one nearest its reset is still tried", r.ran === "cli:claude");
  ok("...and the owner gets the error rather than an invoice", !!r.error);

  /*
   * What the teacher is told when there is genuinely nothing left.
   *
   * In CLI-only mode there is no other route by the owner's choice, so the
   * honest answer is "the plan is spent until this hour" - and the binaries
   * state that hour in their refusal. A teacher who knows the subscription
   * returns at nine tonight can plan around it; one told "AI could not create
   * questions" can only keep pressing the button.
   */
  console.log("\nwhen the plan is spent, the teacher is told WHEN:");
  ok("the error carries a message meant for a person", !!r.error?.userMessage, String(r.error?.userMessage || ""));
  ok("...naming the hour it comes back", /\d{1,2}:\d{2}/.test(r.error?.userMessage || ""), r.error?.userMessage);
  ok("...in Azerbaijani", /yenidən cəhd edin/.test(r.error?.userMessage || ""));
  ok("...and it is 503, not a generic failure", r.error?.aiStatus === 503);
  console.log(`    "${r.error?.userMessage}"`);

  console.log("\nand a CLI that works again is used again immediately:");
  hush();
  r = await call("cli");
  speak();
  ok("the attempt that succeeds clears the memory", r.ran === "cli:claude" && r.got === "claude-result");
  /* Codex is still resting, and rightly: it was not tried, so the date it gave
   * is still the best thing known about it. One CLI recovering is not evidence
   * about the other. */
  ok("...so THAT CLI stops resting", !(await restingNow()).includes("claude"));
  ok("...but the untried one keeps the date it gave", (await restingNow()).join() === "codex");

  // -- api_then_cli -------------------------------------------------------
  console.log("\nwhen the card declines (api_then_cli):");
  cliHealth._reset();
  hush();
  r = await call("api_then_cli", { fail: { api: () => err("credit balance is too low") } });
  speak();
  ok("the request finishes on the first CLI", r.ran === "api -> cli:claude" && r.got === "claude-result");

  cliHealth._reset();
  hush();
  r = await call("api_then_cli", {
    fail: { api: () => err("credit balance is too low"), claude: () => err("usage limit reached") },
  });
  speak();
  ok("and rolls on to the second if that one is out too", r.ran === "api -> cli:claude -> cli:codex" && r.got === "codex-result");

  // -- what must NOT cause a switch --------------------------------------
  console.log("\nan ordinary failure is not a reason to try another CLI:");
  cliHealth._reset();
  hush();
  r = await call("cli_then_api", { fail: { claude: () => err("cli_invalid_json") } });
  speak();
  ok("a model that answered badly is not re-run on the other subscription", r.ran === "cli:claude");
  ok("...nor paid for on the API", !r.ran.includes("api"));
  ok("...and Claude is NOT stood down for it", (await restingNow()).length === 0, (await restingNow()).join());
  ok("the teacher gets the error", !!r.error);

  console.log("\na cancelled request stops everywhere:");
  cliHealth._reset();
  hush();
  r = await call("cli_then_api", { fail: { claude: () => err("cli_cancelled", { code: "cli_cancelled" }) } });
  speak();
  ok("nobody is asked to redo work nobody is waiting for", r.ran === "cli:claude" && !!r.error);

  // -- ordering and configuration ---------------------------------------
  console.log("\nwhose CLI goes first:");
  cliHealth._reset();
  hush();
  r = await call("cli", { prefer: "codex" });
  speak();
  ok("the model the teacher picked decides, when its CLI is up", r.ran === "cli:codex");

  hush();
  r = await call("cli", { prefer: "gemini" });
  speak();
  ok("a provider with no CLI of its own just uses the configured order", r.ran === "cli:claude");

  process.env.AI_CLI_ORDER = "codex";
  cliHealth._reset();
  hush();
  r = await call("cli_then_api", { fail: { codex: () => err(CODEX_LIMIT) } });
  speak();
  ok("an owner with one CLI is not made to wait for a CLI they do not have", r.ran === "cli:codex -> api");
  process.env.AI_CLI_ORDER = "claude,codex";

  console.log("\nwork no CLI can do:");
  cliHealth._reset();
  hush();
  r = await call("cli", { capability: "audio" });
  speak();
  ok("transcription runs on the API even in CLI-only mode", r.ran === "api" && r.got === "api-result");

  // -- what the admin page is shown -------------------------------------
  console.log("\nwhat the admin page can show:");
  cliHealth._reset();
  hush();
  await cliHealth.markExhausted("codex", err(CODEX_LIMIT));
  speak();
  const snap = await cliHealth.snapshot();
  const codex = snap.find((p) => p.id === "codex");
  const claude = snap.find((p) => p.id === "claude");
  ok("the resting CLI reports its state", codex.state === "resting");
  ok("...with the time it comes back", !!codex.until && codex.minutes > 0);
  ok("...and the reason it gave", /usage limit/i.test(codex.reason));
  ok("the working CLI reports ready", claude.state === "ready" && claude.until === null);

  const { planSteps } = require("../helper/aiRuntime");
  const chain = (await planSteps("cli_then_api", undefined, "test")).map((s) => (s.route === "cli" ? `cli:${s.provider}` : "api"));
  ok("and the page's chain is the gateway's own plan", chain.join(" -> ") === "cli:claude -> api", chain.join(" -> "));

  /*
   * The reason has to be the CLI's own words. "cli_failed" is our wrapper, not
   * information: an owner reading it learns nothing and can do nothing. These
   * are the exact strings the deployed binaries printed.
   */
  console.log("\nthe reason shown is what the CLI actually said:");
  const realCodex = Object.assign(new Error("cli_failed"), {
    code: "cli_failed",
    stderr:
      "ERROR: You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 5:19 PM.",
  });
  const realClaude = Object.assign(new Error("cli_failed"), {
    code: "cli_failed",
    stdout:
      '{"num_turns":1,"subtype":"success","api_error_status":null,"result":"Not logged in · Please run /login","type":"result"}',
  });
  const codexReason = cliHealth.reasonFrom(realCodex);
  ok("Codex's refusal keeps the date the owner needs", codexReason.includes("usage limit") && codexReason.includes("Oct 3rd, 2026"), codexReason);
  ok(
    "Claude's notice comes out of its JSON envelope clean",
    cliHealth.reasonFrom(realClaude) === "Not logged in · Please run /login",
    cliHealth.reasonFrom(realClaude)
  );
  ok(
    "and nothing key-shaped is ever stored",
    !cliHealth.reasonFrom(new Error("quota gone, key sk-ant-oat01-ABCDEF123456 rejected")).includes("ABCDEF")
  );

  hush();
  await cliHealth.clear("codex");
  speak();
  ok("\"check again\" forgets the cooldown", (await restingNow()).length === 0);

  // -- a model name must not follow the switch --------------------------
  console.log("\na model name belongs to its own binary:");
  const { cliModel, modelBelongsTo } = require("../helper/cliAi");
  ok("claude-opus-5 is not Codex's to run", modelBelongsTo("codex", "claude-opus-5") === false);
  ok("gpt-5.2 is not Claude's to run", modelBelongsTo("claude", "gpt-5.2") === false);
  ok(
    "so a switch to Codex drops the Claude model rather than passing it on",
    cliModel("codex", "claude-opus-5") === null || cliModel("codex", "claude-opus-5") !== "claude-opus-5"
  );
  ok("and Claude still gets its own alias", cliModel("claude", "claude-opus-5") === "opus");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  speak();
  console.error("test crashed:", e);
  process.exit(1);
});
