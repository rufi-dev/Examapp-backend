/* eslint-env node */
/*
 * What the platform engine promises.
 *
 * The material on screen is the material that exports; nothing the teacher asked
 * for is answered locally when it was not a local question; and no material is
 * ever quietly rewritten, shortened or mis-shaped on the way through.
 *
 * Every assertion here failed against the code that preceded it. The first two
 * groups came from my own review, the rest from Codex's — each one reproduced
 * before it was fixed.
 */
const assert = require("assert");
const {
  normalizeNative,
  nativeBlocksToHtml,
  nativePrintOptions,
  nativeCanHandle,
  diagramSvg,
} = require("../helper/lessonDocNative");
const { sanitizeDocHtml } = require("../helper/lessonDocSanitize");
const { buildLessonDocHtml, withRasterFigures } = require("../helper/lessonDocHtml");

let passed = 0;
let failed = 0;
const ok = (name, cond) => {
  if (cond) { passed += 1; console.log("  ✓", name); } else { failed += 1; console.log("  ✗ FAIL:", name); }
};
const eq = (name, actual, expected) =>
  ok(`${name} (got ${JSON.stringify(actual)})`, JSON.stringify(actual) === JSON.stringify(expected));

const content = normalizeNative({
  title: "Faizlər",
  audience: "7-ci sinif",
  reply: "Hazırdır",
  blocks: [
    { kind: "heading", text: "Faiz nədir?" },
    { kind: "text", text: "Faiz yüzdə bir hissədir." },
    { kind: "diagram", diagram: { type: "flow", title: "Addımlar", labels: ["Oxu", "Hesabla"], values: [1, 2] } },
  ],
});
const html = sanitizeDocHtml(nativeBlocksToHtml(content));
// What the server stores for a platform-rendered material: a body, no blocks.
const doc = { html, blocks: [] };

