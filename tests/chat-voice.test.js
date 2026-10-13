/* eslint-env node */
/*
 * Voice notes in the support chat: what is accepted, how it becomes text, and
 * that the AI reads that text.
 *
 * Owner, 2026-10-13: "add voice so people can send voices, easy to talk". The
 * browser records and uploads to Cloudinary; the server fetches the clip once,
 * transcribes it in Azerbaijani and stores the text with the message.
 */
process.env.NODE_ENV = "test";

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

const V = require("../helper/chatVoice");
const T = require("../helper/transcribe");

(async () => {
  console.log("which recordings are accepted");
  const good = "https://res.cloudinary.com/demo/video/upload/v1/chat/voice-1.webm";
  ok("a Cloudinary audio upload", V.isVoiceUrl(good));
  ok("not an image upload", !V.isVoiceUrl("https://res.cloudinary.com/demo/image/upload/v1/x.png"));
  ok("not another host", !V.isVoiceUrl("https://evil.example/video/upload/x.webm"));
  ok("not plain http", !V.isVoiceUrl("http://res.cloudinary.com/demo/video/upload/x.webm"));
  ok("not garbage", !V.isVoiceUrl("javascript:alert(1)"));
  ok("the list shows what was said, or that it is a voice note", V.voicePreview("Salam, kömək edin") === "🎤 Salam, kömək edin" && V.voicePreview("") === "🎤 Səs mesajı");

  console.log("\nspeech to text");
  const realFetch = global.fetch;
  const sent = {};
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_TRANSCRIBE_MODEL = "gpt-4o-transcribe";
  global.fetch = async (url, init) => {
    sent.url = url;
    sent.auth = init.headers.Authorization;
    sent.form = init.body;
    return { ok: true, status: 200, json: async () => ({ text: "  Zibil qutusundan necə silim?  " }) };
  };
  const text = await T.transcribe(Buffer.from("abc"), { mimetype: "audio/webm", filename: "v.webm" });
  ok("returns the text, trimmed", text === "Zibil qutusundan necə silim?", JSON.stringify(text));
  ok("asks OpenAI's transcription endpoint with the key", sent.url === "https://api.openai.com/v1/audio/transcriptions" && sent.auth === "Bearer test-key");
  ok("in Azerbaijani, with the configured model", sent.form.get("language") === "az" && sent.form.get("model") === "gpt-4o-transcribe");
  ok("with the app's own words as a hint", /Zibil qutusu/.test(sent.form.get("prompt")) && /Lövhə/.test(sent.form.get("prompt")));
  ok("with the audio itself", sent.form.get("file") && sent.form.get("file").size === 3);

  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "rate limited" } }) });
  let err = null;
  await T.transcribe(Buffer.from("abc")).catch((e) => (err = e));
  ok("a service error is reported with its status", err && err.status === 429 && /rate limited/.test(err.message));
  delete process.env.OPENAI_API_KEY;
  err = null;
  await T.transcribe(Buffer.from("abc")).catch((e) => (err = e));
  ok("not configured → 503", err && err.status === 503);
  process.env.OPENAI_API_KEY = "test-key";

  console.log("\na voice note on its way in");
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, headers: new Map([["content-type", "audio/webm"], ["content-length", "5"]]), arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer };
  };
  let got = null;
  const said = await V.transcribeVoice(good, { transcribe: async (buf, o) => ((got = { len: buf.length, ...o }), "Salam") });
  ok("fetches the clip and hands it on with its type and name", said === "Salam" && got.len === 5 && got.mimetype === "audio/webm" && got.filename === "voice-1.webm", JSON.stringify(got));
  global.fetch = async () => ({ ok: true, status: 200, headers: new Map([["content-length", String(V.VOICE_MAX_BYTES + 1)]]), arrayBuffer: async () => new ArrayBuffer(1) });
  ok("a clip over the size cap is not transcribed (and does not fail the message)", (await V.transcribeVoice(good, { transcribe: async () => "x" })) === "");
  global.fetch = async () => ({ ok: false, status: 404, headers: new Map() });
  ok("a clip that cannot be fetched gives no text, not an error", (await V.transcribeVoice(good, { transcribe: async () => "x" })) === "");
  calls.length = 0;
  ok("a URL that is not ours is never fetched", (await V.transcribeVoice("https://evil.example/video/upload/x.webm")) === "" && calls.length === 0);
  global.fetch = realFetch;

  console.log("\nthe chat");
  const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "chatController.js"), "utf8");
  ok("only our recordings are accepted", /if \(audioUrl && !isVoiceUrl\(audioUrl\)\) throw httpError\(400, "bad_audio"/.test(src));
  ok("a message may be only a voice note", /if \(!text && !imageUrl && !audioUrl\) throw httpError\(400, "empty"/.test(src));
  ok("at most 3 minutes", V.VOICE_MAX_SEC === 180 && /Səs mesajı ən çox 3 dəqiqə ola bilər/.test(src));
  ok("a daily cap per person", /audioUrl: \{ \$ne: "" \}, createdAt: \{ \$gte: since \}/.test(src) && /today >= VOICE_PER_DAY/.test(src));
  ok("the text is stored with the message", /Message\.create\(\{ conversation: conv\._id, from: req\.user\._id, to, text, imageUrl, audioUrl, audioSec, transcript \}\)/.test(src));
  ok("sent back and polled with the voice fields", (src.match(/audioUrl: m(sg)?\.audioUrl \|\| ""/g) || []).length === 2 && (src.match(/transcript: m(sg)?\.transcript \|\| ""/g) || []).length === 2);
  ok("the AI reply waits for the text (it is written before the reply starts)", src.indexOf("transcript = (await transcribeVoice(audioUrl))") < src.indexOf("maybeAiReply(String(conv._id)"));
  const model = fs.readFileSync(path.join(__dirname, "..", "models", "messageModel.js"), "utf8");
  ok("the message keeps the recording, its length and its text", /audioUrl: \{ type: String/.test(model) && /audioSec: \{ type: Number/.test(model) && /transcript: \{ type: String/.test(model));

  console.log("\nthe AI reads it");
  const C = require("../services/chatAssistant");
  const h = C.buildHistory(
    [
      { from: "t", text: "", audioUrl: good, transcript: "Biomu necə dəyişim?" },
      { from: "a", text: "Profilə keçin." },
      { from: "t", text: "", audioUrl: good, transcript: "" },
    ],
    "a",
  );
  ok("a heard voice note is its text", h[0].content === "[səs mesajı] Biomu necə dəyişim?", h[0].content);
  ok("an unheard one says so", h[2].content === "[səs mesajı göndərdi, amma eşidilmədi]");
  ok("the AI is told the text came from speech and how to treat an unheard note", /\[səs mesajı\] …/.test(C.SYSTEM_PROMPT) && /bir də danışmağı və ya yazmağı xahiş et/.test(C.SYSTEM_PROMPT));
  ok("and can tell a teacher how to send one", /mikrofon düyməsinə basıb danışın/.test(C.SYSTEM_PROMPT));

  const aic = fs.readFileSync(path.join(__dirname, "..", "controllers", "aiController.js"), "utf8");
  const tsrc = fs.readFileSync(path.join(__dirname, "..", "helper", "transcribe.js"), "utf8");
  ok("speech to text goes through the AI gateway as audio (the switch sees it; the CLIs cannot take audio)", /runAi\(\{ capability: "audio"/.test(tsrc));
  ok("the old /transcribe endpoint uses the same helper", /const \{ transcribe \} = require\("\.\.\/helper\/transcribe"\);/.test(aic) && !/api\.openai\.com\/v1\/audio\/transcriptions/.test(aic));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
