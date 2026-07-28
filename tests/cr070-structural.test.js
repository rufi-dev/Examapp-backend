/*
 * AUD-013 CR-070 — subtype-authentic ZIP/PDF structural validation. Reproduces
 * the five exact polyglots Codex materialized and proves each is REJECTED, while
 * genuine office/PDF files pass:
 *   1. ODF physical-first local member is not `mimetype` (CD order lies).
 *   2. ODF `mimetype` = correct MIME + attacker suffix.
 *   3. OOXML central directory padded with trailing junk.
 *   4. local ZIP header encrypted while central header is not.
 *   5. PDF `%%EOF` followed by an appended ZIP payload.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const { validateUploadFile } = require("../utils/fileValidation");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cr070-"));

// Minimal ZIP writer. `members` are written physically in array order (so their
// local-header offsets increase). Each: {name, data, method=0, localFlags=0,
// centralFlags=0, crc=0}. `cdOrder` lets the central directory list members in a
// different order; `cdJunk` appends counted junk inside cdSize.
function buildZip({ members, cdOrder, cdJunk = Buffer.alloc(0) }) {
  const parts = [];
  const offsets = [];
  let offset = 0;
  for (const m of members) {
    const data = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data, "latin1");
    const name = Buffer.from(m.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(m.localFlags || 0, 6);
    lh.writeUInt16LE(m.method || 0, 8);
    lh.writeUInt32LE(m.crc || 0, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    offsets.push(offset);
    parts.push(lh, name, data);
    offset += lh.length + name.length + data.length;
  }
  const cdStart = offset;
  const order = cdOrder || members.map((_, i) => i);
  const cdParts = [];
  for (const i of order) {
    const m = members[i];
    const data = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data, "latin1");
    const name = Buffer.from(m.name, "utf8");
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(m.centralFlags || 0, 8);
    ch.writeUInt16LE(m.method || 0, 10);
    ch.writeUInt32LE(m.crc || 0, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offsets[i], 42);
    cdParts.push(ch, name);
  }
  cdParts.push(cdJunk);
  const cd = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(order.length, 8);
  eocd.writeUInt16LE(order.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

async function check(bytes, ext, tag) {
  const f = path.join(TMP, `${tag}${ext}`);
  fs.writeFileSync(f, bytes);
  const r = await validateUploadFile(f, ext);
  fs.unlinkSync(f);
  return r;
}

const ODT_MIME = "application/vnd.oasis.opendocument.text";

async function main() {
  // ── genuine files pass ──
  const validOdt = buildZip({ members: [{ name: "mimetype", data: ODT_MIME }, { name: "content.xml", data: "<x/>" }] });
  ok("valid ODT accepted", (await check(validOdt, ".odt", "ok-odt")).ok === true);

  const validDocx = buildZip({ members: [{ name: "[Content_Types].xml", data: "<x/>" }, { name: "word/document.xml", data: "<w/>" }] });
  ok("valid DOCX accepted", (await check(validDocx, ".docx", "ok-docx")).ok === true);

  const validPdf = Buffer.from("%PDF-1.7\n" + "A".repeat(40) + "\n%%EOF\n", "latin1");
  ok("valid PDF accepted", (await check(validPdf, ".pdf", "ok-pdf")).ok === true);

  // ── 1. ODF physical-first member is NOT mimetype (CD lists mimetype first) ──
  const odfWrongFirst = buildZip({
    members: [{ name: "sneaky.xml", data: "junk-at-lowest-offset" }, { name: "mimetype", data: ODT_MIME }, { name: "content.xml", data: "<x/>" }],
    cdOrder: [1, 0, 2], // CD lies: mimetype "first"
  });
  const r1 = await check(odfWrongFirst, ".odt", "adv1");
  ok("1. ODF physical-first-not-mimetype REJECTED", r1.ok === false && r1.reason === "odf_no_stored_mimetype");

  // ── 2. ODF mimetype = correct MIME + attacker suffix ──
  const odfSuffix = buildZip({ members: [{ name: "mimetype", data: ODT_MIME + "EVIL" }, { name: "content.xml", data: "<x/>" }] });
  const r2 = await check(odfSuffix, ".odt", "adv2");
  ok("2. ODF mimetype prefix+suffix REJECTED", r2.ok === false && r2.reason === "odf_mimetype_length");

  // ── 3. OOXML central directory with trailing junk ──
  const ooxmlJunk = buildZip({
    members: [{ name: "[Content_Types].xml", data: "<x/>" }, { name: "word/document.xml", data: "<w/>" }],
    cdJunk: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  });
  const r3 = await check(ooxmlJunk, ".docx", "adv3");
  ok("3. OOXML CD trailing junk REJECTED", r3.ok === false && r3.reason === "cd_trailing_junk");

  // ── 4. local encrypted flag while central is not ──
  const encMismatch = buildZip({ members: [{ name: "[Content_Types].xml", data: "<x/>", localFlags: 0x0001, centralFlags: 0x0000 }, { name: "word/document.xml", data: "<w/>" }] });
  const r4 = await check(encMismatch, ".docx", "adv4");
  ok("4. local-encrypted/central-clear REJECTED", r4.ok === false && r4.reason === "local_encrypted_flag");

  // ── 5. PDF %%EOF followed by an appended ZIP payload ──
  const pdfZip = Buffer.concat([Buffer.from("%PDF-1.7\n" + "A".repeat(30) + "\n%%EOF\n", "latin1"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02])]);
  const r5 = await check(pdfZip, ".pdf", "adv5");
  ok("5. PDF with appended ZIP payload REJECTED", r5.ok === false && r5.reason === "pdf_trailing_bytes");

  // A PDF with only trailing EOL after %%EOF is still fine.
  ok("PDF with trailing CRLF/space after %%EOF accepted", (await check(Buffer.from("%PDF-1.7\nx\n%%EOF\r\n  ", "latin1"), ".pdf", "ok-pdf2")).ok === true);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