(async () => {
  console.log("\nPreview, PDF and Word describe the same material:");

  const pdfHtml = buildLessonDocHtml(doc);
  ok("the preview body IS the PDF body", pdfHtml.includes(doc.html));
  ok("the PDF keeps the diagram as SVG", /<svg/i.test(pdfHtml));

  const wordDoc = await withRasterFigures(doc);
  const wordHtml = buildLessonDocHtml(wordDoc, { forWord: true });
  ok("Word receives the diagram as a PNG", /<img[^>]+src="data:image\/png/i.test(wordHtml));
  ok("...and no inline SVG is left for LibreOffice", !/<svg/i.test(wordHtml));
  ok("the text survives every path", pdfHtml.includes("Faiz nədir?") && wordHtml.includes("Faiz nədir?"));

  // A diagram that cannot be converted must FAIL the export, not disappear from
  // it. A Word file missing a figure the preview shows is a wrong document that
  // looks like a right one.
  const svgMod = require("../helper/lessonDocSvg");
  const realRaster = svgMod.svgToPngDataUri;
  svgMod.svgToPngDataUri = async () => { throw new Error("no rasteriser"); };
  let threw = null;
  try {
    await withRasterFigures(doc);
  } catch (e) {
    threw = e;
  } finally {
    svgMod.svgToPngDataUri = realRaster;
  }
  ok("an unconvertible diagram fails the Word export loudly", Boolean(threw) && threw.code === "export_failed");
  ok("...with something the teacher can act on", Boolean(threw && threw.userMessage));

  console.log("\nA local shortcut never answers half a request:");
  eq("page numbers on", nativePrintOptions("səhifə nömrələrini göstər"), { pageNumbers: true });
  eq("page numbers off", nativePrintOptions("səhifə nömrələrini sil"), { pageNumbers: false });
  eq("'olmalıdır' is not a negation", nativePrintOptions("səhifə nömrələri olmalıdır"), { pageNumbers: true });
  eq("'olmasın' is", nativePrintOptions("səhifə nömrəsi olmasın"), { pageNumbers: false });
  eq("a colour alone touches only the colour", nativePrintOptions("materialın rəngini yaşıl et"), { accent: "green" });
  ok("a translation request is not a print setting", nativePrintOptions("səhifə nömrəsi əlavə et və ingilis dilinə tərcümə et") === null);
  ok("page numbers plus content goes to the engine", nativePrintOptions("səhifə nömrəsi əlavə et və daha çox nümunə yaz") === null);
  ok("a plain content request is untouched", nativePrintOptions("faiz mövzusunu izah et") === null);
  ok("an unknown word is enough to hand the turn over", nativePrintOptions("səhifə nömrəsi və qrafik əlavə et") === null);

  console.log("\nA material is never silently rewritten:");
  ok("an empty document may be written natively", nativeCanHandle({ html: "", blocks: [] }, () => 0));
  ok("a material this engine wrote may be edited natively", nativeCanHandle({ aiMeta: { native: { blocks: [] } } }, () => 12));
  ok("an OLDER material is left to the engine that understands it", !nativeCanHandle({ html: "<h1>Köhnə</h1>", blocks: [] }, () => 4));
  ok("...including a block-based one", !nativeCanHandle({ blocks: [{ kind: "text", text: "x" }] }, () => 1));

  console.log("\nContent keeps its shape:");
  const table = normalizeNative({
    title: "T", audience: "A", reply: "R",
    blocks: [{ kind: "heading", text: "H" }, { kind: "text", text: "B" },
      { kind: "table", columns: ["Hissə", "Say", "Nəticə"], rows: [["birinci", "", "üçüncü"]] }],
  });
  eq("an empty cell keeps its column", table.blocks[2].rows[0], ["birinci", "", "üçüncü"]);

  const eight = ["1", "2", "3", "4", "5", "6", "7", "8"];
  for (const type of ["flow", "compare", "timeline", "concept", "cycle"]) {
    const svg = diagramSvg({ type, title: "T", labels: eight, values: [] });
    const drawn = eight.filter((l) => svg.includes(`>${l}<`)).length;
    ok(`${type}: every label the schema accepts is drawn (${drawn}/8)`, drawn === 8);
  }
  const cycle = diagramSvg({ type: "cycle", title: "T", labels: ["a", "b", "c"], values: [] });
  ok("a cycle is drawn as a cycle, with arrows between its steps", (cycle.match(/marker-end/g) || []).length === 3);

  console.log("\nA scanned source is never mistaken for a readable one:");
  const evidencePath = require.resolve("../helper/curriculumEvidence");
  const realEvidence = require.cache[evidencePath];
  const stub = (pageText) => {
    require.cache[evidencePath] = {
      id: evidencePath,
      filename: evidencePath,
      loaded: true,
      exports: { pdfPageCount: async () => 12, pdfPageText: async () => pageText },
    };
  };
  const { nativeSourceText } = require("../helper/lessonDocFiles");
  const file = [{ mime: "application/pdf", key: "a".repeat(64), ext: "pdf", name: "scan.pdf" }];

  stub("");
  const scanned = await nativeSourceText(file);
  ok("twelve blank pages are NOT reported as extracted text", scanned.length === 0);

  stub("Faiz bir kəmiyyətin yüzdə bir hissəsidir və məktəb riyaziyyatında geniş istifadə olunur. ".repeat(3));
  const readable = await nativeSourceText(file);
  ok("a text PDF is extracted", readable.length === 1 && readable[0].text.length > 200);
  ok("...and a 12-page read of a 12-page file is complete", readable[0].complete === true);

  require.cache[evidencePath] = {
    id: evidencePath,
    filename: evidencePath,
    loaded: true,
    exports: { pdfPageCount: async () => 40, pdfPageText: async () => "Mətn ".repeat(30) },
  };
  const partial = await nativeSourceText(file);
  ok("a 40-page book read to page 12 is NOT complete, so the file still travels", partial[0].complete === false);

  if (realEvidence) require.cache[evidencePath] = realEvidence;
  else delete require.cache[evidencePath];

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} parity assertions failed`);
})();
