const sanitizeHtml = require("sanitize-html");

/*
 * Diagrams the model draws — a number line, a right triangle, a circle with a
 * labelled radius, a bar chart, a fraction strip.
 *
 * SVG rather than a generated image, for three reasons that all matter here: it is
 * text, so the model can author it directly with no image service and no cost; it
 * is sharp at any size, which a raster diagram in a printed handout is not; and it
 * can be edited, so a teacher who wants the label moved is not stuck.
 *
 * IT IS ALSO UNTRUSTED MARKUP. SVG is a full XML document format that can carry
 * <script>, event handlers, <foreignObject> with arbitrary HTML, and external
 * references — pasting a model's SVG into the page unfiltered is a cross-site
 * scripting hole with extra steps. So this is a strict ALLOW-LIST: only drawing
 * elements, only presentational attributes, nothing that can fetch, navigate or
 * execute. Anything unrecognised is dropped rather than sanitised in place, because
 * a diagram that loses a shape is a smaller problem than one that runs.
 */

const SHAPES = [
  "svg", "g", "defs", "title", "desc", "marker", "symbol", "use",
  "path", "line", "polyline", "polygon", "rect", "circle", "ellipse",
  "text", "tspan", "textPath",
  "linearGradient", "radialGradient", "stop", "clipPath", "pattern",
];

// Presentational and geometric only. No href, no xlink:href to anything external,
// no on* handlers, no style attribute (which can carry url() fetches).
const ATTRS = [
  "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "d", "points", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-opacity", "opacity",
  "font-size", "font-family", "font-weight", "text-anchor", "dominant-baseline", "dy", "dx",
  "id", "class", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
  "marker-end", "marker-start", "markerWidth", "markerHeight", "refX", "refY", "orient",
  "patternUnits", "clip-path", "xmlns", "preserveAspectRatio", "letter-spacing",
  // Fragment references only — every value is re-checked and rewritten below, so
  // what survives this list is not what reaches the page.
  "href", "xlink:href", "mask", "filter", "marker-mid",
];

const MAX_SVG = 24000; // a diagram, not a traced photograph

/*
 * Same-document references — the thing that used to break every good diagram.
 *
 * `href` is a fetch vector, so it was simply dropped. But `<use href="#cell">`,
 * `marker-end="url(#arrow)"`, gradients and clip paths are how anyone actually
 * draws a repeated shape or an arrowhead, and the model reaches for them
 * constantly. Dropping the attribute left the ELEMENT in place referring to
 * nothing: a hundred `<use>` tags that draw zero pixels, arrows with no heads. The
 * drawing looked authored and rendered empty, which is worse than refusing it,
 * because nothing anywhere said it had been broken.
 *
 * So fragments are supported, and made safe by construction rather than by trust:
 *
 *   1. Only `#name` is ever accepted. No scheme, no path, no protocol-relative
 *      form, no `javascript:`, no external document — the regex admits one
 *      fragment of word characters and nothing else.
 *   2. Every id in the figure is REWRITTEN to a per-figure namespace and every
 *      reference is rewritten with it. A reference therefore cannot escape into
 *      the host page — `<use href="#login-form">` resolves to nothing because no
 *      such id exists inside this figure's namespace.
 *   3. A reference that does not resolve to an id defined in the SAME figure is
 *      dropped, so a dangling pointer cannot pick up whatever the page defines
 *      later.
 *
 * Point 2 also fixes a bug that had nothing to do with security: two figures in
 * one handout both defining `#arrowhead` collide in the document, and the second
 * drawing silently borrows the first one's marker.
 */
