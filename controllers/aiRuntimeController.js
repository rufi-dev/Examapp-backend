const asyncHandler = require("express-async-handler");
const { getAiExecution, setAiExecution, MODES, MODE_IDS } = require("../config/aiExecution");
const { CLI_UNSUPPORTED, planSteps, isRouteExhausted } = require("../helper/aiRuntime");
const cliHealth = require("../helper/cliHealth");
const { tierModel } = require("../helper/cliAi");

/*
 * What kind of model each sort of work asks for.
 *
 * Teachers no longer choose a model - to them the platform is one engine - so
 * this page is now the only place the choice is visible. Two tiers, because a
 * chat reply is not a forty-question paper: running conversations on the
 * generation model spends a subscription's allowance on small talk.
 */
const ENGINES = Object.freeze([
  {
    kind: "generation",
    tier: "standard",
    label: "İmtahan, dərs materialı, plan",
    describe: "Sual yazmaq, PDF-dən çıxarmaq, material və plan hazırlamaq.",
  },
  {
    kind: "chat",
    tier: "light",
    label: "Söhbət",
    describe: "Köməkçi və dəstək söhbətləri — yüngül model bəs edir, paketi yormur.",
  },
]);

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
      /* When the platform expects to be able to use a CLI again, said the way a
       * person reads it. Null while any subscription is still usable. */
      returns: await (async () => {
        const at = await cliHealth.soonestReturn();
        return at ? { at: new Date(at).toISOString(), text: cliHealth.azWhen(at) } : null;
      })(),
    },
    /*
     * Which model each kind of work runs on.
     *
     * Teachers no longer choose a model - the platform is one engine as far as
     * they are concerned - so this page is the only place the choice is visible
     * at all. It matters more than it looks: asked for no model, `claude` runs
     * Opus, the strongest and the fastest way to spend a subscription. Every
     * kind of work therefore names a tier, and this shows what that resolves to.
     */
    engines: ENGINES.map((e) => ({
      ...e,
      models: cliHealth.KNOWN.reduce(
        (acc, p) => Object.assign(acc, { [p]: tierModel(p, e.tier) || "(CLI-nin öz seçimi)" }),
        {}
      ),
    })),
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
/*
 * "Does this subscription still have allowance?" — asked properly, on request.
 *
 * The page can establish for free that a CLI is installed and signed in, and it
 * says so. It cannot establish that the plan has room left without using some:
 * there is no endpoint that reports remaining quota, and the only way to ask is
 * to run a turn. So the expensive question is a button rather than a page load,
 * and the answer is recorded the same way a real request's answer would be — a
 * refusal stands the CLI down until the date it names, a success marks it
 * verified.
 *
 * Deliberately NOT a background poll. A checker running every few minutes would
 * spend the very allowance it is reporting on, all day, to answer a question
 * nobody asked.
 */
const checkProvider = asyncHandler(async (req, res) => {
  const provider = String(req.params.provider || "");
  if (!cliHealth.KNOWN.includes(provider)) {
    res.status(400);
    throw new Error(`Naməlum CLI. Mümkün olanlar: ${cliHealth.KNOWN.join(", ")}`);
  }

  const { runCliChat } = require("../helper/cliAi");
  const started = Date.now();
  let result;
  try {
    // The smallest turn that still proves the plan will serve one.
    await runCliChat({ provider, messages: [{ role: "user", content: "OK" }], tier: "light" });
    await cliHealth.markRecovered(provider);
    result = { ok: true, ms: Date.now() - started };
    console.log(`[AI] ${provider} checked by admin ${req.user?._id}: works (${result.ms}ms)`);
  } catch (e) {
    const exhausted = isRouteExhausted(e);
    if (exhausted) await cliHealth.markExhausted(provider, e);
    result = {
      ok: false,
      exhausted,
      ms: Date.now() - started,
      reason: cliHealth.reasonFrom(e),
    };
    console.log(`[AI] ${provider} checked by admin ${req.user?._id}: ${exhausted ? "out of quota" : "failed"} — ${result.reason}`);
  }
  res.json({ ...(await payload()), check: { provider, ...result } });
});

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

module.exports = { get, update, resetProvider, checkProvider };
