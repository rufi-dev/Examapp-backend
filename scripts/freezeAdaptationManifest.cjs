/*
 * Regenerate config/adaptationManifest.js from the live registries.
 * Run this ONLY when deliberately adding a new template/evaluator VERSION — never
 * to silence a failing boot, which is the manifest doing its job.
 */
const fs = require("node:fs");
const path = require("node:path");
const { buildManifest } = require("../helper/adaptationTemplates");

const m = buildManifest();
const out = path.join(__dirname, "..", "config", "adaptationManifest.js");
const prev = fs.existsSync(out) ? require(out) : null;
fs.writeFileSync(
  out,
  fs.readFileSync(out, "utf8").replace(/module\.exports = [\s\S]*$/, `module.exports = ${JSON.stringify(m, null, 2)};\n`)
);
console.log(prev ? "manifest refreshed" : "manifest created", `- ${Object.keys(m.templates).length} templates, ${Object.keys(m.evaluators).length} evaluators`);
