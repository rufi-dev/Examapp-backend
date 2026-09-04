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


/*
 * The document's accent colour, as a named choice rather than a free-form hex.
 *
 * A teacher asked to make the material red and nothing happened: colour was not
 * something the system could express, so the request fell through the gap between
 * "content" and "page numbers" and the turn quietly did nothing.
 *
 * Named, because each accent needs a MATCHING tint that keeps text on it readable
 * — a free hex lets a teacher pick a yellow that renders their definitions
 * invisible, and lets arbitrary text into a stylesheet. Each entry is a strong
 * ink for headings and rules, and a pale ground for callouts, checked together.
 */
const ACCENTS = {
  default: { ink: "#445CCA", tint: "#EDF0FB", edge: "#C9D2F0" }, // the app's own primary
  red: { ink: "#C0392B", tint: "#FBEDEB", edge: "#F0C9C4" },
  orange: { ink: "#B45309", tint: "#FDF1E3", edge: "#F2D6B3" },
  green: { ink: "#15803D", tint: "#E9F5ED", edge: "#C2E2CE" },
  teal: { ink: "#0F766E", tint: "#E6F4F2", edge: "#BBDEDA" },
  purple: { ink: "#6D28D9", tint: "#F1EBFC", edge: "#D8C9F5" },
  slate: { ink: "#334155", tint: "#EEF1F4", edge: "#CBD5E1" },
};
const ACCENT_NAMES = Object.keys(ACCENTS);
const accentOf = (doc) => ACCENTS[doc?.settings?.accent] || ACCENTS.default;

/* ------------------------------------------------------------- screen CSS --- */
const cssPdf = (a) => `
/*
 * THE SAME PALETTE THE PREVIEW USES.
 *
 * These were a separate teal identity — a document that looked nothing like the
 * one on screen beside it, which made the preview a decoration rather than a
 * promise. Every value here is the app's own design token from
 * Frontend/src/index.css, resolved to hex because a print stylesheet cannot read
 * a CSS variable set on another document: --primary 68 92 202, --text 34 38 49,
 * --text-muted 103 108 120, --border 221 223 229, --surface-2 235 237 242,
 * --warning 233 180 82, --success 21 128 61.
 *
 * If a token moves in index.css, move it here too. The preview IS the contract.
 */
:root{--ink:#222631;--slate:#676C78;--muted:#676C78;--accent:${a.ink};--accent-tint:${a.tint};
  --ochre:#8A5A00;--ochre-tint:#FBF2DE;--green:#15803D;--green-tint:#E7F1EB;
  --rule:#DDDFE5;--rule-soft:#EBEDF2;
  --serif:"Open Sans","DejaVu Sans",sans-serif;--sans:"Open Sans","DejaVu Sans",sans-serif}
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font-family:var(--sans);font-size:10.5pt;line-height:1.55;color:var(--ink);
  -webkit-print-color-adjust:exact;print-color-adjust:exact}

h1{font-family:var(--serif);font-size:20pt;margin:0 0 4pt;line-height:1.15}
.meta{margin:0;color:var(--muted);font-size:9pt}

h2{font-family:var(--serif);font-size:13.5pt;margin:18pt 0 6pt;color:var(--accent);
  border-bottom:.75pt solid var(--rule);padding-bottom:3pt;break-after:avoid}
p{margin:0 0 8pt;max-width:34em}

ul,ol{margin:0 0 9pt;padding-left:16pt}
li{margin-bottom:3pt}

.def{display:flex;gap:9pt;margin:0 0 9pt;padding:7pt 9pt;background:var(--accent-tint);
  border-radius:3pt;break-inside:avoid}
.def .term{font-weight:700;color:var(--accent);white-space:nowrap}
.def .body{margin:0;max-width:none}

.ex{margin:0 0 10pt;padding:8pt 10pt;border:.75pt solid var(--rule);border-radius:3pt;break-inside:avoid}
.ex .tag{display:block;font-size:7.5pt;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;color:var(--accent);margin-bottom:3pt}
.ex .sol{margin:6pt 0 0;padding-top:5pt;border-top:.5pt dashed var(--rule);
  color:var(--slate);white-space:pre-line}
.ex .sol b{color:var(--ink)}

.task{margin:0 0 9pt;padding:8pt 10pt 8pt 12pt;background:#FAFBFC;border-radius:3pt;break-inside:avoid}
.task .tag{display:block;font-size:7.5pt;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;color:var(--ochre);margin-bottom:3pt}

.note{margin:0 0 9pt;padding:7pt 10pt;border-radius:3pt;break-inside:avoid;font-size:10pt}
.note.info{background:var(--accent-tint);color:var(--accent)}
.note.warning{background:var(--ochre-tint);color:var(--ochre)}
.note.success{background:var(--green-tint);color:var(--green)}
.note p{margin:0;max-width:none}

table{width:100%;border-collapse:collapse;margin:0 0 10pt;break-inside:avoid}
th{font-size:8.5pt;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
  color:var(--accent);text-align:left;border-bottom:1pt solid var(--accent);padding:0 6pt 3pt 0}
td{font-size:10pt;padding:4pt 6pt 4pt 0;border-bottom:.5pt solid var(--rule-soft);vertical-align:top;
  height:16pt}

.fig{margin:0 0 12pt;padding:8pt 0;text-align:center;break-inside:avoid}
.fig svg{max-width:100%;height:auto}
.fig figcaption{margin-top:5pt;color:var(--muted);font-size:8.5pt;font-style:italic}

@page{size:A4;margin:16mm 16mm 18mm}
`;

