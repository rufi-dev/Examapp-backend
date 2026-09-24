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
      parts.push({ mime: f.mime, data: buf.toString("base64"), isPdf: f.mime === "application/pdf" });
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

async function nativeSourceText(files = []) {
  const out = [];
  const evidence = require("./curriculumEvidence");
  for (const f of files) {
    if (f?.mime !== "application/pdf") continue;
    try {
      const src = pathForKey(f.key, f.ext);
      const pages = await evidence.pdfPageCount(src);
      const read = Math.min(NATIVE_MAX_PAGES, pages);
      const chunks = [];
      let extracted = 0; // characters of ACTUAL page text, labels excluded
      for (let page = 0; page < read && extracted < NATIVE_MAX_CHARS; page += 1) {
        // eslint-disable-next-line no-await-in-loop
        const body = String((await evidence.pdfPageText(src, page)) || "").replace(/\s+/g, " ").trim();
        if (!body) continue;
        extracted += body.length;
        chunks.push(`[Səhifə ${page + 1}] ${body}`);
      }
      if (extracted < NATIVE_MIN_TEXT) continue; // a scan: keep the file itself
      out.push({
        name: f.name || "PDF",
        text: chunks.join("\n").slice(0, NATIVE_MAX_CHARS),
        pages,
        // Whether the local read covered the WHOLE document. A 40-page textbook
        // read to page 12 must not let the caller drop the file: the answer to
        // "explain the exercise on page 30" is in the part that was not read.
        complete: read >= pages && extracted < NATIVE_MAX_CHARS,
      });
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
  partForPages,
  parsePages,
  pageCountOf,
  slicePdf,
  pathForKey,
  slimPdf,
  removeIfUnused,
  isValidKey,
};
