/*
 * Speech to text (OpenAI), for Azerbaijani speech.
 *
 * One place for the call, used by POST /api/quiz/transcribe, the chat's voice
 * notes and WhatsApp voice messages. `language: "az"` keeps short Azerbaijani
 * clips from being heard as Turkish; the prompt names the app's own words
 * (Examopia, Lövhə, Zibil qutusu…) so they come back spelled as the app spells
 * them.
 *
 * Two listeners hear every clip at once (owner, 2026-10-13: "even in bad
 * conditions it should understand"). Measured that day on an Azerbaijani clip,
 * clean and under heavy noise: gpt-transcribe and whisper-1 heard it right both
 * times (one letter off in the noise); gpt-4o-transcribe, used until then,
 * dropped most of the noisy clip and wrote another question, and
 * gpt-4o-mini-transcribe gave back the hint itself. So gpt-transcribe leads,
 * whisper-1 (another model family, other mistakes) checks it, and when they
 * differ the AI is shown both (hear → { text, alt }). "Text" that is only the
 * hint is thrown away.
 *
 * Only for recorded clips: the live dictation (Realtime) keeps its own model,
 * OPENAI_TRANSCRIBE_MODEL.
 *
 * It goes through the AI runtime gateway like every other model call; the
 * gateway sends audio to the API whatever the mode, because the CLIs take no
 * audio (aiRuntime CLI_UNSUPPORTED.audio).
 */
const { runAi } = require("./aiRuntime");

const PROMPT =
  "Examopia. Müəllim danışır: imtahan, sinif, şagird, valideyn, tapşırıq, sual, cavab, nəticə, " +
  "Lövhə, Dərs cədvəli, Dərs studiyası, Zibil qutusu, Planım, Profil, AI krediti, WhatsApp.";

const LEAD = () => process.env.OPENAI_FILE_TRANSCRIBE_MODEL || "gpt-transcribe";
const CHECK = () => process.env.OPENAI_FILE_TRANSCRIBE_SECOND || "whisper-1";

class TranscribeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const words = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
const PROMPT_WORDS = new Set(words(PROMPT));
// The hint given back instead of what was said (a model that heard nothing clear).
function echoesPrompt(text) {
  if (/Müəllim danışır/i.test(text)) return true;
  const w = words(text);
  return w.length >= 5 && w.filter((x) => PROMPT_WORDS.has(x)).length / w.length >= 0.7;
}
// How far apart two hearings are: word edits over the longer one (0 = the same, 1 = nothing alike).
function apart(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return x.length || y.length ? 1 : 0;
  const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
  }
  return d[x.length][y.length] / Math.max(x.length, y.length);
}

/*
 * What a clip says, heard twice: { text, alt }. `text` is the lead's hearing
 * (or the check's, when the lead heard nothing); `alt` is the other hearing
 * when the two differ enough to matter, else "". Throws TranscribeError (with
 * an HTTP status the caller may pass on) when it is not configured or both
 * listeners fail.
 */
async function hear(buffer, { mimetype = "audio/webm", filename = "audio.webm", language = "az", prompt = PROMPT, timeoutMs = 45000 } = {}) {
  if (!process.env.OPENAI_API_KEY) throw new TranscribeError("Səs tanıma konfiqurasiya olunmayıb (OPENAI_API_KEY)", 503);
  if (!buffer || !buffer.length) throw new TranscribeError("Səs faylı yoxdur", 400);
  const opts = { mimetype, filename, language, prompt, timeoutMs };
  return runAi({ capability: "audio", label: "speech-to-text", api: () => listenTwice(buffer, opts) });
}

// The text of a clip (the lead's hearing, the check's when the lead heard nothing).
async function transcribe(buffer, opts = {}) {
  return (await hear(buffer, opts)).text;
}

async function listenTwice(buffer, opts) {
  const [lead, check] = await Promise.allSettled([onApi(buffer, LEAD(), opts), onApi(buffer, CHECK(), opts)]);
  const clean = (r) => (r.status === "fulfilled" && r.value && !echoesPrompt(r.value) ? r.value : "");
  const a = clean(lead);
  const b = clean(check);
  if (!a && !b && lead.status === "rejected" && check.status === "rejected") throw lead.reason;
  const text = a || b;
  const alt = a && b && apart(a, b) > 0.25 ? b : "";
  return { text, alt };
}

async function onApi(buffer, model, { mimetype, filename, language, prompt, timeoutMs }) {
  const fd = new FormData();
  fd.append("file", new Blob([buffer], { type: mimetype }), filename);
  fd.append("model", model);
  fd.append("language", language);
  if (prompt) fd.append("prompt", prompt);
  fd.append("temperature", "0");

  let r;
  let data;
  try {
    r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
      signal: AbortSignal.timeout(timeoutMs),
    });
    data = await r.json();
  } catch {
    throw new TranscribeError("Səs tanınmadı, yenidən cəhd et", 502);
  }
  if (!r.ok || data?.error) throw new TranscribeError(data?.error?.message || "Səs tanınmadı", r.status || 502);
  return String(data?.text || "").trim();
}

module.exports = { transcribe, hear, TranscribeError, PROMPT, _echoesPrompt: echoesPrompt, _apart: apart };
