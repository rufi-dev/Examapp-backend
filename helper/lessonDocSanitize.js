const sanitizeHtml = require("sanitize-html");
const { sanitizeSvg } = require("./lessonDocSvg");

/*
 * The document, written by the model as HTML, made safe to render.
 *
 * WHY HTML AT ALL. The document used to be nine block kinds — heading, text,
 * list, definition, example, task, note, table, figure — and everything a teacher
 * asked for had to be expressible in those nine or it could not be built. A blank
 * lesson-plan form with merged cells and a Procedure grid is not expressible in
 * them, so asking for one back produced a flat list of field names. Every fix for
 * that was another negotiation with the schema.
 *
 * So the model writes the document instead, and this makes it safe. The gain is
 * not only fidelity: the SAME html is rendered on screen, into the PDF and into
 * Word, so the preview stops being an approximation of the file and starts being
 * the file.
 *
 * IT IS UNTRUSTED MARKUP. It goes into a page with dangerouslySetInnerHTML and
 * into Chromium with network access, so what this allows IS the security
 * boundary. Strict allow-list: document structure only. Nothing that can fetch,
 * navigate, execute or embed — no script, style, iframe, object, form, input,
 * link, meta, or event handler, and no href/src of any kind. A document that
 * needs to reach the network is not a document.
 */

// Structure a printed handout can be made of, and nothing else.
const TAGS = [
  "h1", "h2", "h3", "h4",
  "p", "br", "hr", "span", "div",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "strong", "b", "em", "i", "u", "s", "sup", "sub", "small", "mark",
  "blockquote", "figure", "figcaption", "section", "header", "footer",
] /* svg is handled by its own pass, see extractSvg */;

/*
 * Presentation only, and `class` so the document can use the shared stylesheet.
 * `style` is allowed but filtered hard below: it is how a model expresses a column
 * width or a cell background, which is most of what makes a form look like a form,
 * and refusing it outright was what pushed layout back into prose.
 */
const ATTRS = {
  "*": ["class", "style", "colspan", "rowspan", "align", "valign", "width", "dir", "lang"],
  col: ["span", "width"],
  td: ["colspan", "rowspan", "align", "valign", "width", "class", "style"],
  th: ["colspan", "rowspan", "align", "valign", "width", "scope", "class", "style"],
};

/*
 * The CSS properties a document may set on itself.
 *
 * `url()` is absent from every one of them, so a style attribute cannot fetch. The
 * list is what a printed page legitimately needs — box, spacing, borders, type,
 * colour — and the values are pattern-matched, so `expression(...)`, a stray
 * semicolon or an `@import` has nowhere to land.
 */
