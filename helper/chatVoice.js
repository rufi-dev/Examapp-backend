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

// What the clip says, heard twice ({ text, alt }, see helper/transcribe), or empty when it cannot be fetched or heard.
async function hearVoice(audioUrl, { hear = require("./transcribe").hear } = {}) {
  try {
    if (!isVoiceUrl(audioUrl)) throw new Error("not a voice url");
    const r = await fetch(audioUrl, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`download ${r.status}`);
    if (Number(r.headers.get("content-length") || 0) > VOICE_MAX_BYTES) throw new Error("too large");
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > VOICE_MAX_BYTES) throw new Error("too large");
    const filename = decodeURIComponent(new URL(audioUrl).pathname.split("/").pop() || "voice.webm");
    const mimetype = r.headers.get("content-type") || "audio/webm";
    const heard = await hear(buffer, { mimetype, filename });
    return { text: heard?.text || "", alt: heard?.alt || "" };
  } catch (e) {
    console.warn("[CHAT-VOICE] not transcribed:", e?.message);
    return { text: "", alt: "" };
  }
}

// What the clip says, or "" when it cannot be fetched or heard.
async function transcribeVoice(audioUrl, { transcribe = require("./transcribe").transcribe } = {}) {
  return (await hearVoice(audioUrl, { hear: async (buf, o) => ({ text: await transcribe(buf, o), alt: "" }) })).text;
}

// How the AI reads a voice note: its text, and the second hearing when the two differ.
const voiceForAi = (text, alt) =>
  text ? `[səs mesajı] ${text}${alt ? ` (başqa cür də eşidildi: «${alt}»)` : ""}` : "[səs mesajı göndərdi, amma eşidilmədi]";

module.exports = { VOICE_MAX_SEC, VOICE_MAX_BYTES, VOICE_PER_DAY, isVoiceUrl, voicePreview, hearVoice, transcribeVoice, voiceForAi };
