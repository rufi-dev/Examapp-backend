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

// Exactly what the providers can actually read. A .docx attached here would be
// silently ignored by every one of them, so it is refused with a reason instead.
const ACCEPT = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

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
 * HONEST SCOPE. Measured on that file this halves the bytes (9.95 MB -> 4.65 MB),
 * which cuts upload time and keeps a multi-file turn under the provider's 32 MB
 * request cap. Whether it cuts TOKENS proportionally is NOT established: a
 * provider normalises a page image to a maximum dimension before tokenising, so
 * a 600 dpi and a 200 dpi scan of the same page may well bill the same. The
 * change that is certain about tokens is prompt caching in aiDocAdapters. Verify
 * this one with /v1/messages/count_tokens on both files when there is credit to
 * call it; if the counts match, the honest thing is to keep it for the size cap
 * and stop describing it as a cost saving.
 */
const SLIM_OVER_BYTES = Number(process.env.LESSON_DOC_SLIM_OVER_MB || 2) * 1024 * 1024;
const SLIM_DPI = Number(process.env.LESSON_DOC_SLIM_DPI || 200);
const SLIM_JPEG_Q = Number(process.env.LESSON_DOC_SLIM_JPEG_Q || 60);
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
async function saveFile({ buffer, mime, name }) {
  const ext = ACCEPT[mime];
  if (!ext) throw new Error("unsupported type");
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
 * Remove a file only when NO document still references it. The key is a content
 * hash, so two materials that attached the same page share one file on disk and
 * deleting one of them must not blind the other.
 */
async function removeIfUnused(key, ext, stillUsed) {
  if (stillUsed) return false;
  try {
    await fsp.unlink(pathForKey(key, ext));
    /*
     * And the downscaled copy, which is derived from this file and useless
     * without it. Deleting the original and leaving its slim twin behind would
     * leak bytes that nothing references and nothing would ever look for — the
     * orphan problem the store was built to avoid, reintroduced by a cache.
     * Best-effort: the original is already gone, so a failure here is a stray
     * file, not a blinded document.
     */
    if (isValidKey(key)) await fsp.unlink(path.join(DIR, `${key}.s${SLIM_DPI}.pdf`)).catch(() => {});
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
  toParts,
  pathForKey,
  slimPdf,
  removeIfUnused,
  isValidKey,
};
