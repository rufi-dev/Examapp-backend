// Request fidelity: the AI must give the teacher what they asked. Locks the pure
// count parser and the math-leak detector that gate honest `verified` + top-up.
const assert = require("assert");
const { parseRequestedCount, hasMathLeak } = require("../controllers/aiController");

let pass = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  pass += 1;
};

// ── parseRequestedCount ─────────────────────────────────────────────────────
const CASES = [
  ["9-cu sinif riyaziyyat, kvadrat tənliklər, 20 sual", 20],
  ["Make me 15 questions about algebra", 15],
  ["sual sayı: 25, orta çətinlik", 25],
  ["25 ədəd sual hazırla", 25],
  ["neçə sual: 12", 12],
  ["10 test hazırla", 10],
  ["kvadrat tənliklər haqqında test", null], // no explicit count
  ["riyaziyyat 200 illik tarix", null], // 200 out of range, not adjacent to "sual"
  ["", null],
];
for (const [prompt, expected] of CASES) {
  ok(
    parseRequestedCount(prompt) === expected,
    `parseRequestedCount(${JSON.stringify(prompt)}) = ${parseRequestedCount(prompt)}, expected ${expected}`
  );
}

// ── hasMathLeak (drives the agentic delimiter re-ask + honest verified) ──────
ok(hasMathLeak("Tapın \\frac{5}{7} hissəsini") === true, "bare \\frac leaks");
ok(hasMathLeak("Tapın $\\frac{5}{7} hissə") === true, "unbalanced $ leaks");
ok(hasMathLeak("Tapın $\\frac{5}{7}$ hissə") === false, "wrapped math is clean");
ok(hasMathLeak("x^2 dəyəri") === true, "bare superscript leaks");
ok(hasMathLeak("20-30 arası ədədlər") === false, "plain range is clean");
ok(hasMathLeak("Qiymət \\$5 manat") === false, "literal \\$ is clean");
ok(hasMathLeak("") === false, "empty is clean");

console.log(`ai-request-fidelity: ${pass} assertions passed`);
