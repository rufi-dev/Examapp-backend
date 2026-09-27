const AppSetting = require("../models/appSettingModel");

const KEY = "ai.execution";
const MODES = new Set(["api", "cli"]);
const CLI_PROVIDERS = new Set(["claude", "codex"]);

const DEFAULTS = Object.freeze({
  mode: "api",
  fallbackToApi: false,
});

function normalize(value) {
  const source = value && typeof value === "object" ? value : {};
  const mode = MODES.has(String(source.mode || "")) ? String(source.mode) : DEFAULTS.mode;
  const fallbackToApi = source.fallbackToApi === true;
  return { mode, fallbackToApi };
}

async function getAiExecution() {
  const row = await AppSetting.findOne({ key: KEY }).lean();
  return normalize(row?.value);
}

async function setAiExecution(input) {
  const value = normalize(input);
  await AppSetting.updateOne({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}

module.exports = {
  KEY,
  MODES: [...MODES],
  CLI_PROVIDERS: [...CLI_PROVIDERS],
  DEFAULTS,
  normalize,
  getAiExecution,
  setAiExecution,
};
