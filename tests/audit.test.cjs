// Deterministic quality audit for AI-generated questions. Pure — no AI, no DB —
// so it runs in CI. The AI review loop that builds on it is exercised
// separately (it needs live model calls).
const assert = require("assert");
const { auditQuestions } = require("../controllers/aiController");

const codes = (list, opts) => auditQuestions(list, opts).map((x) => x.code).sort();
const Q = (o) => ({ type: "Cm", text: "Q?", choices: [{ text: "a" }, { text: "b" }], correct: [0], ...o });
const eq = (label, got, want) => {
  try {
    assert.deepStrictEqual(got, want.slice().sort());
    console.log("ok   " + label);
  } catch {
    console.log("FAIL " + label + "  got " + JSON.stringify(got));
    process.exitCode = 1;
  }
};

// Valid questions produce no findings.
eq("valid single-choice", codes([Q({})], { requireAnswers: true }), []);
eq("valid multi-select", codes([Q({ type: "Cs", correct: [0, 1] })], { requireAnswers: true }), []);
eq("valid open", codes([{ type: "Co", text: "x?", openAnswers: ["5"] }], { requireAnswers: true }), []);
eq(
  "valid matching",
  codes(
    [
      {
        type: "Cma",
        text: "Match\n1. x\n2. y\n\na) A\nb) B",
        pairs: [
          { left: "1", right: "a" },
          { left: "2", right: "b" },
        ],
      },
    ],
    { requireAnswers: true }
  ),
  []
);
eq("reading block", codes([{ type: "reading", text: "passage" }], { requireAnswers: true }), []);

// Each real defect is caught.
eq("unknown type", codes([{ type: "Bad", text: "x" }], { requireAnswers: true }), ["unknown-type"]);
eq("correct index out of range", codes([Q({ correct: [5] })], { requireAnswers: true }), ["bad-correct-index"]);
eq("duplicate correct index", codes([Q({ type: "Cs", correct: [0, 0] })], { requireAnswers: true }), [
  "duplicate-correct-index",
]);
eq("single-choice, two answers", codes([Q({ correct: [0, 1] })], { requireAnswers: true }), ["cm-multi-correct"]);
eq("too few choices", codes([Q({ choices: [{ text: "one" }] })], { requireAnswers: true }), ["too-few-choices"]);
eq("duplicate choices", codes([Q({ choices: [{ text: "x" }, { text: "x" }] })], { requireAnswers: true }), ["duplicate-choice"]);
eq("blank choice", codes([Q({ choices: [{ text: "a" }, { text: "" }] })], { requireAnswers: true }), ["empty-choice"]);
eq("empty text", codes([Q({ text: "" })], { requireAnswers: true }), ["empty-text"]);
eq("missing correct answer", codes([Q({ correct: [] })], { requireAnswers: true }), ["no-correct-answer"]);
eq("open, no answer", codes([{ type: "Co", text: "x?", openAnswers: [] }], { requireAnswers: true }), ["no-open-answer"]);
eq("open with choices", codes([{ type: "Co", text: "x?", openAnswers: ["5"], choices: [{ text: "a" }] }], { requireAnswers: true }), ["open-with-choices"]);
eq("matching too few pairs", codes([{ type: "Cma", text: "x", pairs: [{ left: "1", right: "a" }] }], { requireAnswers: true }), ["too-few-pairs"]);
eq(
  "matching missing numbered list",
  codes(
    [
      {
        type: "Cma",
        text: "Match\n\na) A\nb) B",
        pairs: [
          { left: "1", right: "a" },
          { left: "2", right: "b" },
        ],
      },
    ],
    { requireAnswers: true }
  ),
  ["matching-missing-left-list"]
);
eq(
  "matching missing letter list",
  codes(
    [
      {
        type: "Cma",
        text: "Match\n1. x\n2. y",
        pairs: [
          { left: "1", right: "a" },
          { left: "2", right: "b" },
        ],
      },
    ],
    { requireAnswers: true }
  ),
  ["matching-missing-letter-list"]
);
eq(
  "matching malformed answer label",
  codes(
    [
      {
        type: "Cma",
        text: "Match\n1. x\n2. y\n\na) A\nb) B",
        pairs: [
          { left: "1", right: "aa" },
          { left: "2", right: "b" },
        ],
      },
    ],
    { requireAnswers: true }
  ),
  ["bad-matching-label"]
);
eq(
  "matching answer outside visible list",
  codes(
    [
      {
        type: "Cma",
        text: "Match\n1. x\n2. y\n\na) A\nb) B",
        pairs: [
          { left: "1", right: "c" },
          { left: "2", right: "b" },
        ],
      },
    ],
    { requireAnswers: true }
  ),
  ["bad-matching-label"]
);

// Extraction mode: an unmarked answer is expected, not a defect.
eq("extraction leaves answers to the teacher", codes([Q({ correct: [] })], { requireAnswers: false }), []);
// A figure question excuses empty text.
eq("figure question", codes([Q({ text: "", hasFigure: true })], { requireAnswers: true }), []);

if (!process.exitCode) console.log("\nall audit checks passed");
