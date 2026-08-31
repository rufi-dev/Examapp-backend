// Request fidelity: the AI must give the teacher what they asked. Locks the pure
// count parser and the math-leak detector that gate honest `verified` + top-up.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  parseRequestedCount,
  hasMathLeak,
  claudeContentParts,
  openaiContentParts,
  geminiContentParts,
} = require("../controllers/aiController");

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

// ── provider content-part builders ──────────────────────────────────────────
const PARTS = [
  { mime: "application/pdf", data: "UERG", isPdf: true },
  { mime: "image/png", data: "UE5H", isPdf: false },
];
const one = [PARTS[0]];

{
  const b = claudeContentParts(one);
  ok(b.length === 1 && b[0].type === "document", "claude: one PDF -> exactly one document block");
  ok(b[0].source.media_type === "application/pdf" && b[0].source.data === "UERG", "claude: base64 + media_type carried");
  const both = claudeContentParts(PARTS);
  ok(both[1].type === "image" && both[1].source.media_type === "image/png", "claude: an image becomes an image block");
  // The regression that matters: a part builder must never emit a TEXT block, let
  // alone an empty one — the Anthropic API rejects empty text blocks, and that is
  // what made single-file non-streaming Claude extraction 400 and fall through the
  // provider chain unnoticed.
  ok(both.every((x) => x.type !== "text"), "claude: part builder emits no text blocks at all");
  ok(
    claudeContentParts([]).length === 0,
    "claude: no files -> no blocks (the topic-only document case)"
  );
}

{
  const b = openaiContentParts(one, "exam");
  ok(b[0].type === "input_file" && b[0].filename === "exam-1.pdf", "openai: PDF -> input_file with a 1-based name");
  ok(b[0].file_data === "data:application/pdf;base64,UERG", "openai: data: URI prefix intact");
  const both = openaiContentParts(PARTS, "source");
  ok(both[1].type === "input_image" && both[1].image_url === "data:image/png;base64,UE5H", "openai: image -> input_image");
  ok(openaiContentParts(one)[0].filename === "file-1.pdf", "openai: default filename prefix");
}

{
  const b = geminiContentParts(PARTS);
  ok(b.length === 2 && b[0].inline_data.mime_type === "application/pdf", "gemini: inline_data per part");
  ok(b[1].inline_data.data === "UE5H", "gemini: base64 carried");
}

// The call site itself: the single-file hint must be CONDITIONALLY SPREAD, never a
// block whose text is "". Asserted textually because the array is built inline.
{
  const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "aiController.js"), "utf8");
  ok(
    !/text:\s*parts\.length > 1 \?.*:\s*""/.test(src),
    "aiController no longer builds an empty text block for a single file"
  );
  ok(
    src.includes("...(parts.length > 1"),
    "aiController spreads the multi-file hint conditionally"
  );
  ok(
    (src.match(/\.\.\.claudeContentParts\(parts\)/g) || []).length === 2,
    "both Claude call sites use the shared builder"
  );
  ok(
    (src.match(/\.\.\.geminiContentParts\(parts\)/g) || []).length === 2,
    "both Gemini call sites use the shared builder"
  );
  ok(src.includes("...openaiContentParts(parts, \"exam\")"), "the OpenAI call site uses the shared builder");
}

console.log(`ai-request-fidelity: ${pass} assertions passed`);
