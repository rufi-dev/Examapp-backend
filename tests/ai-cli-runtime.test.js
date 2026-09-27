/* eslint-env node */
const assert = require("assert");
const { normalize, DEFAULTS } = require("../config/aiExecution");
const { parseJsonText, cliModel } = require("../helper/cliAi");

assert.deepStrictEqual(normalize(null), DEFAULTS);
assert.deepStrictEqual(normalize({ mode: "cli", fallbackToApi: true }), { mode: "cli", fallbackToApi: true });
assert.deepStrictEqual(normalize({ mode: "invalid", fallbackToApi: "yes" }), { mode: "api", fallbackToApi: false });
assert.deepStrictEqual(parseJsonText('{"questions":[]}'), { questions: [] });
assert.deepStrictEqual(parseJsonText("```json\n{\"questions\":[]}\n```"), { questions: [] });
assert.strictEqual(cliModel("claude", "claude"), "sonnet");
assert.strictEqual(cliModel("claude", "claude-opus-4-8"), "opus");
console.log("ai-cli-runtime: all assertions passed");
