/*
 * Speech to text (OpenAI), for Azerbaijani speech.
 *
 * One place for the call, used by POST /api/quiz/transcribe and by the chat's
 * voice messages. `language: "az"` keeps short Azerbaijani clips from being
 * heard as Turkish; the prompt names the app's own words (Examopia, Lövhə,
 * Zibil qutusu…) so they come back spelled as the app spells them.
 *
 * It goes through the AI runtime gateway like every other model call; the
 * gateway sends audio to the API whatever the mode, because the CLIs take no
 * audio (aiRuntime CLI_UNSUPPORTED.audio).
 */
const { runAi } = require("./aiRuntime");

const PROMPT =
  "Examopia. Müəllim danışır: imtahan, sinif, şagird, valideyn, tapşırıq, sual, cavab, nəticə, " +
  "Lövhə, Dərs cədvəli, Dərs studiyası, Zibil qutusu, Planım, Profil, AI krediti, WhatsApp.";

const model = () => process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";

class TranscribeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/*
 * The text of an audio clip. Throws TranscribeError (with an HTTP status the
 * caller may pass on) when it is not configured or the service fails.
 */
async function transcribe(buffer, { mimetype = "audio/webm", filename = "audio.webm", language = "az", prompt = PROMPT, timeoutMs = 45000 } = {}) {
  if (!process.env.OPENAI_API_KEY) throw new TranscribeError("Səs tanıma konfiqurasiya olunmayıb (OPENAI_API_KEY)", 503);
  if (!buffer || !buffer.length) throw new TranscribeError("Səs faylı yoxdur", 400);
  return runAi({ capability: "audio", label: "speech-to-text", api: () => onApi(buffer, { mimetype, filename, language, prompt, timeoutMs }) });
}

async function onApi(buffer, { mimetype, filename, language, prompt, timeoutMs }) {
  const fd = new FormData();
  fd.append("file", new Blob([buffer], { type: mimetype }), filename);
  fd.append("model", model());
  fd.append("language", language);
  if (prompt) fd.append("prompt", prompt);

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

module.exports = { transcribe, TranscribeError, PROMPT };
