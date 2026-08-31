/*
 * CR-MSO-009 / CR-MSO-015 — page labels and crop bounds.
 *
 * Everything here must fail BEFORE Ghostscript is spawned: rasterising an
 * attacker-shaped page is the expensive part, so validation precedes it. The
 * spawn-spy proof lives in tests/curriculum-evidence.test.js; this file pins the
 * pure decisions.
 */
const assert = require("assert");
const {
  printedLabelFor,
  fileIndexForLabel,
  validatePageMap,
  validateCropBox,
  unrotateBox,
  rotateBox,
  CROP_LIMITS,
} = require("../helper/curriculumGeometry");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

console.log("\n1. A single page offset cannot express a real book:");
{
  // Cover + 4 roman front-matter pages, then the body starting at printed 1,
  // then an inserted unnumbered scan page, then the body continuing at 5.
  const map = {
    ranges: [
      { fromFileIndex: 1, toFileIndex: 4, style: "roman", startLabel: "i" },
      { fromFileIndex: 5, toFileIndex: 8, style: "arabic", startLabel: 1 },
      { fromFileIndex: 10, toFileIndex: 13, style: "arabic", startLabel: 5 },
    ],
    overrides: { 0: "", 9: "" },
    anchors: [{ filePageIndex: 5, label: "1" }],
  };
  ok("cover has no printed label", printedLabelFor(map, 0) === "");
  ok("roman front matter interpolates", printedLabelFor(map, 1) === "i" && printedLabelFor(map, 3) === "iii");
  ok("body starts at printed 1 on file page 5", printedLabelFor(map, 5) === "1");
  ok("body interpolates within its range", printedLabelFor(map, 8) === "4");
  ok("an inserted unnumbered scan page is blank, not guessed", printedLabelFor(map, 9) === "");
  ok("numbering resumes after the insert", printedLabelFor(map, 10) === "5" && printedLabelFor(map, 13) === "8");
  ok("an unmapped page returns '' rather than a guess", printedLabelFor(map, 99) === "");

  // A literal label — "124a" cannot be produced by any arithmetic.
  const lit = { ranges: [{ fromFileIndex: 2, toFileIndex: 2, style: "literal", startLabel: "124a" }] };
  ok("a literal label survives verbatim", printedLabelFor(lit, 2) === "124a");

  ok("reverse lookup finds the file page for a printed label", fileIndexForLabel(map, "5", 14) === 10);
  ok("an unknown label resolves to -1", fileIndexForLabel(map, "999", 14) === -1);
  const ambiguous = { overrides: { 1: "7", 2: "7" } };
  ok("an AMBIGUOUS label resolves to -1, never silently to the first", fileIndexForLabel(ambiguous, "7", 3) === -1);
}

console.log("\n2. Page maps are validated, not trusted:");
{
  ok("a sane map passes", validatePageMap({ ranges: [{ fromFileIndex: 0, toFileIndex: 3, style: "arabic", startLabel: 1 }] }, 10).ok);
  ok(
    "overlapping ranges are refused",
    validatePageMap(
      { ranges: [ { fromFileIndex: 0, toFileIndex: 5, style: "arabic", startLabel: 1 }, { fromFileIndex: 4, toFileIndex: 7, style: "arabic", startLabel: 9 } ] },
      10
    ).errors.some((e) => e.includes("overlap"))
  );
  ok("a range past the end of the document is refused", validatePageMap({ ranges: [{ fromFileIndex: 0, toFileIndex: 99, style: "arabic", startLabel: 1 }] }, 10).errors.some((e) => e.includes("out_of_document")));
  ok("an invalid roman start is refused", validatePageMap({ ranges: [{ fromFileIndex: 0, toFileIndex: 2, style: "roman", startLabel: "zz" }] }, 10).errors.some((e) => e.includes("roman_start")));
  ok("an anchor with an empty label is refused", validatePageMap({ anchors: [{ filePageIndex: 1, label: "" }] }, 10).errors.some((e) => e.includes("label_empty")));
  ok("an override past the end is refused", validatePageMap({ overrides: { 99: "x" } }, 10).errors.some((e) => e.includes("out_of_document")));
}

