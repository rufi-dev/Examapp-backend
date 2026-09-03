/*
 * The lesson material as a printable document.
 *
 * ONE content walk, TWO stylesheets. The PDF goes through Chromium, so it can use
 * grid, flex and modern colour; the Word file goes through LibreOffice's HTML
 * import, which understands almost none of that and silently flattens anything it
 * does not — a layout built on grid arrives as one column of unstyled text. Rather
 * than maintain two documents that drift apart, the markup is shared and only the
 * CSS differs, with the Word sheet using margins and tables for everything.
 */

const esc = (v) =>
  String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const has = (v) => Boolean(String(v == null ? "" : v).trim());

/* ------------------------------------------------------------- screen CSS --- */
const CSS_PDF = `
:root{--ink:#16212B;--slate:#4C5B68;--muted:#77848F;--teal:#0F4C5C;--teal-tint:#E8F1F3;
  --ochre:#8A5A00;--ochre-tint:#FBF2DE;--green:#2F6B4F;--green-tint:#E7F1EB;
  --rule:#D8DEE2;--rule-soft:#ECF0F2;
  --serif:"DejaVu Serif",Georgia,serif;--sans:"Open Sans","DejaVu Sans",sans-serif}
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font-family:var(--sans);font-size:10.5pt;line-height:1.55;color:var(--ink);
  -webkit-print-color-adjust:exact;print-color-adjust:exact}

.masthead{border-top:2.5pt solid var(--teal);padding-top:8pt;margin-bottom:16pt}
.brandline{display:flex;justify-content:space-between;font-size:7.5pt;letter-spacing:.1em;
  font-weight:700;color:var(--teal);margin-bottom:9pt;text-transform:uppercase}
.brandline .doctype{color:var(--muted);font-weight:600}
h1{font-family:var(--serif);font-size:20pt;margin:0 0 4pt;line-height:1.15}
.meta{margin:0;color:var(--muted);font-size:9pt}

h2{font-family:var(--serif);font-size:13.5pt;margin:18pt 0 6pt;color:var(--teal);
  border-bottom:.75pt solid var(--rule);padding-bottom:3pt;break-after:avoid}
p{margin:0 0 8pt;max-width:34em}

ul,ol{margin:0 0 9pt;padding-left:16pt}
li{margin-bottom:3pt}

.def{display:flex;gap:9pt;margin:0 0 9pt;padding:7pt 9pt;background:var(--teal-tint);
  border-radius:3pt;break-inside:avoid}
.def .term{font-weight:700;color:var(--teal);white-space:nowrap}
.def .body{margin:0;max-width:none}

.ex{margin:0 0 10pt;padding:8pt 10pt;border:.75pt solid var(--rule);border-radius:3pt;break-inside:avoid}
.ex .tag{display:block;font-size:7.5pt;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;color:var(--teal);margin-bottom:3pt}
.ex .sol{margin:6pt 0 0;padding-top:5pt;border-top:.5pt dashed var(--rule);
  color:var(--slate);white-space:pre-line}
.ex .sol b{color:var(--ink)}

.task{margin:0 0 9pt;padding:8pt 10pt 8pt 12pt;background:#FAFBFC;border-radius:3pt;break-inside:avoid}
.task .tag{display:block;font-size:7.5pt;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;color:var(--ochre);margin-bottom:3pt}

.note{margin:0 0 9pt;padding:7pt 10pt;border-radius:3pt;break-inside:avoid;font-size:10pt}
.note.info{background:var(--teal-tint);color:var(--teal)}
.note.warning{background:var(--ochre-tint);color:var(--ochre)}
.note.success{background:var(--green-tint);color:var(--green)}
.note p{margin:0;max-width:none}

table{width:100%;border-collapse:collapse;margin:0 0 10pt;break-inside:avoid}
th{font-size:8.5pt;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
  color:var(--teal);text-align:left;border-bottom:1pt solid var(--teal);padding:0 6pt 3pt 0}
td{font-size:10pt;padding:4pt 6pt 4pt 0;border-bottom:.5pt solid var(--rule-soft);vertical-align:top}

.fig{margin:0 0 12pt;padding:8pt 0;text-align:center;break-inside:avoid}
.fig svg{max-width:100%;height:auto}
.fig figcaption{margin-top:5pt;color:var(--muted);font-size:8.5pt;font-style:italic}

@page{size:A4;margin:16mm 16mm 18mm}
`;

