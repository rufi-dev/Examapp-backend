/*
 * CR-MSO-002 — citation evidence, produced and verified SERVER-SIDE.
 *
 * The browser may propose { filePageIndex, cropBox } and an excerpt. It never
 * uploads a crop and its excerpt is never taken as fact: a modified client could
 * otherwise attach unrelated pixels and any citation would be worthless.
 *
 * Everything authoritative is derived from the PINNED bytes:
 *   - the crop is rasterised with Ghostscript and cut with sharp;
 *   - the match text is extracted with Ghostscript's txtwrite device.
 * Both binaries are already in the image (see Dockerfile: `apk add ... qpdf
 * ghostscript`), and sharp is already a dependency — no new dependency is added.
 *
 * Verification states:
 *   unverified       nothing has confirmed the claim
 *   machine_matched  the excerpt was found on that page IN THE PINNED BYTES
 *   teacher_verified a human confirmed it against the server-rendered crop
 *   rejected         a human said it is wrong
 *
 * A scanned chapter has NO extractable text, so it can never reach
 * machine_matched. That is not a dead end: teacher_verified against the crop is
 * the primary path for image sources, which matters because a teacher
 * photographing a chapter is the common case.
 */
const { execFile } = require("child_process");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { CROP_LIMITS, validateCropBox, unrotateBox } = require("./curriculumGeometry");

const GS_TIMEOUT_MS = Number(process.env.CURRICULUM_GS_TIMEOUT_MS) || 60_000;
// Rasterising is CPU- and memory-hungry; the box also runs Chromium for WhatsApp
// and LibreOffice for conversions, so crop work is capped the way
// utils/convertQueue.js caps office conversions.
const MAX_CONCURRENT = Number(process.env.CURRICULUM_CROP_CONCURRENCY) || 2;

const VERIFY_STATUS = Object.freeze({
  UNVERIFIED: "unverified",
  MACHINE_MATCHED: "machine_matched",
  TEACHER_VERIFIED: "teacher_verified",
  REJECTED: "rejected",
});

// Below this many characters an excerpt is too weak to identify a page, so
// machine matching is not offered at all.
const MIN_EXCERPT_CHARS = Number(process.env.CURRICULUM_MIN_EXCERPT) || 40;
// Tier-2 folding (diacritics, OCR confusions) is destructive enough to create
// false positives on short strings, so it is only applied above this length.
const TIER2_MIN_CHARS = 80;
// A task number must appear near the matched excerpt, not merely somewhere on the
// page — a page match alone never confirms "№8".
const TASK_NO_PROXIMITY = 400;

// ------------------------------------------------------------ normalisation
// Tier 1: always safe. Collapse whitespace and line breaks, join soft-hyphenated
// line ends, fold case. Nothing here can merge two distinct characters.
function normalizeTier1(s) {
  return String(s || "")
    .replace(/­/g, "")
    .replace(/(\p{L})[-‐‑]\s*\n\s*(\p{L})/gu, "$1$2")
    .replace(/[\s ]+/g, " ")
    .trim()
    .toLocaleLowerCase("az");
}

// Tier 2: lossy. Azerbaijani/Turkish diacritics and the OCR confusions that
// actually occur. Applied ONLY to long excerpts (see TIER2_MIN_CHARS).
const FOLD = { ə: "e", ö: "o", ü: "u", ı: "i", i̇: "i", İ: "i", ğ: "g", ş: "s", ç: "c", â: "a", û: "u", î: "i" };
function normalizeTier2(s) {
  let out = normalizeTier1(s).replace(/[əöüıİğşçâûî]/g, (c) => FOLD[c] || c);
  out = out
    .replace(/rn/g, "m")
    .replace(/[l|]/g, "1")
    .replace(/o/g, "0")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out;
}

