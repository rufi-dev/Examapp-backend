/*
 * The AI runtime switch governs EVERY AI feature - a census, not a spot check.
 *
 * The first version of this switch was added at the call sites someone happened
 * to think of: exam generation, PDF extraction, the streamed extraction, and the
 * shared document runner. It missed the lesson-document tool path, the assistant
 * chat, the chat agent and the support chat - so with the admin page set to CLI,
 * four features carried on billing the API and nobody could see it.
 *
 * A setting that only some features honour is worse than no setting, because the
 * owner believes it. So this enumerates every place in the backend that talks to
 * a model provider and requires each one to be behind the gateway, or on an
 * explicit list that says why it cannot be.
 *
 * It fails when a NEW provider call appears anywhere, which is the only
 * assertion that catches the next one.
 */
const fs = require("fs");
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

const BE = path.join(__dirname, "..");

/* Anything that reaches a model provider. */
const PROVIDER_CALL =
  /\.messages\.(create|stream)\s*\(|\.chat\.completions\.create\s*\(|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/;

/*
 * Files allowed to contain a provider call, and what makes that safe.
 *
 * Adding a file here is a deliberate act: it says someone checked that the call
 * cannot run without the gateway having chosen it.
 */
const ALLOWED = {
  "helper/aiDocument.js":
    "the shared document runner - runDocument and documentWithTools both route through runAi",
  "helper/aiDocAdapters.js":
    "leaf adapters for documentWithTools; only ever reached from the gateway's api route",
  "controllers/aiController.js":
    "every dispatcher here (extract, extractStream, runGeneration, runChat, runChatAgent) routes through runAi; transcription and the realtime token are declared CLI-unsupported",
  "services/chatAssistant.js": "the support chat - generateSupportReply routes through runAi",
};

const walk = (dir) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "tests", "uploads", "migrations", "scripts"].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".js")) out.push(full);
  }
  return out;
};

const rel = (f) => path.relative(BE, f).split(path.sep).join("/");
const callers = walk(BE)
  .filter((f) => PROVIDER_CALL.test(fs.readFileSync(f, "utf8")))
  .map(rel)
  .sort();

async function main() {
  console.log("the AI runtime switch reaches every AI feature");

  // -- the census ---------------------------------------------------------
  console.log("\nevery file that talks to a provider:");
  for (const f of callers) console.log(`    ${ALLOWED[f] ? "known  " : "UNKNOWN"} ${f}`);

  const unknown = callers.filter((f) => !ALLOWED[f]);
  ok(
    "no provider call lives outside the known set",
    unknown.length === 0,
    unknown.length ? `new caller(s): ${unknown.join(", ")}` : ""
  );

  ok(
    "and every known file is still a caller",
    Object.keys(ALLOWED).every((f) => callers.includes(f)),
    `stale entries: ${Object.keys(ALLOWED).filter((f) => !callers.includes(f)).join(", ") || "none"}`
  );

  // -- each file actually uses the gateway --------------------------------
  console.log("\neach of them goes through the gateway:");
  const GATEWAY = /require\(["'](?:\.\.?\/)+helper\/aiRuntime["']\)|require\(["']\.\/aiRuntime["']\)/;
  for (const f of callers) {
    const text = fs.readFileSync(path.join(BE, f), "utf8");
    // aiDocAdapters holds leaf adapters only - it is called BY the gateway's
    // api route, so it must not choose a route itself.
    if (f === "helper/aiDocAdapters.js") {
      ok(`${f} is a leaf and chooses nothing`, !GATEWAY.test(text));
      continue;
    }
    ok(`${f} imports the gateway`, GATEWAY.test(text));
  }

  // -- the dispatchers the owner named ------------------------------------
  console.log("\nthe features the switch has to cover:");
  const ai = fs.readFileSync(path.join(BE, "controllers/aiController.js"), "utf8");
  const doc = fs.readFileSync(path.join(BE, "helper/aiDocument.js"), "utf8");
  const chat = fs.readFileSync(path.join(BE, "services/chatAssistant.js"), "utf8");

  /* The body of a top-level function, up to the next top-level declaration. */
  const bodyOf = (src, header) => {
    const at = src.indexOf(header);
    if (at < 0) return "";
    const next = src.slice(at + header.length).search(/\n(?:async function |function |const \w+ = asyncHandler)/);
    return next < 0 ? src.slice(at) : src.slice(at, at + header.length + next);
  };
  const routes = (src, header) => /runAi\s*\(/.test(bodyOf(src, header));

  ok("exam generation", routes(ai, "async function runGeneration("));
  ok("PDF extraction", routes(ai, "const extractQuestions = asyncHandler("));
  ok("streamed PDF extraction", routes(ai, "const extractQuestionsStream = asyncHandler("));
  ok("the assistant chat", routes(ai, "async function runChat("));
  ok("the chat agent (tools)", routes(ai, "async function runChatAgent("));
  ok("lesson documents / plans / curriculum", routes(doc, "async function runDocument("));
  ok("lesson documents that use tools", routes(doc, "async function documentWithTools("));
  ok("the support chat", routes(chat, "async function generateSupportReply("));

  // -- what the CLI genuinely cannot do -----------------------------------
  console.log("\ndeclared API-only, with a reason:");
  const { CLI_UNSUPPORTED } = require("../helper/aiRuntime");
  ok("audio transcription is declared", !!CLI_UNSUPPORTED.audio);
  ok("the realtime voice session is declared", !!CLI_UNSUPPORTED.realtime);
  for (const [k, why] of Object.entries(CLI_UNSUPPORTED)) console.log(`    ${k}: ${why}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
