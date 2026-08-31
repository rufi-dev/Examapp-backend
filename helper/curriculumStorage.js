/*
 * Private, IMMUTABLE storage for curriculum sources (textbook chapters) and the
 * page crops derived from them.
 *
 * This deliberately does NOT reuse materials/. That store is unsafe as a citation
 * anchor and the evidence is in the code:
 *   - deleteMaterial unlinks the file BEFORE the DB row is removed
 *     (controllers/materialController.js), inverting the ordering the repo's own
 *     ADR states, and there is no reference check of any kind;
 *   - the bytes are rewritten IN PLACE after upload — utils/materialPdfOptimize.js
 *     renames a linearised temp over the original, and the opt-in Ghostscript pass
 *     does it again;
 *   - optimisation runs deferred after the 201 AND lazily on first read, and every
 *     read runs a crash-recovery step that may rmSync + rename the file;
 *   - a second delete path (services/entityLifecycle.js) drops rows with no unlink
 *     at all, orphaning bytes with no sweeper;
 *   - no hash is ever computed for a material file, so tampering is undetectable;
 *   - MATERIALS_DIR is process.cwd()-relative, exactly the layout
 *     examPdfStorage.preflight() was written to forbid.
 *
 * It clones the exam-PDF lifecycle instead (helper/examPdfStorage.js +
 * models/pdfModel.js): an absolute env-configured dir with a production preflight,
 * 32-byte random keys, traversal-proof resolution, and sha256 of the FINAL bytes.
 */
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

// Absolute in production. The relative default lives in the container layer and is
// erased on rebuild, which is why preflight() refuses it outside development.
const CURRICULUM_DIR = path.resolve(process.env.CURRICULUM_DIR || "lessonAssets");
const CURRICULUM_STAGING_DIR = path.join(CURRICULUM_DIR, ".staging");

// 256 bits of entropy: the key IS the filename, so it must be unguessable.
const newKey = () => crypto.randomBytes(32).toString("hex");
const isValidKey = (k) => typeof k === "string" && /^[a-f0-9]{64}$/.test(k);

// Traversal-proof: a key that is not exactly 64 hex chars never becomes a path.
function pathForKey(key, ext = ".bin") {
  if (!isValidKey(key)) throw new Error("invalid curriculum storage key");
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(String(ext)) ? ext : ".bin";
  const p = path.join(CURRICULUM_DIR, `${key}${safeExt}`);
  if (!p.startsWith(CURRICULUM_DIR + path.sep)) throw new Error("invalid curriculum storage path");
  return p;
}

function stagingPathFor(key, ext = ".bin") {
  if (!isValidKey(key)) throw new Error("invalid curriculum storage key");
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(String(ext)) ? ext : ".bin";
  const p = path.join(CURRICULUM_STAGING_DIR, `${key}${safeExt}`);
  if (!p.startsWith(CURRICULUM_STAGING_DIR + path.sep)) throw new Error("invalid curriculum staging path");
  return p;
}

/*
 * Refuse a relative directory outside development. A cwd-relative store lives in
 * the container layer and is erased on the next `docker compose up --build`, which
 * would silently destroy the bytes every published citation is pinned to.
 */
function preflight(env = process.env) {
  const configured = env.CURRICULUM_DIR || "";
  if (env.NODE_ENV === "production" && !path.isAbsolute(configured)) {
    throw new Error(
      "FATAL curriculum storage: CURRICULUM_DIR must be an ABSOLUTE path on a persistent volume in production " +
        "(the relative default lives in the container layer and is erased on rebuild)"
    );
  }
  fs.mkdirSync(CURRICULUM_DIR, { recursive: true });
  fs.mkdirSync(CURRICULUM_STAGING_DIR, { recursive: true });
  return { dir: CURRICULUM_DIR, staging: CURRICULUM_STAGING_DIR };
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function sha256File(file) {
  return sha256(await fsp.readFile(file));
}

// Move staged bytes into the immutable store. After this the file is never
// rewritten — the hash is taken here, AFTER the last byte-mutating step.
async function commitStaged(key, ext, stagedPath) {
  const dest = pathForKey(key, ext);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(stagedPath, dest);
  const digest = await sha256File(dest);
  const { size } = await fsp.stat(dest);
  return { path: dest, sha256: digest, bytes: size };
}

// Verify stored bytes still match what a published citation pinned. A mismatch is
// corruption or substitution — the ONLY thing that may invalidate a citation.
async function verifyBytes(key, ext, expectedHash) {
  const p = pathForKey(key, ext);
  try {
    const actual = await sha256File(p);
    return { ok: actual === expectedHash, actual, expected: expectedHash };
  } catch {
    return { ok: false, actual: null, expected: expectedHash, missing: true };
  }
}

module.exports = {
  CURRICULUM_DIR,
  CURRICULUM_STAGING_DIR,
  newKey,
  isValidKey,
  pathForKey,
  stagingPathFor,
  preflight,
  sha256,
  sha256File,
  commitStaged,
  verifyBytes,
};
