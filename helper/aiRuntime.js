/*
 * Required as a module rather than destructured so the setting is read through
 * it at call time. Destructuring binds the function at import, which also made
 * the policy untestable without a database.
 */
const aiExecution = require("../config/aiExecution");
const cliHealth = require("./cliHealth");

/*
 * The ONE place that decides whether a piece of AI work runs on the API or on
 * the server's CLI - and, when it runs on a CLI, WHICH CLI.
 *
 * It is a single function on purpose. The first version of this switch was
 * copied into each call site that someone happened to think of, which left the
 * lesson-document tool path, the assistant chat, the chat agent and the support
 * chat still going straight to the API while the admin page said "CLI". A
 * setting that only some features honour is worse than no setting, because the
 * owner believes it.
 *
 * Every caller hands over two ways of doing the same work and lets this choose:
 *
 *   runAi({
 *     capability: "structured",             // what the work needs
 *     preferCli: "codex",                   // which CLI suits the chosen model
 *     api: () => callTheProvider(),         // always required
 *     cli: (provider) => runTheCli(provider), // omitted when the CLI cannot do it
 *   })
 *
 * The CLI callback is HANDED its provider rather than choosing one. That is
 * what makes CLI-to-CLI failover work everywhere at once: when one
 * subscription hits its limit the gateway stands it down and calls the same
 * callback again with the other one. A call site that picked its own provider
 * would quietly opt out of that, and would keep hammering a CLI that is out of
 * quota until the request failed.
 *
 * The full chain, in the two ordered modes, is therefore:
 *
 *   cli_then_api:  CLI A -> CLI B -> API
 *   api_then_cli:  API   -> CLI A -> CLI B
 *
 * and in "Yalnız CLI": CLI A -> CLI B, then the error.
 */

/* Work the CLI genuinely cannot do, and why - so "not wired" is never a guess. */
const CLI_UNSUPPORTED = Object.freeze({
  audio: "the CLIs take no audio input; transcription is an API-only endpoint",
  realtime: "a realtime voice session is a direct socket to the provider",
  /*
   * The lesson-document agent runs a TOOL LOOP: the model asks for a source
   * passage, our code answers, and `validate` checks that answer against the
   * pinned PDF before the text is allowed into the document. That check is what
   * makes a cited lesson trustworthy, and it happens between the model's turns -
   * which a one-shot CLI call has no way to reproduce.
   *
   * Running it on the CLI would still produce a lesson. It would produce one
   * whose citations had never been verified, which is a quieter failure than an
   * error and a worse one. The PLAN half of a Studio turn has no tools and does
   * use the CLI, so the saving is real but partial.
   */
  tools: "the tool loop verifies each source passage between turns; a one-shot CLI call cannot",
});

/*
 * Is this failure the kind the OTHER route survives?
 *
 * The ordered modes and the CLI-to-CLI switch exist for exactly two situations:
 * a subscription that has run out of plan allowance, and an API key that has run
 * out of credit. Both report themselves clearly, and both are cured by switching
 * route. Anything else - a malformed prompt, a schema the model would not
 * satisfy, a bug - will fail the same way on the other route, so retrying it
 * there wastes a minute of the teacher's time and, in one direction, real money.
 */
