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
const { parseJsonText, cliModel, limitFromText, claudeEnvelope } = require("../helper/cliAi");
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

console.log("ai-cli-runtime: all assertions passed");
