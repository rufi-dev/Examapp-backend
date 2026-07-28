/*
 * AUD-013 CR-057/CR-067 — PRIVATE exam-PDF storage. Exam PDFs live under random,
 * unguessable keys in a directory that is NOT served statically, reachable ONLY
 * through the authorized range-streaming endpoint. Possession of an old /uploads
 * URL can no longer bypass exam access/revocation.
 *
 * CR-067: every path here is CONFIGURATION-DRIVEN (no hard-coded "uploads") so a
 * disposable E2E run can point staging/private/journal at throwaway OS-temp dirs,
 * and production can point the private store at a PERSISTENT Docker volume. The
 * relative default would land in the container's writable layer and be lost on
 * rebuild, so `preflight()` refuses a non-absolute private dir in production.
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

// The PRIVATE store (never express.static'd) and the transient STAGING dir where
// multer lands an upload before it is validated and moved private. Resolved to
// ABSOLUTE paths at load; a spawned process (real server, disposable launcher,
// test) sets the env BEFORE requiring this module, so load-time resolution is
// correct for every caller.
const EXAM_PDF_DIR = path.resolve(process.env.EXAM_PDF_DIR || "examPdfs");
const PDF_STAGING_DIR = path.resolve(process.env.PDF_STAGING_DIR || "uploads");

// 32-byte random hex — unguessable, filesystem-safe, no PII.
const newKey = () => crypto.randomBytes(32).toString("hex");
const isValidKey = (k) => typeof k === "string" && /^[a-f0-9]{64}$/.test(k);

// Resolve a key to an absolute path, refusing anything that isn't a clean key
// (defence-in-depth against traversal even though keys are generated internally).
function pathForKey(key, dir = EXAM_PDF_DIR) {
  if (!isValidKey(key)) return null;
  const base = path.resolve(dir);
  const abs = path.resolve(base, `${key}.pdf`);
  if (path.dirname(abs) !== base) return null; // never escape the dir
  return abs;
}

// A multer-written staging file resolved into the staging dir by BASENAME only —
// never trust a caller-supplied path/traversal for the source location.
function stagingPathFor(filename, dir = PDF_STAGING_DIR) {
  if (typeof filename !== "string" || !filename) return null;
  const base = path.resolve(dir);
  const abs = path.resolve(base, path.basename(filename));
  if (path.dirname(abs) !== base) return null;
  return abs;
}

async function ensureDir(dir = EXAM_PDF_DIR) {
  await fsp.mkdir(dir, { recursive: true });
}

// Prove a directory exists and is writable by round-tripping a uniquely-named
// probe file (create → read → delete). Returns true or throws.
async function assertWritable(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const probe = path.join(dir, `.probe-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  await fsp.writeFile(probe, "ok");
  await fsp.readFile(probe, "utf8");
  await fsp.unlink(probe);
  return true;
}

/*
 * Startup preflight. Ensures the private + staging dirs exist and are writable,
 * and — in production — refuses a NON-ABSOLUTE private dir (the container-layer
 * default), because that is not the persistent volume mount and would silently
 * lose migrated PDFs on rebuild. Throws a config error naming the fix; callers
 * fail closed before listening.
 */
async function preflight({ env = process.env.NODE_ENV, explicitDir = process.env.EXAM_PDF_DIR } = {}) {
  if (env === "production" && (!explicitDir || !path.isAbsolute(explicitDir))) {
    throw new Error(
      "EXAM_PDF_DIR must be set to an ABSOLUTE path on a persistent volume in production " +
      "(e.g. EXAM_PDF_DIR=/app/examPdfs with a Docker volume mounted there). " +
      "The relative default lives in the container layer and is erased on rebuild."
    );
  }
  await assertWritable(EXAM_PDF_DIR);
  await assertWritable(PDF_STAGING_DIR);
  return { examPdfDir: EXAM_PDF_DIR, stagingDir: PDF_STAGING_DIR, writable: true };
}

module.exports = {
  EXAM_PDF_DIR,
  PDF_STAGING_DIR,
  newKey,
  isValidKey,
  pathForKey,
  stagingPathFor,
  ensureDir,
  assertWritable,
  preflight,
};
