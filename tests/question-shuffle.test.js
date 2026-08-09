// Question-order shuffle: block-safe permutation + answer round-trip. Grading MUST
// be unaffected by the shuffle, so we assert the permutation is valid, keeps
// reading passages grouped, and that display-order answers map back to canonical.
const assert = require("assert");
const { buildQuestionOrder } = require("../controllers/quizController");

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; };

const isPerm = (arr, n) => {
  if (!Array.isArray(arr) || arr.length !== n) return false;
  const seen = new Set(arr);
  if (seen.size !== n) return false;
  for (let i = 0; i < n; i += 1) if (!seen.has(i)) return false;
  return true;
};

// Map display-order answers back to canonical using the permutation, the exact
// inverse the scorer applies.
const deshuffle = (order, displayAnswers, n) => {
  const canon = new Array(n);
  order.forEach((canonIdx, dispPos) => { canon[canonIdx] = displayAnswers[dispPos]; });
  return canon;
};

// ── Plain exam (no blocks): full shuffle, valid permutation, round-trips ──────
{
  const n = 20;
  const qs = Array.from({ length: n }, () => ({ type: "Cm" }));
  // Run many times (it's random) — every result must be a valid permutation.
  for (let t = 0; t < 200; t += 1) {
    const order = buildQuestionOrder(qs);
    if (order === undefined) continue; // identity by chance — allowed
    ok(isPerm(order, n), "plain: valid permutation of 0..n-1");
    // Round-trip: canonical answer i = "A{i}". Student sees display order; the
    // answer they give at display pos d belongs to canonical order[d].
    const canonAnswers = Array.from({ length: n }, (_, i) => `A${i}`);
    const displayAnswers = order.map((canonIdx) => canonAnswers[canonIdx]);
    const back = deshuffle(order, displayAnswers, n);
    ok(JSON.stringify(back) === JSON.stringify(canonAnswers), "plain: answers round-trip to canonical");
  }
}

// ── Reading block stays grouped; passage first; boundaries fixed ─────────────
{
  // [0]=passage(covers 3) [1..3]=its Qs [4..6]=standalone [7]=passage(covers 2) [8..9]=its Qs
  const qs = [
    { type: "reading", covers: 3 }, { type: "Cm" }, { type: "Cm" }, { type: "Cm" },
    { type: "Cm" }, { type: "Cs" }, { type: "Cm" },
    { type: "reading", covers: 2 }, { type: "Cm" }, { type: "Cm" },
  ];
  const n = qs.length;
  let sawShuffle = false;
  for (let t = 0; t < 300; t += 1) {
    const order = buildQuestionOrder(qs);
    if (order === undefined) continue;
    sawShuffle = true;
    ok(isPerm(order, n), "blocks: valid permutation");
    // Passage 0 must be at display pos 0; passage 7 must be at display pos 7 (block
    // boundaries fixed) and each passage is immediately followed by ITS questions.
    ok(order[0] === 0, "blocks: first passage stays at the front");
    ok(order[7] === 7, "blocks: second passage stays at its boundary");
    // positions 1..3 are a permutation of {1,2,3} (passage-0's governed Qs)
    ok([order[1], order[2], order[3]].slice().sort().join() === "1,2,3", "blocks: passage-0 Qs stay in its group");
    // positions 8..9 are a permutation of {8,9}
    ok([order[8], order[9]].slice().sort().join() === "8,9", "blocks: passage-1 Qs stay in its group");
    // positions 4..6 are a permutation of the standalone run {4,5,6}
    ok([order[4], order[5], order[6]].slice().sort().join() === "4,5,6", "blocks: standalone run shuffles within itself");
  }
  ok(sawShuffle, "blocks: at least one shuffle occurred across 300 tries");
}

// ── Tiny inputs: nothing to shuffle ─────────────────────────────────────────
ok(buildQuestionOrder([]) === undefined, "empty -> undefined");
ok(buildQuestionOrder([{ type: "Cm" }]) === undefined, "single question -> undefined");

console.log(`question-shuffle: ${pass} assertions passed`);
