const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

/*
 * Reference files a teacher attaches to a material: a textbook page, a photo of a
 * worksheet, a syllabus PDF, a diagram to copy the style of.
 *
 * WHY THEY ARE STORED, not just passed through once. A conversation has many turns
 * and the model needs the reference on every one of them — "now add three tasks
 * like the ones on page 4" is meaningless if page 4 was only visible during the
 * first request. They live with the document and are sent with each turn.
 *
 * The store is the exam-PDF lifecycle in miniature: an absolute directory outside
 * the container layer, 32-byte random keys resolved traversal-proof, and the file
 * removed when the document is deleted. It is deliberately NOT the materials
 * library — these are working references for one material, not a shared library
 * a teacher curates.
 */

const DIR = path.resolve(process.env.LESSON_DOC_DIR || process.env.CURRICULUM_DIR || "lessonAssets", "docfiles");

const MAX_FILE_MB = 20;
const MAX_FILES = 6;
// Beyond this the request itself becomes the problem: providers cap a single
// request, and four large PDFs is a slower, costlier call than any teacher wants.
const MAX_TOTAL_MB = 32;

// Exactly what the providers can actually read, as stored. Anything else that is
// accepted arrives as one of these — an Office file is converted to a PDF on the
// way in (see trustedType / the controller), never stored as itself.
const ACCEPT = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Word, PowerPoint and spreadsheets: accepted, then converted to PDF by the
// LibreOffice already installed for the materials library. The model reads the
// PDF; the teacher sees their own filename.
const OFFICE_EXTS = new Set([".doc", ".docx", ".odt", ".rtf", ".ppt", ".pptx", ".odp", ".xls", ".xlsx", ".ods"]);

/*
 * What a file actually IS, decided from its bytes.
 *
 * The upload used to be typed by `mimetype` — a header the browser fills in from
 * the filename — and that string was the only gate between an upload and the
 * disk, the model, and every later viewer. A file renamed to .pdf was a PDF as
 * far as this code could tell. The magic bytes are the one thing about an
 * upload the client does not get to assert, so they decide here; the declared
 * type is not consulted at all.
 *
 * Returns { ok, ext, mime, office } or { ok:false, reason }. `office` marks a
 * container that still needs the deep structural pass and a conversion before
 * it can be stored — a ZIP is only a .docx once word/document.xml is in it.
 */
function trustedType({ buffer, name }) {
  const { detectHead } = require("../utils/fileValidation");
  const head = Buffer.isBuffer(buffer) ? buffer.subarray(0, 32) : Buffer.alloc(0);
  const found = detectHead(head);
  if (!found) return { ok: false, reason: "unrecognised" };

  const ext = path.extname(decodeUploadName(name)).toLowerCase();

  const direct = { pdf: ["pdf", "application/pdf"], png: ["png", "image/png"], jpg: ["jpg", "image/jpeg"], webp: ["webp", "image/webp"], gif: ["gif", "image/gif"] };
  if (direct[found.type]) {
    const [e, mime] = direct[found.type];
    return { ok: true, ext: e, mime, office: false };
  }

  // A container. Which Office format it is comes from the NAME, but only if the
  // bytes agree: .docx/.pptx/.xlsx/.od* are ZIPs, .doc/.ppt/.xls are OLE, .rtf
  // is RTF. A .docx whose bytes are not a ZIP is refused, whatever it is called.
  if (!OFFICE_EXTS.has(ext)) return { ok: false, reason: "unsupported" };
  const zipExts = new Set([".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods"]);
  const oleExts = new Set([".doc", ".ppt", ".xls"]);
  const consistent =
    (found.type === "zip" && zipExts.has(ext)) ||
    (found.type === "ole" && oleExts.has(ext)) ||
    (found.type === "rtf" && ext === ".rtf");
  if (!consistent) return { ok: false, reason: "mismatch" };
  return { ok: true, ext: ext.slice(1), mime: "", office: true };
}

/*
 * multer 1.x (busboy) decodes multipart filenames as latin1, so a UTF-8 name like
 * "Üçbucaqlar.pdf" arrives mojibaked ("Ã¼Ã§bucaqlar.pdf") — the same defect fixed
 * for assignment uploads in controllers/assignmentController.js. Re-decode the raw
 * bytes as UTF-8 to recover the real name; if that introduces a replacement
 * character that was not already there, the bytes were not valid UTF-8 in the
 * first place, so keep the original rather than corrupting it further.
 */
const decodeUploadName = (name) => {
  const raw = String(name || "");
  if (!raw) return "";
  try {
    const utf8 = Buffer.from(raw, "latin1").toString("utf8");
    if (utf8.includes("�") && !raw.includes("�")) return raw;
    return utf8;
  } catch {
    return raw;
  }
};

const isValidKey = (k) => typeof k === "string" && /^[a-f0-9]{64}$/.test(k);

function pathForKey(key, ext) {
  if (!isValidKey(key)) throw new Error("invalid doc file key");
  const safeExt = /^[a-z0-9]{1,5}$/.test(String(ext || "")) ? `.${ext}` : "";
  const p = path.join(DIR, `${key}${safeExt}`);
  // Belt and braces: the key is already constrained, but a path that escapes the
  // store is the one bug in a file helper that must be impossible.
  if (!p.startsWith(DIR + path.sep)) throw new Error("invalid doc file path");
  return p;
}

async function ensureDir() {
  await fsp.mkdir(DIR, { recursive: true });
}

