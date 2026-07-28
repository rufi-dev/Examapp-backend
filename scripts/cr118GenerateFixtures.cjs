/*
 * CR-118/CR-120 — deterministic generator for the controlled PDF.js matrix. Produces
 * PAIRED fixtures where ONLY linearization changes (compression/object-stream held
 * constant), at a small and a large size, and:
 *   - controls the EXACT page count with explicit addPage() + per-page text that FITS
 *     one page (no PDFKit overflow auto-pagination);
 *   - asserts the ACTUAL page count with an INDEPENDENT parser (pikepdf), failing if a
 *     fixture overflowed its intended count;
 *   - DERIVES xref-table vs xref-stream from the file (never hard-codes it);
 *   - verifies linearization via libqpdf check_linearization() AND the structural head.
 *
 *   node scripts/cr118GenerateFixtures.cjs <outDir>
 *
 * Prints a JSON manifest {name,path,intendedPages,actualPages,bytes,linearized,xref}.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const PDFKit = require("pdfkit");

const outDir = process.argv[2];
if (!outDir) { console.error("usage: cr118GenerateFixtures.cjs <outDir>"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

// A per-page paragraph sized to FIT one Letter page at 11pt (no overflow → pages == calls).
const PARA = ("Examopia sinaq imtahani. ".repeat(28)).trim();

function pagePayload(page, bytes) {
  if (!bytes) return "";
  let out = "";
  let n = 0;
  while (out.length < bytes) {
    out += crypto
      .createHash("sha256")
      .update(`examopia:${page}:${n++}`)
      .digest("hex");
  }
  return out.slice(0, bytes);
}

function makePdfkit(pages, payloadBytesPerPage = 0) {
  return new Promise((resolve) => {
    const doc = new PDFKit({ size: "letter", compress: false, autoFirstPage: false });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    for (let p = 1; p <= pages; p++) {
      doc.addPage({ margin: 54 });
      doc.fontSize(16).text(`Examopia PDF — page ${p} / ${pages}`, { continued: false });
      doc.moveDown(0.5).fontSize(11).text(PARA, { width: 500, height: 640 });
      if (payloadBytesPerPage) {
        // A PDF content-stream comment adds deterministic bytes without changing
        // rendering or pagination. `compress:false` keeps the size representative.
        doc.addContent(`% CR120-PAYLOAD-${p}-${pagePayload(p, payloadBytesPerPage)}\n`);
      }
    }
    doc.end();
  });
}

// One python call: linearize (holding compression/object streams), then report libqpdf
// linearization, actual page count, and derived xref style — all from independent parsing.
function pikepdfProcess(src, dst, linearize) {
  const py = `import pikepdf,sys
p=pikepdf.open(${JSON.stringify(src)})
p.save(${JSON.stringify(dst)}, linearize=${linearize ? "True" : "False"}, compress_streams=False, object_stream_mode=pikepdf.ObjectStreamMode.preserve)
q=pikepdf.open(${JSON.stringify(dst)})
try: lin = q.check_linearization()
except Exception: lin = False
pages = len(q.pages)
# Derive xref style: an xref STREAM has a trailer object of /Type /XRef; a classic table
# starts its last cross-ref section with the 'xref' keyword.
raw = open(${JSON.stringify(dst)}, "rb").read()
xref = "stream" if b"/Type /XRef" in raw or b"/Type/XRef" in raw else ("table" if b"\\nxref" in raw or b"\\rxref" in raw else "unknown")
print("LIN" if lin else "NONLIN"); print(pages); print(xref)`;
  const r = spawnSync("python", ["-c", py], { encoding: "utf8" });
  if (r.status !== 0) { console.error("pikepdf failed:", r.stderr || r.stdout); process.exit(1); }
  const [linTok, pagesTok, xrefTok] = r.stdout.trim().split("\n").map((s) => s.trim());
  return { linearized: linTok === "LIN", pages: Number(pagesTok), xref: xrefTok };
}

const structuralLinearized = (p) => fs.readFileSync(p).subarray(0, 2048).includes(Buffer.from("/Linearized"));

(async () => {
  const manifest = [];
  const emitPair = async (name, intendedPages, source) => {
    const src = path.join(outDir, `_src_${name}.pdf`);
    const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
    fs.writeFileSync(src, source);
    for (const linear of [false, true]) {
      const variant = `${name}_${linear ? "lin" : "nonlin"}`;
      const dst = path.join(outDir, `${variant}.pdf`);
      const info = pikepdfProcess(src, dst, linear);
      if (info.pages !== intendedPages) {
        console.error(
          `FIXTURE OVERFLOW: ${variant} intended ${intendedPages} pages but parser found ${info.pages}`
        );
        process.exit(1);
      }
      const struct = structuralLinearized(dst);
      manifest.push({
        name: variant,
        path: dst,
        intendedPages,
        actualPages: info.pages,
        bytes: fs.statSync(dst).size,
        sourceSha256,
        linearized:
          (info.linearized && struct) === linear
            ? linear
            : `MISMATCH(qpdf=${info.linearized},struct=${struct})`,
        xref: info.xref,
      });
    }
    fs.rmSync(src, { force: true });
  };

  // Large (~5.2 MB — the original failing size) and small controlled pairs. Within each
  // pair only linearization differs; the page count is explicit + parser-asserted (no
  // overflow). ~2000 fitting pages reaches the ~5.2 MB size honestly.
  await emitPair("large", 160, await makePdfkit(160, 32_000));
  await emitPair("stress_2000_pages", 2_000, await makePdfkit(2_000));
  await emitPair("small", 12, await makePdfkit(12));

  console.log(JSON.stringify(manifest, null, 2));
})();
