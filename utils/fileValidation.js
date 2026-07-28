/*
 * AUD-013 CR-056/CR-065/CR-066 — TRUSTED, SUBTYPE-AUTHENTIC, ASYNC file validation.
 * Never trusts the client extension/MIME. All disk access is bounded async reads
 * with an awaited finally-close; fstat is the authoritative size.
 *
 *  - PDF: `%PDF-` header AND a bounded structural trailer (`%%EOF` within the last
 *    2KB) — rejects header-only/truncated and PDF-headed polyglots.
 *  - OOXML (.docx/.xlsx/.pptx): a ZIP that contains `[Content_Types].xml` AND the
 *    format-specific member (word/document.xml | xl/workbook.xml | ppt/presentation.xml).
 *  - OpenDocument (.odt/.ods/.odp): the FIRST local member must be a STORED
 *    `mimetype` whose bytes EXACTLY equal the extension's MIME, and `content.xml`
 *    must exist. `[Content_Types].xml` is never ODF evidence.
 *  - The ZIP central directory is parsed independently and must EXACTLY match the
 *    EOCD count; ZIP64/multi-disk/encrypted, malformed bounds, duplicates, traversal/
 *    drive/backslash names, and local-vs-central name/method mismatches are rejected.
 *  - HEIC/HEIF requires a known HEIF `ftyp` brand (AVIF is NOT accepted as HEIC).
 */
const fs = require("fs");
const fsp = fs.promises;

const ascii = (b, off, str) => b.slice(off, off + str.length).toString("latin1") === str;
const eq = (b, off, bytes) => b.length >= off + bytes.length && bytes.every((x, i) => b[off + i] === x);

async function readAt(fh, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.slice(0, bytesRead);
}