/* --------------------------------------------------------------- Word CSS --- */
// No grid, no flex, no custom properties: LibreOffice ignores all three and Word
// ignores most of them. Margins, borders and tables only.
const CSS_DOCX = `
@page{size:A4;margin:2cm}
body{font-family:"Calibri","Segoe UI",sans-serif;font-size:11pt;color:#16212B;line-height:1.45}
h1{font-family:"Georgia",serif;font-size:22pt;color:#0F4C5C;margin:0 0 4pt}
.meta{color:#77848F;font-size:9.5pt;margin:0 0 16pt}
h2{font-family:"Georgia",serif;font-size:14pt;color:#0F4C5C;margin:18pt 0 6pt;
  border-bottom:1pt solid #D8DEE2;padding-bottom:3pt}
p{margin:0 0 8pt}
ul,ol{margin:0 0 9pt}
li{margin-bottom:3pt}
.def{margin:0 0 9pt;padding:8pt 10pt;background:#E8F1F3}
.def .term{font-weight:bold;color:#0F4C5C}
.ex{margin:0 0 10pt;padding:8pt 10pt;border:1pt solid #D8DEE2}
.ex .tag{font-size:8pt;font-weight:bold;color:#0F4C5C}
.ex .sol{margin:6pt 0 0;color:#4C5B68}
.task{margin:0 0 9pt;padding:8pt 10pt;background:#FAFBFC}
.task .tag{font-size:8pt;font-weight:bold;color:#8A5A00}
.note{margin:0 0 9pt;padding:8pt 10pt}
.note.info{background:#E8F1F3;color:#0F4C5C}
.note.warning{background:#FBF2DE;color:#8A5A00}
.note.success{background:#E7F1EB;color:#2F6B4F}
table{border-collapse:collapse;width:100%;margin:0 0 10pt}
th{font-size:9pt;color:#0F4C5C;text-align:left;border-bottom:1pt solid #0F4C5C;padding:4pt 6pt 4pt 0}
td{font-size:10.5pt;padding:4pt 6pt;border-bottom:0.5pt solid #ECF0F2}
.fig{margin:0 0 12pt;text-align:center}
.fig figcaption{margin-top:4pt;color:#77848F;font-size:9pt;font-style:italic}
`;

/* ------------------------------------------------------------ the content --- */

/*
 * WHY WORD GETS DIFFERENT MARKUP.
 *
 * LibreOffice's HTML import does not keep a bordered, padded <div> together. It
 * turns each child paragraph into its OWN framed paragraph, so one worked example
 * arrived in Word as three separate boxes — and a long solution broke mid-sentence
 * across two of them, which is worse than having no box at all.
 *
 * A single-cell TABLE is how Word actually represents a callout, and LibreOffice
 * imports tables faithfully: the cell holds its paragraphs together, keeps one
 * border around all of them, and takes a background. So the screen and the PDF use
 * divs, and Word uses a table carrying the same colours and the same content.
 */
const wordBox = (inner, { bg = "", border = "#D8DEE2", pad = "10pt 12pt" } = {}) => `
<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:0 0 10pt 0">
  <tr><td style="border:0.75pt solid ${border};${bg ? `background-color:${bg};` : ""}padding:${pad}">
    ${inner}
  </td></tr>
</table>`;

