/* eslint-env node */
/*
 * The failures that exit zero.
 *
 * Every earlier guard here assumed a route announces its own failure: a non-zero
 * exit, a refusal on stderr, a timeout. On 29 September a teacher uploaded a
 * paper full of questions and was told it had none, twice, four minutes apart -
 * and nothing in the logs was an error, because the CLI had exited 0 with a
 * perfectly well-formed `{"questions":[]}`.
 *
 * That is the shape this file exists for. A route can fail while looking exactly
 * like a route that succeeded, and the two ways it happens here are:
 *
 *   - it answers in the right shape with nothing in it, and
 *   - we hand it a file its Read tool will not open, so it truthfully reports
 *     that it saw no questions in a document it was never shown.
 *
 * Both must be defects: hand the work to the next engine, and do NOT stand the
 * subscription down, because neither says anything about the plan. Fifty minutes
 * after that teacher gave up, the same paper went through the API untouched.
 */
process.env.NODE_ENV = "test";

const fs = require("node:fs");
const path = require("node:path");

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

const { isRouteDefect, isRouteExhausted, shouldTryNextRoute } = require("../helper/aiRuntime");
const { CLI_READ_MAX_BYTES, runCliStructured, claudeTurns } = require("../helper/cliAi");

async function main() {
  console.log("the failures that exit zero");

  console.log("\nan empty answer is a defect, not an answer:");
  const empty = Object.assign(new Error("returned no questions"), { code: "cli_no_questions" });
  ok("the work moves to the next engine", shouldTryNextRoute(empty) === true);
  ok("...because it is a defect of the route", isRouteDefect(empty) === true);
  /*
   * The distinction that matters. Resting the subscription here would punish a
   * healthy plan for one unreadable file and push every teacher onto the paid
   * route - for a fault that lasted exactly one request.
   */
  ok("but the subscription is NOT stood down", isRouteExhausted(empty) === false);

  console.log("\na file the CLI cannot open is a defect too:");
  const big = Object.assign(new Error("attachment is 21MB"), { code: "cli_input_too_large" });
  ok("the work moves on", shouldTryNextRoute(big) === true);
  ok("...as a defect", isRouteDefect(big) === true);
  ok("and the plan is left alone", isRouteExhausted(big) === false);

  console.log("\nthe ceiling is real and we refuse BEFORE spawning:");
  ok("it is the CLI Read tool's 20MB, not a number we invented", CLI_READ_MAX_BYTES === 20 * 1024 * 1024);
  /*
   * Spawned with the file, the binary exits 0 and the model reports an empty
   * paper - the exact silent failure above. Refusing here turns it into a
   * hand-over the gateway can act on, and costs no process at all.
   */
  let refused = null;
  try {
    await runCliStructured({
      provider: "claude",
      prompt: "extract the questions",
      schema: { type: "object" },
      parts: [{ name: "huge.pdf", data: Buffer.alloc(CLI_READ_MAX_BYTES + 1024).toString("base64") }],
    });
  } catch (e) {
    refused = e;
  }
  ok("an oversized attachment is refused", refused?.code === "cli_input_too_large", refused?.code || "no error thrown");
  ok("...and the message says the size and the limit", /\d+MB.*\d+MB/s.test(String(refused?.message || "")), String(refused?.message || ""));

  console.log("\nand a file UNDER the ceiling is still allowed through:");
  /*
   * The guard must not become the new silent failure. It only ever refuses the
   * files the tool genuinely rejects; everything else still reaches the model,
   * so this asserts it fails for some LATER reason (no binary in CI), never for
   * being too large.
   */
  let small = null;
  try {
    await runCliStructured({
      provider: "claude",
      prompt: "extract the questions",
      schema: { type: "object" },
      parts: [{ name: "fine.pdf", data: Buffer.alloc(1024).toString("base64") }],
    });
  } catch (e) {
    small = e;
  }
  ok("a 1KB attachment is never refused for its size", small?.code !== "cli_input_too_large", small?.code || "ran");

  console.log("\nthe turn budget has headroom (this is what killed the route):");
  /*
   * Production, repeatedly: "Reached maximum number of turns (1)" having used 2,
   * and "(3)" having used 4. Asserting the exact minimum is what let that ship.
   */
  ok("a plain prompt gets more than the one turn it minimally needs", claudeTurns(0) >= 2, `got ${claudeTurns(0)}`);
  ok("an attachment gets more than a plain prompt", claudeTurns(1) > claudeTurns(0), `${claudeTurns(1)} vs ${claudeTurns(0)}`);
  ok("production's observed 4 turns for one file now fits", claudeTurns(1) >= 4, `got ${claudeTurns(1)}`);
  ok("and it is still bounded against a runaway", claudeTurns(99) <= 20, `got ${claudeTurns(99)}`);

  console.log("\nthe extractor hands over instead of reporting an empty paper:");
  const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "aiController.js"), "utf8");
  ok("the CLI branch throws on zero questions", /cli_no_questions/.test(src));
  ok("...and it checks the questions it actually got", /const got = out\.doc\?\.questions \|\| \[\];/.test(src));
  /*
   * The same rule on the paid side. One engine coming back empty says nothing
   * about the paper while other engines are still untried - and the last one's
   * empty answer is RETURNED, not thrown, because by then it is the honest one.
   */
  ok("an empty API answer tries the next engine", /if \(!found\(got\) && i < order\.length - 1\)/.test(src));
  ok("...and the last engine's empty answer is still reported, not thrown", /if \(lastEmpty\) return \{ result: lastEmpty/.test(src));

  console.log("\na document without ready questions BUILDS an exam instead of refusing:");
  /*
   * The product rule, not a bug fix. A teacher uploads the grammar page or the
   * topic summary and expects a test out of it; "bu sənəddə sual tapılmadı" was
   * us enforcing a shape they never agreed to.
   */
  const { EXTRACTION_SCHEMA } = require("../controllers/aiController");
  const kinds = String(src.match(/enum: \["questions", "material", "unreadable"\]/) || "");
  ok("the model must classify the document", !!kinds);
  ok("...copying a real paper is still a distinct mode", /- "questions" —/.test(src));
  ok("...and teaching material is authored FROM that content", /- "material" —/.test(src));
  ok("the Azerbaijani ask tells it to build when there are no questions", /materiala əsasən imtahan suallarını ÖZÜN qur/.test(src));

  console.log("\nbut it must never invent a paper it could not read:");
  /*
   * The dangerous half. A model that cannot see the page and decides to be
   * helpful hands back twenty fabricated questions where the teacher's own test
   * should have been - and nothing about that looks like an error.
   */
  ok("unreadable is its own answer", /- "unreadable" —/.test(src));
  ok("...and the prompt forbids guessing the topic instead", /must NOT fall back to writing questions about what you guess/.test(src));
  ok("...the CLI turns it into a hand-over", /cli_unreadable_document/.test(src));
  ok("...which the gateway treats as a defect", isRouteDefect({ code: "cli_unreadable_document" }) === true);
  ok("...and the plan is not stood down for it", isRouteExhausted({ code: "cli_unreadable_document" }) === false);
  ok("the teacher is told the file did not open, not that it was empty", /Sənəd oxunmadı\./.test(src));

  console.log("\na scan is not an excuse:");
  ok("image-only pages are still 'questions', to be read out of the picture",
    /A page whose questions are PICTURES/.test(src));

  console.log("\nthe generate-from-a-prompt schema is left alone:");
  /*
   * It shares the question shape but not the classification: asking a model that
   * was handed no document to say what kind of document it got is a question
   * with no honest answer, and OpenAI's strict mode would demand one.
   */
  ok("EXTRACTION_SCHEMA still requires only questions",
    JSON.stringify(EXTRACTION_SCHEMA.required) === '["questions"]');
  ok("...and carries no documentKind", !("documentKind" in EXTRACTION_SCHEMA.properties));
  ok("...while the document schema does", /const DOCUMENT_SCHEMA = \{/.test(src));

  console.log("\na composer draft no longer casts \"new\" to an ObjectId:");
  /*
   * Harmless in effect and constant in the log - every generation from the
   * composer printed a CastError - but it also meant the prompt behind a brand
   * new exam was never recorded at all.
   */
  ok("the id is validated before the update", /isValidObjectId\(req\.params\.examId\)/.test(src));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