function isRouteExhausted(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 429 || status === 402) return true;
  /* stdout as well as stderr: a CLI states its limit on whichever stream it
   * prefers, and reading only one of them turns a spent subscription into an
   * unexplained failure. */
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.stderr || ""} ${error?.stdout || ""}`.toLowerCase();
  return (
    /rate.?limit|too many requests/.test(text) ||
    /quota|credit balance|insufficient.?(credit|quota|funds)|billing/.test(text) ||
    /usage limit|plan limit|limit reached|upgrade your plan/.test(text) ||
    /cli_unavailable|cli_provider_unavailable|not logged in|unauthorized|authentication/.test(text)
  );
}

/*
 * Did this route fail at BEING a route, rather than at the request?
 *
 * This is the distinction that "ordinary error, do not retry" was missing, and
 * it is why the platform got less reliable when it moved to the CLI.
 *
 * The old rule said: a malformed prompt or an unsatisfiable schema will fail the
 * same way everywhere, so retrying elsewhere wastes a teacher's minute and real
 * money. True — but it quietly assumed every route is equally CAPABLE, and that
 * is exactly what is not true here. The API can REQUIRE a schema; a CLI turn
 * cannot. So a CLI that answers a perfectly good request in prose, or returns
 * nothing, or times out, has not discovered anything about the request at all.
 * It has told us about itself. Production says this is not rare: five prose
 * answers in three hours, and a teacher shown "AI emalı alınmadı" for a paper
 * the API would have extracted without complaint.
 *
 * These failures therefore move to the next route, without standing the
 * subscription down — the plan is fine, the turn just did not work.
 */
function isRouteDefect(error) {
  const code = String(error?.code || "");
  if (code === "cli_cancelled") return false; // nobody is waiting for it any more
  return [
    "cli_invalid_json",   // answered in prose, or with JSON we cannot read
    "cli_empty_output",   // answered with nothing at all
    "cli_failed",         // exited non-zero for a reason that is not a limit
    "cli_timeout",        // took longer than a turn is allowed to take
    "cli_output_too_large",
    /*
     * A process that would not start is a defect too, NOT a spent plan. It used
     * to count as exhaustion, which meant an oversized prompt (E2BIG) or a
     * missing binary stood a perfectly healthy subscription down for ten
     * minutes and pushed every teacher onto the paid route — punishing the plan
     * for something the plan had nothing to do with.
     */
    "cli_spawn_failed",
  ].includes(code);
}

/* Either reason to move on: the route is unavailable, or it is not up to it. */
function shouldTryNextRoute(error) {
  return isRouteExhausted(error) || isRouteDefect(error);
}

/* A failure the caller should see rather than have retried. */
function fatal(error, code, attempts) {
  const e = error instanceof Error ? error : new Error(String(error || code));
  if (code && !e.code) e.code = code;
  if (attempts && attempts.length > 1) e.aiAttempts = attempts.slice();
  return e;
}

/*
 * The exact sequence of attempts for the mode that is set, with each `cli` in
 * the mode's order expanded into the CLIs that are actually up.
 *
 * A CLI that is resting is skipped rather than attempted, which is the whole
 * point: once Codex has said "try again on Oct 3rd" there is nothing to learn
 * from spawning it again, and a spawn-and-refuse is a minute of a teacher's
 * waiting.
 *
 * The exception is the last resort. If every CLI is resting and the mode has no
 * API route to fall through to, the one nearest its reset is attempted anyway. A
 * cooldown is a memory - read out of text a binary printed - and refusing to do
 * any work at all on the strength of a memory would be worse than one wasted
 * process. Only that one, though: the others have nothing new to say either, and
 * a request should not be made to wait for all of them to repeat themselves.
 */
async function planSteps(mode, preferCli, label) {
  const routes = aiExecution.orderFor(mode);
  const hasApi = routes.includes("api");
  const steps = [];
  for (const route of routes) {
    if (route !== "cli") {
      steps.push({ route: "api" });
      continue;
    }
    const { ready, resting } = await cliHealth.plan({ prefer: preferCli });
    const providers = ready.length ? ready : hasApi ? [] : resting.slice(0, 1);
    if (!ready.length) {
      console.warn(
        `[AI] ${label}: every CLI is resting (${resting.join(", ") || "none configured"}) - ${
          hasApi
            ? "going straight to the API"
            : `no API route in this mode, so trying ${resting[0] || "nothing"} anyway`
        }`
      );
    }
    for (const provider of providers) steps.push({ route: "cli", provider });
  }
  /* A mode whose only route was CLI, with no CLI configured at all. The API
   * bills, but a platform that answers is better than one that does not. */
  if (!steps.length) steps.push({ route: "api" });
  return steps;
}

async function runAi({ capability = "structured", api, cli, label = "ai", preferCli } = {}) {
  if (typeof api !== "function") throw new Error("runAi: an api route is required");

  const unsupported = CLI_UNSUPPORTED[capability];
  const { mode } = await aiExecution.getAiExecution().catch(() => ({ mode: "api" }));

  /*
   * Work the CLI cannot do runs on the API whatever the mode says. This is not
   * a silent fallback - there is no CLI implementation to prefer - and it is
   * declared above rather than discovered here.
   */
  if (unsupported || typeof cli !== "function") {
    return api();
  }

  const steps = await planSteps(mode, preferCli, label);
  const attempts = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const isLast = i === steps.length - 1;
    const name = step.route === "cli" ? `cli:${step.provider}` : "api";
    try {
      const value = step.route === "cli" ? await cli(step.provider) : await api();
      /* It worked, so anything remembered about this CLI being down is stale.
       * Clearing it here is what lets a reset subscription be used again within
       * the same minute instead of at the end of a guessed cooldown. */
      if (step.route === "cli") await cliHealth.markRecovered(step.provider).catch(() => {});
      return value;
    } catch (error) {
      const why = error?.code || error?.status || error?.message;
      attempts.push(`${name}: ${why}`);
      const exhausted = isRouteExhausted(error);
      /*
       * Only an EXHAUSTED route is stood down. A route that merely failed at
       * this turn is still perfectly usable for the next one — standing it down
       * for half an hour over one unparseable answer would push every teacher
       * onto the paid route for a fault that lasted one request.
       */
      if (step.route === "cli" && exhausted) {
        await cliHealth.markExhausted(step.provider, error).catch(() => {});
      }
      const carryOn = shouldTryNextRoute(error);
      if (isLast || !carryOn) {
        if (attempts.length > 1) console.warn(`[AI] ${label}: all routes failed - ${attempts.join(" | ")}`);
        const failure = fatal(error, `${name.replace(":", "_")}_failed`, attempts);
        /*
         * "Try again later" is not something a teacher can act on, and in
         * CLI-only mode there IS no later route - the platform is simply out of
         * plan until a stated hour. The binaries name that hour in their
         * refusal, so say it: a teacher who knows the subscription returns at
         * nine tonight can plan around it, where one told "AI could not create
         * questions" can only keep pressing the button.
         */
        if (step.route === "cli" && exhausted && !failure.userMessage) {
          const back = await cliHealth.soonestReturn().catch(() => null);
          const when = back ? cliHealth.azWhen(back) : "";
          failure.userMessage = when
            ? `AI paketinin limiti bitib. Təxminən ${when} radələrində yenidən cəhd edin.`
            : "AI paketinin limiti bitib. Bir az sonra yenidən cəhd edin.";
          failure.aiStatus = 503;
          failure.resetAt = back || null;
        }
        throw failure;
      }
      const next = steps[i + 1];
      /*
       * The REASON, not just the code. "cli_failed" in a log is a fact nobody
       * can act on; the process almost always said something, and the next
       * intermittent failure should explain itself here rather than needing another
       * afternoon of reproducing it by hand.
       */
      const detail = String(error?.stderr || error?.sample || error?.stdout || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(-300);
      console.warn(
        `[AI] ${label}: ${name} ${exhausted ? "is exhausted" : "could not do it"} (${why}); continuing on ${
          next.route === "cli" ? `cli:${next.provider}` : "api"
        }${detail ? ` — ${detail}` : ""}`
      );
    }
  }
  throw fatal(new Error("ai_unavailable"), "ai_unavailable", attempts);
}

module.exports = { runAi, isRouteExhausted, isRouteDefect, shouldTryNextRoute, planSteps, CLI_UNSUPPORTED };
