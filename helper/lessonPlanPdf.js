/*
 * HTML -> A4 PDF, rendered by the Chromium already in this image.
 *
 * The whole reason for doing this server-side is the browser print dialog's own
 * header and footer — the date, the page title and the full URL stamped onto every
 * sheet. No stylesheet can remove them; only a renderer we control can.
 *
 * Resource note: WhatsApp sessions already hold long-lived Chromium instances in
 * this container, so this launches a browser PER REQUEST and always closes it,
 * even on failure. A pooled browser would be faster and would also mean a leaked
 * page or a wedged renderer outliving the request that caused it.
 */
const puppeteer = require("puppeteer");

const MARGIN = { top: "14mm", right: "15mm", bottom: "15mm", left: "15mm" };

// Our own footer, which is what displaces the browser's. The header template must
// still be non-empty or Chromium falls back to printing its default one.
// The label is a parameter because this renderer is shared: an exam's analytic
// table carrying "dərs planı" in its footer is a small error a teacher would
// notice immediately, on a document they hand to a methodologist.
/*
 * `label: null` prints page numbers ALONE, with no product name on the sheet.
 *
 * A lesson material is the teacher's own document — they hand it to a class or to
 * a methodologist — and a tool that signs the output it was asked to produce has
 * put a watermark on someone else's work. Lesson plans and exam tables keep their
 * label because those name what the document IS, which is useful on a stack of
 * printouts; a material's own title already does that job.
 */
const footerFor = (label) => `
  <div style="font-family:'Open Sans',sans-serif;font-size:7pt;color:#77848F;width:100%;
              padding:0 15mm;display:flex;justify-content:${label ? "space-between" : "flex-end"};">
    ${label ? `<span>Examopia · ${label}</span>` : ""}
    <span><span class="pageNumber"></span>/<span class="totalPages"></span></span>
  </div>`;
const FOOTER = footerFor("dərs planı");

async function renderPdf(
  html,
  { timeoutMs = 30000, footerLabel = "dərs planı", landscape = false, pageNumbers = true } = {}
) {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      // --no-sandbox because the container runs as root with no user namespace;
      // the input is our own template, never a third-party page.
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);

    // No network at all: the document is self-contained and an outbound font or
    // image request could hang the render behind a timeout for no benefit.
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().startsWith("data:") || r.url() === "about:blank" ? r.continue() : r.abort()));

    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    // Without this the first render can use fallback metrics and reflow wrongly.
    await page.evaluateHandle("document.fonts.ready");

    /*
     * Buffer.from is load-bearing, not tidiness. Puppeteer 24 returns a Uint8Array
     * where older versions returned a Buffer, and Express's res.send() sends a
     * Buffer as bytes but falls through to res.json() for ANY other object — so a
     * Uint8Array was delivered as {"0":37,"1":80,…} under a Content-Type of
     * application/pdf. The client received a 143KB JSON document instead of a 13KB
     * PDF and showed "Failed to load PDF document" against a body that had arrived
     * perfectly intact. Converting here means no caller can reintroduce it.
     */
    return Buffer.from(await page.pdf({
      format: "A4",
      printBackground: true, // the design is tinted blocks; without this it is blank boxes
      /*
       * displayHeaderFooter stays TRUE even with page numbers off: switching it
       * off hands the sheet back to Chromium's own header and footer — the date,
       * the page title and the file URL on every page — which is the exact thing
       * this renderer exists to prevent. An empty template is how you get a clean
       * sheet.
       */
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: pageNumbers ? footerFor(footerLabel) : "<div></div>",
      landscape,
      margin: MARGIN,
      preferCSSPageSize: false,
      timeout: timeoutMs,
    }));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}


/*
 * The same page, as a picture.
 *
 * The model writes HTML and has never once seen it. Asked to reproduce a
 * timetable exactly it got the colours right and the ruling wrong — it had
 * merged five empty September cells into the lecture block, which is invisible in
 * markup you are only reading and obvious the moment you look at it. Every other
 * check here is arithmetic on the source; this is the one that answers "does it
 * LOOK like the file", and only an image can answer that.
 *
 * Same hardened setup as the PDF: no network, no sandbox, our own document.
 */
async function renderPng(html, { timeoutMs = 30000, width = 1240 } = {}) {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.setViewport({ width, height: 1600, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().startsWith("data:") || r.url() === "about:blank" ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.evaluateHandle("document.fonts.ready");
    /*
     * Capped, not full-page. A long handout would otherwise come back as a strip
     * thousands of pixels tall that costs a fortune in image tokens and shows the
     * model less of what matters, because everything is scaled to fit.
     */
    return Buffer.from(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height: 1600 } }));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { renderPdf, renderPng, footerFor, FOOTER, MARGIN };
