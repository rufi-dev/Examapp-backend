/* eslint-env node */
/*
 * Questions appear as they are written on the CLI route too.
 *
 * Since the CLI route arrived, `claude -p --output-format json` printed its one
 * envelope when the turn was over, so a teacher stared at an empty screen for a
 * minute and then got 25 questions at once (prod, 2026-10-05). Generation now
 * asks for `stream-json` with partial messages and reads the text deltas as they
 * come. The lines below are the shapes the deployed CLI (2.1.289) printed.
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

const { claudeStreamReader, streamedArgs, claudeArgs, claudeResult, claudeEnvelope, codexTurnReader, limitFromText } = require("../helper/cliAi");

const delta = (text) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } } });
const ANSWER = '{"questions":[{"text":"1+1=?"},{"text":"2+2=?"}]}';
const LINES = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } }),
  delta("```json\n{\"questions"),
  delta("\":[{\"text\":\"1+1=?\"},{\""),
  delta("text\":\"2+2=?\"}]}"),
  delta("\n```"),
  JSON.stringify({ type: "assistant", message: {} }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\n" + ANSWER + "\n```", total_cost_usd: 0.001 }),
];

function main() {
  console.log("streaming the CLI's answer");

  const seen = [];
  const reader = claudeStreamReader((text) => seen.push(text));
  // Delivered in awkward pieces, the way a pipe hands them over: lines split mid-way.
  const all = LINES.join("\n") + "\n";
  for (let i = 0; i < all.length; i += 37) reader.push(all.slice(i, i + 37));
  const raw = reader.finish();

  ok("the text reaches the listener delta by delta, not once at the end", seen.length === 4, String(seen.length));
  ok("each call carries everything written so far", seen[1] === '```json\n{"questions":[{"text":"1+1=?"},{"' && seen[3].endsWith("```"));
  ok("thinking is not shown as answer text", !seen.some((t) => t.includes("hmm")));
  ok("the answer is still read from the closing result envelope", JSON.stringify(claudeResult(raw)) === ANSWER, raw.slice(0, 80));

  // No result line (a CLI that died after writing): the streamed text is what is left to parse.
  const cut = claudeStreamReader(() => {});
  cut.push(delta(ANSWER) + "\n");
  ok("without a result line, the streamed text is what is parsed", JSON.stringify(claudeResult(cut.finish())) === ANSWER);

  // A failure stated inside the envelope still fails, exactly as with `json`.
  const bad = claudeStreamReader(() => {});
  bad.push(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in" }));
  let threw = null;
  try {
    claudeEnvelope(bad.finish());
  } catch (e) {
    threw = e;
  }
  ok("an error envelope is still an error", threw?.code === "cli_failed");

  // A listener that throws must not stop the turn.
  const rough = claudeStreamReader(() => {
    throw new Error("listener broke");
  });
  rough.push(LINES.join("\n"));
  ok("a broken listener does not break the reading", JSON.stringify(claudeResult(rough.finish())) === ANSWER);

  console.log("\nthe arguments:");
  const base = claudeArgs({ model: "sonnet", systemPrompt: "x" });
  const streamed = streamedArgs(base);
  ok("the plain call still asks for json", base[base.indexOf("--output-format") + 1] === "json");
  ok("the streamed call asks for stream-json", streamed[streamed.indexOf("--output-format") + 1] === "stream-json");
  ok("with the two flags stream-json needs for partial text", streamed.includes("--verbose") && streamed.includes("--include-partial-messages"));
  ok("and nothing else changes", streamed.length === base.length + 2 && streamed.includes("--system-prompt"));

  console.log("\ncodex, through its app-server (shapes the deployed 0.162 printed):");
  const cseen = [];
  const turn = codexTurnReader((t) => cseen.push(t));
  const note = (method, params) => ({ method, params });
  const msgs = [
    note("turn/started", {}),
    note("item/completed", { item: { type: "userMessage", text: "" } }),
    note("item/agentMessage/delta", { itemId: "m1", delta: '{"' }),
    note("item/agentMessage/delta", { itemId: "m1", delta: 'questions":[{"text":"1+1=?"},' }),
    note("item/agentMessage/delta", { itemId: "m1", delta: '{"text":"2+2=?"}]}' }),
    note("item/completed", { item: { type: "agentMessage", text: ANSWER } }),
  ];
  let ended = null;
  for (const m of msgs) ended = turn.handle(m) || ended;
  ok("the text reaches the listener piece by piece", cseen.length === 3 && cseen[2] === ANSWER, JSON.stringify(cseen));
  ok("nothing ends before turn/completed", ended === null);
  const end = turn.handle(note("turn/completed", { turn: { status: "completed", error: null } }));
  ok("the finished message is the answer", end && end.result === ANSWER);

  const second = codexTurnReader(() => {});
  second.handle(note("item/agentMessage/delta", { itemId: "a", delta: "Thinking about it" }));
  second.handle(note("item/agentMessage/delta", { itemId: "b", delta: '{"questions":[]}' }));
  ok("a new message starts its text over", second.text === '{"questions":[]}');

  const spent = codexTurnReader(() => {});
  spent.handle(note("error", { error: { message: "You've hit your usage limit. Try again later." }, willRetry: false }));
  const failedTurn = spent.handle(note("turn/completed", { turn: { status: "failed", error: null } }));
  ok("a failed turn reports the reason it was given", failedTurn && /usage limit/.test(failedTurn.error));
  ok("...which reads as a spent plan, so the gateway switches route", limitFromText(failedTurn.error, "codex")?.code === "cli_limit_reached");

  console.log("\nthinking is a sign of life, not text:");
  let claudeThinks = 0;
  const thinking = claudeStreamReader(() => {}, () => (claudeThinks += 1));
  thinking.push(LINES.join("\n") + "\n");
  ok("claude's thinking deltas reach the activity listener", claudeThinks === 1, String(claudeThinks));
  ok("...and never the answer text", !thinking.text.includes("hmm"));
  let codexThinks = 0;
  const reasoning = codexTurnReader(() => {}, () => (codexThinks += 1));
  reasoning.handle({ method: "item/reasoning/summaryTextDelta", params: { delta: "planning" } });
  reasoning.handle({ method: "item/reasoning/textDelta", params: { delta: "more" } });
  ok("codex's reasoning deltas reach it too", codexThinks === 2 && reasoning.text === "", String(codexThinks));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
