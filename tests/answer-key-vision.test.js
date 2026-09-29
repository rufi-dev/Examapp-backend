/* eslint-env node */
/*
 * The answer key must be able to SEE the paper, and must run on the engine that
 * read it.
 *
 * A teacher's ÇOXLUQLAR paper went out on 29 September with question 9 marked
 * wrong and five questions unmarked. The usage log says why: the extraction ran
 * on sonnet through the CLI, and then the whole-paper answer pass at 11:54 ran
 * on `gpt-4.1-mini` - a small, cheap text model set as the default for turning a
 * sentence into questions, and used here as its own reviewer too.
 *
 * But the model was only half of it. The solve pass was called without the
 * pages:
 *
 *     runGeneration({ prompt: payload, preset, model, signal, system })
 *
 * so it received the extracted TEXT alone. Question 9's text is "Diaqrama əsasən
 * A çoxluğunun elementlərinin sayını tapın" - the numbers 10, 7 and 2 exist only
 * in the bar chart. The model could not solve it. It could only pick one of five
 * options and sound certain, and it picked 6 where the chart gives
 * n(A) = 10 + 2 - 7 = 5. Question 4 is the same shape and the guess happened to
 * land: one in five, not skill.
 */
process.env.NODE_ENV = "test";

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

const fs = require("node:fs");
const path = require("node:path");
const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "aiController.js"), "utf8");
const ai = require("../controllers/aiController");
const { cliModel, tierModel } = require("../helper/cliAi");

function main() {
  console.log("the answer key can see the paper");

  console.log("\nthe pages reach the solver:");
  ok("verifyAndFix takes them", /async function verifyAndFix\(\{[^}]*parts[^}]*\}\)/s.test(src));
  ok("...and hands them to the generation call", /system: REVIEW_SYSTEM_PROMPT,\s*(\/\/[^\n]*\n\s*)*parts,/s.test(src));
  ok("applyAnswerMode takes them", /async function applyAnswerMode\(\{[^}]*parts[^}]*\}\)/s.test(src));
  ok("runGeneration takes them", /async function runGeneration\(\{[^}]*parts[^}]*\}\)/s.test(src));
  ok("...and the CLI turn carries them", /schema: EXTRACTION_SCHEMA,\s*(\/\/[^\n]*\n\s*)*parts: Array\.isArray\(parts\)/s.test(src));
  ok("...and so does the API chain", /runGenerationOnApi\(\{[^}]*parts[^}]*\}\)/s.test(src));

  console.log("\nevery API engine attaches them, not just one:");
  /* A CLI outage must not quietly put the key back to guessing. */
  ok("Claude gets the document", /claudeContentParts\(Array\.isArray\(parts\)/.test(src));
  ok("Gemini gets the document", /geminiContentParts\(Array\.isArray\(parts\)/.test(src));
  ok("OpenAI gets the images", /type: "image_url"/.test(src));

  console.log("\nthe engine that READ the paper also answers it:");
  ok("the answer pass no longer uses the cheap generation model",
    !/model: PLATFORM_MODEL,\s*(\/\/[^\n]*\n\s*)*parts,/s.test(src));
  /*
   * EVERY call site, not a count of them. The count broke the moment the
   * "Cavabları tap" endpoint added a third, which is the wrong reason for a test
   * to fail: the rule is "no answer key is decided on the cheap model", and it
   * should hold however many places decide one.
   */
  /* Split rather than match: a call spans several lines with varying indentation,
   * and the 600 characters after each opening covers every one of them. */
  /* `await` so the function's own DEFINITION is not counted as a call site of
   * itself - it has a `model` parameter and would have passed for the wrong
   * reason. Split rather than match, because a call spans several lines at
   * varying indentation and 600 characters covers all of them. */
  const answerCalls = src.split("await applyAnswerMode({").slice(1).map((c) => c.slice(0, 600));
  ok("there are answer-key call sites to check", answerCalls.length >= 3, String(answerCalls.length));
  ok("...and every one of them uses the solve model",
    answerCalls.every((c) => /model: PLATFORM_SOLVE_MODEL/.test(c)),
    answerCalls.filter((c) => !/model: PLATFORM_SOLVE_MODEL/.test(c)).join(" | ").slice(0, 200));
  ok("...and none of them uses the cheap one",
    answerCalls.every((c) => !/model: PLATFORM_MODEL/.test(c)));
  ok("which is not gpt-4.1-mini", ai.PLATFORM_SOLVE_MODEL !== "gpt-4.1-mini", ai.PLATFORM_SOLVE_MODEL);

  console.log("\nand on the CLI it is the SAME model the extraction ran on:");
  /*
   * The owner's requirement, stated plainly: if the CLI is the chosen route, the
   * answers come from the CLI's model too - not a cheaper one, and not a
   * different one from the pass that read the page.
   */
  const extractionModel = tierModel("claude", "standard");
  ok("extraction resolves to a model", !!extractionModel, extractionModel);
  ok("the solve pass resolves to the same one",
    cliModel("claude", ai.PLATFORM_SOLVE_MODEL) === cliModel("claude", ""),
    `${cliModel("claude", ai.PLATFORM_SOLVE_MODEL)} vs ${cliModel("claude", "")}`);
  ok("...and it is the standard tier, not the light one",
    cliModel("claude", ai.PLATFORM_SOLVE_MODEL) === extractionModel);

  console.log("\nwhen the solver had NO pages, a figure question is left blank:");
  /*
   * The backstop. A blank costs the teacher a minute; a confident wrong key
   * costs their students the marks, and nobody re-checks a key that looks
   * finished.
   */
  const paper = [
    { type: "Cm", text: "Diaqrama əsasən n(A)?", hasFigure: true, correct: [4], choices: [1, 2, 3, 4, 5] },
    { type: "Cm", text: "n(A)=20, n(B)=14, n(A∪B)=24", hasFigure: false, correct: [3], choices: [1, 2, 3, 4, 5] },
    { type: "Cm", text: "answered on the sheet already", hasFigure: true, correct: [1], choices: [1, 2] },
  ];
  const wasUnanswered = new Set([0, 1]); // the third came WITH its answer

  const blind = ai.unguessFigures(paper, wasUnanswered, false);
  ok("the guessed figure question is cleared", blind[0].correct.length === 0);
  ok("the one it could actually solve is kept", blind[1].correct.length === 1);
  /*
   * The distinction that makes this safe to ship: an answer printed ON the paper
   * is the teacher's, not the model's, and clearing it would be us destroying
   * data to protect against our own guess.
   */
  ok("an answer the PAPER supplied is never touched", blind[2].correct.length === 1);

  const seeing = ai.unguessFigures(paper, wasUnanswered, true);
  ok("and with the pages, nothing is cleared at all",
    seeing[0].correct.length === 1 && seeing[1].correct.length === 1);

  console.log("\nthe arithmetic the teacher was given, as a worked case:");
  /*
   * Question 9's chart: A∩B = 2, A∪B = 10, B = 7.
   *   n(A) = n(A∪B) + n(A∩B) - n(B) = 10 + 2 - 7 = 5   -> option A
   * The key that went out said 6.
   */
  ok("n(A) = 10 + 2 - 7 = 5, which was option A and not the 6 that shipped", 10 + 2 - 7 === 5);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
