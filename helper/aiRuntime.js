/*
 * Required as a module rather than destructured so the setting is read through
 * it at call time. Destructuring binds the function at import, which also made
 * the policy untestable without a database.
 */
const aiExecution = require("../config/aiExecution");

/*
 * The ONE place that decides whether a piece of AI work runs on the API or on
 * the server's CLI.
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
 *     capability: "structured",        // what the work needs
 *     api: () => callTheProvider(),    // always required
 *     cli: () => runTheCli(),          // omitted when the CLI cannot do it
 *   })
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
 * The ordered modes exist for exactly two situations: a subscription that has
 * run out of plan allowance, and an API key that has run out of credit. Both
 * report themselves clearly, and both are cured by switching route. Anything
 * else - a malformed prompt, a schema the model would not satisfy, a bug - will
 * fail the same way on the other route, so retrying it there wastes a minute of
 * the teacher's time and, in one direction, real money.
 */
function isRouteExhausted(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 429 || status === 402) return true;
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.stderr || ""}`.toLowerCase();
  return (
    /rate.?limit|too many requests/.test(text) ||
    /quota|credit balance|insufficient.?(credit|quota|funds)|billing/.test(text) ||
    /usage limit|plan limit|limit reached|upgrade your plan/.test(text) ||
    /cli_unavailable|cli_spawn_failed|cli_provider_unavailable|not logged in|unauthorized|authentication/.test(text)
  );
}

/* A failure the caller should see rather than have retried. */
function fatal(error, code) {
  const e = error instanceof Error ? error : new Error(String(error || code));
  if (code && !e.code) e.code = code;
  return e;
}

async function runAi({ capability = "structured", api, cli, label = "ai" } = {}) {
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

  const routes = aiExecution.orderFor(mode);
  const run = { api, cli };
  let firstError = null;

  for (let i = 0; i < routes.length; i += 1) {
    const route = routes[i];
    const isLast = i === routes.length - 1;
    try {
      return await run[route]();
    } catch (error) {
      if (!firstError) firstError = error;
      if (isLast) throw fatal(firstError, `${route}_failed`);
      if (!isRouteExhausted(error)) throw fatal(error, `${route}_failed`);
      console.warn(
        `[AI] ${label}: ${route} is exhausted (${error?.code || error?.status || error?.message}); continuing on ${routes[i + 1]}`
      );
    }
  }
  throw fatal(firstError, "ai_unavailable");
}

module.exports = { runAi, isRouteExhausted, CLI_UNSUPPORTED };