/*
 * Shrink a big scanned PDF before it is sent to a model, once, and keep the copy.
 *
 * WHY. A teacher attached a 10.4 MB scan of a test bank — twelve pages at roughly
 * 870 KB each, so several hundred dpi. Providers bill a PDF as page images plus
 * text, and the studio's tool loop re-sends the whole attachment on every step of
 * a turn. That one file was the largest single line on a $2.94 turn. A scan at
 * that resolution carries no information the model can use that 200 dpi does not:
 * it is reading digits and task numbers, not inspecting paper fibre.
 *
 * WHY 200 AND NOT 150. 150 is where a cheap scan of small print starts losing
 * digits, and a misread "№ 18" in a citation is worse than a larger bill. 200 is
 * above fax resolution, comfortably legible, and still a large reduction.
 *
 * FAIL OPEN, ALWAYS. Every failure path returns the ORIGINAL: ghostscript
 * missing, a crash, a timeout, an output that is not a PDF, or one that did not
 * actually get smaller. A cost optimisation that can blind the model to a source
 * is not a cost optimisation — it is the "it acts like it read my file" bug with
 * a new cause.
 *
 * The result is content-addressed beside the original (`<key>.s200.pdf`), so the
 * conversion happens once per file rather than once per turn.
 *
 * MEASURED SCOPE — IT SAVES NO TOKENS. count_tokens on the real file, both ways:
 *
 *     original      9.95 MB, 12 pages -> 18,921 tokens
 *     downscaled    4.65 MB, 12 pages -> 18,921 tokens   (identical)
 *     pages 1-3     1.18 MB,  3 pages ->  4,755 tokens
 *
 * A provider normalises every page image to a fixed maximum dimension before
 * tokenising, so a page costs about 1,580 tokens whatever its resolution. Half
 * the bytes, exactly the same bill. What actually cuts tokens is sending fewer
 * PAGES (slicePdf below) and re-reading the prefix from cache instead of paying
 * for it again (aiDocAdapters).
 *
 * SO WHY KEEP IT. One reason, and it is not cost: the provider caps a single
 * request at 32 MB, base64 inflates a file by a third, and this store accepts up
 * to 32 MB of attachments per document — so a teacher who attaches the maximum
 * would build a request that is refused outright. Halving the biggest files
 * keeps that request inside the cap. It also cuts upload time on a slow line.
 *
 * And because bytes no longer buy anything, the settings below are tuned for
 * FIDELITY rather than size: quality 75 instead of 60, and only files large
 * enough to threaten the cap are touched at all. A JPEG artefact that turns an 8
 * into a 3 was a bad trade when it saved money; it is an indefensible one now
 * that it does not.
 *
 * Known limitation: the threshold is per FILE, while the cap applies to the
 * whole request. Several files each just under the threshold can still add up.
 * A budget-aware pass would fix that, and has not been needed yet.
 */
// 6 MB, not 2: only files big enough to threaten the 32 MB request cap are worth
// re-encoding at all, now that re-encoding is known to save no tokens.
const SLIM_OVER_BYTES = Number(process.env.LESSON_DOC_SLIM_OVER_MB || 6) * 1024 * 1024;
const SLIM_DPI = Number(process.env.LESSON_DOC_SLIM_DPI || 200);
// 75, not 60. Quality costs nothing here — the token count is the same either way.
const SLIM_JPEG_Q = Number(process.env.LESSON_DOC_SLIM_JPEG_Q || 75);
// Enough for a big scan on a busy box; a slow conversion must not hold a turn.
const SLIM_TIMEOUT_MS = 120000;

let slimWarned = false;

async function slimPdf(srcPath, key) {
  const out = path.join(DIR, `${key}.s${SLIM_DPI}.pdf`);
  if (!out.startsWith(DIR + path.sep)) return srcPath;

  // Already converted on an earlier turn.
  try {
    const done = await fsp.stat(out);
    if (done.size > 0) return out;
  } catch {
    /* not yet built */
  }

  const { execFile } = require("child_process");
  const run = () =>
    new Promise((resolve) => {
      execFile(
        "gs",
        [
          "-sDEVICE=pdfwrite",
          "-dCompatibilityLevel=1.5",
          "-dNOPAUSE",
          "-dBATCH",
          "-dQUIET",
          "-dSAFER",
          "-dDetectDuplicateImages=true",
          /*
           * These four lines are the ones that do the work, and the first
           * version of this function had none of them — it set only the
           * Downsample flags and the target resolution, and measured against a
           * real 9.95 MB scan it changed the size by nothing at all.
           *
           * Two defaults were in the way. `AutoFilter*Images` leaves the
           * ORIGINAL encoding in place, so a page stored as a bloated lossless
           * image stayed one; forcing DCTEncode re-encodes it as JPEG.
           * `*DownsampleThreshold` defaults to 1.5, meaning a 200 dpi target
           * only triggers above 300 dpi — at 1.0 any excess is downsampled.
           * With both fixed the same file came out at 4.65 MB.
           */
          "-dAutoFilterColorImages=false",
          "-dColorImageFilter=/DCTEncode",
          "-dAutoFilterGrayImages=false",
          "-dGrayImageFilter=/DCTEncode",
          "-dDownsampleColorImages=true",
          `-dColorImageResolution=${SLIM_DPI}`,
          "-dColorImageDownsampleThreshold=1.0",
          "-dDownsampleGrayImages=true",
          `-dGrayImageResolution=${SLIM_DPI}`,
          "-dGrayImageDownsampleThreshold=1.0",
          // Quality 60 keeps printed digits crisp; the artefacts JPEG introduces
          // below about 50 are exactly the kind that turn an 8 into a 3.
          `-dJPEGQ=${SLIM_JPEG_Q}`,
          // Mono (pure black-and-white line art and text) stays higher: it is
          // cheap to store and it is where thin strokes break up first.
          "-dDownsampleMonoImages=true",
          `-dMonoImageResolution=${SLIM_DPI * 2}`,
          `-sOutputFile=${out}`,
          srcPath,
        ],
        { timeout: SLIM_TIMEOUT_MS, maxBuffer: 1 << 20 },
        (err) => resolve(!err)
      );
    });

  let ok = false;
  try {
    ok = await run();
  } catch {
    ok = false;
  }
  if (!ok) {
    if (!slimWarned) {
      slimWarned = true;
      console.warn("[LESSON DOC] pdf downscale unavailable — sending originals at full size");
    }
    await fsp.unlink(out).catch(() => {});
    return srcPath;
  }

  // Verify the result before anybody relies on it: a real PDF, and smaller than
  // what we already had. "Smaller by a margin" rather than "smaller", so a file
  // that is already efficient is not replaced for a rounding error.
  try {
    const [before, after] = await Promise.all([fsp.stat(srcPath), fsp.stat(out)]);
    const head = Buffer.alloc(5);
    const fh = await fsp.open(out, "r");
    try {
      await fh.read(head, 0, 5, 0);
    } finally {
      await fh.close();
    }
    if (head.toString("latin1") !== "%PDF-" || after.size >= before.size * 0.9) {
      await fsp.unlink(out).catch(() => {});
      return srcPath;
    }
    console.log(
      `[LESSON DOC] pdf downscaled ${(before.size / 1048576).toFixed(1)}MB -> ${(after.size / 1048576).toFixed(1)}MB @${SLIM_DPI}dpi`
    );
    return out;
  } catch {
    await fsp.unlink(out).catch(() => {});
    return srcPath;
  }
}

