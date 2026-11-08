/*
 * The subscription-CLI route for PDF extraction, end to end through the real
 * extractQuestionsStream handler, with FAKE `claude` / `codex` binaries that act
 * out what the real ones do: stream-json, the schema echoed back, prose instead of
 * JSON, a spent plan reported as an exit-0 ANSWER, LaTeX written without its
 * backslashes doubled.
 *
 * Linux only (the fakes are shebang scripts). Dependency-free, so it runs inside
 * the production image:   node tests/cliAi.test.js
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const T = fs.mkdtempSync(path.join(os.tmpdir(), "cliai-test-"));
const LOG = path.join(T, "calls.log");
const MODE = path.join(T, "mode.json");

// ---- a one-page PDF (Ghostscript must be able to draw it for codex) ----
const pdfLines = ["1. 2 + 3 = ?", "A) 4  B) 5  C) 6"];
let y = 760;
const content = pdfLines.map((l) => `BT /F1 14 Tf 60 ${(y -= 24)} Td (${l}) Tj ET`).join("\n");
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let pdf = "%PDF-1.4\n";
const offs = [];
objs.forEach((o, i) => {
  offs.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const PDF = Buffer.from(pdf);

// ---- the fakes ----
const GOOD = (text) => JSON.stringify({ questions: [{ type: "Cm", text, latex: "", choices: [{ text: "4", latex: "" }, { text: "5", latex: "" }, { text: "6", latex: "" }], correct: [1], pairs: [], hasFigure: false, openAnswer: "", openAnswers: [], explanation: "" }] });
const fakeClaude = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
let stdin = ""; try { stdin = fs.readFileSync(0, "utf8"); } catch {}
const sys = args[args.indexOf("--system-prompt") + 1] || "";
const mode = JSON.parse(fs.readFileSync(${JSON.stringify(MODE)}, "utf8")).claude;
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ bin: "claude", args, apiKey: process.env.ANTHROPIC_API_KEY !== undefined, token: !!process.env.CLAUDE_CODE_OAUTH_TOKEN, insist: /SXEMİN ÖZÜNÜ|JSON DEYİLDİ/.test(sys), stdinHasSchema: stdin.includes('"questions"') }) + "\\n");
const out = (t) => process.stdout.write(JSON.stringify(t) + "\\n");
const answer = (text) => {
  for (let i = 0; i < text.length; i += 40) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(i, i + 40) } } });
  out({ type: "result", subtype: "success", is_error: false, result: text });
};
const second = /SXEMİN ÖZÜNÜ|JSON DEYİLDİ/.test(sys);
if (mode === "good") answer(${JSON.stringify(GOOD("2 + 3 = ?"))});
else if (mode === "latex") answer(${JSON.stringify(GOOD("PLACEHOLDER"))}.replace("PLACEHOLDER", "$\\\\frac{1}{2}$ və $\\\\begin{cases}x\\\\end{cases}$ və $a \\\\times b$"));
else if (mode === "echo") answer(second ? ${JSON.stringify(GOOD("after echo"))} : JSON.stringify({ type: "object", properties: { questions: {} }, required: ["questions"] }));
else if (mode === "prose") answer(second ? ${JSON.stringify(GOOD("after prose"))} : "Hansı sualları çıxarmağımı istəyirsiniz?");
else if (mode === "prose2") answer("Bağışlayın, aydın deyil.");
else if (mode === "limit") answer("Claude AI usage limit reached|" + Math.floor(Date.now() / 1000 + 3600));
else if (mode === "nologin") { out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }); process.exit(1); }
`;
const fakeCodex = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const mode = JSON.parse(fs.readFileSync(${JSON.stringify(MODE)}, "utf8")).codex;
const img = args.indexOf("--image") >= 0 ? args[args.indexOf("--image") + 1].split(",") : [];
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ bin: "codex", args: args.slice(0, -1), images: img, imagesExist: img.every((f) => fs.existsSync(f)), claudeToken: process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined }) + "\\n");
const outFile = args[args.indexOf("--output-last-message") + 1];
if (mode === "good") { fs.writeFileSync(outFile, "\`\`\`json\\n" + ${JSON.stringify(GOOD("codex q"))} + "\\n\`\`\`"); process.exit(0); }
if (mode === "limit") { process.stderr.write("x".repeat(30000) + "\\nYou've hit your usage limit. Try again at Nov 9th, 2026 5:19 PM.\\n"); process.exit(1); }
process.exit(1);
`;
const bin = path.join(T, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "claude"), fakeClaude, { mode: 0o755 });
fs.writeFileSync(path.join(bin, "codex"), fakeCodex, { mode: 0o755 });
process.env.CLAUDE_CLI_BIN = path.join(bin, "claude");
process.env.CODEX_CLI_BIN = path.join(bin, "codex");
process.env.ANTHROPIC_API_KEY = "sk-ant-api-should-never-reach-the-cli";
process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-fake";
process.env.GEMINI_API_KEY = ""; // the paid fallback fails fast and visibly

const { extractQuestionsStream } = require("../controllers/aiController");

function run(provider = "gemini") {
  return new Promise((resolve) => {
    let body = "";
    const listeners = {};
    const res = {
      statusCode: 200,
      writableEnded: false,
      status(c) { this.statusCode = c; return this; },
      writeHead(c) { this.statusCode = c; },
      flushHeaders() {},
      on(ev, fn) { listeners[ev] = fn; },
      write(s) { body += s; },
      end() {
        this.writableEnded = true;
        const events = [];
        for (const block of body.split("\n\n")) {
          const ev = /^event: (\w+)$/m.exec(block);
          const da = /^data: (.*)$/m.exec(block);
          if (ev && da) events.push([ev[1], JSON.parse(da[1])]);
        }
        resolve(events);
      },
    };
    extractQuestionsStream({ file: { buffer: PDF, mimetype: "application/pdf" }, body: { provider }, params: { examId: "x" } }, res, (e) => resolve([["thrown", { message: e && e.message }]]));
  });
}
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const setMode = (claude, codex) => {
  fs.writeFileSync(MODE, JSON.stringify({ claude, codex }));
  fs.rmSync(LOG, { force: true });
};
const done = (ev) => (ev.find((e) => e[0] === "done") || [])[1];
const error = (ev) => (ev.find((e) => e[0] === "error") || [])[1];
let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failed += 1;
};

(async () => {
  // 1. Claude answers: streamed live, authoritative done, $0, API key withheld.
  setMode("good", "good");
  let ev = await run();
  let d = done(ev);
  let c = calls();
  ok(d && d.provider === "claude-cli" && d.questions.length === 1 && d.questions[0].correct[0] === 1, "claude CLI extracts; done carries the questions");
  ok(ev.some((e) => e[0] === "question"), "questions stream live while Claude writes");
  ok(d && d.cost && d.cost.cli === true && d.cost.usd === undefined, "browser gets no $ figure for a subscription run");
  ok(c[0] && c[0].apiKey === false && c[0].token === true, "claude child sees the OAuth token, NOT ANTHROPIC_API_KEY");
  ok(c[0] && !c[0].args.includes("--bare") && c[0].args.includes("--system-prompt") && c[0].args.includes("--strict-mcp-config"), "no --bare; system prompt replaced; no MCP connectors");
  ok(c[0] && c[0].args.includes("--tools") && c[0].args[c[0].args.indexOf("--tools") + 1] === "Read", "only the Read tool");
  ok(c[0] && Number(c[0].args[c[0].args.indexOf("--max-turns") + 1]) >= 4, "enough turns to read a file");
  ok(c[0] && c[0].stdinHasSchema, "prompt (with the schema as a form) goes in on stdin");

  // 2. The schema echoed back: detected, one pointed retry, then a real answer.
  setMode("echo", "good");
  d = done(await run());
  c = calls();
  ok(d && d.provider === "claude-cli" && d.questions[0].text === "after echo", "schema echo is not accepted; the retry answers");
  ok(c.length === 2 && c[1].insist === true, "exactly one retry, told it returned the schema");

  // 3. Prose instead of JSON: one retry.
  setMode("prose", "good");
  d = done(await run());
  ok(d && d.questions[0].text === "after prose", "prose answer gets one retry");

  // 4. LaTeX written without doubled backslashes is repaired.
  setMode("latex", "good");
  d = done(await run());
  const t = d && d.questions[0].text;
  ok(t && t.includes("\\frac{1}{2}") && t.includes("\\begin{cases}") && t.includes("\\times") && !/[\u0008\u0009\u000c]/.test(t), "\\frac / \\begin / \\times survive a mis-escaped answer");

  // 5. Prose twice: Claude gives up, Codex (pages attached as images) answers.
  setMode("prose2", "good");
  d = done(await run());
  c = calls();
  const cx = c.find((x) => x.bin === "codex");
  ok(d && d.provider === "codex-cli" && d.questions[0].text === "codex q", "claude fails → codex answers (```json fence parsed)");
  ok(cx && cx.images.length >= 1 && cx.imagesExist && cx.args[0] === "exec" && cx.args[1] === "--image", "codex gets the PDF as page images, --image first");
  ok(cx && cx.claudeToken === false, "codex child never sees Claude's token");

  // 6. A spent Claude plan, reported as an exit-0 ANSWER: stood down, codex used,
  //    and the next request skips Claude entirely.
  setMode("limit", "good");
  d = done(await run());
  ok(d && d.provider === "codex-cli", "claude usage limit → codex");
  setMode("good", "good");
  d = done(await run());
  c = calls();
  ok(d && d.provider === "codex-cli" && !c.some((x) => x.bin === "claude"), "claude stays stood down for the next request");

  // 6b. Writing questions from a request (no file): Claude, live, marked generated.
  for (const k of Object.keys(require.cache)) if (/controllers|helper/.test(k)) delete require.cache[k];
  const gen = require("../controllers/aiController");
  setMode("good", "good");
  ev = await new Promise((resolve) => {
    let body = "";
    const res = { statusCode: 200, writableEnded: false, status() { return this; }, writeHead() {}, flushHeaders() {}, on() {}, write(s) { body += s; },
      end() { resolve(body.split("\n\n").map((b) => [/^event: (\w+)$/m.exec(b)?.[1], /^data: (.*)$/m.exec(b)?.[1]]).filter((x) => x[0]).map(([e, j]) => [e, JSON.parse(j)])); } };
    gen.generateQuestionsStream({ body: { prompt: "9-cu sinif: kvadrat tənliklər, 1 sual" }, params: { examId: "x" } }, res, (e) => resolve([["thrown", { message: e && e.message }]]));
  });
  d = done(ev);
  c = calls();
  ok(d && d.generated === true && d.provider === "claude-cli" && d.questions.length === 1, "generate: Claude writes questions, done is marked generated");
  ok(c[0] && c[0].args[c[0].args.indexOf("--tools") + 1] === "" && !c[0].args.includes("--add-dir"), "generate: no file, no tools");
  ok(ev.some((e) => e[0] === "question"), "generate: questions stream live");
  // too-short request is refused before any CLI starts
  setMode("good", "good");
  const short = await new Promise((resolve) => {
    const res = { status(code) { this.code = code; return this; }, writeHead() {}, flushHeaders() {}, on() {}, write() {}, end() {} };
    gen.generateQuestionsStream({ body: { prompt: "abc" }, params: { examId: "x" } }, res, (e) => resolve({ code: res.code, msg: e && e.message }));
  });
  ok(short.code === 400 && calls().length === 0, "generate: a 3-letter request is refused, no CLI started");

  // 6c. Photos of a worksheet: claude gives up, codex gets the image AS IS.
  setMode("prose2", "good");
  const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
  ev = await new Promise((resolve) => {
    let body = "";
    const res = { statusCode: 200, writableEnded: false, status() { return this; }, writeHead() {}, flushHeaders() {}, on() {}, write(s) { body += s; },
      end() { resolve(body.split("\n\n").map((b) => [/^event: (\w+)$/m.exec(b)?.[1], /^data: (.*)$/m.exec(b)?.[1]]).filter((x) => x[0]).map(([e, j]) => [e, JSON.parse(j)])); } };
    gen.extractQuestionsStream({ files: [{ buffer: PNG, mimetype: "image/png", originalname: "sehife-1.png" }, { buffer: PDF, mimetype: "application/pdf", originalname: "x.pdf" }], body: {}, params: { examId: "x" } }, res, (e) => resolve([["thrown", { message: e && e.message }]]));
  });
  d = done(ev);
  const cx2 = calls().find((x) => x.bin === "codex");
  ok(d && d.provider === "codex-cli", "photo + PDF upload is read by the CLIs");
  ok(cx2 && cx2.images.some((f) => /attachment-1\.png$/.test(f)) && cx2.images.some((f) => /attachment-2-\d+\.png$/.test(f)) && cx2.imagesExist, "codex: the photo as is, the PDF as page images");
  // a .docx is refused up front
  const bad = await new Promise((resolve) => {
    const res = { status(code) { this.code = code; return this; }, writeHead() {}, flushHeaders() {}, on() {}, write() {}, end() {} };
    gen.extractQuestionsStream({ files: [{ buffer: Buffer.from("x"), mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", originalname: "a.docx" }], body: {}, params: { examId: "x" } }, res, (e) => resolve({ code: res.code, msg: e && e.message }));
  });
  ok(bad.code === 400 && /PDF/.test(bad.msg || ""), "a Word file is refused with a clear message");

  // 7. Both spent (codex's refusal buried after 30KB of stderr) → the paid API path.
  //    Fresh module state so claude is tried again.
  for (const k of Object.keys(require.cache)) if (/controllers|helper/.test(k)) delete require.cache[k];
  process.env.ANTHROPIC_API_KEY = ""; // the paid chain fails locally, no network call
  const fresh = require("../controllers/aiController");
  setMode("nologin", "limit");
  ev = await new Promise((resolve) => {
    let body = "";
    const res = { statusCode: 200, writableEnded: false, status() { return this; }, writeHead() {}, flushHeaders() {}, on() {}, write(s) { body += s; },
      end() { resolve(body.split("\n\n").map((b) => [/^event: (\w+)$/m.exec(b)?.[1], /^data: (.*)$/m.exec(b)?.[1]]).filter((x) => x[0]).map(([e, j]) => [e, JSON.parse(j)])); } };
    fresh.extractQuestionsStream({ file: { buffer: PDF, mimetype: "application/pdf" }, body: { provider: "gemini" }, params: { examId: "x" } }, res, () => resolve([]));
  });
  ok(error(ev) && /GEMINI_API_KEY|AI/.test(error(ev).message), "both CLIs unavailable → falls through to the API chain");

  // 8. AI_EXECUTION=cli never bills: same failure, CLI-only message.
  for (const k of Object.keys(require.cache)) if (/controllers|helper/.test(k)) delete require.cache[k];
  process.env.AI_EXECUTION = "cli";
  const cliOnly = require("../controllers/aiController");
  setMode("nologin", "limit");
  ev = await new Promise((resolve) => {
    let body = "";
    const res = { statusCode: 200, writableEnded: false, status() { return this; }, writeHead() {}, flushHeaders() {}, on() {}, write(s) { body += s; },
      end() { resolve(body.split("\n\n").map((b) => [/^event: (\w+)$/m.exec(b)?.[1], /^data: (.*)$/m.exec(b)?.[1]]).filter((x) => x[0]).map(([e, j]) => [e, JSON.parse(j)])); } };
    cliOnly.extractQuestionsStream({ file: { buffer: PDF, mimetype: "application/pdf" }, body: { provider: "gemini" }, params: { examId: "x" } }, res, () => resolve([]));
  });
  ok(error(ev) && /Abunə AI-ları/.test(error(ev).message), "AI_EXECUTION=cli: no paid fallback, honest message");

  // 9. AI_EXECUTION=api never starts a CLI.
  for (const k of Object.keys(require.cache)) if (/controllers|helper/.test(k)) delete require.cache[k];
  process.env.AI_EXECUTION = "api";
  const apiOnly = require("../controllers/aiController");
  setMode("good", "good");
  await new Promise((resolve) => {
    const res = { status() { return this; }, writeHead() {}, flushHeaders() {}, on() {}, write() {}, end: resolve, writableEnded: false };
    apiOnly.extractQuestionsStream({ file: { buffer: PDF, mimetype: "application/pdf" }, body: { provider: "gemini" }, params: { examId: "x" } }, res, resolve);
  });
  ok(calls().length === 0, "AI_EXECUTION=api: no CLI is started");

  fs.rmSync(T, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
