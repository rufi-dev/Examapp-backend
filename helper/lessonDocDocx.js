const { execFile } = require("child_process");
const crypto = require("crypto");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

/*
 * HTML -> .docx, via the LibreOffice already in this image.
 *
 * A teacher who asks for Word wants to EDIT it — add a paragraph, change a number,
 * paste a picture. A PDF renamed .docx would satisfy the button and none of the
 * intent, so this is a real conversion producing a real document.
 *
 * LibreOffice is already installed and already invoked this way for
 * utils/officeToPdf.js, so this adds no dependency — only the opposite direction.
 */

const SOFFICE = process.env.SOFFICE_PATH || "soffice";
const TIMEOUT_MS = 60000;

const run = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(SOFFICE, args, { timeout: TIMEOUT_MS, cwd, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`soffice failed: ${err.message} ${stderr || ""}`.trim()));
      resolve(stdout);
    });
  });

/*
 * Each conversion gets its OWN profile directory.
 *
 * LibreOffice keeps a single user profile and refuses to start a second instance
 * against it — under concurrent requests that turns into one export hanging until
 * the other finishes, or failing outright. A per-run profile makes them
 * independent, and it is removed with the rest of the scratch directory.
 */
async function htmlToDocx(html) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "examopia-docx-"));
  const src = path.join(dir, "document.html");
  const out = path.join(dir, "document.docx");
  const profile = path.join(dir, "profile");

  try {
    await fsp.writeFile(src, html, "utf8");
    await run(
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=file://${profile.replace(/\\/g, "/")}`,
        "--convert-to",
        "docx:MS Word 2007 XML",
        "--outdir",
        dir,
        src,
      ],
      dir
    );

    const buf = await fsp.readFile(out);
    // A .docx is a zip; anything else means the conversion produced something we
    // must not hand over as a Word file.
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error("conversion produced a non-docx file");
    }
    return buf;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// A filename a teacher can find again, with the characters a filesystem and a
// Content-Disposition header both tolerate.
const safeName = (title, ext) => {
  const base =
    String(title || "ders-materiali")
      .replace(/[^\p{L}\p{N}\s._-]/gu, "")
      .trim()
      .slice(0, 80) || "ders-materiali";
  return `${base}.${ext}`;
};

module.exports = { htmlToDocx, safeName, SOFFICE };
