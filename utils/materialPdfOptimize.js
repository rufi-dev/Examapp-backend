const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const jobs = new Map();
const HEAD_BYTES = 4096;
const BACKUP_SUFFIX = ".linearize.backup";

function isLinearizedPdf(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const head = buffer.subarray(0, read);
    return (
      head.subarray(0, 8).includes(Buffer.from("%PDF-")) &&
      head.includes(Buffer.from("/Linearized"))
    );
  } catch {
    return false;
  }
}

function recoverInterruptedPdfOptimization(filePath) {
  const source = path.resolve(filePath);
  const backup = `${source}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backup)) return fs.existsSync(source);
  try {
    if (!fs.existsSync(source)) {
      fs.renameSync(backup, source);
      return true;
    }
    if (isLinearizedPdf(source)) {
      fs.rmSync(backup, { force: true });
      return true;
    }
    // The replacement was not completed. Restore the known original.
    fs.rmSync(source, { force: true });
    fs.renameSync(backup, source);
    return true;
  } catch {
    return false;
  }
}

function exec(command, args, timeout = 240000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout }, (error) => {
      resolve({
        ok: !error || error.code === 3,
        missing: error?.code === "ENOENT",
      });
    });
  });
}

async function defaultLinearizer(source, target) {
  const qpdf = await exec("qpdf", ["--linearize", "--", source, target]);
  if (qpdf.ok && fs.existsSync(target)) return true;

  // Local Windows development does not always have qpdf. The project already
  // uses pikepdf for its controlled PDF fixtures, so use it only as a
  // missing-binary development fallback. Production containers ship qpdf.
  if (!qpdf.missing || process.env.NODE_ENV === "production") return false;
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // The Python call below will fail safely if the temp path is unusable.
  }
  const script = [
    "import pikepdf,sys",
    "p=pikepdf.open(sys.argv[1])",
    "p.save(sys.argv[2], linearize=True)",
  ].join(";");
  const python = await exec("python", ["-c", script, source, target]);
  return python.ok && fs.existsSync(target);
}

async function linearizePdfAtomic(
  filePath,
  { linearizer = defaultLinearizer } = {}
) {
  const source = path.resolve(filePath);
  recoverInterruptedPdfOptimization(source);
  if (isLinearizedPdf(source)) {
    return { ok: true, changed: false };
  }
  if (!fs.existsSync(source)) return { ok: false, changed: false };

  const temp = `${source}.${crypto.randomBytes(8).toString("hex")}.linearized.tmp`;
  try {
    const produced = await linearizer(source, temp);
    if (
      !produced ||
      !fs.existsSync(temp) ||
      fs.statSync(temp).size === 0 ||
      !isLinearizedPdf(temp)
    ) {
      return { ok: false, changed: false };
    }

    // Windows refuses fsync on a read-only descriptor. Open read/write so the
    // durability barrier behaves consistently on Windows and Linux.
    const fd = fs.openSync(temp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temp, source);
    } catch (error) {
      // POSIX rename replaces atomically. Windows refuses an existing target,
      // so use a recoverable two-rename sequence with a deterministic backup.
      if (process.platform !== "win32") throw error;
      const backup = `${source}${BACKUP_SUFFIX}`;
      fs.rmSync(backup, { force: true });
      fs.renameSync(source, backup);
      try {
        fs.renameSync(temp, source);
        if (!isLinearizedPdf(source)) {
          throw new Error("linearized replacement failed validation");
        }
        fs.rmSync(backup, { force: true });
      } catch (replaceError) {
        try {
          fs.rmSync(source, { force: true });
          fs.renameSync(backup, source);
        } catch {
          // The deterministic backup is intentionally retained for recovery.
        }
        throw replaceError;
      }
    }
    return { ok: isLinearizedPdf(source), changed: true };
  } catch {
    return { ok: false, changed: false };
  } finally {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The source remains untouched when temp cleanup itself fails.
    }
  }
}

function ensureMaterialPdfOptimized(filePath, options) {
  const key = path.resolve(filePath);
  recoverInterruptedPdfOptimization(key);
  if (isLinearizedPdf(key)) {
    return Promise.resolve({ ok: true, changed: false });
  }
  if (jobs.has(key)) return jobs.get(key);

  const job = linearizePdfAtomic(key, options).finally(() => {
    if (jobs.get(key) === job) jobs.delete(key);
  });
  jobs.set(key, job);
  return job;
}

module.exports = {
  HEAD_BYTES,
  BACKUP_SUFFIX,
  isLinearizedPdf,
  recoverInterruptedPdfOptimization,
  linearizePdfAtomic,
  ensureMaterialPdfOptimized,
};