const COLOR = [/^#(0x)?[0-9a-f]{3,8}$/i, /^rgba?\(\s*[\d.\s,%/]+\)$/i, /^[a-z-]{3,20}$/i];
const SIZE = [/^-?\d{0,4}(\.\d{1,3})?(px|pt|em|rem|%|mm|cm|in)?$/i];
const STYLES = {
  "*": {
    color: COLOR,
    "background-color": COLOR,
    "border-color": COLOR,
    "text-align": [/^(left|right|center|justify)$/],
    "vertical-align": [/^(top|middle|bottom|baseline)$/],
    "font-weight": [/^(normal|bold|[1-9]00)$/],
    "font-style": [/^(normal|italic)$/],
    "font-size": SIZE,
    "line-height": [/^\d{0,2}(\.\d{1,3})?(px|pt|em|rem|%)?$/],
    "text-decoration": [/^(none|underline|line-through)$/],
    "text-transform": [/^(none|uppercase|lowercase|capitalize)$/],
    "letter-spacing": SIZE,
    width: SIZE,
    "min-width": SIZE,
    height: SIZE,
    "min-height": SIZE,
    margin: SIZE,
    "margin-top": SIZE,
    "margin-bottom": SIZE,
    "margin-left": SIZE,
    "margin-right": SIZE,
    padding: SIZE,
    "padding-top": SIZE,
    "padding-bottom": SIZE,
    "padding-left": SIZE,
    "padding-right": SIZE,
    border: [/^[\d.]{1,5}(px|pt|mm)?\s+(solid|dashed|dotted|none)(\s+.{1,24})?$/i],
    "border-top": [/^[\d.]{1,5}(px|pt|mm)?\s+(solid|dashed|dotted|none)(\s+.{1,24})?$/i],
    "border-bottom": [/^[\d.]{1,5}(px|pt|mm)?\s+(solid|dashed|dotted|none)(\s+.{1,24})?$/i],
    "border-left": [/^[\d.]{1,5}(px|pt|mm)?\s+(solid|dashed|dotted|none)(\s+.{1,24})?$/i],
    "border-right": [/^[\d.]{1,5}(px|pt|mm)?\s+(solid|dashed|dotted|none)(\s+.{1,24})?$/i],
    "border-collapse": [/^(collapse|separate)$/],
    "border-radius": SIZE,
    "page-break-before": [/^(auto|always|avoid)$/],
    "page-break-after": [/^(auto|always|avoid)$/],
    "page-break-inside": [/^(auto|avoid)$/],
    "break-inside": [/^(auto|avoid)$/],
    "white-space": [/^(normal|nowrap|pre-line|pre-wrap)$/],
  },
};

// A handout, not a book. Past this something has gone wrong upstream.
const MAX_HTML = 400000;

/*
 * SVG is handled by its own allow-list, which already refuses script, handlers,
 * foreignObject and any reference that leaves the figure. Running it through the
 * HTML sanitiser as well would strip the attributes that make a drawing draw
 * (viewBox, d, points), so each <svg> is lifted out, sanitised as SVG, and put
 * back — and a drawing that does not survive that is dropped rather than shown
 * as an empty frame.
 */
function extractSvg(html) {
  /*
   * A token the model cannot forge. The two allow-lists must not run over each
   * other's markup — the HTML pass does not know <circle> or `d`, so letting it
   * see a drawing strips the drawing to an empty <svg>, and teaching it every SVG
   * tag would fork the SVG rules across two files that then drift. So each figure
   * is lifted out, sanitised by the SVG rules alone, and put back afterwards.
   * The token is random per call, so markup that arrives containing a token from
   * a previous document matches nothing.
   */
  const token = `__svg${require("crypto").randomBytes(8).toString("hex")}__`;
  const kept = [];
  const stripped = String(html).replace(/<svg[\s\S]*?<\/svg>/gi, (svg) => {
    const clean = sanitizeSvg(svg);
    // A drawing that does not survive is dropped, not shown as an empty frame.
    if (!clean) return "";
    kept.push(clean);
    return `${token}${kept.length - 1}${token}`;
  });
  return { stripped, kept, token };
}

function sanitizeDocHtml(raw) {
  const src = String(raw || "").trim();
  if (!src) return "";
  if (src.length > MAX_HTML) return "";

  const { stripped, kept, token } = extractSvg(src);

  const clean = sanitizeHtml(stripped, {
    allowedTags: TAGS,
    allowedAttributes: ATTRS,
    allowedStyles: STYLES,
    // Kill the contents outright, not just the tag: a stripped <script> whose body
    // survived as text would still run once re-parsed into the page.
    nonTextTags: ["script", "style", "textarea", "noscript", "iframe", "object", "embed", "template"],
    // No scheme is allowed anywhere, so no attribute can address the network. With
    // no href/src in the attribute list this is belt and braces, and it stays
    // correct if that list is ever widened by mistake.
    allowedSchemes: [],
    allowProtocolRelative: false,
    // The SVG pass above already ran; keep its casing (viewBox, not viewbox).
    parser: { lowerCaseAttributeNames: false },
    allowVulnerableTags: false,
  });

  // Put the drawings back, now that the HTML pass cannot mangle them.
  const whole = kept.reduce((html, svg, i) => html.split(`${token}${i}${token}`).join(svg), clean);

  /*
   * Invisible characters are not invisible when a font has no glyph for them.
   *
   * A blank form arrived with a non-breaking space in each empty cell — a spacer,
   * so the cells would not collapse to nothing — and every one of them drew on
   * screen as a hex box reading "A0". The document was correct; it just could not
   * be rendered by a font that has never needed U+00A0. Empty cells get their
   * height from CSS instead, in all three renderers, so this text carries no
   * spacers and nothing here depends on a font shipping a glyph for a space.
   */
  return whole
    .replace(/ /g, " ")
    // Zero-width space, BOM and soft hyphen: same failure, and they also break
    // search and copy-paste out of the document.
    .replace(/[​‌﻿­]/g, "");
}

module.exports = { sanitizeDocHtml, TAGS, STYLES, MAX_HTML };
