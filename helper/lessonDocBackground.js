/*
 * A teacher's own paper, taken off their PDF and put under our text.
 *
 * "Make it identical" used to be impossible without handing layout to the model,
 * which is the expensive architecture this engine exists to replace. It turns out
 * not to need the model at all: a PDF page is drawn in layers, and Ghostscript
 * will render it with the TEXT LAYER SUPPRESSED. What comes back is the design —
 * the letterhead band, the border, the watermark, the tint, the logo — with every
 * word gone, and the platform's own text renders on top of it.
 *
 * Zero model tokens. Deterministic. The preview and the exported PDF use the same
 * image, so they stay the same document, which is the promise the whole engine
 * rests on.
 *
 * Two ways to take it, because two different things get called "the design":
 *
 *   keepText: false — the words are removed. Right for a filled-in worksheet or
 *     a page of content, whose text would otherwise sit under the new material.
 *   keepText: true — the page exactly as it is. Right for a letterhead, where
 *     the school's NAME is set as text and removing it guts the thing being
 *     copied. A logo drawn as an image survives either way.
 */
const path = require("path");
const fsp = require("fs/promises");
const { execFile } = require("child_process");

// A4 at 150dpi is 1240x1754 — sharp enough that a hairline border still reads as
// a line when printed, small enough to inline in every render.
const DPI = Number(process.env.LESSON_DOC_BG_DPI || 150);
// A background that costs more than the material it decorates is not a
// background. Past this the page is re-rendered coarser rather than refused.
const MAX_BYTES = Number(process.env.LESSON_DOC_BG_MAX_KB || 1400) * 1024;
const FALLBACK_DPI = 96;
const TIMEOUT_MS = 25000;

const IMAGE_MIME = /^image\/(png|jpe?g|webp)$/i;

const run = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 }, (err) => (err ? reject(err) : resolve()));
  });

/*
 * Render page one of a PDF to a PNG.
 *
 * `-dFILTERTEXT` is the whole trick: Ghostscript draws every graphic and skips
 * every glyph. `-dFirstPage/-dLastPage 1` because a background is one page by
 * definition — a letterhead repeated on every sheet, not a document.
 */
async function renderPage(src, out, { keepText, dpi }) {
  const args = [
    "-q",
    "-dNOPAUSE",
    "-dBATCH",
    "-dSAFER",
    "-dFirstPage=1",
    "-dLastPage=1",
    ...(keepText ? [] : ["-dFILTERTEXT"]),
    "-sDEVICE=png16m",
    `-r${dpi}`,
    `-sOutputFile=${out}`,
    src,
  ];
  await run("gs", args);
}

/*
 * How much of this page is text?
 *
 * Decides the default so a teacher does not have to understand the distinction:
 * a page that is mostly words is content and its text must go; a page with a few
 * words is a letterhead and they are part of the design. Measured by rendering
 * twice and comparing sizes, which costs one extra cheap render at low dpi and
 * needs no PDF parsing at all.
 */
async function looksLikeContent(src, tmpDir) {
  try {
    const full = path.join(tmpDir, "probe-full.png");
    const bare = path.join(tmpDir, "probe-bare.png");
    await renderPage(src, full, { keepText: true, dpi: 40 });
    await renderPage(src, bare, { keepText: false, dpi: 40 });
    const [a, b] = await Promise.all([fsp.stat(full), fsp.stat(bare)]);
    await Promise.all([fsp.rm(full, { force: true }), fsp.rm(bare, { force: true })]);
    if (!a.size) return false;
    // A page whose ink is mostly glyphs loses a lot when they go.
    return (a.size - b.size) / a.size > 0.2;
  } catch {
    // Undecidable: keep the page whole. Removing a letterhead's name is the
    // more damaging mistake of the two, and the teacher can switch.
    return false;
  }
}

/*
 * Take the background off an attachment.
 *
 * `keepText` undefined means "decide for me", which is what a teacher who just
 * asked for the design actually wants. An already-flat image is used as it is —
 * there are no layers to separate.
 *
 * Returns { buffer, mime, keptText } or null when there is nothing to take.
 */
