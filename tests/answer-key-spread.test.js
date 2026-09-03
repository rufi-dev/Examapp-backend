/*
 * "Ardıcıl olaraq təkrarlanan düzgün cavablar olmamalıdır."
 *
 * The prompt asked for it and the model did not deliver: the live German paper came
 * back B A A B B A C D B C D, with runs at 2→3 and 4→5. A student who spots a run
 * stops reading and copies the letter, which is the whole reason for the rule.
 *
 * The dangerous way to fix this is to renumber the key. Rotating the OPTIONS and
 * the key together is safe — the same text stays correct — and these tests exist to
 * make sure it stays that way, because a bug here silently mis-marks a whole class.
 */
const assert = require("assert");
const { spreadAnswerKeys, keyLetters, isRotatable } = require("../helper/answerKeySpread");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

const mk = (k, opts) => ({ type: "Cm", text: "sual", choices: opts || ["a", "b", "c", "d"], correct: [k] });
const correctTexts = (list) =>
  list.filter((q) => Array.isArray(q.correct) && q.correct.length === 1).map((q) => q.choices[q.correct[0]]);
const hasRun = (letters) => letters.some((l, i) => i > 0 && l !== "—" && l === letters[i - 1]);

console.log("\n1. The real paper that failed:");
{
  const live = [1, 0, 0, 1, 1, 0, 2, 3, 1, 2, 3].map((k) => mk(k));
  ok("it starts with runs", hasRun(keyLetters(live)));

  const r = spreadAnswerKeys(live);
  ok("no consecutive repeat remains", !hasRun(keyLetters(r.items)), keyLetters(r.items).join(" "));
  ok("nothing was left unfixable", r.remaining === 0, r.remaining);
  ok("only the runs were touched", r.rotated === 2, r.rotated);
}

console.log("\n2. THE property: the same answer is still the answer:");
{
  // If this ever fails, every student is marked against the wrong option and
  // nothing in the interface looks broken.
  const live = [1, 0, 0, 1, 1, 0, 2, 3, 1, 2, 3].map((k) => mk(k, ["alfa", "beta", "qamma", "delta"]));
  const before = correctTexts(live);
  const after = correctTexts(spreadAnswerKeys(live).items);
  ok("the correct TEXT is unchanged for every question",
    JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));

  const r = spreadAnswerKeys(live);
  ok("every question keeps all four options", r.items.every((q) => q.choices.length === 4));
  ok("no option is lost or duplicated",
    r.items.every((q) => new Set(q.choices).size === 4));
  ok("the paper keeps its length", r.items.length === live.length);
  ok("the input is not mutated", keyLetters(live).join("") === "BAABBACDBCD");
}

console.log("\n3. What it refuses to touch:");
{
  // Options that reference each other positionally: rotating "yuxarıdakıların
  // hamısı" into the middle of the list makes the question nonsense.
  const pos = [mk(0), mk(0, ["a", "b", "c", "yuxarıdakıların hamısı"])];
  const r = spreadAnswerKeys(pos);
  ok("a positional option set is left alone", r.rotated === 0);
  ok("and the failure is reported, not hidden", r.remaining === 1, r.remaining);
  ok("'heç biri' is also protected", !isRotatable(mk(0, ["a", "b", "heç biri", "d"])));
  ok("'all of the above' is protected", !isRotatable(mk(0, ["a", "b", "c", "all of the above"])));

  ok("a multi-answer question is not rotatable",
    !isRotatable({ type: "Cs", choices: ["a", "b", "c", "d"], correct: [0, 2] }));
  ok("a question with no choices is not rotatable", !isRotatable({ type: "Co", correct: [0] }));
  ok("an out-of-range key is not rotatable", !isRotatable(mk(9)));
  ok("a reading block is not rotatable", !isRotatable({ type: "reading", text: "mətn" }));
}

console.log("\n4. Open tasks and readings break a run by themselves:");
{
  // An open question between two A's is not a run a student can exploit, so
  // rotating there would be churn for nothing.
  const list = [mk(0), { type: "Co", text: "açıq", answer: "x" }, mk(0)];
  const r = spreadAnswerKeys(list);
  ok("no rotation across an open task", r.rotated === 0, r.rotated);
  ok("and nothing is reported as unfixable", r.remaining === 0);

  // A reading PASSAGE is different from an open task: it carries no letter of its
  // own, but the two questions around it are still consecutive questions on the
  // paper, and the answer column still reads A A. So the run is broken.
  const withReading = [mk(0), { type: "reading", text: "mətn" }, mk(0)];
  const r2 = spreadAnswerKeys(withReading);
  ok("a reading block does not shield a run", r2.rotated === 1, r2.rotated);
  ok("and the letters end up different", keyLetters(r2.items).join("") === "AB", keyLetters(r2.items).join(""));
}

console.log("\n5. Edge cases that must not throw:");
{
  ok("empty list", spreadAnswerKeys([]).items.length === 0);
  ok("null", spreadAnswerKeys(null).items.length === 0);
  ok("a null entry", spreadAnswerKeys([null, mk(0)]).items.length === 2);
  ok("a two-option question can still be fixed",
    spreadAnswerKeys([mk(0, ["a", "b"]), mk(0, ["a", "b"])]).rotated === 1);
  ok("a single question needs nothing", spreadAnswerKeys([mk(0)]).rotated === 0);
  ok("an already-clean paper is untouched",
    spreadAnswerKeys([mk(0), mk(1), mk(2), mk(3)]).rotated === 0);
}

console.log("\n6. Wired into the summative preset only:");
{
  const fs = require("fs");
  const path = require("path");
  const ai = fs.readFileSync(path.join(__dirname, "../controllers/aiController.js"), "utf8");
  ok("the spread is applied", /spreadKeysIfNeeded/.test(ai));
  ok("only for mso-15", /preset !== "mso-15"\) return questions/.test(ai));
  ok("on the ai-solve path", /\.\.\.v, questions: spreadKeysIfNeeded\(v\.questions, preset\)/.test(ai));
  ok("and on the has-answers path", /questions: spreadKeysIfNeeded\(questions, preset\)/.test(ai));
  // The manual path strips answers, so there is no key to spread.
  ok("the prompt still asks for it too", /Ardıcıl tapşırıqlarda eyni hərfli düzgün cavab təkrarlanmasın/.test(ai));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} answer-key-spread assertions failed`);
process.exit(failed ? 1 : 0);
