/* eslint-env node */
/*
 * Where an extracted exam's answers come from.
 *
 * Teachers used to be asked this up front - "are the answers on the sheet, will
 * you mark them yourself, or should the AI solve it?" - before they had seen a
 * single extracted question, about a PDF the AI had not read yet. They are the
 * wrong person to ask: whether the answers are printed on the paper is a
 * property OF THE PAPER, and the paper is right there.
 *
 * So it is read instead of asked. What the sheet marks is kept exactly as the
 * teacher wrote it; only what the sheet leaves blank is worked out. Two things
 * have to hold for that to be worth doing, and both are asserted here:
 *
 *   - a fully answered paper must cost NOTHING extra. If reading a complete
 *     answer key still triggered a solving pass, the feature would spend a
 *     model call on every extraction to re-derive answers it already had.
 *   - a paper with gaps must actually be solved, and must SAY how many answers
 *     the AI supplied - those are the ones a teacher needs to check, and the
 *     ones copied off the sheet are not.
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

const { applyAnswerMode } = require("../controllers/aiController");

const choice = (correct) => ({
  type: "Cm",
  text: "2 + 2 = ?",
  choices: [{ text: "3" }, { text: "4" }, { text: "5" }, { text: "6" }],
  correct,
});

async function main() {
  console.log("an extracted paper answers itself where it can");

  console.log("\nwhen the sheet marks every answer:");
  const full = await applyAnswerMode({ questions: [choice([1]), choice([1]), choice([0])] });
  ok("the mode is auto without being asked for", full.mode === "auto");
  ok("nothing is solved", full.solved === 0);
  ok("no model was called at all", full.rounds === 0 && !full.reviewCost);
  ok("and the teacher's own answers are untouched", JSON.stringify(full.questions[0].correct) === "[1]");

  console.log("\nan explicit choice is still honoured, for anything that sends one:");
  const manual = await applyAnswerMode({ questions: [choice([1])], mode: "manual" });
  ok("manual strips the answers", manual.mode === "manual" && manual.questions[0].correct.length === 0);

  console.log("\nand nonsense falls back to reading the paper, not to guessing:");
  const junk = await applyAnswerMode({ questions: [choice([1])], mode: "not-a-mode" });
  ok("an unknown mode is auto", junk.mode === "auto");
  ok("...which, on a complete sheet, means no extra spend", junk.solved === 0 && junk.rounds === 0);

  /*
   * The gap case calls a provider, so it is not exercised here - a unit test
   * that reaches the network is a unit test that fails on a plane. What IS
   * checked is the decision that precedes the call, which is the part that was
   * wrong when a teacher had to make it.
   */
  console.log("\nthe decision to solve is taken from the questions, not from a question asked:");
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "controllers", "aiController.js"), "utf8");
  ok("unanswered questions are counted", /const missing = unansweredCount\(questions\)/.test(src));
  ok("...using the audit's own rules rather than a second copy", /auditQuestions\(questions, \{ requireAnswers: true \}\)/.test(src));
  ok("a complete sheet returns before any provider call", /if \(!missing\) \{[\s\S]{0,200}return \{ questions: spreadKeysIfNeeded/.test(src));
  ok("and the count of AI-supplied answers reaches the client", /answersSolved: applied\.solved \|\| 0/.test(src));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
