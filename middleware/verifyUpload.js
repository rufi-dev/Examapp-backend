/*
 * AUD-013 CR-056 — post-multer guard. Validates the uploaded file's ACTUAL bytes
 * and STRUCTURE (magic bytes, HEIF brand, ZIP central-directory structure) against
 * its extension, and attaches the TRUSTED detected type/canonical MIME to the
 * request so the controller never trusts the client MIME. On a mismatch it deletes
 * the file (fail-closed) and returns 400; if cleanup fails it emits a security event
 * (a rejected file must never linger where it could be served/scanned/shared).
 */
const fsp = require("fs").promises;
const path = require("path");
const { validateUploadFile } = require("../utils/fileValidation");
const { recordDebug } = require("../utils/debugLog");

// CR-066: async — bounded reads happen off the request thread; wrapped in
// asyncHandler-style so a thrown error still flows to the error middleware.
async function verifyUploadSignature(req, res, next) {
  try {
    const file = req.file;
    if (!file || !file.path) return next(); // nothing uploaded → let the handler decide
    const ext = path.extname(file.originalname || file.filename || "").toLowerCase();

    const result = await validateUploadFile(file.path, ext);
    if (!result.ok) {
      try {
        await fsp.unlink(file.path);
      } catch (e) {
        // A rejected file we could not delete is a security event — it must not be
        // left in the (private) upload dir where it could later be served/shared.
        recordDebug({ kind: "upload_reject_cleanup_failed", message: `${result.reason}:${e.message}` });
      }
      return res.status(400).json({ message: "Faylın məzmunu uzantısı ilə uyğun gəlmir" });
    }

    // TRUSTED classification the controller MUST use (never file.mimetype).
    req.detectedType = result.type;         // pdf | png | jpg | gif | webp | heic | rtf | ole | ooxml | odf
    req.canonicalMime = result.canonicalMime;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = verifyUploadSignature;
