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
const { parseJsonText, cliModel } = require("../helper/cliAi");

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

console.log("ai-cli-runtime: all assertions passed");