function normalizeFor(excerpt) {
  const t1 = normalizeTier1(excerpt);
  return t1.length >= TIER2_MIN_CHARS ? { tier: 2, value: normalizeTier2(excerpt) } : { tier: 1, value: t1 };
}

// ------------------------------------------------------------ ghostscript
let inFlight = 0;
const queue = [];
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      inFlight += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          inFlight -= 1;
          const next = queue.shift();
          if (next) next();
        });
    };
    if (inFlight < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

function gs(args, timeout = GS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile("gs", args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`ghostscript failed: ${err.message}`));
      resolve(stdout);
    });
  });
}

// Page count, straight from the pinned bytes.
async function pdfPageCount(file) {
  const out = await gs([
    "-q", "-dNODISPLAY", "-dNOSAFER", "-dBATCH",
    "-sFileName=" + file,
    "-c", "FileName (r) file runpdfbegin pdfpagecount = quit",
  ]);
  const n = parseInt(String(out).trim(), 10);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("could not read pdf page count");
  return n;
}

// Page geometry in points, plus /Rotate — needed to validate a crop and to turn a
// viewer-space box into page space.
async function pdfPageGeometry(file, filePageIndex) {
  const n = Number(filePageIndex) + 1;
  const out = await gs([
    "-q", "-dNODISPLAY", "-dNOSAFER", "-dBATCH",
    "-sFileName=" + file,
    "-c",
    `FileName (r) file runpdfbegin ${n} pdfgetpage /MediaBox pget {aload pop exch 4 -1 roll sub 3 1 roll sub exch ( ) print =print ( ) print =print} if quit`,
  ]).catch(() => "");
  const nums = String(out).trim().split(/\s+/).map(Number).filter(Number.isFinite);
  if (nums.length >= 2) return { widthPt: Math.abs(nums[0]), heightPt: Math.abs(nums[1]), rotate: 0, userUnit: 1 };
  // A4 is the only sane default for an Azerbaijani textbook scan, and a wrong
  // guess can only make validateCropBox stricter, never looser.
  return { widthPt: 595.28, heightPt: 841.89, rotate: 0, userUnit: 1 };
}

