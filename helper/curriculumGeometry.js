/*
 * CR-MSO-009 / CR-MSO-015 — page labels and crop geometry. Pure; no I/O.
 *
 * TWO page numbers, never conflated:
 *   filePageIndex    — 0-based position in the file. Machine truth.
 *   printedPageLabel — what is PRINTED on the paper. A STRING, because real books
 *                      use "124", "iv", "A-12" and "124a". Nothing arithmetic is
 *                      ever done on it.
 *
 * A single offset cannot express covers, unnumbered front matter, roman sections,
 * inserted or missing scan pages, or a book with several numbering runs — so the
 * mapping is teacher-confirmed anchors plus ranges plus per-page overrides.
 *
 * cropBox is {x, y, w, h} as NORMALISED floats in [0,1], origin top-left, relative
 * to the page as rendered at the pinned DPI AFTER the page's /Rotate is applied.
 * Normalised units keep stored evidence independent of the render DPI, and
 * applying rotation server-side means a client cannot smuggle an unrotated box.
 */

// ---------------------------------------------------------------- page labels
const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"];

function romanAt(startLabel, offset) {
  const base = ROMAN.indexOf(String(startLabel).toLowerCase());
  if (base < 0) return "";
  const i = base + offset;
  return i >= 0 && i < ROMAN.length ? ROMAN[i] : "";
}

/*
 * Resolve the printed label for a file page.
 * Precedence: explicit override > confirmed anchor > interpolated range > "".
 * An unmapped page returns "" — never a guess, because a wrong page label is
 * exactly the fabrication this whole contract exists to prevent.
 */
function printedLabelFor(pageMap, filePageIndex) {
  const idx = Number(filePageIndex);
  if (!Number.isSafeInteger(idx) || idx < 0) return "";
  const map = pageMap && typeof pageMap === "object" ? pageMap : {};

  const overrides = map.overrides && typeof map.overrides === "object" ? map.overrides : {};
  if (Object.prototype.hasOwnProperty.call(overrides, String(idx))) return String(overrides[String(idx)] ?? "");

  const anchors = Array.isArray(map.anchors) ? map.anchors : [];
  const hit = anchors.find((a) => Number(a.filePageIndex) === idx);
  if (hit) return String(hit.label ?? "");

  const ranges = Array.isArray(map.ranges) ? map.ranges : [];
  for (const r of ranges) {
    const from = Number(r.fromFileIndex);
    const to = Number(r.toFileIndex);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || idx < from || idx > to) continue;
    const offset = idx - from;
    if (r.style === "literal") return String(r.startLabel ?? "");
    if (r.style === "roman") return romanAt(r.startLabel, offset);
    const start = Number(r.startLabel);
    if (!Number.isFinite(start)) return "";
    return String(start + offset);
  }
  return "";
}

// Reverse lookup: which file page carries this printed label? Returns -1 when the
// label is unknown or ambiguous — an ambiguous label must never resolve silently.
function fileIndexForLabel(pageMap, label, pageCount) {
  const want = String(label ?? "").trim().toLowerCase();
  if (!want) return -1;
  const n = Number(pageCount) || 0;
  let found = -1;
  for (let i = 0; i < n; i++) {
    if (String(printedLabelFor(pageMap, i)).trim().toLowerCase() === want) {
      if (found >= 0) return -1; // ambiguous
      found = i;
    }
  }
  return found;
}

