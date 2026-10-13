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

/*
 * Anything that reaches a model provider.
 *
 * Every SDK shape as well as the raw hostnames: OpenAI's Responses API and the
 * Gemini SDK name no host and use neither `messages.create` nor
 * `chat.completions.create`, so a new file built on either of those would
 * otherwise slip past this census and quietly ignore the switch - which is the
 * exact failure this test exists to prevent.
 */
const PROVIDER_CALL =
  /\.messages\.(create|stream)\s*\(|\.chat\.completions\.create\s*\(|\.responses\.(create|stream)\s*\(|generateContent\s*\(|GoogleGenerativeAI|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/;

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
  "helper/transcribe.js":
    "speech to text (the /transcribe endpoint and the chat's voice notes) - routes through runAi as capability audio, which the CLIs cannot take",
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

  // -- no call site chooses its own CLI -----------------------------------
  /*
   * The gateway HANDS each CLI route its provider, because that is what makes
   * one CLI running out of quota move the work to the other everywhere at once.
   * A call site that took no argument would be choosing for itself again - and
   * would keep spawning a subscription that is known to be out until the request
   * failed. This is the mechanical version of that rule: a zero-argument cli
   * route cannot be honouring the switch, whatever its comments say.
   */
  console.log("\nevery CLI route is handed its provider by the gateway:");
  const ROUTE_FILES = ["controllers/aiController.js", "helper/aiDocument.js", "services/chatAssistant.js"];
  let cliRoutes = 0;
  for (const f of ROUTE_FILES) {
    const text = fs.readFileSync(path.join(BE, f), "utf8");
    const found = text.match(/\bcli:\s*(?:async\s*)?\(([^)]*)\)/g) || [];
    cliRoutes += found.length;
    const chooseTheirOwn = found.filter((m) => /\(\s*\)/.test(m));
    ok(`${f} (${found.length} route${found.length === 1 ? "" : "s"})`, chooseTheirOwn.length === 0, chooseTheirOwn.join(", "));
  }
  /*
   * Six: exam generation, PDF extraction, streamed PDF extraction, the
   * assistant chat, every lesson document/plan/curriculum, and the support
   * chat. The chat agent and the lesson-document tool loop have no cli route at
   * all - they are declared API-only above, with the reason.
   */
  ok("and all six CLI-capable features are still there", cliRoutes === 6, `found ${cliRoutes}`);

  // -- the platform chooses the engine, not the client --------------------
  /*
   * Teachers no longer pick a model. That has to be true on the SERVER, not
   * just in the UI: a picker removed from a screen is a picker removed from one
   * screen, while a handler that still reads req.body.model will happily take a
   * choice from anything that can post. The platform decides what it spends on.
   */
  console.log("\nno handler takes a model from the request:");
  const SERVER_DIRS = ["controllers", "helper", "services", "routes"];
  const readsModel = [];
  for (const dir of SERVER_DIRS) {
    for (const f of walk(path.join(BE, dir))) {
      const text = fs.readFileSync(f, "utf8");
      if (/req\.body\s*(\?\.|\.)\s*model\b|req\.body\s*&&\s*req\.body\.model|req\.query\s*(\?\.|\.)\s*model\b/.test(text)) {
        readsModel.push(rel(f));
      }
    }
  }
  ok("none of them do", readsModel.length === 0, readsModel.join(", "));

  const quizRoute = fs.readFileSync(path.join(BE, "routes/quizRoute.js"), "utf8");
  ok("and the catalogue is not served to clients either", !/["']\/ai\/models["']/.test(quizRoute));

  // -- a chat is not an exam ----------------------------------------------
  /*
   * Asked for no model at all, `claude` runs Opus - the strongest model and the
   * fastest way to spend a subscription's allowance. So every kind of work names
   * a tier, and a conversation must not be on the same one as a forty-question
   * paper.
   */
  console.log("\nthe chat runs light:");
  const { tierModel, CLI_TIERS } = require("../helper/cliAi");
  ok("there is a light tier and a standard one", !!CLI_TIERS.light && !!CLI_TIERS.standard);
  ok("light is not the same model as standard", tierModel("claude", "light") !== tierModel("claude", "standard"));
  ok("and neither is empty for Claude", !!tierModel("claude", "light") && !!tierModel("claude", "standard"));
  console.log(`    standard: ${tierModel("claude", "standard")}   light: ${tierModel("claude", "light")}`);

  const chatSrc = fs.readFileSync(path.join(BE, "services/chatAssistant.js"), "utf8");
  ok("the support chat is not on a heavyweight model", !/CHAT_SUPPORT_MODEL \|\| "gpt-4\.1"/.test(chatSrc));

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