/*
 * Store one uploaded buffer. The key is the CONTENT HASH, so attaching the same
 * page twice costs one file on disk, and re-uploading after a failure is idempotent.
 */
async function saveFile({ buffer, mime, ext: givenExt, name }) {
  // The extension comes from trustedType now, never from the declared mime; the
  // mime lookup remains only for callers that pass one of the four storable types.
  const ext = givenExt || ACCEPT[mime];
  if (!ext || !ACCEPT[mime]) throw new Error("unsupported type");
  await ensureDir();
  const key = crypto.createHash("sha256").update(buffer).digest("hex");
  const file = pathForKey(key, ext);
  await fsp.writeFile(file, buffer);
  return {
    key,
    ext,
    mime,
    bytes: buffer.length,
    name: decodeUploadName(name).slice(0, 120) || "fayl",
    at: new Date(),
  };
}

/*
 * How many pages a PDF has, so a page request can be answered or corrected.
 *
 * Ghostscript is already the tool of record here and this costs a fraction of a
 * second, but it is cached anyway: the count never changes for a content-hashed
 * file, and it is asked for on every read.
 */
const pageCounts = new Map();

async function pageCountOf(srcPath, key) {
  if (key && pageCounts.has(key)) return pageCounts.get(key);
  const { execFile } = require("child_process");
  const n = await new Promise((resolve) => {
    execFile(
      "gs",
      ["-q", "-dNODISPLAY", "-dNOSAFER", "-c", `(${srcPath}) (r) file runpdfbegin pdfpagecount = quit`],
      { timeout: 60000, maxBuffer: 1 << 16 },
      (err, stdout) => resolve(err ? 0 : Number(String(stdout).trim()) || 0)
    );
  });
  if (key && n > 0) pageCounts.set(key, n);
  return n;
}

/*
 * Parse a page request the way a person writes one: "3", "22-24", "1,4,7-9".
 *
 * Returns a normalised, de-duplicated, ascending list, or null when there is
 * nothing to parse. Deliberately forgiving about spacing and about a reversed
 * range ("24-22"), because the alternative is refusing a request whose meaning
 * is obvious. Out-of-range numbers are NOT silently dropped here — the caller
 * needs to know it was asked for a page that does not exist, so it can say the
 * page count back and let the model correct itself.
 */