const FRAGMENT = /^#([A-Za-z][\w-]*)$/;
const URL_REF = /^url\(\s*['"]?#([A-Za-z][\w-]*)['"]?\s*\)$/;

// Attributes whose value may be a `url(#id)` reference into the same figure.
const REF_ATTRS = ["fill", "stroke", "clip-path", "marker-end", "marker-start", "marker-mid", "mask", "filter"];

let figureSeq = 0;

function namespaceRefs(svg) {
  // A counter, not a hash of the content: two IDENTICAL figures in one document
  // must still get distinct ids, or they collide exactly as before.
  figureSeq = (figureSeq + 1) % 1e6;
  const ns = `xf${figureSeq.toString(36)}`;

  const defined = new Set();
  svg.replace(/\sid="([A-Za-z][\w-]*)"/g, (_, id) => {
    defined.add(id);
    return "";
  });

  /*
   * No early return when the figure defines nothing.
   *
   * A drawing with no ids of its own is exactly the one to worry about: every
   * reference in it necessarily points OUTSIDE itself, which is the escape into
   * the host page this function exists to prevent. Running with an empty set drops
   * all of them, which is the right answer.
   */
  const rename = (id) => `${ns}-${id}`;

  let out = svg.replace(/(\sid=")([A-Za-z][\w-]*)(")/g, (m, a, id, b) =>
    defined.has(id) ? `${a}${rename(id)}${b}` : m
  );

  // href / xlink:href — only ever a bare fragment, only ever to an id this figure
  // defines itself.
  out = out.replace(/\s(?:xlink:)?href="([^"]*)"/g, (m, value) => {
    const hit = FRAGMENT.exec(String(value).trim());
    return hit && defined.has(hit[1]) ? ` href="#${rename(hit[1])}"` : "";
  });

  /*
   * url(#id) in the presentation attributes that accept one.
   *
   * The test is "does it reference anything at all", not "does it match the safe
   * form" — `url(http://evil/a#b)` fails the safe pattern, and treating a failed
   * match as "leave it alone" would have waved it straight through. Anything
   * shaped like a reference must resolve locally or be dropped; a plain colour or
   * keyword contains no `url(` and is never touched.
   */
  for (const attr of REF_ATTRS) {
    const re = new RegExp(`\\s${attr}="([^"]*)"`, "g");
    out = out.replace(re, (m, value) => {
      const v = String(value).trim();
      if (!/url\s*\(/i.test(v)) return m; // a colour, a keyword — untouched
      const hit = URL_REF.exec(v);
      return hit && defined.has(hit[1]) ? ` ${attr}="url(#${rename(hit[1])})"` : "";
    });
  }

  return out;
}

/*
 * Grow the viewBox until nothing is drawn outside it.
 *
 * An SVG clips to its viewport, so a title placed at `y="-5"` loses its top half
 * against the edge of the figure — which is exactly what a teacher reported, and
 * exactly the kind of defect that makes a handout look unfinished. The model is
 * told to leave margins, but a rule the model may forget is not a guarantee, and
 * the cost of being wrong is a visibly broken document.
 *
 * This measures what it can and only ever ENLARGES the box, so the worst case is a
 * little extra whitespace and the best case is a label that is no longer cut in
 * half. It is deliberately conservative: anything it cannot measure exactly —
 * a path's curve data, a rotate or scale transform — makes it leave the drawing
 * completely alone rather than compute a box it cannot stand behind.
 */
const SELF_OR_OPEN = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const TRANSLATE_ONLY = /^translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)$/;

const numAttr = (attrs, name, dflt = 0) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  if (!m) return dflt;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : dflt;
};
const strAttr = (attrs, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? m[1] : "";
};

