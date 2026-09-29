/* eslint-env node */
/*
 * What a question is worth when the teacher did not say.
 *
 * A teacher wrote in asking how to make "yazılı" and "test" carry the same
 * marks. The honest answer was that they could not: with no preset the app did
 * not score by type at all, it scored by POSITION - the first 18 questions
 * shared 55 points and everything after shared 45 - so two identical questions
 * were worth different amounts depending on where they sat.
 *
 * Her paper was 21 questions: eighteen at 3.06 and three at 15. Three questions
 * carried 45% of the grade, and nothing on screen explained why. She pressed the
 * "Hamısına eyni bal ver" button on both rows and still got 4.55 against 5.44,
 * because that action averages one type against itself.
 *
 * The ladder is a real format - it is the DİM Buraxılış shape, where the closing
 * tasks genuinely are worth more - so it stays, on the presets that ask for it.
 * It is just not what "I am building my own exam" means.
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

const { questionPoints, ladderPoints, computePointsPlan } = require("../helper/scoring");
const { PRESETS } = require("../helper/examPresets");

const round = (n) => Math.round(n * 100) / 100;
const spread = (plan) => [...new Set(plan.map(round))].sort((a, b) => a - b);
const sum = (plan) => round(plan.reduce((a, b) => a + b, 0));
const qs = (n, types) => Array.from({ length: n }, (_, i) => ({ type: types ? types[i % types.length] : "Cm" }));

function main() {
  console.log("what a question is worth by default");

  console.log("\nno preset: every question is worth the same:");
  for (const n of [1, 5, 18, 20, 21, 35, 41, 62]) {
    const plan = questionPoints(n);
    ok(`${String(n).padStart(2)} questions -> one value (${spread(plan).join("/")})`, spread(plan).length === 1);
  }

  console.log("\n...and the paper still adds up to 100:");
  for (const n of [3, 7, 20, 21, 41, 62]) {
    ok(`${String(n).padStart(2)} questions total 100`, sum(questionPoints(n)) === 100, String(sum(questionPoints(n))));
  }

  console.log("\nthe teacher's actual paper — 21 questions, 16 test + 5 written:");
  const hers = computePointsPlan(qs(21, ["Cm", "Cm", "Cm", "Co"]), { preset: "custom" });
  ok("every question is worth 4.76", spread(hers).length === 1 && spread(hers)[0] === 4.76, spread(hers).join("/"));
  ok("a written answer is worth exactly what a test question is",
    round(hers[3]) === round(hers[0]));
  /*
   * The regression, stated as the thing it was: not "the numbers changed" but
   * "three questions used to carry nearly half the paper".
   */
  const before = ladderPoints(21);
  ok("...where before it was 3.06 against 15", spread(before).join("/") === "3.06/15", spread(before).join("/"));
  ok("...i.e. 3 of 21 questions used to carry 45 of the 100 marks",
    round(before[18] + before[19] + before[20]) === 45);

  console.log("\nthe worst size, which nobody would have chosen on purpose:");
  const twenty = ladderPoints(20);
  ok("20 questions used to end 3.06 / 22.5", spread(twenty).join("/") === "3.06/22.5", spread(twenty).join("/"));
  ok("...one question worth more than seven others", twenty[19] > twenty[0] * 7);
  ok("now it is a flat 5", spread(questionPoints(20)).join("/") === "5");

  console.log("\nthe ladder is kept where a real exam format asks for it:");
  const bur = computePointsPlan(qs(25), { preset: "buraxilis" });
  ok("buraxilis still scores by position", spread(bur).length > 1, spread(bur).join("/"));
  /*
   * Within a hundredth of 55/45, not exactly: the per-question value is rounded
   * to 2dp before the first block absorbs the remainder, so 25 questions land on
   * 54.99/45.01. Asserting the round number would be asserting a paper that does
   * not exist.
   */
  const head = round(bur.slice(0, 18).reduce((a, b) => a + b, 0));
  const tail = round(bur.slice(18).reduce((a, b) => a + b, 0));
  ok("...with the first 18 sharing ~55", Math.abs(head - 55) <= 0.05, `got ${head}`);
  ok("...and the rest sharing ~45", Math.abs(tail - 45) <= 0.05, `got ${tail}`);
  ok("...and the two halves still make the whole 100", round(head + tail) === 100);
  /*
   * It used to get this by inheriting the no-preset fallback. A preset that
   * depends on someone else's default is a preset that changes when that default
   * does - which is exactly what just happened.
   */
  ok("and it says so itself rather than inheriting it", typeof PRESETS.buraxilis.pointsPlan === "function");

  console.log("\nevery other preset is untouched:");
  for (const id of Object.keys(PRESETS)) {
    if (id === "custom") continue;
    const plan = computePointsPlan(qs(20), { preset: id });
    ok(`${id.padEnd(16)} totals ${sum(plan)}`, plan.length === 20 && sum(plan) > 0);
  }

  console.log("\na teacher's own per-type figures still win over everything:");
  const forced = computePointsPlan(qs(6, ["Cm", "Co"]), { preset: "custom", typePoints: { Co: 10 } });
  ok("the overridden type takes the given value", round(forced[1]) === 10);
  ok("...and the others keep the default", round(forced[0]) === round(100 / 6));

  console.log("\nreading passages are still not scored:");
  const withPassage = computePointsPlan([{ type: "reading" }, { type: "Cm" }, { type: "Cm" }], { preset: "custom" });
  ok("the passage is worth 0", withPassage[0] === 0);
  ok("...and the two questions split the whole 100", round(withPassage[1] + withPassage[2]) === 100);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