function parsePages(spec) {
  const raw = String(spec == null ? "" : spec).trim();
  if (!raw) return null;
  const out = new Set();
  for (const chunk of raw.split(/[,;\s]+/).filter(Boolean)) {
    const range = chunk.match(/^(\d{1,4})\s*[-–—:]\s*(\d{1,4})$/);
    if (range) {
      let a = Number(range[1]);
      let b = Number(range[2]);
      if (a > b) [a, b] = [b, a];
      // A runaway range must not be able to ask for ten thousand pages.
      for (let p = a; p <= b && out.size < 64; p += 1) if (p >= 1) out.add(p);
      continue;
    }
    const one = chunk.match(/^(\d{1,4})$/);
    if (one && Number(one[1]) >= 1) out.add(Number(one[1]));
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

/*
 * Cut the requested pages out of a PDF, downscaled, cached on disk.
 *
 * WHY. A turn that needs three pages of a twelve-page test bank was sending all
 * twelve, every read. Measured on a real 9.95 MB scan: pages 1-3 come out at
 * 1.18 MB and a single page at 0.37 MB — 8x and 27x less. Unlike downscaling,
 * this is not a quality tradeoff at all: the model still sees the real page at
 * the same resolution, there are simply fewer of them.
 *
 * Ghostscript takes one contiguous range, so a scattered request ("1,5,9") is
 * served as the span that covers it. Spelling that out rather than hiding it:
 * the caller tells the model which pages it actually got.
 */
async function slicePdf(srcPath, key, first, last) {
  const a = Math.max(1, Number(first) || 1);
  const b = Math.max(a, Number(last) || a);
  const out = path.join(DIR, `${key}.p${a}-${b}.s${SLIM_DPI}.pdf`);
  if (!out.startsWith(DIR + path.sep)) return null;

  try {
    const done = await fsp.stat(out);
    if (done.size > 0) return out;
  } catch {
    /* not cut yet */
  }

  const { execFile } = require("child_process");
  const ok = await new Promise((resolve) => {
    execFile(
      "gs",
      [
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        "-dNOPAUSE",
        "-dBATCH",
        "-dQUIET",
        "-dSAFER",
        `-dFirstPage=${a}`,
        `-dLastPage=${b}`,
        "-dAutoFilterColorImages=false",
        "-dColorImageFilter=/DCTEncode",
        "-dAutoFilterGrayImages=false",
        "-dGrayImageFilter=/DCTEncode",
        "-dDownsampleColorImages=true",
        `-dColorImageResolution=${SLIM_DPI}`,
        "-dColorImageDownsampleThreshold=1.0",
        "-dDownsampleGrayImages=true",
        `-dGrayImageResolution=${SLIM_DPI}`,
        "-dGrayImageDownsampleThreshold=1.0",
        `-dJPEGQ=${SLIM_JPEG_Q}`,
        `-sOutputFile=${out}`,
        srcPath,
      ],
      { timeout: SLIM_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err) => resolve(!err)
    );
  });
  if (!ok) {
    await fsp.unlink(out).catch(() => {});
    return null;
  }
  // A slice that is not a PDF is worse than no slice: the caller would send
  // rubbish and the model would report it could not read the source.
  try {
    const head = Buffer.alloc(5);
    const fh = await fsp.open(out, "r");
    try {
      await fh.read(head, 0, 5, 0);
    } finally {
      await fh.close();
    }
    if (head.toString("latin1") !== "%PDF-") {
      await fsp.unlink(out).catch(() => {});
      return null;
    }
    return out;
  } catch {
    await fsp.unlink(out).catch(() => {});
    return null;
  }
}

/*
 * One attachment, optionally only some of its pages, as a provider part.
 *
 * Returns what was actually served alongside the bytes — the page span and the
 * file's true page count — because the request and the answer are allowed to
 * differ and the model has to be told when they do. A teacher's scan is numbered
 * by its PRINTED pages ("с. 22-33") while the file has twelve; a model asking
 * for page 22 of a twelve-page file is being reasonable and needs the count, not
 * a failure.
 */
async function partForPages(file, spec) {
  const src = pathForKey(file.key, file.ext);
  const isPdf = file.mime === "application/pdf";
  const pages = isPdf ? parsePages(spec) : null;
  const total = isPdf ? await pageCountOf(src, file.key) : 0;

  if (pages && total > 0) {
    const inRange = pages.filter((p) => p <= total);
    if (!inRange.length) {
      return { part: null, total, served: null, outOfRange: true };
    }
    const cut = await slicePdf(src, file.key, inRange[0], inRange[inRange.length - 1]);
    if (cut) {
      const buf = await fsp.readFile(cut);
      return {
        part: { mime: file.mime, data: buf.toString("base64"), isPdf: true },
        total,
        served: { from: inRange[0], to: inRange[inRange.length - 1] },
        outOfRange: inRange.length !== pages.length,
      };
    }
    // Slicing failed — fall through and send the whole file rather than nothing.
  }

  const { parts } = await toParts([file]);
  return { part: parts[0] || null, total, served: null, outOfRange: false };
}

/*
 * Read the attachments back in the shape the AI document path already speaks —
 * and REPORT the ones that could not be read.
 *
 * This used to swallow an unreadable file with a console line. That is the worst
 * possible outcome for a grounded material: the teacher attached a textbook page,
 * the model never received it, and the answer came back written from general
 * knowledge in exactly the same confident tone. Nothing anywhere said the source
 * had been dropped, so "based on the page I gave you" was unfalsifiable.
 *
 * The turn still runs on what WAS readable — a teacher would rather have the
 * material than an error — but the caller now knows what is missing and can say
 * so, and can refuse outright when nothing at all could be read.
 */
async function toParts(files = []) {
  const parts = [];
  const unreadable = [];
  for (const f of files) {
    try {
      const src = pathForKey(f.key, f.ext);
      /*
       * A large scan is downscaled first — the same bytes the model needs, a
       * fraction of the tokens. slimPdf returns the original on ANY problem, so
       * this cannot be the reason a source goes unread.
       */
      let readFrom = src;
      if (f.mime === "application/pdf") {
        // eslint-disable-next-line no-await-in-loop
        const big = await fsp.stat(src).then((s) => s.size > SLIM_OVER_BYTES).catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        if (big) readFrom = await slimPdf(src, f.key);
      }
      // eslint-disable-next-line no-await-in-loop
      const buf = await fsp.readFile(readFrom);
      /*
       * The key travels with the part. Without it the caller holds an anonymous
       * blob: the native engine matched extracted text to parts by `part.name`,
       * which was never set, so `readByName.get(undefined)` missed every time
       * and NO PDF was ever dropped from the paid request — while its extracted
       * text went into the prompt as well. Every textbook was billed twice, and
       * the feature's whole reason for existing quietly did nothing.
       */
      parts.push({
        key: f.key,
        name: f.name || "",
        mime: f.mime,
        data: buf.toString("base64"),
        isPdf: f.mime === "application/pdf",
      });
    } catch {
      console.error("[LESSON DOC] attachment unreadable:", f.key);
      unreadable.push(f.name || "fayl");
    }
  }
  return { parts, unreadable };
}

/*
 * A text-first source path for the platform renderer. Sending a whole textbook PDF
 * as vision input is the largest avoidable lesson cost. Ghostscript is already used
 * by the evidence tools, so extract a bounded text sample locally and send that as
 * prompt context; image-only PDFs still use the existing file part unchanged.
 */
const NATIVE_MAX_PAGES = 12;
const NATIVE_MAX_CHARS = 12000;
// Below this much REAL text a PDF is treated as a scan. A page label is not text:
// twelve empty pages still produce "[Səhifə 1]…[Səhifə 12]", which sailed past a
// naive length check and convinced the caller a scanned worksheet was readable —
// so the file was dropped from the request and the model was handed nothing but
// page numbers.
const NATIVE_MIN_TEXT = 200;
// Below this, a page gave no usable text of its own: a scan, or a page that is
// one large figure. Either way the file still has to travel.
const MIN_PAGE_TEXT = 40;

// A single content stream larger than this is not examined; the PDF is kept
// instead. No real page stream approaches it, so this bounds memory without
// deciding anything — too big to look at is not the same as looked at and found
// empty, and the previous version's shared budget could be exhausted by a long
// document before the page with the diagram on it was ever reached.
const MAX_STREAM_CHARS = 32 * 1024 * 1024;

/*
 * A stream that cannot be decoded but cannot hold a drawing either.
 *
 * Embedded fonts are the common case: a TrueType or CFF program is binary, does
 * not inflate, and is present in every PDF with text in it. Treating those
 * skips as "something might be hidden here" marked every typeset document as
 * having drawings — the conservative answer, but so conservative it switched
 * the saving off entirely. Measured on a plain Chromium text PDF: five streams,
 * two of them fonts.
 *
 * Judged by the object dictionary that precedes the stream, which is not
 * compressed. Anything NOT recognised here is still treated as a content
 * stream, so the caution stays where it matters.
 */
const BENIGN_STREAM = /\/(FontFile[23]?|Metadata|ICCBased|Length1|Type1C|CIDFontType0C|OpenType|XML)\b/;

/*
 * Every way a content stream is commonly wrapped, tried in turn.
 *
 * Streams are not simply Flate. `/ASCII85Decode /FlateDecode` is an ordinary
 * chain in PDFs from other tools, and inflating those bytes directly fails —
 * which the first version treated as "skip this one", so text-only files from
 * outside kept being sent in full and the saving never applied to them.
 *
 * Nothing here parses the stream dictionary to find out which filter was used.
 * Each decoding is simply attempted; the one that works, works. That is shorter
 * than a filter parser and cannot be fooled by a dictionary it fails to find.
 */
function decodeAscii85(text) {
  const body = text.replace(/^\s*<~/, "").replace(/~>[\s\S]*$/, "").replace(/\s+/g, "");
  const out = [];
  let tuple = 0;
  let count = 0;
  for (const ch of body) {
    if (ch === "z" && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const v = ch.charCodeAt(0) - 33;
    if (v < 0 || v > 84) throw new Error("not ascii85");
    tuple = tuple * 85 + v;
    count += 1;
    if (count === 5) {
      out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i += 1) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255];
    out.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(out);
}

function decodeAsciiHex(text) {
  const body = text.replace(/>[\s\S]*$/, "").replace(/[^0-9a-fA-F]/g, "");
  if (!body.length) throw new Error("not asciihex");
  return Buffer.from(body.length % 2 ? body + "0" : body, "hex");
}

/*
 * Decompress one stream, refusing to blow up over it.
 *
 * `maxOutputLength` bounds the work inside zlib rather than after it. The size
 * check used to happen on the finished string, which fails closed for
 * correctness but only once the memory had already been allocated — a
 * decompression bomb was still decompressed in full before anyone objected.
 *
 * Returns the text, OVERSIZE when it refused on size, or null when nothing
 * could read it. Those three are different answers and the caller treats them
 * differently: only null is a maybe.
 */
const OVERSIZE = Symbol("oversize");

function readStream(bytes) {
  const zlib = require("zlib");
  const limit = { maxOutputLength: MAX_STREAM_CHARS };
  const attempts = [
    () => zlib.inflateSync(bytes, limit),
    () => zlib.inflateRawSync(bytes, limit),
    () => zlib.unzipSync(bytes, limit),
    () => zlib.inflateSync(decodeAscii85(bytes.toString("latin1")), limit),
    () => zlib.inflateSync(decodeAsciiHex(bytes.toString("latin1")), limit),
  ];
  for (const attempt of attempts) {
    try {
      const out = attempt();
      if (out && out.length) return out.toString("latin1");
    } catch (e) {
      // Refused on size: the stream is real and readable, just too big to look
      // at. That is a verdict, not a failure to try the next wrapping.
      if (e && (e.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength/i.test(e.message || ""))) {
        return OVERSIZE;
      }
      /* wrong wrapping: try the next */
    }
  }
  // An uncompressed content stream is legal and needs no decoding at all.
  const plain = bytes.toString("latin1");
  if (plain.length > MAX_STREAM_CHARS) return OVERSIZE;
  if (/\bBT\b|\bET\b|\bTj\b|\bre\b|\bcm\b/.test(plain)) return plain;
  return null;
}

/*
 * A content stream, read as PDF rather than as text.
 *
 * Regexes over the raw bytes kept failing in both directions, and the failures
 * were not fixable by a better pattern:
 *
 *   "(100% complete)" — the % begins a comment only OUTSIDE a string, so
 *   stripping to end-of-line threw away the rest of the line and with it the
 *   diagonal that followed. A drawing vanished.
 *
 *   "(Find y given the equation)" — the y is a letter in a sentence, not the
 *   curve operator, so an ordinary worksheet was called a diagram and never
 *   qualified for the saving.
 *
 *   "re W S" and "re 1 0 0 RG S" — the paint operator need not follow `re`
 *   immediately; a clip flag or a colour change may sit between. Both draw a
 *   visible rectangle and both were read as painting nothing.
 *
 * So the stream is tokenised. It is a small grammar — whitespace, delimiters,
 * comments, literal and hex strings, names, numbers, operators — and knowing
 * where a string begins and ends is the whole difference.
 */
function* contentTokens(src) {
  const n = src.length;
  let i = 0;
  const isWs = (c) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
  const isDelim = (c) => c === "(" || c === ")" || c === "<" || c === ">" || c === "[" || c === "]" || c === "{" || c === "}" || c === "/" || c === "%";

  while (i < n) {
    const c = src[i];
    if (isWs(c)) { i += 1; continue; }

    // A comment, but only here — outside a string.
    if (c === "%") {
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i += 1;
      continue;
    }

    // A literal string: parentheses nest, and a backslash escapes the next byte.
    if (c === "(") {
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        const ch = src[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        i += 1;
      }
      continue; // an operand, never an operator
    }

    if (c === "<") {
      if (src[i + 1] === "<") { i += 2; continue; } // dictionary
      while (i < n && src[i] !== ">") i += 1; // hex string
      i += 1;
      continue;
    }
    if (c === ">") { i += src[i + 1] === ">" ? 2 : 1; continue; }
    if (c === "[" || c === "]" || c === "{" || c === "}") { i += 1; continue; }

    if (c === "/") { // a name
      i += 1;
      while (i < n && !isWs(src[i]) && !isDelim(src[i])) i += 1;
      continue;
    }

    let j = i;
    while (j < n && !isWs(src[j]) && !isDelim(src[j])) j += 1;
    const token = src.slice(i, j);
    i = j === i ? i + 1 : j;
    if (token) yield token;
  }
}

const IS_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
// Operators that build a path. None of them is a mark on its own.
const PATH_OPS = new Set(["m", "l", "c", "v", "y", "re", "h"]);
// Operators that put the built path on the page.
const PAINT_OPS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*"]);

/*
 * What one content stream does, as a verdict rather than a boolean.
 *
 *   DRAWS      a path was built AND painted, both inside this stream.
 *   UNCERTAIN  the stream begins or ends mid-path, so its other half is in
 *              another stream and this one cannot be judged alone.
 *   CLEAN      nothing was painted.
 *
 * The middle answer is the point. A page's content may legally be split across
 * several streams, stored in any order, and reached through the page's
 * /Contents array — so "the stream before this one in the file" is not
 * necessarily the stream before this one on the page. Carrying a tail of text
 * between them papered over the simplest case and failed two others: a path
 * built, then more than the tail's worth of colour settings, then a stroke; and
 * objects stored in reverse of their /Contents order.
 *
 * Rather than resolve the page tree to put them back in order, a stream that
 * does not contain a whole path keeps the PDF. A well-formed stream that draws
 * nothing never ends mid-path and never paints one it did not build, so this
 * costs nothing on the documents the saving is for, and refuses exactly the
 * ones whose drawings span a boundary.
 */
const DRAWS = "draws";
const UNCERTAIN = "uncertain";
const CLEAN = "clean";

function streamVerdict(text) {
  let pending = false;
  for (const token of contentTokens(text)) {
    if (IS_NUMBER.test(token)) continue;
    if (PATH_OPS.has(token)) { pending = true; continue; }
    if (token === "n") { pending = false; continue; } // clipped, or thrown away
    if (PAINT_OPS.has(token)) {
      if (pending) return DRAWS;
      // Painting a path this stream never built: the path came from elsewhere.
      return UNCERTAIN;
    }
    if (token === "sh" || token === "BI") return DRAWS;
    // Anything else — W, W*, a colour, a graphics state — leaves the path alone.
  }
  // Built a path and never painted it: the painting is in another stream.
  return pending ? UNCERTAIN : CLEAN;
}

/*
 * Where this stream actually ends, according to the file.
 *
 * Searching for the next "endstream" is a guess, and an uncompressed stream can
 * contain those very letters — a worksheet with the word in its text ends the
 * stream early, everything after the false boundary is never read, and a
 * diagram past it is invisible. /Length is the file telling us the answer.
 *
 * It may be an indirect reference ("/Length 12 0 R"), which is ordinary in
 * files written in one pass, so that object is resolved too. The result is only
 * used when it lands where a stream should end; anything else is not trusted.
 */
function declaredLength(raw, dict) {
  const m = dict.match(/\/Length\s+(\d+)(?:\s+(\d+)\s+R\b)?/);
  if (!m) return null;
  if (m[2] === undefined) return Number(m[1]);
  const found = raw.match(new RegExp(`(?:^|[^0-9])${m[1]}\\s+${m[2]}\\s+obj\\b([\\s\\S]{0,64}?)endobj`));
  const n = found && found[1].match(/\d+/);
  return n ? Number(n[0]) : null;
}

/*
 * The object dictionary that introduces THIS stream, and nothing else.
 *
 * A fixed lookback of several hundred bytes reached into whatever object
 * happened to sit before it, so a drawing stream that would not decode could be
 * waved through because a font object nearby mentioned /FontFile2. The
 * dictionary starts at this object's own "N G obj", so that is where to look
 * from.
 */
function ownDictionary(raw, streamAt) {
  const window = raw.slice(Math.max(0, streamAt - 4096), streamAt);
  const marks = [...window.matchAll(/\d+\s+\d+\s+obj\b/g)];
  const from = marks.length ? marks[marks.length - 1].index : 0;
  return window.slice(from);
}

/*
 * Does this PDF draw anything the text extractor cannot hand over?
 *
 * Raster content leaves markers in the object dictionaries that survive in the
 * raw bytes. Vector content is drawing operators inside a compressed content
 * stream, so the streams are decoded and read as they come.
 *
 * Streams are read one at a time, and any stream that does not contain a WHOLE
 * path keeps the PDF. A page's content may legally be split across several
 * streams, stored in any order and sequenced by its /Contents array, so a
 * drawing can begin in one object and be painted in another.
 *
 * Every uncertainty answers YES and keeps the PDF in the request: an unreadable
 * file, a stream that would not decode, one too large to examine, an unfamiliar
 * shape. The cost of a wrong yes is tokens; the cost of a wrong no is a diagram
 * the teacher can see, that the model never received, answered in the same
 * confident tone. Those are not comparable, so the bias is not symmetric.
 */
async function pdfHasDrawings(src) {
  let buf;
  try {
    buf = await fsp.readFile(src);
  } catch {
    return true;
  }
  const raw = buf.toString("latin1");
  if (/\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/JBIG2Decode/.test(raw)) {
    return true;
  }

  let seen = 0;
  let read = 0;
  /*
   * CR alone is a legal separator in the wild. Ordered longest-first so that
   * "\r\n" is never matched as "\r" with the newline left behind.
   */
  const re = /stream(?:\r\n|\n|\r)/g;
  let m;
  while ((m = re.exec(raw))) {
    const from = m.index + m[0].length;
    const to = raw.indexOf("endstream", from);
    if (to < 0) break;
    /*
     * A real stream is introduced by its dictionary, so the bytes before the
     * keyword end in ">>". Without this the scan also matched the letters
     * "stream" occurring INSIDE another stream's compressed payload.
     */
    const before = raw.slice(Math.max(0, m.index - 600), m.index);
    if (!/>>\s*$/.test(before)) continue;

    const dict = ownDictionary(raw, m.index);
    /*
     * A font program is not page content, and it inflates perfectly well.
     *
     * This check used to run only when decoding FAILED, which was enough while
     * the scan looked for "digit, whitespace, operator" — binary glyph data
     * rarely spells that. Reading the stream as tokens, it spells everything:
     * 60KB of compressed outlines contains stray letters that look like path
     * and paint operators, and every typeset page was suddenly a drawing.
     *
     * Glyphs reach the page through text operators in the content stream, so a
     * font, an ICC profile or a metadata blob cannot put a mark there itself.
     */
    if (BENIGN_STREAM.test(dict)) continue;

    seen += 1;

    /*
     * Prefer the declared length, and check that it lands where a stream ends.
     * A wrong /Length is worse than none, so it has to point at "endstream"
     * before it is believed.
     */
    const declared = declaredLength(raw, dict);
    let end = to;
    let trusted = false;
    if (declared !== null && declared >= 0 && from + declared <= raw.length) {
      const at = from + declared;
      if (/^\s*endstream/.test(raw.slice(at, at + 32))) {
        end = at;
        trusted = true;
      }
    }

    /*
     * The bytes, without the end-of-line that separates them from `endstream`.
     * zlib tolerates that trailing byte; gunzip does not.
     */
    const body = raw.slice(from, end).replace(/[\r\n]+$/, "");
    const text = readStream(Buffer.from(body, "latin1"));

    if (text === OVERSIZE) return true; // real, readable, too big to examine
    // A stream nobody could read might be the one with the picture in it. The
    // ones that cannot be are already gone, above.
    if (text === null) return true;
    /*
     * An UNCOMPRESSED stream whose end was guessed cannot be trusted to be
     * whole: the guess stops at the first "endstream", which its own text may
     * contain, and everything after that — including a diagram — was never
     * looked at. A compressed stream does not need this guard, because a
     * truncated deflate stream fails to inflate and has already been handled
     * above as unreadable.
     */
    if (!trusted && text === body) return true;

    // A stream that does not hold a whole path keeps the PDF: its other half is
    // in another stream, and the page may store them in any order.
    if (streamVerdict(text) !== CLEAN) return true;
    read += 1;
  }

  // Nothing could be read at all, but there were streams to read.
  return read === 0 && seen > 0;
}

/*
 * Extracted text, remembered.
 *
 * A key is the sha256 of the file's contents, so what Ghostscript reads out of
 * it can never change: the same key is always the same bytes. Without this, a
 * document holding six PDFs re-ran a page count plus up to twelve extractions
 * per file on EVERY turn — around seventy subprocesses to answer "make the page
 * numbers green". No provider money, but seconds of latency and a busy box.
 *
 * Bounded, and oldest-out: this is a cache, not a store.
 */
const EXTRACT_CACHE = new Map();
const EXTRACT_CACHE_MAX = 200;

function cacheExtraction(key, value) {
  if (!key) return value;
  if (EXTRACT_CACHE.size >= EXTRACT_CACHE_MAX) {
    EXTRACT_CACHE.delete(EXTRACT_CACHE.keys().next().value);
  }
  EXTRACT_CACHE.set(key, value);
  return value;
}

async function nativeSourceText(files = []) {
  const out = [];
  const evidence = require("./curriculumEvidence");
  for (const f of files) {
    if (f?.mime !== "application/pdf") continue;
    if (f.key && EXTRACT_CACHE.has(f.key)) {
      const hit = EXTRACT_CACHE.get(f.key);
      if (hit) out.push({ ...hit, name: f.name || hit.name });
      continue;
    }
    try {
      const src = pathForKey(f.key, f.ext);
      const pages = await evidence.pdfPageCount(src);
      const read = Math.min(NATIVE_MAX_PAGES, pages);
      const chunks = [];
      let extracted = 0; // characters of ACTUAL page text, labels excluded
      let thinPages = 0; // pages that gave little or nothing: scans, or figures
      for (let page = 0; page < read && extracted < NATIVE_MAX_CHARS; page += 1) {
        // eslint-disable-next-line no-await-in-loop
        const body = String((await evidence.pdfPageText(src, page)) || "").replace(/\s+/g, " ").trim();
        if (body.length < MIN_PAGE_TEXT) thinPages += 1;
        if (!body) continue;
        extracted += body.length;
        chunks.push(`[Səhifə ${page + 1}] ${body}`);
      }
      /*
       * Does this PDF hold anything a reader can SEE but the extractor cannot
       * read? A worksheet is usually text with a diagram on it, and a textbook
       * chapter often has one scanned page among typeset ones — in both cases
       * the words come out and the picture does not.
       *
       * Two signals, either of which keeps the file in the request:
       *   a page that gave little or no text — a scan, or a full-page figure;
       *   an embedded image anywhere in the bytes.
       *
       * The byte scan is deliberately crude. It can miss an image hidden inside
       * a compressed object stream, which is why the per-page check stands
       * beside it, and the two together fail in the safe direction: a doubtful
       * PDF travels, costing tokens, instead of a diagram silently not reaching
       * the model while the answer claims to be based on it.
       */
      // eslint-disable-next-line no-await-in-loop
      const hasDrawings = await pdfHasDrawings(src);

      if (extracted < NATIVE_MIN_TEXT) {
        /*
         * Not cached. A read can come back empty for reasons that are not about
         * the file — Ghostscript missing, a busy box, a transient failure — and
         * remembering "unreadable" would keep a perfectly good textbook out of
         * the prompt for the rest of the process's life. Re-reading a scan costs
         * a few subprocesses; getting it permanently wrong costs the lesson.
         */
        continue;
      }
      out.push(cacheExtraction(f.key, {
        key: f.key,
        name: f.name || "PDF",
        text: chunks.join("\n").slice(0, NATIVE_MAX_CHARS),
        pages,
        pagesRead: read,
        thinPages,
        hasDrawings,
        /*
         * `complete` means one thing only: the extracted text can STAND IN for
         * the file, so the file itself need not be sent. That requires every
         * page to have been read (a 40-page textbook stopped at page 12 leaves
         * the exercise on page 30 in the part nobody sent), every page to have
         * actually given text, and nothing visual to be left behind.
         */
        complete:
          read >= pages &&
          extracted < NATIVE_MAX_CHARS &&
          thinPages === 0 &&
          !hasDrawings,
      }));
    } catch {
      // No local extractor, or an unreadable file: the original PDF part stands.
    }
  }
  return out;
}

/*
 * Remove a file only when NO document still references it. The key is a content
 * hash, so two materials that attached the same page share one file on disk and
 * deleting one of them must not blind the other.
 */
async function removeIfUnused(key, ext, stillUsed) {
  if (stillUsed) return false;
  try {
    await fsp.unlink(pathForKey(key, ext));
    /*
     * And every copy DERIVED from it — the downscaled whole and each cached page
     * slice. They are useless without the original and nothing would ever look
     * for them again, so leaving them behind reintroduces exactly the orphan
     * problem this store was built to avoid, by way of a cache.
     *
     * Matched by the `<key>.` prefix rather than by reconstructing each name: the
     * set of derived shapes has already grown once (a downscale, then per-page
     * slices at varying resolutions) and a list of guesses would silently miss
     * whatever is added next. The key is 64 hex characters, so the prefix cannot
     * collide with another file's.
     *
     * Best-effort: the original is already gone, so a failure here leaves a stray
     * file, not a blinded document.
     */
    if (isValidKey(key)) {
      const derived = await fsp.readdir(DIR).catch(() => []);
      await Promise.all(
        derived
          .filter((n) => n.startsWith(`${key}.`) && n !== `${key}.${ext}`)
          .map((n) => fsp.unlink(path.join(DIR, n)).catch(() => {}))
      );
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DIR,
  ACCEPT,
  MAX_FILE_MB,
  MAX_FILES,
  MAX_TOTAL_MB,
  SLIM_DPI,
  SLIM_JPEG_Q,
  SLIM_OVER_BYTES,
  saveFile,
  trustedType,
  OFFICE_EXTS,
  toParts,
  nativeSourceText,
  pdfHasDrawings,
  partForPages,
  parsePages,
  pageCountOf,
  slicePdf,
  pathForKey,
  slimPdf,
  removeIfUnused,
  isValidKey,
};