function boxOf(tag, attrs, textLen) {
  switch (tag) {
    case "rect": {
      const x = numAttr(attrs, "x");
      const y = numAttr(attrs, "y");
      return [x, y, x + numAttr(attrs, "width"), y + numAttr(attrs, "height")];
    }
    case "circle": {
      const cx = numAttr(attrs, "cx");
      const cy = numAttr(attrs, "cy");
      const r = numAttr(attrs, "r");
      return [cx - r, cy - r, cx + r, cy + r];
    }
    case "ellipse": {
      const cx = numAttr(attrs, "cx");
      const cy = numAttr(attrs, "cy");
      const rx = numAttr(attrs, "rx");
      const ry = numAttr(attrs, "ry");
      return [cx - rx, cy - ry, cx + rx, cy + ry];
    }
    case "line": {
      const x1 = numAttr(attrs, "x1");
      const y1 = numAttr(attrs, "y1");
      const x2 = numAttr(attrs, "x2");
      const y2 = numAttr(attrs, "y2");
      return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    }
    case "polyline":
    case "polygon": {
      const nums = (strAttr(attrs, "points").match(/-?[\d.]+/g) || []).map(Number);
      if (nums.length < 4) return null;
      const xs = nums.filter((_, i) => i % 2 === 0);
      const ys = nums.filter((_, i) => i % 2 === 1);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    case "text": {
      /*
       * A text box is an estimate, and it is the one that matters most — the
       * clipped label is nearly always a title. The baseline sits at `y`, so the
       * glyphs rise a full em above it and descend about a third below; the width
       * is estimated at ~0.6em per character and placed by `text-anchor`.
       * Estimated generously on purpose: over-reserving costs whitespace,
       * under-reserving costs a cut-off word.
       */
      const size = numAttr(attrs, "font-size", 12) || 12;
      const x = numAttr(attrs, "x");
      const y = numAttr(attrs, "y");
      const w = Math.max(0, textLen) * size * 0.6;
      const anchor = strAttr(attrs, "text-anchor");
      const left = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
      return [left, y - size, left + w, y + size * 0.35];
    }
    default:
      return null;
  }
}

function fitViewBox(svg) {
  const vb = /viewBox\s*=\s*"([^"]*)"/.exec(svg);
  if (!vb) return svg;
  const parts = (vb[1].match(/-?[\d.]+/g) || []).map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return svg;
  const [vx, vy, vw, vh] = parts;
  if (!(vw > 0 && vh > 0)) return svg;

  let minX = vx;
  let minY = vy;
  let maxX = vx + vw;
  let maxY = vy + vh;

  // Cumulative translate per nesting level. Anything that is not a pure translate
  // means we cannot place a shape exactly, so the whole attempt is abandoned.
  const stack = [[0, 0]];
  let bail = false;

  SELF_OR_OPEN.lastIndex = 0;
  let m;
  while ((m = SELF_OR_OPEN.exec(svg))) {
    const [, closing, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (tag === "svg") continue;

    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const [tx, ty] = stack[stack.length - 1];
    const transform = strAttr(attrs, "transform").trim();
    let dx = 0;
    let dy = 0;
    if (transform) {
      const t = TRANSLATE_ONLY.exec(transform);
      if (!t) {
        bail = true;
        break;
      }
      dx = parseFloat(t[1]) || 0;
      dy = parseFloat(t[2] || "0") || 0;
    }

    // `defs` and its contents are templates, not drawings — a shape defined there
    // is painted wherever a `use` puts it, never at its own coordinates.
    if (tag === "defs" || tag === "marker" || tag === "symbol" || tag === "clippath" || tag === "pattern") {
      // Skip to the matching close by pushing a level that contributes nothing;
      // the shapes inside still resolve their own stack entries harmlessly.
      if (!selfClose) stack.push([tx + dx, ty + dy]);
      continue;
    }

    let len = 0;
    if (tag === "text" || tag === "tspan") {
      const close = svg.indexOf(`</${rawTag}`, m.index);
      const inner = close > -1 ? svg.slice(m.index + m[0].length, close) : "";
      len = inner.replace(/<[^>]*>/g, "").trim().length;
    }

    const box = boxOf(tag, attrs, len);
    if (box) {
      minX = Math.min(minX, box[0] + tx + dx);
      minY = Math.min(minY, box[1] + ty + dy);
      maxX = Math.max(maxX, box[2] + tx + dx);
      maxY = Math.max(maxY, box[3] + ty + dy);
    }

    if (!selfClose && tag !== "text") stack.push([tx + dx, ty + dy]);
  }

  if (bail) return svg;
  if (minX >= vx && minY >= vy && maxX <= vx + vw && maxY <= vy + vh) return svg;

  // A breath of air, so a grown edge does not sit flush against a glyph.
  const pad = Math.max(2, Math.min(vw, vh) * 0.02);
  const nx = Math.min(vx, minX - pad);
  const ny = Math.min(vy, minY - pad);
  const nw = Math.max(vx + vw, maxX + pad) - nx;
  const nh = Math.max(vy + vh, maxY + pad) - ny;

  // A wild estimate is worse than the original. If measuring says the drawing is
  // several times its declared size, the measurement is what is wrong.
  if (nw > vw * 3 || nh > vh * 3) return svg;

  const round = (n) => Math.round(n * 100) / 100;
  return svg.replace(/viewBox\s*=\s*"[^"]*"/, `viewBox="${round(nx)} ${round(ny)} ${round(nw)} ${round(nh)}"`);
}

function sanitizeSvg(raw) {
  const src = String(raw || "").trim();
  if (!src || src.length > MAX_SVG) return "";
  if (!/^<svg[\s>]/i.test(src)) return "";

  const clean = sanitizeHtml(src, {
    allowedTags: SHAPES,
    allowedAttributes: { "*": ATTRS },
    // Kill the contents outright, not just the tag: a stripped <script> tag whose
    // body survives as text would still execute once re-parsed inside <svg>.
    nonTextTags: ["script", "style", "foreignObject", "animate", "set", "handler"],
    parser: { lowerCaseAttributeNames: false }, // viewBox, not viewbox
    allowedSchemes: [],
    allowProtocolRelative: false,
  }).trim();

  if (!/^<svg[\s>]/i.test(clean) || !/<\/svg>$/i.test(clean)) return "";

  // A viewBox is what makes it scale into whatever box the layout gives it; without
  // one the browser falls back to a 300x150 default and the drawing is cropped.
  if (!/viewBox=/.test(clean)) return "";

  return fitViewBox(namespaceRefs(clean));
}

/*
 * Word cannot be relied on to render inline SVG from an HTML import, so the same
 * drawing is rasterised for that path only. Kept at 2x so it is not soft in print.
 */
async function svgToPngDataUri(svg, width = 900) {
  const clean = sanitizeSvg(svg);
  if (!clean) return "";
  try {
    const sharp = require("sharp");
    const png = await sharp(Buffer.from(clean), { density: 200 })
      .resize({ width, withoutEnlargement: false })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch (e) {
    // A diagram that will not rasterise must not cost the teacher the document.
    console.error("[LESSON DOC] svg->png failed:", e.message);
    return "";
  }
}

module.exports = { sanitizeSvg, svgToPngDataUri, SHAPES, ATTRS, MAX_SVG };