/* --------------------------------------------------------------- Word CSS --- */
// No grid, no flex, no custom properties: LibreOffice ignores all three and Word
// ignores most of them. Margins, borders and tables only.
const cssDocx = (a) => `
@page{size:A4;margin:2cm}
body{font-family:"Calibri","Segoe UI",sans-serif;font-size:11pt;color:#222631;line-height:1.45}
h1{font-family:"Georgia",serif;font-size:22pt;color:${a.ink};margin:0 0 4pt}
.meta{color:#676C78;font-size:9.5pt;margin:0 0 16pt}
h2{font-family:"Georgia",serif;font-size:14pt;color:${a.ink};margin:18pt 0 6pt;
  border-bottom:1pt solid #DDDFE5;padding-bottom:3pt}
p{margin:0 0 8pt}
ul,ol{margin:0 0 9pt}
li{margin-bottom:3pt}
.def{margin:0 0 9pt;padding:8pt 10pt;background:${a.tint}}
.def .term{font-weight:bold;color:${a.ink}}
.ex{margin:0 0 10pt;padding:8pt 10pt;border:1pt solid #DDDFE5}
.ex .tag{font-size:8pt;font-weight:bold;color:${a.ink}}
.ex .sol{margin:6pt 0 0;color:#676C78}
.task{margin:0 0 9pt;padding:8pt 10pt;background:#FAFBFC}
.task .tag{font-size:8pt;font-weight:bold;color:#8A5A00}
.note{margin:0 0 9pt;padding:8pt 10pt}
.note.info{background:${a.tint};color:${a.ink}}
.note.warning{background:#FBF2DE;color:#8A5A00}
.note.success{background:#E7F1EB;color:#15803D}
table{border-collapse:collapse;width:100%;margin:0 0 10pt}
th{font-size:9pt;color:${a.ink};text-align:left;border-bottom:1pt solid ${a.ink};padding:4pt 6pt 4pt 0}
td{font-size:10.5pt;padding:4pt 6pt;border-bottom:0.5pt solid #EBEDF2;height:16pt}
.fig{margin:0 0 12pt;text-align:center}
.fig figcaption{margin-top:4pt;color:#676C78;font-size:9pt;font-style:italic}
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
const wordBox = (inner, { bg = "", border = "#DDDFE5", pad = "10pt 12pt" } = {}) => `
<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:0 0 10pt 0">
  <tr><td style="border:0.75pt solid ${border};${bg ? `background-color:${bg};` : ""}padding:${pad}">
    ${inner}
  </td></tr>