console.log("\n3. Crop bounds — every rejection has a stable code:");
{
  const base = { filePageIndex: 2, pageCount: 10, pageWidthPt: 595, pageHeightPt: 842 };
  const good = { x: 0.1, y: 0.1, w: 0.4, h: 0.3 };
  ok("a sane crop passes", validateCropBox(good, base).ok);

  const bad = (box, code, extra = {}) => {
    const r = validateCropBox(box, { ...base, ...extra });
    ok(`${code}: ${JSON.stringify(box).slice(0, 52)}`, r.ok === false && r.code === code, r.code);
  };
  bad(null, "bad_crop_box");
  bad("nope", "bad_crop_box");
  bad([0.1, 0.1, 0.2, 0.2], "bad_crop_box");
  bad({ x: NaN, y: 0.1, w: 0.2, h: 0.2 }, "bad_crop_box");
  bad({ x: Infinity, y: 0.1, w: 0.2, h: 0.2 }, "bad_crop_box");
  bad({ x: -Infinity, y: 0.1, w: 0.2, h: 0.2 }, "bad_crop_box");
  // A numeric STRING must not be coerced — "1e400" would otherwise become Infinity.
  bad({ x: "0.1", y: 0.1, w: 0.2, h: 0.2 }, "bad_crop_box");
  bad({ x: "1e400", y: 0.1, w: 0.2, h: 0.2 }, "bad_crop_box");
  bad({ x: -0.1, y: 0.1, w: 0.2, h: 0.2 }, "crop_out_of_page");
  bad({ x: 0.1, y: 0.1, w: 0, h: 0.2 }, "crop_out_of_page");
  bad({ x: 0.1, y: 0.1, w: -0.2, h: 0.2 }, "crop_out_of_page");
  bad({ x: 0.9, y: 0.1, w: 0.2, h: 0.2 }, "crop_out_of_page");
  bad({ x: 0.1, y: 0.9, w: 0.2, h: 0.2 }, "crop_out_of_page");
  bad({ x: 0.1, y: 0.1, w: 0.001, h: 0.001 }, "crop_area_invalid");

  ok("page index below zero is refused", validateCropBox(good, { ...base, filePageIndex: -1 }).code === "page_out_of_range");
  ok("page index past the end is refused", validateCropBox(good, { ...base, filePageIndex: 10 }).code === "page_out_of_range");
  ok("a fractional page index is refused", validateCropBox(good, { ...base, filePageIndex: 1.5 }).code === "page_out_of_range");

  // /UserUnit != 1 scales the page; pdf.js and Ghostscript do not agree on it
  // without extra care, so it fails CLOSED rather than cropping the wrong region.
  ok("a non-default /UserUnit fails closed", validateCropBox(good, { ...base, userUnit: 2 }).code === "unsupported_page_geometry");
  ok("missing page geometry fails closed", validateCropBox(good, { ...base, pageWidthPt: 0 }).code === "unsupported_page_geometry");

  // Output budget.
  const huge = { ...base, pageWidthPt: 20000, pageHeightPt: 20000 };
  ok("an oversized page raster is refused", validateCropBox(good, huge).code === "crop_too_large");
  const wide = { ...base, pageWidthPt: 5000, pageHeightPt: 5000 };
  ok("an oversized OUTPUT crop is refused", validateCropBox({ x: 0, y: 0, w: 1, h: 1 }, wide).code === "crop_too_large");
  ok("the produced pixel size is reported for a valid crop", validateCropBox(good, base).out.widthPx > 0);
  ok("the DPI is pinned, not client-chosen", validateCropBox(good, base).out.dpi === CROP_LIMITS.dpi);
}

console.log("\n4. Rotation is applied server-side and round-trips:");
{
  const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  const close = (a, b) => ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - b[k]) < 1e-9);
  for (const r of [0, 90, 180, 270]) {
    ok(`/Rotate ${r} round-trips`, close(rotateBox(unrotateBox(box, r), r), box), JSON.stringify(unrotateBox(box, r)));
  }
  ok("/Rotate 90 swaps the axes", (() => { const u = unrotateBox(box, 90); return Math.abs(u.w - box.h) < 1e-9 && Math.abs(u.h - box.w) < 1e-9; })());
  ok("/Rotate 180 mirrors both axes", (() => { const u = unrotateBox(box, 180); return Math.abs(u.x - (1 - box.x - box.w)) < 1e-9; })());
  ok("a negative or >360 rotation normalises", close(unrotateBox(box, -90), unrotateBox(box, 270)) && close(unrotateBox(box, 450), unrotateBox(box, 90)));
  ok("an unrotated box stays inside the page", (() => { const u = unrotateBox(box, 90); return u.x >= 0 && u.y >= 0 && u.x + u.w <= 1 + 1e-9 && u.y + u.h <= 1 + 1e-9; })());
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} curriculum-geometry assertions failed`);
process.exit(failed ? 1 : 0);
