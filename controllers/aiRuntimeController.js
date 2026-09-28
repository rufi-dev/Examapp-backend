const asyncHandler = require("express-async-handler");
const { getAiExecution, setAiExecution, MODES, MODE_IDS } = require("../config/aiExecution");
const { CLI_UNSUPPORTED, planSteps } = require("../helper/aiRuntime");
const cliHealth = require("../helper/cliHealth");

/*
 * The admin page needs four things, and it should not have to know any of them
 * in advance: which modes exist, which is set, what the CLI cannot do, and which
 * route the next request will actually take.
 *
 * The third matters. If the page offered "Yalnız CLI" without saying that
 * transcription, the realtime session and the lesson-document agent still run on
 * the API, the owner would pick it expecting a bill of zero and be wrong.
 *
 * The fourth matters more, because it is the part that changes by itself. When
 * Codex hits its weekly limit the platform moves to Claude without being told,
 * and when both are out it moves to the API. An owner looking at this page needs
 * to see that that has happened, and until when - otherwise the only evidence is
 * an invoice. `chain` is computed by the gateway's own planner, so the page shows
 * the sequence the next request will really follow rather than a description of
 * it.
 */
const payload = async () => {
  const settings = await getAiExecution();
  const steps = await planSteps(settings.mode, undefined, "admin-page");
  return {
    settings,
    modes: MODE_IDS.map((id) => ({
      id,
      label: MODES[id].label,
      describe: MODES[id].describe,
      order: MODES[id].order,
    })),
    apiOnly: Object.entries(CLI_UNSUPPORTED).map(([capability, why]) => ({ capability, why })),
    cli: {
      order: cliHealth.order(),
      providers: await cliHealth.snapshot(),
      chain: steps.map((s) => (s.route === "cli" ? `cli:${s.provider}` : "api")),
    },
  };
};

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

/*
 * "Check this CLI again now."
 *
 * A cooldown is read out of the refusal the binary printed, and a binary can be
 * wrong about its own reset time - or an owner can upgrade the plan, or log in
 * again, and want the platform to notice immediately rather than at the end of a
 * wait it no longer needs. This forgets what was remembered; the next request
 * finds out the truth by trying.
 */
const resetProvider = asyncHandler(async (req, res) => {
  const provider = String(req.params.provider || "");
  if (!cliHealth.KNOWN.includes(provider)) {
    res.status(400);
    throw new Error(`Naməlum CLI. Mümkün olanlar: ${cliHealth.KNOWN.join(", ")}`);
  }
  await cliHealth.clear(provider);
  console.log(`[AI] ${provider} CLI cooldown cleared by admin ${req.user?._id}`);
  res.json(await payload());
});

module.exports = { get, update, resetProvider };
