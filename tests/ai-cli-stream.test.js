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

const { claudeStreamReader, streamedArgs, claudeArgs, claudeResult, claudeEnvelope } = require("../helper/cliAi");

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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
