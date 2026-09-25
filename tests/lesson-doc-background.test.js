/* eslint-env node */
/*
 * A teacher's own paper, under our text.
 *
 * "Make it identical" was impossible without handing layout to the model, which
 * is the expensive architecture this engine exists to replace. It turns out not
 * to need the model at all: a PDF page is drawn in layers and Ghostscript will
 * render it with the TEXT LAYER SUPPRESSED, so the letterhead, border, watermark
 * and tint survive and every word goes.
 *
 * Every positioning rule below was MEASURED rather than reasoned about, because
 * three successive guesses about paged CSS each produced a wrong page:
 *
 *   - `position:fixed` in print is laid out against the page AREA, not the sheet.
 *   - Anything outside that area is CLIPPED, so negative offsets cannot bleed.
 *   - Therefore a design can only reach the paper's edge with @page margin 0.
 *   - Which means the text's distance from the edge must come from something
 *     that REPEATS: a table header/footer group, because padding insets page one
 *     and lets page two start underneath the band.
 *   - And the page's own white fill paints over a z-index:-1 layer, which hid
 *     the design everywhere the content reached.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { backgroundIntent, safeArea } = require("../helper/lessonDocBackground");
const { buildLessonDocHtml } = require("../helper/lessonDocHtml");

let passed = 0;
let failed = 0;
const ok = (name, cond) => {
  if (cond) { passed += 1; console.log("  ✓", name); } else { failed += 1; console.log("  ✗ FAIL:", name); }
};
const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

const hasGs = (() => {
  try { execFileSync("gs", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

(async () => {
  console.log("\n— asking for the design —");
  /*
   * Read locally, like the print settings, so wanting a letterhead costs no
   * tokens at all. That is the whole point: this is the cheap half of "make it
   * identical".
   */
  ok("a plain request is understood", backgroundIntent("eyni fonu istəyirəm")?.want === true);
  ok("...and so is the word design", backgroundIntent("bu dizaynı saxla")?.want === true);
  ok("...and a template", backgroundIntent("şablon eyni olsun")?.want === true);
  // A negation must switch it OFF, not on. Matching the noun alone would have
  // turned "remove the background" into "add the background".
  eq("removing it is not asking for it", backgroundIntent("fonu götürmə"), { remove: true });
  eq("...nor is cancelling it", backgroundIntent("dizaynı ləğv et"), { remove: true });
  // An ordinary edit must not drag a letterhead in behind it.
  eq("an unrelated instruction asks for nothing", backgroundIntent("daha çox sual əlavə et"), null);
  eq("...and so does silence", backgroundIntent(""), null);
  // Which half of the page they mean.
  ok("keeping the writing is heard", backgroundIntent("fonu götür, mətn qalsın")?.keepText === true);
  ok("removing the writing is heard", backgroundIntent("fonu götür, yazıları sil")?.keepText === false);

  console.log("\n— what the renderer does with one —");
  const doc = { title: "T", html: "<h2>Başlıq</h2><p>Mətn</p>" };
  const uri = "data:image/png;base64,AAAA";
  const plain = buildLessonDocHtml(doc);
  const withBg = buildLessonDocHtml(doc, { backgroundDataUri: uri, backgroundSafe: { top: 0.107, bottom: 0.06 } });
  const word = buildLessonDocHtml(doc, { forWord: true, backgroundDataUri: uri, backgroundSafe: { top: 0.107 } });

  ok("an ordinary material is untouched", !/<body class="has-bg">/.test(plain) && !/<table class="doc-sheet">/.test(plain));
  ok("a material with a design says so", /<body class="has-bg">/.test(withBg));
  /*
   * Measured: fixed is laid out against the page area and overflow is clipped,
   * so the margins must be zero or the design cannot reach the paper's edge.
   */
  ok("...and drops the page margins, or the design cannot reach the edge", /@page\{margin:0\}/.test(withBg));
  /*
   * ...which moves the text's spacing into a header and footer group, the only
   * constructs that repeat on every printed page. Padding clears page one and
   * lets page two start under the band.
   */
  ok("...and reserves the zone with repeating rows", /<table class="doc-sheet"><thead>/.test(withBg));
  ok("...sized from the measurement", /--doc-mt:36mm/.test(withBg));
  ok("...with a floor under it", /--doc-mb:22mm/.test(withBg));
  // The page's own fill sits ABOVE a z-index:-1 layer and hid the design.
  ok("nothing paints over it", /body\.has-bg\{background:transparent\}/.test(withBg.replace(/\s+/g, "")) || /background:transparent/.test(withBg));

  /*
   * Word is left alone on purpose. LibreOffice does not honour a fixed
   * full-bleed layer, so a .docx would come out with the design stretched down
   * page one or missing altogether — and a wrong background is worse than none.
   */
  ok("Word gets no design rather than a broken one", !/<body class="has-bg">/.test(word));
  ok("...and none of its scaffolding", !/<table class="doc-sheet">/.test(word));

  // Only a real image may be painted; a string that is not one is refused.
  ok("a non-image source is refused", !/<body class="has-bg">/.test(buildLessonDocHtml(doc, { backgroundDataUri: "javascript:alert(1)" })));

  if (!hasGs) {
    console.log("\n— the surgery itself — SKIPPED (no ghostscript here; it runs in the container)");
  } else {
    console.log("\n— the surgery itself —");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bgt-"));
    const src = path.join(dir, "s.pdf");
    const content = `q\n0.2 0.3 0.7 rg\n0 742 595 100 re f\nQ\nBT /F1 20 Tf 60 400 Td (metn) Tj ET\n`;
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${content.length} >>\nstream\n${content}endstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offs = [0];
    objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objs.length; i += 1) pdf += `${String(offs[i]).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    fs.writeFileSync(src, pdf, "latin1");

    const { extractBackground } = require("../helper/lessonDocBackground");
    const taken = await extractBackground(src, "application/pdf", { keepText: false });
    ok("a page yields a background", !!taken && taken.buffer.length > 0);
    ok("...as a png", taken && taken.mime === "image/png");
    /*
     * The band is 100 of 842 points from the top — 11.9% — and the measurement
     * has to find it, because that is what keeps the heading off the letterhead.
     */
    ok("...and its header zone is measured", taken && taken.safe.top > 0.08 && taken.safe.top < 0.16);
    ok("...with nothing invented at the foot", taken && taken.safe.bottom === 0);

    // A page decorated edge to edge would otherwise squeeze the material to
    // nothing, so an implausible measurement is discarded rather than obeyed.
    const flooded = await safeArea(Buffer.from(
      await require("sharp")({ create: { width: 60, height: 90, channels: 3, background: { r: 10, g: 20, b: 200 } } })
        .png().toBuffer()
    ));
    eq("a page with no clear area keeps the ordinary margins", flooded, { top: 0, bottom: 0 });

    const notAPdf = await extractBackground(src, "text/plain", {});
    eq("a file that is not a page yields nothing", notAPdf, null);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} background assertions failed`);
})().catch((e) => { console.error(e); process.exit(1); });
