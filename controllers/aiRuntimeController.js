const asyncHandler = require("express-async-handler");
const { getAiExecution, setAiExecution, MODES, MODE_IDS } = require("../config/aiExecution");
const { CLI_UNSUPPORTED } = require("../helper/aiRuntime");

/*
 * The admin page needs three things, and it should not have to know any of them
 * in advance: which modes exist, which is set, and what the CLI cannot do.
 *
 * The last one matters. If the page offered "Yalnız CLI" without saying that
 * transcription, the realtime session and the lesson-document agent still run on
 * the API, the owner would pick it expecting a bill of zero and be wrong. The
 * reasons are sent from the same constant the gateway enforces, so the page
 * cannot describe a policy the server is not applying.
 */
const payload = async () => ({
  settings: await getAiExecution(),
  modes: MODE_IDS.map((id) => ({
    id,
    label: MODES[id].label,
    describe: MODES[id].describe,
    order: MODES[id].order,
  })),
  apiOnly: Object.entries(CLI_UNSUPPORTED).map(([capability, why]) => ({ capability, why })),
});

const get = asyncHandler(async (req, res) => {
  res.json(await payload());
});

const update = asyncHandler(async (req, res) => {
  const asked = String(req.body?.mode || "");
  if (!MODE_IDS.includes(asked)) {
    res.status(400);
    throw new Error(`Naməlum rejim. Mümkün olanlar: ${MODE_IDS.join(", ")}`);
  }
  await setAiExecution({ mode: asked });
  // Who changed the platform's AI billing route, and to what.
  console.log(`[AI] runtime mode set to "${asked}" by admin ${req.user?._id}`);
  res.json(await payload());
});

module.exports = { get, update };
