/* eslint-env node */
/*
 * An uploaded paper is read on the CLI, shown as it is copied, and not checked
 * twice for nothing.
 *
 * Two teachers on 2026-10-06 uploaded a paper and waited 58 s and 172 s: both
 * CLIs answered "unreadable" (the file was written as `attachment-1.bin`, Claude's
 * PDF reader needs pdftoppm, and Codex was never shown the page), the Claude API
 * had no credit, Gemini had none either, and OpenAI finally did it, all at once
 * at the end. After that a full review pass rewrote the whole paper again.
 */
process.env.NODE_ENV = "test";

const fs = require("fs");
const os = require("os");
const path = require("path");

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

const cli = require("../helper/cliAi");
const ai = require("../controllers/aiController");
const cliSrc = fs.readFileSync(path.join(__dirname, "..", "helper", "cliAi.js"), "utf8");
const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "aiController.js"), "utf8");
const dockerfile = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");

async function main() {
  console.log("the CLI is told what the file is");
  ok("a PDF with no name is written as .pdf", cli.safeName(undefined, 0, "application/pdf") === "attachment-1.pdf");
  ok("a photo with no name is written as .jpg", cli.safeName("", 1, "image/jpeg") === "attachment-2.jpg");
  ok("a name's own extension wins", cli.safeName("Sinaq.PNG", 2, "image/jpeg") === "attachment-3.png");
  ok("only an unknown type is still .bin", cli.safeName("x", 3, "") === "attachment-4.bin");
  ok("the upload keeps its original name", /name: f\.originalname \|\| "",/.test(src));
  ok("the runner passes the MIME type along", /safeName\(part\.name, i, part\.mime\)/.test(cliSrc));
  ok("the image carries pdftoppm for Claude's PDF reader", /apk add --no-cache poppler-utils/.test(dockerfile));

  console.log("\nCodex is SHOWN the pages");
  const job = fs.mkdtempSync(path.join(os.tmpdir(), "cli-uploads-"));
  try {
    const shown = await cli.codexImages(job, ["attachment-1.png", "attachment-2.jpg", "attachment-3.bin"]);
    ok("photos are attached as they are", JSON.stringify(shown) === '["attachment-1.png","attachment-2.jpg"]', JSON.stringify(shown));
  } finally {
    fs.rmSync(job, { recursive: true, force: true });
  }
  ok("a PDF is drawn to PNG pages with Ghostscript", /"-sDEVICE=png16m"/.test(cliSrc));
  ok("exec gets --image FIRST, so it cannot swallow the prompt", /args = \["exec", \.\.\.\(images\.length \? \["--image", images\.join\(","\)\] : \[\]\),/.test(cliSrc));
  ok("the app-server gets them as localImage items", /type: "localImage", path: path\.resolve\(cwd, f\)/.test(cliSrc));
  ok("nothing drawable is a hand-over, not an empty paper", /no page of the attachment could be drawn for codex"\), \{ code: "cli_unreadable_document" \}/.test(cliSrc));

  console.log("\nCodex is not asked for an API model");
  ok("gpt-4.1-mini is dropped for the binary's own model", cli.cliModel("codex", "gpt-4.1-mini") === (process.env.CODEX_CLI_DEFAULT_MODEL || null));
  ok("a Codex model is still passed through", cli.cliModel("codex", "gpt-5.2-codex") === "gpt-5.2-codex");
  ok("Claude's mapping is unchanged", cli.cliModel("claude", "") === (process.env.CLAUDE_CLI_DEFAULT_MODEL || "sonnet"));

  console.log("\nno account connectors in an exam turn");
  ok("--strict-mcp-config is on every claude turn", cli.CLAUDE_BASE_ARGS.includes("--strict-mcp-config"));

  console.log("\nthe upload streams on the CLI route");
  const cliBranch = src.slice(src.indexOf('label: "extract-stream"'), src.indexOf("api: async () => {", src.indexOf('label: "extract-stream"')));
  ok("the CLI turn gets a text listener", /onText: emit,/.test(cliBranch));
  ok("...and the thinking signal", /onThinking,/.test(cliBranch));
  ok("...and anything unstreamed is shown at the end", /emit\(JSON\.stringify\(\{ questions: got \}\)\)/.test(cliBranch));
  ok("every route starts clean", (src.match(/freshStart\(\);/g) || []).length >= 2);
  ok("a hand-over mid-stream clears the screen", /if \(streamedCount > 0\) sse\("reset", \{\}\);/.test(src));
  ok("generation does the same", /if \(shown > 0\) sse\("reset", \{\}\);/.test(src));
  ok("the upload sends signs of life", /sse\("alive", \{\}\);[\s\S]{0,40}\}, 7000\);[\s\S]{0,200}const onThinking/.test(src));

  console.log("\nno review pass over a clean set");
  const clean = [
    { type: "Cm", text: "2 + 2 = ?", choices: [{ text: "3" }, { text: "4" }, { text: "5" }], correct: [1] },
    { type: "Cm", text: "3 + 3 = ?", choices: [{ text: "5" }, { text: "6" }, { text: "7" }], correct: [1] },
  ];
  let said = 0;
  const v = await ai.verifyAndFix({ questions: clean, prompt: "x", onStatus: () => (said += 1) });
  ok("a clean set calls no model", v.rounds === 0 && !v.reviewCost);
  ok("...and shows no 'yoxlanılır'", said === 0);
  ok("...and comes back as it went in", JSON.stringify(v.questions.map((q) => q.correct)) === "[[1],[1]]");
  ok("a set with defects sends only those questions", /JSON\.stringify\(\{ questions: sub \}\)/.test(src));
  ok("...merged back in place", /merged\[orig\] = candidate\[k\];/.test(src));
  ok("a check asked for by name still runs whole", /parts,\s*force: true,\s*\}\);/.test(src));

  console.log("\nthe blanks are solved side by side");
  const sizes = (n) => ai.planParallelSolve([...Array(n).keys()]).map((b) => b.length).join(",");
  ok("44 blanks go as 4 batches of 11", sizes(44) === "11,11,11,11", sizes(44));
  ok("a short paper is one turn", sizes(3) === "3");
  ok("nothing to solve is no turn", sizes(0) === "");
  ok("only the answer is laid back onto the teacher's question", /list\[orig\] = answerOnly\(sub\[k\], v\.questions\[k\]\)/.test(src));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
