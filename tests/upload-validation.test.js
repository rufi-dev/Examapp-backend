/*
 * AUD-013 CR-056/CR-065/CR-066 — TRUSTED, SUBTYPE-AUTHENTIC, ASYNC file validation.
 * Covers the reproduced confusions (DOCX-as-ODT, Word-as-XLSX, fake
 * [Content_Types].xml-only ZIP as DOCX, garbage ODF mimetype, EOCD count mismatch,
 * AVIF-as-HEIC, header-only PDF), the async controller fail-closed boundary, and a
 * real multer HTTP matrix.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const multer = require("multer");
const { validateUploadFile } = require("../utils/fileValidation");
const verifyUploadSignature = require("../middleware/verifyUpload");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

const PDF = Buffer.from("%PDF-1.7\n1 0 obj<< >>endobj\ntrailer<< >>\n%%EOF\n", "latin1");
const PDF_HEADER_ONLY = Buffer.from("%PDF-1.7\nnothing here, no trailer", "latin1");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>       ", "latin1");

// Minimal ZIP builder (stored/method 0). `eocdCount` overrides the EOCD entry count.
function makeZip(entries, { eocdCount } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const en of entries) {
    const name = Buffer.from(en.name, "utf8");
    const data = en.data || Buffer.alloc(0);
    const uncompressed = en.uncompressed != null ? en.uncompressed : data.length;
    const method = en.method || 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(uncompressed, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(uncompressed, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const localBuf = Buffer.concat(locals), centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  const count = eocdCount != null ? eocdCount : entries.length;
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(count, 8); eocd.writeUInt16LE(count, 10); eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}
function makeHeic(brand) { const b = Buffer.alloc(24); b.writeUInt32BE(24, 0); b.write("ftyp", 4, "latin1"); b.write(brand.padEnd(4).slice(0, 4), 8, "latin1"); b.write(brand.padEnd(4).slice(0, 4), 16, "latin1"); return b; }

const DOCX = makeZip([{ name: "[Content_Types].xml", data: Buffer.from("<Types/>") }, { name: "word/document.xml", data: Buffer.from("<w/>") }]);
const XLSX = makeZip([{ name: "[Content_Types].xml", data: Buffer.from("<Types/>") }, { name: "xl/workbook.xml", data: Buffer.from("<wb/>") }]);
const PPTX = makeZip([{ name: "[Content_Types].xml", data: Buffer.from("<Types/>") }, { name: "ppt/presentation.xml", data: Buffer.from("<p/>") }]);
const ODT = makeZip([{ name: "mimetype", data: Buffer.from("application/vnd.oasis.opendocument.text") }, { name: "content.xml", data: Buffer.from("<x/>") }]);
const ODS = makeZip([{ name: "mimetype", data: Buffer.from("application/vnd.oasis.opendocument.spreadsheet") }, { name: "content.xml", data: Buffer.from("<x/>") }]);
const CT_ONLY = makeZip([{ name: "[Content_Types].xml", data: Buffer.from("<Types/>") }]);
const GENERIC_ZIP = makeZip([{ name: "hello.txt", data: Buffer.from("hi") }]);
const ODF_BAD_MIME = makeZip([{ name: "mimetype", data: Buffer.from("application/garbage") }, { name: "content.xml", data: Buffer.from("<x/>") }]);
const COUNT_MISMATCH = makeZip([{ name: "[Content_Types].xml", data: Buffer.from("<T/>") }, { name: "word/document.xml", data: Buffer.from("<w/>") }], { eocdCount: 5 });
const ZIP_SLIP = makeZip([{ name: "../evil", data: Buffer.from("x") }, { name: "[Content_Types].xml", data: Buffer.from("<T/>") }, { name: "word/document.xml", data: Buffer.from("<w/>") }]);

function tmp(bytes) { const p = path.join(os.tmpdir(), `cr065-${Date.now()}-${Math.random().toString(36).slice(2)}`); fs.writeFileSync(p, bytes); return p; }
async function val(bytes, ext) { const p = tmp(bytes); try { return await validateUploadFile(p, ext); } finally { try { fs.unlinkSync(p); } catch {} } }

async function main() {
  // ── simple types + PDF trailer ──
  ok("genuine PDF (has %%EOF) as .pdf accepted", (await val(PDF, ".pdf")).ok === true);
  ok("CR-066: header-only PDF (no trailer) REJECTED", (await val(PDF_HEADER_ONLY, ".pdf")).ok === false);
  ok("PNG as .png accepted", (await val(PNG, ".png")).ok === true);
  ok("HTML as .pdf rejected", (await val(HTML, ".pdf")).ok === false);

  // ── OOXML subtype-authentic ──
  ok(".docx (has word/document.xml) accepted", (await val(DOCX, ".docx")).type === "ooxml");
  ok(".xlsx (has xl/workbook.xml) accepted", (await val(XLSX, ".xlsx")).ok === true);
  ok(".pptx (has ppt/presentation.xml) accepted", (await val(PPTX, ".pptx")).ok === true);
  ok("CR-065: Word (docx bytes) REJECTED as .xlsx", (await val(DOCX, ".xlsx")).ok === false);
  ok("CR-065: fake [Content_Types].xml-only ZIP REJECTED as .docx", (await val(CT_ONLY, ".docx")).ok === false);
  ok("CR-065: generic ZIP REJECTED as .docx", (await val(GENERIC_ZIP, ".docx")).ok === false);

  // ── ODF subtype-authentic ──
  ok(".odt (stored mimetype + content.xml) accepted", (await val(ODT, ".odt")).type === "odf");
  ok(".ods accepted", (await val(ODS, ".ods")).ok === true);
  ok("CR-065: DOCX REJECTED as .odt (no stored mimetype first)", (await val(DOCX, ".odt")).ok === false);
  ok("CR-065: garbage ODF mimetype REJECTED", (await val(ODF_BAD_MIME, ".odt")).ok === false);
  ok("CR-065: [Content_Types].xml is NOT ODF evidence (CT_ONLY as .odt rejected)", (await val(CT_ONLY, ".odt")).ok === false);

  // ── structural ZIP hardening ──
  ok("CR-065: EOCD entry-count mismatch REJECTED", (await val(COUNT_MISMATCH, ".docx")).reason === "eocd_count_mismatch");
  ok("CR-065: zip-slip entry name REJECTED", (await val(ZIP_SLIP, ".docx")).reason === "bad_name");

  // ── HEIC brands, AVIF excluded ──
  ok("HEIC (heic brand) accepted", (await val(makeHeic("heic"), ".heic")).ok === true);
  ok("CR-065: AVIF brand REJECTED as .heic", (await val(makeHeic("avif"), ".heic")).ok === false);
  ok("non-HEIF brand (mp42) rejected", (await val(makeHeic("mp42"), ".heic")).ok === false);

  // ── middleware: async, trusted type, reject+delete ──
  {
    const p = tmp(DOCX);
    const req = { file: { path: p, originalname: "a.docx" } };
    await new Promise((r) => verifyUploadSignature(req, { status() { return this; }, json() { return this; } }, r));
    ok("middleware set req.detectedType='ooxml'", req.detectedType === "ooxml");
    try { fs.unlinkSync(p); } catch {}
    const bad = tmp(HTML);
    let code = 0;
    await new Promise((r) => verifyUploadSignature({ file: { path: bad, originalname: "x.pdf" } }, { status(c) { code = c; return this; }, json() { r(); return this; } }, r));
    ok("middleware rejects HTML-as-PDF (400) + deletes", code === 400 && !fs.existsSync(bad));
  }

  // ── real multer HTTP matrix + controller-style fail-closed ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr065up-"));
  const upload = multer({ storage: multer.diskStorage({ destination: (rq, f, cb) => cb(null, dir), filename: (rq, f, cb) => cb(null, `u-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(f.originalname)}`) }) });
  const app = express();
  // A controller stub that FAILS CLOSED unless a trusted type is present.
  app.post("/up", upload.single("file"), verifyUploadSignature, (req, res) => {
    if (!req.detectedType || !req.canonicalMime) return res.status(400).json({ failClosed: true });
    res.json({ type: req.detectedType, mime: req.canonicalMime });
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  function up(filename, bytes, mime) {
    return new Promise((resolve) => {
      const b = "----b" + Math.random().toString(36).slice(2);
      const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`), bytes, Buffer.from(`\r\n--${b}--\r\n`)]);
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/up", headers: { "Content-Type": `multipart/form-data; boundary=${b}`, "Content-Length": body.length } },
        (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })() })); });
      req.write(body); req.end();
    });
  }
  ok("HTTP: genuine PDF → 200 + trusted type (client MIME ignored)", (await up("n.pdf", PDF, "application/octet-stream")).body.type === "pdf");
  ok("HTTP: forged MIME (png as .pdf) → 400", (await up("e.pdf", PNG, "application/pdf")).status === 400);
  ok("HTTP: Word-as-XLSX forged container → 400", (await up("s.xlsx", DOCX, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).status === 400);
  ok("HTTP: PDF-headed polyglot as .docx → 400", (await up("p.docx", Buffer.concat([Buffer.from("%PDF-1.7\n"), GENERIC_ZIP]), "application/zip")).status === 400);
  ok("HTTP: truncated → 400", (await up("t.pdf", Buffer.from("%P"), "application/pdf")).status === 400);

  // CR-070: the exact polyglots, through the REAL upload route.
  const PDF_ZIP = Buffer.concat([Buffer.from("%PDF-1.7\nx\n%%EOF\n", "latin1"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02])]);
  ok("CR-070 HTTP: PDF with appended ZIP payload → 400", (await up("poly.pdf", PDF_ZIP, "application/pdf")).status === 400);
  const ODT_SUFFIX = makeZip([{ name: "mimetype", data: Buffer.from("application/vnd.oasis.opendocument.textEVIL") }, { name: "content.xml", data: Buffer.from("<x/>") }]);
  ok("CR-070 HTTP: ODF mimetype prefix+suffix → 400", (await up("s.odt", ODT_SUFFIX, "application/vnd.oasis.opendocument.text")).status === 400);
  const ODT_NO_MIME_FIRST = makeZip([{ name: "content.xml", data: Buffer.from("<x/>") }, { name: "mimetype", data: Buffer.from("application/vnd.oasis.opendocument.text") }]);
  ok("CR-070 HTTP: ODF without mimetype as physical-first → 400", (await up("f.odt", ODT_NO_MIME_FIRST, "application/vnd.oasis.opendocument.text")).status === 400);

  await new Promise((r) => server.close(r));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
