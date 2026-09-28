/*
 * The four modes, and the one question that decides whether a fallback happens.
 *
 * Two of the modes exist only for failure: `cli_then_api` for the night the
 * subscription hits its plan limit, `api_then_cli` for the morning the card
 * declines. Everything rests on telling those failures apart from ordinary ones,
 * because retrying an ordinary failure on the other route wastes a minute of a
 * teacher's time and, in one direction, spends real money on a request that was
 * always going to fail.
 */
process.env.NODE_ENV = "test";
/*
 * This file is about the MODES - which KINDS of route are attempted, in what
 * order, and on which failures. The CLI route is really as many routes as there
 * are subscriptions, and the switching between them is tested in
 * ai-cli-failover, which owns it. Pinning one CLI here keeps these assertions
 * about the thing they are about.
 */
process.env.AI_CLI_ORDER = "claude";

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log("  ✓", label);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", label, extra ? `- ${extra}` : "");
  }
};

const { MODES, MODE_IDS, normalize, orderFor } = require("../config/aiExecution");
const { isRouteExhausted, CLI_UNSUPPORTED } = require("../helper/aiRuntime");

/* runAi reads the stored mode, so the test controls it by stubbing that read. */
const aiExecution = require("../config/aiExecution");
let CURRENT = "api";
aiExecution.getAiExecution = async () => ({ mode: CURRENT });
const { runAi } = require("../helper/aiRuntime");

const cliHealth = require("../helper/cliHealth");

const call = async (mode, { cliFails, apiFails, noCli } = {}) => {
  CURRENT = mode;
  /* A CLI that hit a limit is remembered until its reset time, so each case
   * starts from a platform that knows nothing - otherwise case two would be
   * answering for case one. */
  cliHealth._reset();
  const ran = [];
  const boom = (why) => {
    const e = new Error(why);
    if (why === "limit") e.status = 429;
    return e;
  };
  try {
    const got = await runAi({
      capability: noCli ? "audio" : "structured",
      cli: noCli
        ? undefined
        : async () => {
            ran.push("cli");
            if (cliFails) throw boom(cliFails);
            return "cli-result";
          },
      api: async () => {
        ran.push("api");
        if (apiFails) throw boom(apiFails);
        return "api-result";
      },
    });
    return { ran, got, error: null };
  } catch (e) {
    return { ran, got: null, error: e };
  }
};

async function main() {
  console.log("the AI runtime modes");

  console.log("\nthe modes on offer:");
  ok("there are exactly four", MODE_IDS.length === 4, MODE_IDS.join(", "));
  for (const id of MODE_IDS) console.log(`    ${id.padEnd(13)} ${MODES[id].label}`);
  ok("each one is labelled for the admin page", MODE_IDS.every((id) => MODES[id].label && MODES[id].describe));

  console.log("\nwhen nothing fails:");
  ok("api uses the API", (await call("api")).ran.join() === "api");
  ok("cli uses the CLI", (await call("cli")).ran.join() === "cli");
  ok("cli_then_api uses the CLI first", (await call("cli_then_api")).ran.join() === "cli");
  ok("api_then_cli uses the API first", (await call("api_then_cli")).ran.join() === "api");

  console.log("\nwhen the first route is EXHAUSTED (plan limit / credit):");
  const a = await call("cli_then_api", { cliFails: "limit" });
  ok("cli_then_api finishes the request on the API", a.ran.join() === "cli,api" && a.got === "api-result");
  const b = await call("api_then_cli", { apiFails: "credit balance is too low" });
  ok("api_then_cli finishes the request on the CLI", b.ran.join() === "api,cli" && b.got === "cli-result");

  console.log("\nwhen the first route fails for an ORDINARY reason:");
  /*
   * A bad prompt, or a schema the model will not satisfy, fails the same way on
   * the other route. Retrying it there is a minute of the teacher's time for
   * nothing - and on api_then_cli it would have been a minute of paid tokens.
   *
   * Note what this case is NOT: a CLI that answers in prose looks like an
   * ordinary failure and is not one. That is a fault of the ROUTE, not of the
   * request — the API would have answered it — so it hands over instead, which
   * ai-cli-failover covers. This case is a request no route can satisfy.
   */
  const c = await call("cli_then_api", { cliFails: "schema validation failed" });
  ok("it is NOT retried on the other route", c.ran.join() === "cli");
  ok("and the teacher gets the error", !!c.error);

  console.log("\nthe single-route modes never wander:");
  const d = await call("cli", { cliFails: "limit" });
  ok("cli fails closed - it does not reach for the API", d.ran.join() === "cli" && !!d.error);
  const e = await call("api", { apiFails: "limit" });
  ok("api fails closed - it does not reach for the CLI", e.ran.join() === "api" && !!e.error);

  console.log("\nwork the CLI cannot do:");
  const f = await call("cli", { noCli: true });
  ok("runs on the API even in CLI-only mode", f.ran.join() === "api" && f.got === "api-result");
  ok("...and every such case says why", Object.values(CLI_UNSUPPORTED).every((s) => s.length > 20));

  console.log("\ntelling the two kinds of failure apart:");
  for (const [why, expected] of [
    ["rate limit exceeded", true],
    ["Credit balance is too low", true],
    ["usage limit reached", true],
    ["not logged in", true],
    /*
     * A process that would not start is NOT a spent plan. It used to count as
     * exhaustion, so an oversized prompt (E2BIG) or a missing binary stood a
     * healthy subscription down for ten minutes and pushed every teacher onto
     * the paid route — punishing the plan for something it had no part in. It
     * is a route DEFECT: the work still moves on, the plan is left alone.
     */
    ["cli_spawn_failed", false],
    ["cli_invalid_json", false],
    ["schema validation failed", false],
    ["prompt too long", false],
  ]) {
    ok(`${expected ? "switch " : "report "} ${why}`, isRouteExhausted(new Error(why)) === expected);
  }
  ok("a 429 is a switch", isRouteExhausted({ status: 429 }) === true);
  ok("a 402 is a switch", isRouteExhausted({ status: 402 }) === true);
  ok("a 400 is not", isRouteExhausted({ status: 400, message: "bad request" }) === false);

  console.log("\nan owner's saved choice survives:");
  ok("the old shape upgrades to the ordered mode", normalize({ mode: "cli", fallbackToApi: true }).mode === "cli_then_api");
  ok("...and plain cli stays cli", normalize({ mode: "cli" }).mode === "cli");
  ok("anything unrecognised is api", normalize({ mode: "nonsense" }).mode === "api" && normalize(null).mode === "api");
  ok("order is defined for every mode", MODE_IDS.every((id) => orderFor(id).length >= 1));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