// A page map is only worth trusting if it is internally consistent.
function validatePageMap(pageMap, pageCount) {
  const errors = [];
  const map = pageMap && typeof pageMap === "object" ? pageMap : {};
  const n = Number(pageCount);
  if (!Number.isSafeInteger(n) || n <= 0) errors.push("page_count_invalid");

  const ranges = Array.isArray(map.ranges) ? map.ranges : [];
  for (const [i, r] of ranges.entries()) {
    const from = Number(r.fromFileIndex);
    const to = Number(r.toFileIndex);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) { errors.push(`range_${i}_bounds_invalid`); continue; }
    if (from < 0 || to < from) errors.push(`range_${i}_bounds_invalid`);
    if (Number.isSafeInteger(n) && to >= n) errors.push(`range_${i}_out_of_document`);
    if (!["arabic", "roman", "literal"].includes(r.style)) errors.push(`range_${i}_style_invalid`);
    if (r.style === "roman" && ROMAN.indexOf(String(r.startLabel).toLowerCase()) < 0) errors.push(`range_${i}_roman_start_invalid`);
    if (r.style === "arabic" && !Number.isFinite(Number(r.startLabel))) errors.push(`range_${i}_arabic_start_invalid`);
  }
  for (let a = 0; a < ranges.length; a++) {
    for (let b = a + 1; b < ranges.length; b++) {
      const x = ranges[a];
      const y = ranges[b];
      if (Number(x.fromFileIndex) <= Number(y.toFileIndex) && Number(y.fromFileIndex) <= Number(x.toFileIndex)) {
        errors.push(`ranges_${a}_${b}_overlap`);
      }
    }
  }
  const anchors = Array.isArray(map.anchors) ? map.anchors : [];
  for (const [i, a] of anchors.entries()) {
    if (!Number.isSafeInteger(Number(a.filePageIndex)) || Number(a.filePageIndex) < 0) errors.push(`anchor_${i}_index_invalid`);
    if (Number.isSafeInteger(n) && Number(a.filePageIndex) >= n) errors.push(`anchor_${i}_out_of_document`);
    if (!String(a.label ?? "").trim()) errors.push(`anchor_${i}_label_empty`);
  }
  const overrides = map.overrides && typeof map.overrides === "object" ? map.overrides : {};
  for (const k of Object.keys(overrides)) {
    const idx = Number(k);
    if (!Number.isSafeInteger(idx) || idx < 0) errors.push(`override_${k}_index_invalid`);
    else if (Number.isSafeInteger(n) && idx >= n) errors.push(`override_${k}_out_of_document`);
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- crop bounds
// Everything here is rejected BEFORE Ghostscript is spawned. Rasterising an
// attacker-shaped page is the expensive part; validation must precede it.
const CROP_LIMITS = {
  dpi: Number(process.env.CURRICULUM_CROP_DPI) || 150,
  minArea: 0.0005, // an unusably small crop is not evidence
  maxDimension: 4000, // px, per side
  maxPixels: 4_000_000, // px total for the produced crop
  maxPagePixels: 40_000_000, // px total for the intermediate page raster
};

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/*
 * Validate a proposed crop. Returns { ok, code, out: {widthPx, heightPx} }.
 * Codes are stable and client-facing: bad_crop_box, crop_out_of_page,
 * crop_area_invalid, page_out_of_range, crop_too_large, unsupported_page_geometry.
 */
function validateCropBox(box, { filePageIndex, pageCount, pageWidthPt, pageHeightPt, userUnit = 1, limits = CROP_LIMITS } = {}) {
  const idx = Number(filePageIndex);
  if (!Number.isSafeInteger(idx) || idx < 0 || !Number.isSafeInteger(Number(pageCount)) || idx >= Number(pageCount)) {
    return { ok: false, code: "page_out_of_range" };
  }
  if (!box || typeof box !== "object" || Array.isArray(box)) return { ok: false, code: "bad_crop_box" };
  const { x, y, w, h } = box;
  // Number.isFinite rejects NaN and ±Infinity; the typeof guard rejects numeric
  // strings, so "1e400" can never arrive pre-coerced to Infinity.
  if (![x, y, w, h].every(finite)) return { ok: false, code: "bad_crop_box" };
  if (w <= 0 || h <= 0 || x < 0 || y < 0) return { ok: false, code: "crop_out_of_page" };
  // A hair of tolerance for float round-trips through JSON, not a real overhang.
  const EPS = 1e-9;
  if (x + w > 1 + EPS || y + h > 1 + EPS) return { ok: false, code: "crop_out_of_page" };
  if (w * h < limits.minArea) return { ok: false, code: "crop_area_invalid" };

  // /UserUnit scales the page by an arbitrary factor. pdf.js and Ghostscript do not
  // agree on it without extra care, so an unhandled value fails CLOSED rather than
  // silently producing a crop of the wrong region.
  if (finite(Number(userUnit)) && Math.abs(Number(userUnit) - 1) > 1e-6) {
    return { ok: false, code: "unsupported_page_geometry" };
  }

  const pw = Number(pageWidthPt);
  const ph = Number(pageHeightPt);
  if (!finite(pw) || !finite(ph) || pw <= 0 || ph <= 0) return { ok: false, code: "unsupported_page_geometry" };

  const scale = limits.dpi / 72;
  const pagePx = Math.ceil(pw * scale) * Math.ceil(ph * scale);
  if (pagePx > limits.maxPagePixels) return { ok: false, code: "crop_too_large" };

  const widthPx = Math.max(1, Math.round(pw * scale * w));
  const heightPx = Math.max(1, Math.round(ph * scale * h));
  if (widthPx > limits.maxDimension || heightPx > limits.maxDimension) return { ok: false, code: "crop_too_large" };
  if (widthPx * heightPx > limits.maxPixels) return { ok: false, code: "crop_too_large" };

  return { ok: true, code: null, out: { widthPx, heightPx, dpi: limits.dpi } };
}

/*
 * Apply the page's /Rotate to a normalised box expressed in VIEWER space (what the
 * teacher saw in pdf.js) to get the box in UNROTATED page space (what Ghostscript
 * rasterises). Rotation is applied server-side so the client only ever states what
 * it saw, never how to slice the file.
 */
function unrotateBox(box, rotate = 0) {
  const r = ((Number(rotate) % 360) + 360) % 360;
  const { x, y, w, h } = box;
  if (r === 90) return { x: y, y: 1 - x - w, w: h, h: w };
  if (r === 180) return { x: 1 - x - w, y: 1 - y - h, w, h };
  if (r === 270) return { x: 1 - y - h, y: x, w: h, h: w };
  return { x, y, w, h };
}

// The identity that makes the round trip provable: unrotate then rotate back.
function rotateBox(box, rotate = 0) {
  const r = ((Number(rotate) % 360) + 360) % 360;
  const { x, y, w, h } = box;
  if (r === 90) return { x: 1 - y - h, y: x, w: h, h: w };
  if (r === 180) return { x: 1 - x - w, y: 1 - y - h, w, h };
  if (r === 270) return { x: y, y: 1 - x - w, w: h, h: w };
  return { x, y, w, h };
}

module.exports = {
  CROP_LIMITS,
  printedLabelFor,
  fileIndexForLabel,
  validatePageMap,
  validateCropBox,
  unrotateBox,
  rotateBox,
};
