const AppSetting = require("../models/appSettingModel");

const KEY = "ai.execution";

/*
 * WHERE the platform's AI work runs, as one setting for the whole platform.
 *
 * Two routes exist to the same models. The API route bills per token. The CLI
 * route runs the `claude` and `codex` binaries on this server against the
 * owner's subscription, so it costs nothing per call but is bounded by that
 * plan's limits and is slower (a process per turn, no token streaming).
 *
 * Neither is strictly better, so the choice is the owner's, and it is one
 * choice: whatever is set here governs EVERY AI feature - exam generation, PDF
 * extraction, lesson documents, lesson plans, the assistant chat, the support
 * chat. A setting that some features honoured and others ignored would be worse
 * than no setting, because it would be believed.
 *
 * The two ordered modes exist because each route fails in a way the other
 * survives: a subscription runs out of plan allowance, an API key runs out of
 * credit. `cli_then_api` keeps the platform working when the plan resets at
 * midnight; `api_then_cli` keeps it working when the card fails.
 */
const MODES = Object.freeze({
  api: {
    id: "api",
    label: "Yalnız API",
    describe: "Bütün AI işləri API ilə işləyir. Token üzř ödəniş olunur.",
    order: ["api"],
  },
  cli: {
    id: "cli",
    label: "Yalnız CLI",
    describe: "Bütün AI işləri serverdəki CLI ilə işləyir. Paket limiti bitərsə səhv qaytarılır - API-yə keçmir.",
    order: ["cli"],
  },
  cli_then_api: {
    id: "cli_then_api",
    label: "CLI — limit bitəndə API",
    describe: "Əvvəl CLI. Paket limiti bitəndə həmin sorğu API ilə tamamlanır.",
    order: ["cli", "api"],
  },
  api_then_cli: {
    id: "api_then_cli",
    label: "API — kredit bitəndə CLI",
    describe: "Əvvəl API. Kredit və ya limit bitəndə həmin sorğu CLI ilə tamamlanır.",
    order: ["api", "cli"],
  },
});

const MODE_IDS = Object.keys(MODES);
const DEFAULT_MODE = "api";

const DEFAULTS = Object.freeze({ mode: DEFAULT_MODE });

/*
 * Read whatever is stored, including the shape this setting had before the
 * ordered modes existed ({ mode: "cli", fallbackToApi: true }), so turning the
 * feature on a second time does not silently reset an owner's choice.
 */
function normalize(value) {
  const source = value && typeof value === "object" ? value : {};
  const raw = String(source.mode || "");
  /*
   * The legacy shape is checked FIRST, because "cli" is both the old mode name
   * and a current one: a stored { mode: "cli", fallbackToApi: true } would
   * otherwise match the new id, return as plain "cli", and silently turn an
   * owner's "fall back to API" choice into "fail closed" the next time the
   * setting was read.
   */
  if (raw === "cli" && typeof source.fallbackToApi === "boolean") {
    return { mode: source.fallbackToApi ? "cli_then_api" : "cli" };
  }
  if (MODE_IDS.includes(raw)) return { mode: raw };
  return { mode: DEFAULT_MODE };
}

/* The routes to attempt, in order, for the mode currently set. */
function orderFor(mode) {
  return (MODES[mode] || MODES[DEFAULT_MODE]).order;
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
  MODES,
  MODE_IDS,
  DEFAULT_MODE,
  DEFAULTS,
  normalize,
  orderFor,
  getAiExecution,
  setAiExecution,
};