// The text of ONE page, from the pinned bytes. Empty string for a scan.
async function pdfPageText(file, filePageIndex) {
  const n = Number(filePageIndex) + 1;
  const tmp = path.join(os.tmpdir(), `curr-${crypto.randomBytes(8).toString("hex")}.txt`);
  try {
    await withSlot(() =>
      gs(["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", `-dFirstPage=${n}`, `-dLastPage=${n}`, `-sOutputFile=${tmp}`, file])
    );
    return await fsp.readFile(tmp, "utf8");
  } catch {
    return "";
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

/*
 * Render one page and cut the crop. Validation happens FIRST and unconditionally:
 * a malformed, out-of-page or oversized box must never reach Ghostscript.
 */
async function renderCrop(file, { filePageIndex, cropBox, pageCount, geometry, limits = CROP_LIMITS }) {
  const geo = geometry || (await pdfPageGeometry(file, filePageIndex));
  const check = validateCropBox(cropBox, {
    filePageIndex,
    pageCount,
    pageWidthPt: geo.widthPt,
    pageHeightPt: geo.heightPt,
    userUnit: geo.userUnit,
    limits,
  });
  if (!check.ok) {
    const e = new Error(check.code);
    e.cropCode = check.code;
    throw e;
  }

  const sharp = require("sharp");
  const n = Number(filePageIndex) + 1;
  const tmp = path.join(os.tmpdir(), `curr-${crypto.randomBytes(8).toString("hex")}.png`);
  try {
    const png = await withSlot(async () => {
      await gs([
        "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
        "-sDEVICE=png16m", `-r${check.out.dpi}`,
        `-dFirstPage=${n}`, `-dLastPage=${n}`,
        `-sOutputFile=${tmp}`, file,
      ]);
      return fsp.readFile(tmp);
    });
    // limitInputPixels stops a decompression bomb from being expanded in-process.
    const img = sharp(png, { limitInputPixels: limits.maxPagePixels });
    const meta = await img.metadata();
    const inPage = unrotateBox(cropBox, geo.rotate);
    const left = Math.max(0, Math.min(meta.width - 1, Math.round(inPage.x * meta.width)));
    const top = Math.max(0, Math.min(meta.height - 1, Math.round(inPage.y * meta.height)));
    const width = Math.max(1, Math.min(meta.width - left, Math.round(inPage.w * meta.width)));
    const height = Math.max(1, Math.min(meta.height - top, Math.round(inPage.h * meta.height)));
    const buf = await img.extract({ left, top, width, height }).png().toBuffer();
    return { buffer: buf, cropHash: crypto.createHash("sha256").update(buf).digest("hex"), widthPx: width, heightPx: height };
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

// ------------------------------------------------------------ matching
/*
 * Decide a verifyStatus for one claimed citation, against text that came from the
 * pinned bytes. Never promotes to machine_matched on a short excerpt, and never
 * confirms a task number that is not NEAR the matched text.
 */
function matchExcerpt(pageText, { excerpt, sourceTaskNo } = {}) {
  const raw = String(pageText || "");
  const t1Page = normalizeTier1(raw);
  const t1Excerpt = normalizeTier1(excerpt);

  if (!t1Page) return { status: VERIFY_STATUS.UNVERIFIED, reason: "no_extractable_text" };
  if (t1Excerpt.length < MIN_EXCERPT_CHARS) return { status: VERIFY_STATUS.UNVERIFIED, reason: "excerpt_too_short" };

  const { tier, value } = normalizeFor(excerpt);
  const hay = tier === 2 ? normalizeTier2(raw) : t1Page;
  const at = hay.indexOf(value);
  if (at < 0) return { status: VERIFY_STATUS.UNVERIFIED, reason: "excerpt_not_found", tier };

  const taskNo = String(sourceTaskNo || "").trim();
  if (taskNo) {
    const needle = tier === 2 ? normalizeTier2(taskNo) : normalizeTier1(taskNo);
    const from = Math.max(0, at - TASK_NO_PROXIMITY);
    const to = Math.min(hay.length, at + value.length + TASK_NO_PROXIMITY);
    if (!needle || hay.slice(from, to).indexOf(needle) < 0) {
      return { status: VERIFY_STATUS.UNVERIFIED, reason: "task_no_not_near_excerpt", tier };
    }
  }
  return { status: VERIFY_STATUS.MACHINE_MATCHED, reason: null, tier, at };
}

/*
 * CR-MSO-003 — DETECT a citation claim in prose; never rewrite it.
 *
 * An earlier draft stripped page-like text with a regex. That is unsafe: it would
 * damage a legitimate question containing "kitabın 47-ci səhifəsi". Detection is
 * advisory input to a validator, which fails the task to needs_teacher_review or
 * regenerates it — the text itself is never edited.
 */
const CITATION_CLAIM = [
  /\b(səh|səhifə|s|page|str)\.?\s*\d+/iu,
  /\d+\s*-?\s*[cç]i\s+səhifə/iu,
  /\bdərslik\w*\s*[,:]?\s*(səh|s)\b/iu,
  /№\s*\d+/u,
];
function findCitationClaims(text) {
  const s = String(text || "");
  const hits = [];
  for (const re of CITATION_CLAIM) {
    const m = s.match(re);
    if (m) hits.push(m[0].trim());
  }
  return hits;
}

module.exports = {
  VERIFY_STATUS,
  MIN_EXCERPT_CHARS,
  TIER2_MIN_CHARS,
  TASK_NO_PROXIMITY,
  normalizeTier1,
  normalizeTier2,
  normalizeFor,
  matchExcerpt,
  findCitationClaims,
  pdfPageCount,
  pdfPageGeometry,
  pdfPageText,
  renderCrop,
};
