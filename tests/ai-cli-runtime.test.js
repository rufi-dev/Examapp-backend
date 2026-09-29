/* eslint-env node */
/*
 * The CLI runner's own arithmetic: reading a model's answer, and turning the
 * platform's model names into the aliases the binaries accept.
 *
 * The mode policy itself is tested in ai-runtime-modes, and which features the
 * switch reaches in ai-runtime-coverage. This file is only about the runner.
 */
const assert = require("assert");
const { normalize, DEFAULTS } = require("../config/aiExecution");
const fs = require("fs");
const path = require("path");
const {
  parseJsonText,
  cliModel,
  limitFromText,
  claudeEnvelope,
  CLAUDE_BASE_ARGS,
  claudeArgs,
  claudeTurns,
} = require("../helper/cliAi");
const { isRouteExhausted } = require("../helper/aiRuntime");

// Nothing stored, or nonsense stored, means the API - the route that bills but
// always works. A switch that defaulted to CLI would take the platform down the
// first time it was deployed without a login.
assert.deepStrictEqual(normalize(null), DEFAULTS);
assert.deepStrictEqual(normalize({ mode: "invalid" }), { mode: "api" });

// A model answering in JSON does not always answer in ONLY JSON.
assert.deepStrictEqual(parseJsonText('{"questions":[]}'), { questions: [] });
assert.deepStrictEqual(parseJsonText("```json\n{\"questions\":[]}\n```"), { questions: [] });
assert.deepStrictEqual(parseJsonText('here you go:\n{"questions":[]}\nhope that helps'), { questions: [] });

// The picker speaks product names; the binaries speak their own aliases.
assert.strictEqual(cliModel("claude", "claude"), "sonnet");
assert.strictEqual(cliModel("claude", "claude-opus-4-8"), "opus");
assert.strictEqual(cliModel("claude", "claude-opus-5"), "opus");

// An unmapped model stays the teacher's choice rather than being silently
// swapped for a different one.
assert.strictEqual(cliModel("claude", "sonnet"), "sonnet");

// A model name is never allowed to become a shell argument of its own.
assert.throws(() => cliModel("claude", "sonnet; rm -rf /"), /invalid_cli_model/);

/*
 * A spent subscription is not always an error exit.
 *
 * `claude -p` reports one as its ANSWER, with exit code 0 and the text where the
 * reply should be. If that reads as "the model failed to produce JSON" then it is
 * an ordinary failure: the gateway does not switch to the other CLI, does not
 * rest this one, and retries the exhausted plan on the next request and the one
 * after that. So the refusal has to be recognised in the output itself, and it
 * has to be recognised as the kind of failure that switches route.
 */
const spent = limitFromText("Claude AI usage limit reached|1759507140", "claude");
assert.ok(spent, "a usage-limit answer must be recognised");
assert.strictEqual(spent.code, "cli_limit_reached");
assert.ok(isRouteExhausted(spent), "...and must send the work to the other subscription");
assert.ok(isRouteExhausted({ code: "cli_failed", stdout: "You've hit your usage limit. Try again at Oct 3rd, 2026 5:19 PM." }),
  "a refusal printed on stdout is still a refusal");

// ...but generated material that happens to discuss limits is not a refusal. A
// false positive here would rest a working subscription for half an hour.
assert.strictEqual(
  limitFromText(`{"questions":[${'{"title":"API rate limit reached nədir?"},'.repeat(40)}{}]}`, "claude"),
  null
);

/*
 * The other zero-exit refusal, in the wording production actually printed: the
 * binary is installed and simply not logged in. That is a route that cannot
 * work, so it must send the request to the other subscription and say which
 * login needs fixing - not read as a model that failed to produce JSON.
 */
const unlogged = limitFromText("Not logged in · Please run /login", "claude");
assert.ok(unlogged, "a not-logged-in answer must be recognised");
assert.strictEqual(unlogged.code, "cli_unavailable");
assert.ok(isRouteExhausted(unlogged), "...and must send the work to the other subscription");

