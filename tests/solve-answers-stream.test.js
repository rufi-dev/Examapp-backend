/* eslint-env node */
/*
 * "Cavabları tap" shows which question it is reading. That status has to be TRUE.
 *
 * The first version sent the whole paper to the model in one turn, and the CLI
 * cannot stream - so there was no real "now checking question 7" to show, and
 * the only way to draw one would have been a highlight marching down the list on
 * a timer. A progress effect that is not tied to progress is a lie told in
 * animation, and a teacher who learns the shimmer means nothing stops trusting
 * all of it.
 *
 * So the server solves in real batches and says so as each one starts and as
 * each answer lands. These tests hold the parts that make that honest.
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
const ai = require("../controllers/aiController");
const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "aiController.js"), "utf8");
const figSrc = fs.readFileSync(path.join(__dirname, "..", "helper", "questionFigures.js"), "utf8");

function main() {
  console.log("solving a paper in batches the teacher can watch");

  console.log("\nthe batches are real turns:");
  const idx = (n) => Array.from({ length: n }, (_, i) => i);
  ok("21 questions -> 4 turns of at most 6", JSON.stringify(ai.planSolveBatches(idx(21)).map((b) => b.length)) === "[6,6,6,3]");
  /* The status is only worth extra turns when there is a wait long enough to
   * need it — a short paper is not made slower for the sake of an animation. */
  ok("a short paper stays ONE turn", ai.planSolveBatches(idx(5)).length === 1);
  ok("...up to the threshold", ai.planSolveBatches(idx(8)).length === 1);
  ok("every question is solved exactly once",
    ai.planSolveBatches(idx(21)).flat().join() === idx(21).join());
  ok("nothing to solve is no turns at all", ai.planSolveBatches([]).length === 0);

  console.log("\na batch carries the passage its questions are about:");
  /*
   * A comprehension question batched without the text it asks about is
   * unanswerable, and a model handed one answers it anyway.
   */
  const paper = [
    { type: "Cm", text: "q0" },
    { type: "reading", text: "PASSAGE A" },
    { type: "Cm", text: "q2 about A" },
    { type: "Cm", text: "q3 about A" },
    { type: "reading", text: "PASSAGE B" },
    { type: "Cm", text: "q5 about B" },
  ];
  const { origin, sub } = ai.batchSubPaper(paper, [2, 5]);
  ok("both passages come along", origin.includes(1) && origin.includes(4), JSON.stringify(origin));
  ok("...in the paper's own order", JSON.stringify(origin) === "[1,2,4,5]");
  ok("...and a question before any passage brings none", JSON.stringify(ai.batchSubPaper(paper, [0]).origin) === "[0]");
  ok("the sub-paper is the same objects, not copies that could drift", sub[0] === paper[1]);

  console.log("\nthe stream says what is happening, as structure:");
  ok("a plan up front, from the one place that decides it", /sse\("plan", \{ targets, batches \}\)/.test(src));
  ok("each batch announces itself", /sse\("batch", \{ batch: b \+ 1, batches: batches\.length, indexes: batch/.test(src));
  ok("each answer arrives on its own", /sse\("answer", \{ index: orig, question: q, found \}\)/.test(src));
  ok("a failed batch is reported and the rest carry on", /sse\("batchError"/.test(src) && /continue;/.test(src));
  /*
   * Indexes, not sentences. The builder numbers questions its own way — passages
   * are not counted — so it composes the words and the number on the status is
   * always the number on the card.
   */
  ok("no Azerbaijani question numbers are composed server-side", !/sse\("answer",[^)]*Sual/.test(src));

  console.log("\nonly a batch's own pictures go with it:");
  ok("each fetched picture knows its question", /forQuestion: n,/.test(figSrc));
  ok("and the batch filters to its own", /figures\.filter\(\(f\) => own\.has\(f\.forQuestion\)\)/.test(src));

  console.log("\nit is billed — and only when it produced something:");
  /*
   * The first version of this endpoint never called usable(), so the credit
   * reservation never committed and "Cavabları tap" was quietly free.
   */
  ok("the reservation commits on a usable result", /req\.aiCredit\.usable\(\);/.test(src.slice(src.indexOf("const solveAnswers"))));
  ok("...only once a question was actually answered", /if \(solved > 0 && !charged && req\.aiCredit\)/.test(src));

  console.log("\na dropped connection is never shown as a finished paper:");
  const fe = fs.readFileSync(path.join(__dirname, "..", "..", "Frontend", "src", "pages", "admin", "StructuredBuilder.jsx"), "utf8");
  ok("the builder notices a stream that ended without `done`", /if \(!finished\) \{/.test(fe));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