async function extractBackground(srcPath, mime, { keepText } = {}) {
  if (IMAGE_MIME.test(String(mime || ""))) {
    const buffer = await fsp.readFile(srcPath);
    return { buffer, mime, keptText: true };
  }
  if (!/pdf/i.test(String(mime || ""))) return null;

  const tmpDir = path.dirname(srcPath);
  const decided = typeof keepText === "boolean" ? keepText : !(await looksLikeContent(srcPath, tmpDir));
  const out = path.join(tmpDir, `bg-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    await renderPage(srcPath, out, { keepText: decided, dpi: DPI });
    let buffer = await fsp.readFile(out);
    if (buffer.length > MAX_BYTES) {
      // Too heavy to carry into every render. Coarser beats refusing: a slightly
      // soft letterhead is still the teacher's letterhead.
      await fsp.rm(out, { force: true });
      await renderPage(srcPath, out, { keepText: decided, dpi: FALLBACK_DPI });
      buffer = await fsp.readFile(out);
    }
    return { buffer, mime: "image/png", keptText: decided, safe: await safeArea(buffer) };
  } catch {
    // Encrypted, malformed, or Ghostscript refused it. The material is still a
    // material; it simply does not get the decoration.
    return null;
  } finally {
    await fsp.rm(out, { force: true }).catch(() => {});
  }
}

/*
 * Where on this page is it safe to write?
 *
 * A letterhead is not a flat wash: it has a band at the top and often a bar at
 * the bottom, and text laid out on the page's ordinary margins lands inside them.
 * The first render of this feature put a heading across a school's blue header,
 * which looks less like a design and more like a fault.
 *
 * So the page is measured. Each row of pixels is compared against the colour of
 * the page's middle - taken as "the paper" - and a row that differs on more than
 * a few percent of its width is decorated. The first and last clear rows bound
 * the area the material may use, and the renderer's margins are set from them.
 *
 * Returned as FRACTIONS of the page, so they survive any paper size the material
 * is later printed at.
 */
async function safeArea(png) {
  try {
    const sharp = require("sharp");
    const { data, info } = await sharp(png).removeAlpha().resize({ width: 120, fit: "fill" })
      .raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const at = (x, y) => {
      const i = (y * width + x) * channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    // The paper's own colour, read from the middle of the page where a design
    // is least likely to be - a tint counts as paper, not as decoration.
    const [pr, pg, pb] = at(Math.floor(width / 2), Math.floor(height / 2));
    const differs = (x, y) => {
      const [r, g, b] = at(x, y);
      return Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb) > 60;
    };
    const busy = (y) => {
      let n = 0;
      for (let x = 0; x < width; x += 1) if (differs(x, y)) n += 1;
      return n / width > 0.06;
    };
    let top = 0;
    while (top < height && busy(top)) top += 1;
    let bottom = height - 1;
    while (bottom > top && busy(bottom)) bottom -= 1;
    /*
     * A page that is decorated edge to edge - a full-bleed photograph, a heavy
     * border - would otherwise squeeze the material into nothing. Past a third
     * of the page the measurement is not trusted and the ordinary margins stand.
     */
    const topF = top / height;
    const botF = (height - 1 - bottom) / height;
    return {
      top: topF > 0 && topF < 0.34 ? Number(topF.toFixed(4)) : 0,
      bottom: botF > 0 && botF < 0.34 ? Number(botF.toFixed(4)) : 0,
    };
  } catch {
    return { top: 0, bottom: 0 };
  }
}

/*
 * Did the teacher ask for the design?
 *
 * Read locally, like the print settings, so wanting a letterhead costs nothing.
 * Whole words only — "fonu" must not be found inside another word — and a
 * negation anywhere near it means the opposite: "fonu götürmə" has to switch the
 * background OFF rather than on.
 */
const WANT = /(^|\s)(fon|fonu|fonunu|arxafon|dizayn|dizayni|dizaynı|şablon|sablon|blank|letterhead|background|eyni|identik|oxşar)(\s|$|[,.!?])/i;
/*
 * `\S*` where a suffix goes, never `\w*`.
 *
 * JavaScript's \w is [A-Za-z0-9_], so it matches "dizayn" and then refuses the
 * "ı" that Azerbaijani puts on the end of it. "dizaynı ləğv et" - cancel the
 * design - therefore failed the negation test and was read as a REQUEST for one,
 * which is the opposite of what was asked. Every noun here takes case endings,
 * so every one of them needs this.
 */
const OFF = /(fon|dizayn|şablon|sablon|background)\S*\s+(götürmə|goturme|silmə|silme|olmasın|olmasin|istəmirəm|istemirem|ləğv|legv|çıxar|cixar)/i;
const KEEP_TEXT = /(mətn|metn|yazı|yazi|ad|başlıq|basliq|text)\S*\s+(qalsın|qalsin|saxla|saxlansın|saxlansin)/i;
const DROP_TEXT = /(mətn|metn|yazı|yazi|text)\S*\s+(sil|silin|silinsin|götür|gotur|olmasın|olmasin|çıxar|cixar)/i;

function backgroundIntent(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  if (OFF.test(s)) return { remove: true };
  if (!WANT.test(s)) return null;
  if (KEEP_TEXT.test(s)) return { want: true, keepText: true };
  if (DROP_TEXT.test(s)) return { want: true, keepText: false };
  return { want: true }; // let the page decide
}

module.exports = { extractBackground, backgroundIntent, safeArea, DPI, MAX_BYTES };