// Claude's JSON envelope: the reply is inside it, and so is failure.
assert.strictEqual(claudeEnvelope('{"result":"salam","is_error":false}'), "salam");
assert.strictEqual(claudeEnvelope("plain text, no envelope"), "plain text, no envelope");
assert.throws(() => claudeEnvelope('{"result":"Claude AI usage limit reached|1759507140","is_error":true}'), /usage limit/);

/*
 * `--bare` must never come back.
 *
 * It looks exactly like the flag a one-shot backend turn wants - it skips hooks,
 * plugin sync, LSP, auto-memory and CLAUDE.md discovery - and someone tidying
 * this file will reach for it. Its help states the rest of the bargain:
 * "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth
 * excluded)". CLI mode exists to run on the owner's SUBSCRIPTION, which is
 * OAuth, so --bare makes the binary ignore a perfectly good login and report
 * "Not logged in - Please run /login" - while `claude auth status`, in the same
 * environment, reports a valid Max subscription, because that command does read
 * the file. Nothing about the failure points at the flag.
 */
assert.ok(!CLAUDE_BASE_ARGS.includes("--bare"), "--bare disables OAuth: CLI mode would silently fall back to the API");
assert.ok(CLAUDE_BASE_ARGS.includes("--no-session-persistence"), "a backend turn must not write session files");
const runnerSource = fs.readFileSync(path.join(__dirname, "..", "helper", "cliAi.js"), "utf8");
// Allowed in prose (the comment explaining this), never as an argument.
assert.ok(
  !/"--bare"|'--bare'/.test(runnerSource),
  "--bare appears as an argument in helper/cliAi.js - it disables subscription auth"
);

/*
 * The prompt does not travel in argv at all.
 *
 * It used to be a positional argument behind two VARIADIC options
 * (`--add-dir <directories...>`, `--tools <tools...>`), which swallowed it and
 * made the binary refuse with "Input must be provided either through stdin or
 * as a prompt argument" — a message that reads like our bug rather than an
 * argument-parsing one. A `--` fence solved that, and left a worse limit in
 * place: argv caps a single argument at 131,072 bytes on Linux, while the
 * review pass alone sends up to 60,000 characters of question JSON plus a
 * schema plus a system prompt. Measured on the server: 200 KB as an argument is
 * E2BIG, 200 KB on stdin is fine.
 *
 * So the prompt goes in on stdin and argv carries only flags. Both problems are
 * gone at once, and the fence with them.
 */
const withFiles = claudeArgs({
  model: "claude-sonnet-5",
  fileCount: 2,
  extra: ["--tools", "Read", "--add-dir", "/tmp/job"],
  systemPrompt: "be a backend",
});
assert.ok(!withFiles.includes("--"), "no fence is needed once nothing positional follows the flags");
assert.ok(
  withFiles.every((a2) => typeof a2 === "string" && a2.length < 20000),
  "argv carries flags only - nothing in it may approach the 128 KB limit"
);
assert.strictEqual(withFiles[withFiles.indexOf("--system-prompt") + 1], "be a backend");
const runnerSrc0 = fs.readFileSync(path.join(__dirname, "..", "helper", "cliAi.js"), "utf8");
assert.ok(/stdin: fullPrompt/.test(runnerSrc0), "the structured turn must feed its prompt on stdin");
assert.ok(/stdin: transcript/.test(runnerSrc0), "and so must the chat turn");

