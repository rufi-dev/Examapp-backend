const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// Office formats we accept and convert to PDF so the in-app viewer only ever
// has to render PDFs (which we can show without a download link).
const OFFICE_EXTS = new Set([
  ".doc",
  ".docx",
  ".odt",
  ".rtf",
  ".ppt",
  ".pptx",
  ".odp",
  ".xls",
  ".xlsx",
  ".ods",
]);

const isOfficeFile = (name) =>
  OFFICE_EXTS.has(path.extname(String(name || "")).toLowerCase());

/**
 * Convert an office document to PDF with headless LibreOffice.
 *
 * Resolves with the produced .pdf path. Rejects with a message meant for the
 * teacher (shown in a toast) — notably when LibreOffice isn't installed on the
 * host, so the feature degrades to "upload a PDF instead" rather than 500ing.
 *
 * `-env:UserInstallation` points LibreOffice at a throwaway profile in /tmp:
 * without it, concurrent conversions fight over the default profile lock and
 * silently produce nothing.
 */
function convertOfficeToPdf(srcPath, outDir) {
  return new Promise((resolve, reject) => {
    const args = [
      "-env:UserInstallation=file:///tmp/lo-convert-profile",
      "--headless",
      "--norestore",
      "--convert-to",
      "pdf",
      "--outdir",
      outDir,
      srcPath,
    ];
    execFile("soffice", args, { timeout: 120000 }, (err) => {
      const produced = path.join(
        outDir,
        `${path.basename(srcPath, path.extname(srcPath))}.pdf`
      );
      // LibreOffice can exit non-zero and still have written the PDF, so trust
      // the file on disk over the exit code.
      if (fs.existsSync(produced)) return resolve(produced);
      if (err && (err.code === "ENOENT" || /ENOENT/.test(String(err.message)))) {
        return reject(
          new Error(
            "Word/PowerPoint çevrilməsi bu serverdə quraşdırılmayıb — faylı PDF kimi yükləyin"
          )
        );
      }
      reject(
        new Error("Fayl PDF-ə çevrilə bilmədi — faylı PDF kimi yükləyin")
      );
    });
  });
}

module.exports = { convertOfficeToPdf, isOfficeFile, OFFICE_EXTS };
