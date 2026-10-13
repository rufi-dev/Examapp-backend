/*
 * Voice notes in the support chat.
 *
 * The browser records, uploads the clip to Cloudinary (audio is stored there
 * as a "video" asset) and sends its URL; the server fetches it once and turns
 * the speech into text (helper/transcribe), so the AI reads what was said and
 * the person who answers can read it too. A clip that cannot be heard is still
 * delivered, without text.
 */

const VOICE_MAX_SEC = 180;
const VOICE_MAX_BYTES = 10 * 1024 * 1024;
const VOICE_PER_DAY = 60;

function isVoiceUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "res.cloudinary.com" && /\/video\/upload\//.test(url.pathname);
  } catch {
    return false;
  }
}

const voicePreview = (transcript) => `🎤 ${transcript ? transcript.slice(0, 180) : "Səs mesajı"}`;

// What the clip says, or "" when it cannot be fetched or heard.
async function transcribeVoice(audioUrl, { transcribe = require("./transcribe").transcribe } = {}) {
  try {
    if (!isVoiceUrl(audioUrl)) throw new Error("not a voice url");
    const r = await fetch(audioUrl, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`download ${r.status}`);
    if (Number(r.headers.get("content-length") || 0) > VOICE_MAX_BYTES) throw new Error("too large");
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > VOICE_MAX_BYTES) throw new Error("too large");
    const filename = decodeURIComponent(new URL(audioUrl).pathname.split("/").pop() || "voice.webm");
    const mimetype = r.headers.get("content-type") || "audio/webm";
    return await transcribe(buffer, { mimetype, filename });
  } catch (e) {
    console.warn("[CHAT-VOICE] not transcribed:", e?.message);
    return "";
  }
}

module.exports = { VOICE_MAX_SEC, VOICE_MAX_BYTES, VOICE_PER_DAY, isVoiceUrl, voicePreview, transcribeVoice };
