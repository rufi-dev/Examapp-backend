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
const FOOTER = `
  <div style="font-family:'Open Sans',sans-serif;font-size:7pt;color:#77848F;width:100%;
              padding:0 15mm;display:flex;justify-content:space-between;">
    <span>Examopia · dərs planı</span>
    <span><span class="pageNumber"></span>/<span class="totalPages"></span></span>
  </div>`;

async function renderPdf(html, { timeoutMs = 30000 } = {}) {
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

    return await page.pdf({
      format: "A4",
      printBackground: true, // the design is tinted blocks; without this it is blank boxes
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: FOOTER,
      margin: MARGIN,
      preferCSSPageSize: false,
      timeout: timeoutMs,
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { renderPdf, FOOTER, MARGIN };
