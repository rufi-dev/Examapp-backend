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
];

const MAX_SVG = 24000; // a diagram, not a traced photograph

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

  return clean;
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
