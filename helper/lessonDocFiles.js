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
    name: String(name || "fayl").slice(0, 120),
    at: new Date(),
  };
}

// Read the attachments back in the shape the AI document path already speaks.
async function toParts(files = []) {
  const parts = [];
  for (const f of files) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const buf = await fsp.readFile(pathForKey(f.key, f.ext));
      parts.push({ mime: f.mime, data: buf.toString("base64"), isPdf: f.mime === "application/pdf" });
    } catch {
      // A missing reference must not take down the turn: the teacher would rather
      // have the material written without it than get an error and nothing.
      console.error("[LESSON DOC] attachment unreadable:", f.key);
    }
  }
  return parts;
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
    return true;
  } catch {
    return false;
  }
}

module.exports = { DIR, ACCEPT, MAX_FILE_MB, MAX_FILES, MAX_TOTAL_MB, saveFile, toParts, pathForKey, removeIfUnused, isValidKey };