/*
 * Turns. A prompt with an attachment needs at least two: one for the model to
 * call Read, one to answer with. At --max-turns 1 the binary exits with NO result
 * at all - not an error, an empty string - so every CLI PDF extraction came back
 * empty, which is indistinguishable from a PDF that could not be read.
 *
 * Those minimums were necessary and not sufficient, and this file used to assert
 * the exact minimum, which is how the CLI route stayed dead for a day with a
 * green suite. Production printed `error_max_turns` on generate after generate -
 * "Reached maximum number of turns (1)" having used 2, "(3)" having used 4 - so
 * every call exited non-zero, handed over, and ran on the paid API while the
 * admin page said CLI.
 *
 * So the rule is headroom, not the minimum. It is safe to be generous because an
 * unused turn is free: measured on the server, the same generate took 15s at a
 * cap of 1 and 16s at 6, the same extraction 37s at 3 and 31s at 12. The cap
 * costs nothing until it bites, and when it bites it takes the route down.
 */
assert.ok(claudeTurns(0) >= 2, "a plain prompt must not be pinned to its minimum of one turn");
assert.ok(claudeTurns(1) > claudeTurns(0), "an attachment needs room to read it AND to answer");
assert.ok(claudeTurns(40) <= 20, "and it is still bounded");
assert.strictEqual(
  claudeArgs({ prompt: "P" })[CLAUDE_BASE_ARGS.length + 1],
  String(claudeTurns(0)),
  "the args must carry the budget the policy decided, not a hard-coded one"
);

// A chat turn reads nothing and must therefore carry nothing: without --bare the
// default tool set is available, and a conversation has no business running Bash
// on this server.
const chat = claudeArgs({ extra: ["--tools", ""], prompt: "hi" });
assert.strictEqual(chat[chat.indexOf("--tools") + 1], "", 'tools are switched off with an explicit ""');

/*
 * A model that answers a vague brief with a QUESTION.
 *
 * A teacher typed "change all make english exam grammar" and the CLI replied in
 * prose — asking which questions to change and how, and offering to send raw
 * JSON if that was wanted. Sensible from an assistant, useless from a backend:
 * the parser saw an essay and the teacher got "AI suallar yarada bilmədi" for a
 * request the model had understood well enough to ask a good question about.
 *
 * Two defences, both asserted here. The prompt tells the turn not to ask, and a
 * parse failure carries WHAT it could not parse, because "cli_invalid_json" on
 * its own cannot tell an essay from an answer cut off by an output limit — and
 * those want opposite fixes.
 */
const runnerText = fs.readFileSync(path.join(__dirname, "..", "helper", "cliAi.js"), "utf8");
assert.ok(/HEÇ VAXT sual vermə/.test(runnerText), "the CLI turn must be told not to ask questions");
assert.ok(/ÖNCƏKİ CAVAB JSON DEYİLDİ/.test(runnerText), "the retry must say why it is asking again");
/*
 * And the contract rides in the SYSTEM prompt, not buried in the user message.
 *
 * `claude -p` is a coding agent by default, and its own system prompt says so —
 * which is why a vague brief got a thoughtful clarifying question instead of an
 * exam. Replacing that prompt is the difference between asking a conversational
 * agent to behave like a backend and telling it that it is one.
 */
assert.ok(/buildSystemPrompt/.test(runnerText), "there must be a system prompt builder");
assert.ok(/"--system-prompt", systemPrompt/.test(runnerText), "and it must be passed as --system-prompt");
assert.ok(
  /if \(e\?\.code !== "cli_invalid_json" \|\| signal\?\.aborted\) throw e;/.test(runnerText),
  "only unparseable output is retried - never a spent plan, a cancel or a timeout"
);

const prose = (() => {
  try {
    parseJsonText("A couple of things I need clarified before I can act: 1. Which questions?");
    return null;
  } catch (e) {
    return e;
  }
})();
assert.ok(prose, "prose must not parse as JSON");
assert.strictEqual(prose.code, "cli_invalid_json");
assert.ok(prose.sample && prose.sample.includes("clarified"), "the failure must carry what it saw");

const cut = (() => {
  try {
    parseJsonText('{"questions":[{"title":"x"');
    return null;
  } catch (e) {
    return e;
  }
})();
assert.ok(cut.truncated === true, "an answer cut off mid-array is reported as truncated, not malformed");

console.log("ai-cli-runtime: all assertions passed");