function renderBlock(b, forWord) {
  switch (b.kind) {
    case "heading":
      return `<h2>${esc(b.text)}</h2>`;

    case "text":
      return `<p>${esc(b.text)}</p>`;

    case "definition":
      return forWord
        ? wordBox(
            `<p style="margin:0"><b style="color:#0F4C5C">${esc(b.term)}</b> — ${esc(b.text)}</p>`,
            { bg: "#E8F1F3", border: "#C7DDE2" }
          )
        : `<div class="def"><span class="term">${esc(b.term)}</span><p class="body">${esc(b.text)}</p></div>`;

    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}>${(b.items || []).map((i) => `<li>${esc(i)}</li>`).join("")}</${tag}>`;
    }

    case "example": {
      const inner = `<p style="margin:0 0 4pt 0;font-size:8.5pt;font-weight:bold;color:#0F4C5C">NÜMUNƏ</p>
        <p style="margin:0">${esc(b.text)}</p>${
        has(b.solution)
          ? `<p style="margin:7pt 0 0 0;padding-top:5pt;border-top:0.5pt solid #D8DEE2;color:#4C5B68"><b>Həlli:</b> ${esc(b.solution)}</p>`
          : ""
      }`;
      return forWord
        ? wordBox(inner)
        : `<div class="ex"><span class="tag">Nümunə</span><p>${esc(b.text)}</p>${
            has(b.solution) ? `<p class="sol"><b>Həlli:</b> ${esc(b.solution)}</p>` : ""
          }</div>`;
    }

    /*
     * A task's solution is NEVER printed, in either format. This is the sheet a
     * student writes on; putting the answer under the question hands them the
     * paper. The teacher has it on screen, which is where it belongs.
     */
    case "task":
      return forWord
        ? wordBox(
            `<p style="margin:0 0 4pt 0;font-size:8.5pt;font-weight:bold;color:#8A5A00">TAPŞIRIQ</p>
             <p style="margin:0">${esc(b.text)}</p>`,
            { bg: "#FAFBFC", border: "#E6E9EC" }
          )
        : `<div class="task"><span class="tag">Tapşırıq</span><p>${esc(b.text)}</p></div>`;

    case "note": {
      const tone = b.tone || "info";
      const WORD_TONE = {
        info: { bg: "#E8F1F3", border: "#C7DDE2", fg: "#0F4C5C" },
        warning: { bg: "#FBF2DE", border: "#EBD9AE", fg: "#8A5A00" },
        success: { bg: "#E7F1EB", border: "#C6DFD1", fg: "#2F6B4F" },
      }[tone] || { bg: "#E8F1F3", border: "#C7DDE2", fg: "#0F4C5C" };
      return forWord
        ? wordBox(`<p style="margin:0;color:${WORD_TONE.fg}">${esc(b.text)}</p>`, {
            bg: WORD_TONE.bg,
            border: WORD_TONE.border,
            pad: "9pt 12pt",
          })
        : `<div class="note ${esc(tone)}"><p>${esc(b.text)}</p></div>`;
    }

    /*
     * A drawing. Inline SVG for the PDF, because Chromium renders it perfectly and
     * it stays sharp at any print size. For Word the caller has already rasterised
     * it to a PNG and put it on `pngSrc` — LibreOffice's HTML import cannot be
     * relied on for inline SVG, and a missing diagram in a handout is worse than a
     * slightly softer one.
     */
    case "figure": {
      const art = forWord
        ? b.pngSrc
          ? `<img src="${b.pngSrc}" alt="${esc(b.text)}" style="width:100%;max-width:460pt"/>`
          : ""
        : b.svg || "";
      if (!art) return "";
      return `<figure class="fig">${art}${
        has(b.text) ? `<figcaption>${esc(b.text)}</figcaption>` : ""
      }</figure>`;
    }

    case "table": {
      const head = (b.columns || []).map((c) => `<th>${esc(c)}</th>`).join("");
      const body = (b.rows || [])
        .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
        .join("");
      // Word ignores the stylesheet's borders on an imported table often enough
      // that they are declared on the element itself — a dotted grey grid was what
      // it fell back to.
      return forWord
        ? `<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:0 0 12pt 0">
             <tr>${(b.columns || [])
               .map(
                 (c) =>
                   `<td style="border-bottom:1pt solid #0F4C5C;padding:5pt 8pt 4pt 0;color:#0F4C5C;font-size:9pt;font-weight:bold">${esc(c)}</td>`
               )
               .join("")}</tr>
             ${(b.rows || [])
               .map(
                 (r) =>
                   `<tr>${r
                     .map(
                       (c) =>
                         `<td style="border-bottom:0.5pt solid #E4E8EA;padding:5pt 8pt;font-size:10.5pt;vertical-align:top">${esc(c)}</td>`
                     )
                     .join("")}</tr>`
               )
               .join("")}
           </table>`
        : `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }

    default:
      return "";
  }
}

/*
 * Rasterise every figure for the Word path. Async, so it is a separate step the
 * export awaits before rendering — buildLessonDocHtml itself stays synchronous,
 * which keeps it usable from a test with no image toolchain.
 */
async function withRasterFigures(doc = {}) {
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  if (!blocks.some((b) => b && b.kind === "figure")) return doc;
  const { svgToPngDataUri } = require("./lessonDocSvg");
  const out = [];
  for (const b of blocks) {
    if (b && b.kind === "figure" && b.svg) {
      // eslint-disable-next-line no-await-in-loop
      out.push({ ...b, pngSrc: await svgToPngDataUri(b.svg) });
    } else {
      out.push(b);
    }
  }
  return { ...doc, blocks: out };
}

function buildLessonDocHtml(rawDoc = {}, { forWord = false } = {}) {
  const doc = rawDoc && typeof rawDoc === "object" ? rawDoc : {};
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  const title = has(doc.title) ? doc.title : has(doc.topic) ? doc.topic : "Dərs materialı";
  const meta = [doc.subject, doc.grade && `${doc.grade}-ci sinif`, doc.audience]
    .filter((x) => has(x))
    .join(" · ");

  const body = blocks.map((b) => renderBlock(b, forWord)).join("\n");

  const head = forWord
    ? `<h1>${esc(title)}</h1>${meta ? `<p class="meta">${esc(meta)}</p>` : ""}`
    : `<header class="masthead">
  <div class="brandline"><span>Examopia</span><span class="doctype">Dərs materialı</span></div>
  <h1>${esc(title)}</h1>
  ${meta ? `<p class="meta">${esc(meta)}</p>` : ""}
</header>`;

  return `<!DOCTYPE html><html lang="az"><head><meta charset="utf-8">
<title>${esc(title)}</title><style>${forWord ? CSS_DOCX : CSS_PDF}</style></head><body>
${head}
${body || '<p class="meta">Bu materialda hələ məzmun yoxdur.</p>'}
</body></html>`;
}

module.exports = { buildLessonDocHtml, withRasterFigures, renderBlock, esc, CSS_PDF, CSS_DOCX };