</table>`;

function renderBlock(b, forWord, a = ACCENTS.default) {
  switch (b.kind) {
    case "heading":
      return `<h2>${esc(b.text)}</h2>`;

    case "text":
      return `<p>${esc(b.text)}</p>`;

    case "definition":
      return forWord
        ? wordBox(
            `<p style="margin:0"><b style="color:${a.ink}">${esc(b.term)}</b> — ${esc(b.text)}</p>`,
            { bg: a.tint, border: a.edge }
          )
        : `<div class="def"><span class="term">${esc(b.term)}</span><p class="body">${esc(b.text)}</p></div>`;

    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}>${(b.items || []).map((i) => `<li>${esc(i)}</li>`).join("")}</${tag}>`;
    }

    case "example": {
      const inner = `<p style="margin:0 0 4pt 0;font-size:8.5pt;font-weight:bold;color:${a.ink}">NÜMUNƏ</p>
        <p style="margin:0">${esc(b.text)}</p>${
        has(b.solution)
          ? `<p style="margin:7pt 0 0 0;padding-top:5pt;border-top:0.5pt solid #DDDFE5;color:#676C78"><b>Həlli:</b> ${esc(b.solution)}</p>`
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
        info: { bg: a.tint, border: a.edge, fg: a.ink },
        warning: { bg: "#FBF2DE", border: "#EBD9AE", fg: "#8A5A00" },
        success: { bg: "#E7F1EB", border: "#C6DFD1", fg: "#15803D" },
      }[tone] || { bg: a.tint, border: a.edge, fg: a.ink };
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
      /*
       * An empty cell still has to be a box you can write in.
       *
       * A blank form is mostly empty cells, and an empty <td> collapses to a hair
       * line in both renderers — the teacher gets the labels and nowhere to put
       * anything. A non-breaking space gives the cell a line box, so a form prints
       * as a form rather than as a list of headings with gaps.
       */
      const cell = (c) => (String(c || "").trim() ? esc(c) : "&nbsp;");
      const head = (b.columns || []).map((c) => `<th>${cell(c)}</th>`).join("");
      const body = (b.rows || [])
        .map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`)
        .join("");
      // Word ignores the stylesheet's borders on an imported table often enough
      // that they are declared on the element itself — a dotted grey grid was what
      // it fell back to.
      return forWord
        ? `<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:0 0 12pt 0">
             <tr>${(b.columns || [])
               .map(
                 (c) =>
                   `<td style="border-bottom:1pt solid ${a.ink};padding:5pt 8pt 4pt 0;color:${a.ink};font-size:9pt;font-weight:bold">${cell(c)}</td>`
               )
               .join("")}</tr>
             ${(b.rows || [])
               .map(
                 (r) =>
                   `<tr>${r
                     .map(
                       (c) =>
                         `<td style="border-bottom:0.5pt solid #E4E8EA;padding:5pt 8pt;font-size:10.5pt;vertical-align:top">${cell(c)}</td>`
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

  // The document's own accent, chosen by the teacher through the AI's
  // set_print_options tool. Both stylesheets and the Word markup take it, so the
  // colour a teacher asked for is the colour that prints.
  const a = accentOf(doc);
  /*
   * The model's own document when there is one, the old block walk otherwise.
   *
   * Documents written before the HTML tool still hold blocks and must keep
   * rendering — a teacher does not lose a material because the representation
   * changed underneath it. New ones are the model's markup, sanitised on the way
   * in, and the SAME string reaches the screen, the PDF and Word, which is what
   * makes the preview the file rather than an approximation of it.
   */
  const body = has(doc.html) ? doc.html : blocks.map((b) => renderBlock(b, forWord, a)).join("\n");

  /*
   * No brandline. The PDF used to open with "EXAMOPIA" and "DƏRS MATERİALI"
   * stamped across the top — words that appear nowhere in the preview beside it,
   * on a document a teacher hands to a methodologist as their own work. A tool
   * signing the output it was asked to produce is a watermark, and the preview is
   * the contract: what is on screen is what prints.
   */
  const head = `<h1>${esc(title)}</h1>${meta ? `<p class="meta">${esc(meta)}</p>` : ""}`;

  return `<!DOCTYPE html><html lang="az"><head><meta charset="utf-8">
<title>${esc(title)}</title><style>${forWord ? cssDocx(a) : cssPdf(a)}</style></head><body>
${head}
${body || '<p class="meta">Bu materialda hələ məzmun yoxdur.</p>'}
</body></html>`;
}

module.exports = { buildLessonDocHtml, withRasterFigures, renderBlock, esc, cssPdf, cssDocx, ACCENTS, ACCENT_NAMES };