// Coarse type from the head. Container types (zip / isobmff) still need the deep pass.
function detectHead(head) {
  if (ascii(head, 0, "%PDF-")) return { type: "pdf" };
  if (eq(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: "png" };
  if (eq(head, 0, [0xff, 0xd8, 0xff])) return { type: "jpg" };
  if (ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a")) return { type: "gif" };
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) return { type: "webp" };
  if (ascii(head, 0, "{\\rtf")) return { type: "rtf" };
  if (eq(head, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { type: "ole" };
  if (eq(head, 0, [0x50, 0x4b, 0x03, 0x04]) || eq(head, 0, [0x50, 0x4b, 0x05, 0x06])) return { type: "zip" };
  if (ascii(head, 4, "ftyp")) return { type: "isobmff", brand: head.slice(8, 12).toString("latin1").replace(/\0+$/, "") };
  return null;
}

// AVIF deliberately excluded — it is not separately supported as an image here.
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

const EXT_TYPE = {
  ".pdf": "pdf", ".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".gif": "gif", ".webp": "webp",
  ".heic": "heic", ".heif": "heic", ".rtf": "rtf", ".doc": "ole", ".xls": "ole", ".ppt": "ole",
  ".docx": "ooxml", ".xlsx": "ooxml", ".pptx": "ooxml", ".odt": "odf", ".ods": "odf", ".odp": "odf",
};
const CANONICAL_MIME = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", rtf: "application/rtf", ole: "application/x-ole-storage",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
};
const OOXML_MEMBER = { ".docx": "word/document.xml", ".xlsx": "xl/workbook.xml", ".pptx": "ppt/presentation.xml" };
const ODF_MIME = { ".odt": CANONICAL_MIME[".odt"], ".ods": CANONICAL_MIME[".ods"], ".odp": CANONICAL_MIME[".odp"] };

const ZIP_MAX_ENTRIES = 5000;
const ZIP_MAX_UNCOMPRESSED = 500 * 1024 * 1024;
const ZIP_MAX_CD = 16 * 1024 * 1024;
const PDF_TRAILER_SCAN = 2048;

function badName(name) {
  return name.includes("..") || name.startsWith("/") || name.startsWith("\\") || name.includes("\\") || name.includes("\0") || /^[a-zA-Z]:/.test(name);
}

// Parse + structurally validate the ZIP, then require the ext's authentic subtype.
async function validateZipOffice(fh, size, ext) {
  const tailLen = Math.min(size, 64 * 1024);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) { if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { e = i; break; } }
  if (e < 0) return { ok: false, reason: "no_eocd" };
  const diskNo = tail.readUInt16LE(e + 4), cdDisk = tail.readUInt16LE(e + 6);
  const entriesThisDisk = tail.readUInt16LE(e + 8), totalEntries = tail.readUInt16LE(e + 10);
  const cdSize = tail.readUInt32LE(e + 12), cdOffset = tail.readUInt32LE(e + 16);
  if (diskNo !== 0 || cdDisk !== 0 || entriesThisDisk !== totalEntries) return { ok: false, reason: "multi_disk" };
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { ok: false, reason: "zip64" };
  if (totalEntries > ZIP_MAX_ENTRIES) return { ok: false, reason: "too_many_entries" };
  if (cdSize > ZIP_MAX_CD || cdOffset + cdSize > size) return { ok: false, reason: "bad_cd" };

  const cd = await readAt(fh, cdOffset, cdSize);
  if (cd.length !== cdSize) return { ok: false, reason: "bad_cd" };
  const names = new Set();
  const entries = [];
  let p = 0, totalUncompressed = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compressed = cd.readUInt32LE(p + 20);
    const uncompressed = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.slice(p + 46, p + 46 + nameLen).toString("utf8");
    if (flags & 0x0001) return { ok: false, reason: "encrypted" };
    if (badName(name)) return { ok: false, reason: "bad_name" };
    if (names.has(name)) return { ok: false, reason: "duplicate_entry" };
    names.add(name);
    totalUncompressed += uncompressed;
    if (totalUncompressed > ZIP_MAX_UNCOMPRESSED) return { ok: false, reason: "zip_bomb" };
    entries.push({ name, flags, method, crc, compressed, uncompressed, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  // CR-070: the central directory must be consumed EXACTLY (no unparsed trailing
  // junk padded inside cdSize) and its entry count must match the EOCD.
  if (p !== cd.length) return { ok: false, reason: "cd_trailing_junk" };
  if (entries.length !== totalEntries) return { ok: false, reason: "eocd_count_mismatch" };

  // CR-070: verify each LOCAL header agrees with the central directory on name,
  // flags, method and (when sizes are inline, i.e. no data-descriptor) CRC and
  // sizes. Pick the physical FIRST member by the LOWEST local-header offset, not
  // central-directory order (an attacker controls CD order).
  let firstLocal = null;
  for (const en of entries) {
    const lh = await readAt(fh, en.localOffset, 30);
    if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) return { ok: false, reason: "bad_local_header" };
    const lFlags = lh.readUInt16LE(6);
    const lMethod = lh.readUInt16LE(8);
    const lCrc = lh.readUInt32LE(14);
    const lCompressed = lh.readUInt32LE(18);
    const lUncompressed = lh.readUInt32LE(22);
    const lNameLen = lh.readUInt16LE(26), lExtraLen = lh.readUInt16LE(28);
    const lName = (await readAt(fh, en.localOffset + 30, lNameLen)).toString("utf8");
    if (lName !== en.name || lMethod !== en.method) return { ok: false, reason: "local_central_mismatch" };
    if ((lFlags & 0x0001) || (lFlags & 0x0001) !== (en.flags & 0x0001)) return { ok: false, reason: "local_encrypted_flag" };
    if ((lFlags & 0x0008) !== (en.flags & 0x0008)) return { ok: false, reason: "local_central_flag_mismatch" };
    // When sizes are inline (no data-descriptor), CRC + sizes must match exactly.
    if (!(en.flags & 0x0008)) {
      if (lCrc !== en.crc || lCompressed !== en.compressed || lUncompressed !== en.uncompressed) return { ok: false, reason: "local_central_size_mismatch" };
    }
    const cand = { ...en, dataOffset: en.localOffset + 30 + lNameLen + lExtraLen };
    if (firstLocal === null || en.localOffset < firstLocal.localOffset) firstLocal = cand;
  }

  // Authentic subtype checks.
  if (OOXML_MEMBER[ext]) {
    if (!names.has("[Content_Types].xml") || !names.has(OOXML_MEMBER[ext])) return { ok: false, reason: "not_ooxml_subtype" };
    return { ok: true, type: "ooxml", canonicalMime: CANONICAL_MIME[ext] };
  }
  if (ODF_MIME[ext]) {
    // ODF: the PHYSICAL first member MUST be a STORED `mimetype` whose declared
    // uncompressed length EXACTLY equals the ext MIME length and whose bytes
    // EXACTLY equal it (prefix + attacker suffix is rejected by the length check).
    const wantMime = ODF_MIME[ext];
    if (!firstLocal || firstLocal.name !== "mimetype" || firstLocal.method !== 0) return { ok: false, reason: "odf_no_stored_mimetype" };
    if (firstLocal.uncompressed !== wantMime.length) return { ok: false, reason: "odf_mimetype_length" };
    const mimeBytes = (await readAt(fh, firstLocal.dataOffset, wantMime.length)).toString("latin1");
    if (mimeBytes !== wantMime) return { ok: false, reason: "odf_mimetype_mismatch" };
    if (!names.has("content.xml")) return { ok: false, reason: "odf_no_content" };
    return { ok: true, type: "odf", canonicalMime: CANONICAL_MIME[ext] };
  }
  return { ok: false, reason: "zip_ext_mismatch" };
}

// PDF: %PDF- header + a %%EOF trailer, and — CR-070 — NOTHING but bounded EOL/
// whitespace after the LAST %%EOF (rejects an appended ZIP/script polyglot). A
// large appended payload pushes the last %%EOF out of the 2KB tail, so the
// no-trailer branch rejects it too.
const PDF_TRAILER_ALLOWED = new Set([0x0d, 0x0a, 0x20, 0x09, 0x0c, 0x00]);
async function validatePdf(fh, size) {
  const tailLen = Math.min(size, PDF_TRAILER_SCAN);
  const tail = await readAt(fh, size - tailLen, tailLen);
  const marker = Buffer.from("%%EOF");
  const idx = tail.lastIndexOf(marker);
  if (idx < 0) return { ok: false, reason: "pdf_no_trailer" };
  for (let i = idx + marker.length; i < tail.length; i++) {
    if (!PDF_TRAILER_ALLOWED.has(tail[i])) return { ok: false, reason: "pdf_trailing_bytes" };
  }
  return { ok: true, type: "pdf", canonicalMime: CANONICAL_MIME.pdf };
}

// Validate a file on disk against its claimed extension → TRUSTED type. ASYNC.
async function validateUploadFile(filePath, ext) {
  const e = String(ext || "").toLowerCase();
  const expected = EXT_TYPE[e];
  if (!expected) return { ok: false, reason: "ext_not_allowed" };

  let fh;
  try {
    fh = await fsp.open(filePath, "r");
    const st = await fh.stat();
    const size = st.size; // fstat is authoritative
    const head = await readAt(fh, 0, Math.min(64, size));
    const det = detectHead(head);
    if (!det) return { ok: false, reason: "unknown_signature" };

    if (expected === "pdf") {
      if (det.type !== "pdf") return { ok: false, reason: "type_ext_mismatch" };
      return await validatePdf(fh, size);
    }
    if (["png", "jpg", "gif", "webp", "rtf", "ole"].includes(expected)) {
      if (det.type !== expected) return { ok: false, reason: "type_ext_mismatch" };
      return { ok: true, type: expected, canonicalMime: CANONICAL_MIME[expected] };
    }
    if (expected === "heic") {
      if (det.type !== "isobmff" || !HEIF_BRANDS.has(det.brand)) return { ok: false, reason: "not_heif_brand" };
      return { ok: true, type: "heic", canonicalMime: CANONICAL_MIME.heic };
    }
    if (expected === "ooxml" || expected === "odf") {
      if (det.type !== "zip") return { ok: false, reason: "not_zip" };
      return await validateZipOffice(fh, size, e);
    }
    return { ok: false, reason: "unhandled" };
  } catch (err) {
    return { ok: false, reason: "read_error" };
  } finally {
    if (fh) { try { await fh.close(); } catch { /* ignore */ } }
  }
}

module.exports = { validateUploadFile, detectHead, HEIF_BRANDS, EXT_TYPE };
