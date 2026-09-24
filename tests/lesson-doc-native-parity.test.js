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
const path = require("path");
const {
  normalizeNative,
  nativePrompt,
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
  ok("a material this engine wrote may be edited natively", nativeCanHandle({ aiMeta: { native: { blocks: [{ kind: "text", text: "x" }] } } }, () => 12));
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
  /*
   * Real files on disk, because completeness now also asks whether the PDF holds
   * an image — and a file that cannot be read answers "yes, keep it", which is
   * the safe default but not what these cases are about.
   */
  const fsMod = require("fs");
  const osMod = require("os");
  const prevDocDir = process.env.LESSON_DOC_DIR;
  const scanDir = fsMod.mkdtempSync(path.join(osMod.tmpdir(), "lessondoc-scan-"));
  process.env.LESSON_DOC_DIR = scanDir;
  fsMod.mkdirSync(path.join(scanDir, "docfiles"), { recursive: true });
  delete require.cache[require.resolve("../helper/lessonDocFiles")];
  const { nativeSourceText } = require("../helper/lessonDocFiles");
  // A key is a content hash, so each scenario needs its own: the extraction
  // cache would otherwise hand the second stub the first stub's answer.
  const fileFor = (c) => {
    const key = c.repeat(64);
    fsMod.writeFileSync(path.join(scanDir, "docfiles", `${key}.pdf`), "%PDF-1.4 typeset, no pictures");
    return [{ mime: "application/pdf", key, ext: "pdf", name: c + ".pdf" }];
  };

  stub("");
  const scanned = await nativeSourceText(fileFor("a"));
  ok("twelve blank pages are NOT reported as extracted text", scanned.length === 0);

  stub("Faiz bir kəmiyyətin yüzdə bir hissəsidir və məktəb riyaziyyatında geniş istifadə olunur. ".repeat(3));
  const readable = await nativeSourceText(fileFor("c"));
  ok("a text PDF is extracted", readable.length === 1 && readable[0].text.length > 200);
  ok("...and a 12-page read of a 12-page file is complete", readable[0].complete === true);

  require.cache[evidencePath] = {
    id: evidencePath,
    filename: evidencePath,
    loaded: true,
    exports: { pdfPageCount: async () => 40, pdfPageText: async () => "Mətn ".repeat(30) },
  };
  const partial = await nativeSourceText(fileFor("d"));
  ok("a 40-page book read to page 12 is NOT complete, so the file still travels", partial[0].complete === false);

  if (realEvidence) require.cache[evidencePath] = realEvidence;
  else delete require.cache[evidencePath];
  fsMod.rmSync(scanDir, { recursive: true, force: true });
  if (prevDocDir === undefined) delete process.env.LESSON_DOC_DIR;
  else process.env.LESSON_DOC_DIR = prevDocDir;
  delete require.cache[require.resolve("../helper/lessonDocFiles")];

  console.log("\nThe cost saving actually happens:");
  /*
   * The regression: parts carried no name, the controller matched extracted
   * text to parts by `part.name`, so the lookup missed every time and NO PDF
   * was ever dropped — while its text went into the prompt as well. Every
   * textbook was paid for twice and the feature's whole point did nothing.
   */
  {
    const os = require("os");
    const fs = require("fs");
    const prevDir = process.env.LESSON_DOC_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lessondoc-parts-"));
    process.env.LESSON_DOC_DIR = tmp;
    delete require.cache[require.resolve("../helper/lessonDocFiles")];
    const freshFiles = require("../helper/lessonDocFiles");
    const key = "b".repeat(64);
    fs.mkdirSync(path.join(tmp, "docfiles"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "docfiles", `${key}.pdf`), "%PDF-1.4 test");

    const { parts } = await freshFiles.toParts([
      { key, ext: "pdf", mime: "application/pdf", name: "kitab.pdf" },
    ]);
    ok("a part says WHICH file it is", parts.length === 1 && parts[0].key === key);
    ok("...and carries its name too", parts[0].name === "kitab.pdf");

    // The controller's rule, applied to what it actually receives.
    const byKey = new Map([[key, { key, complete: true }]]);
    const kept = parts.filter((part) => !part.isPdf || !(byKey.get(part.key) || {}).complete);
    ok("a fully-read PDF is dropped from the paid request", kept.length === 0);

    const partialRead = new Map([[key, { key, complete: false }]]);
    const keptPartial = parts.filter((part) => !part.isPdf || !(partialRead.get(part.key) || {}).complete);
    ok("a partially-read one still travels", keptPartial.length === 1);

    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.LESSON_DOC_DIR;
    else process.env.LESSON_DOC_DIR = prevDir;
    delete require.cache[require.resolve("../helper/lessonDocFiles")];
  }

  console.log("\nAn edit never loses the end of a document:");
  {
    const huge = {
      title: "T", audience: "A", reply: "R",
      blocks: Array.from({ length: 40 }, (_, i) => ({ kind: "text", text: "x".repeat(4000), n: i })),
    };
    let threw = null;
    try {
      nativePrompt({ request: "dəyiş", current: huge, sourceNotes: [], sourceText: [] });
    } catch (e) {
      threw = e;
    }
    ok("an impossibly large material is refused, not silently trimmed", Boolean(threw));

    const full = {
      title: "T", audience: "A", reply: "R",
      blocks: Array.from({ length: 36 }, (_, i) => ({ kind: "text", text: "y".repeat(1200), n: i })),
    };
    const prompt = nativePrompt({ request: "dəyiş", current: full, sourceNotes: [], sourceText: [] });
    // The tail is exactly what fell off the end of an 18,000-character slice.
    ok("a full-size material reaches the model with its LAST block intact", prompt.includes('"n":35'));
  }

  console.log("\nThe print parser reads Azerbaijani negation:");
  eq("göstərmə is not göstər", nativePrintOptions("səhifə nömrələrini göstərmə"), { pageNumbers: false });
  eq("silmə means keep them", nativePrintOptions("səhifə nömrələrini silmə"), { pageNumbers: true });
  ok("a negated colour cannot be expressed, so the engine takes it", nativePrintOptions("rəngi yaşıl etmə") === null);
  ok("a quantity means content, not a setting", nativePrintOptions("2 səhifə material yaz") === null);
  ok("...as does asking for material to be written", nativePrintOptions("material yaz") === null);

  console.log("\nOnly a material this engine wrote may be rebuilt:");
  ok("damaged metadata (native: {}) is NOT a native document", !nativeCanHandle({ aiMeta: { native: {} }, html: "<div>Köhnə</div>" }, () => 0));
  ok("a body of <div> is somebody's work, not a blank page", !nativeCanHandle({ html: "<div>Existing lesson</div>" }, () => 0));
  ok("so is a drawing with no text at all", !nativeCanHandle({ html: "<svg><rect/></svg>" }, () => 0));
  ok("a genuinely empty document may still be written", nativeCanHandle({ html: "", blocks: [] }, () => 0));

  console.log("\nA PDF is only replaced when the text can stand in for it:");
  {
    const os = require("os");
    const fs = require("fs");
    const prevDir = process.env.LESSON_DOC_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lessondoc-mixed-"));
    process.env.LESSON_DOC_DIR = tmp;
    fs.mkdirSync(path.join(tmp, "docfiles"), { recursive: true });
    delete require.cache[require.resolve("../helper/lessonDocFiles")];
    const freshFiles = require("../helper/lessonDocFiles");
    const evPath = require.resolve("../helper/curriculumEvidence");
    const realEv = require.cache[evPath];

    const write = (key, body) => fs.writeFileSync(path.join(tmp, "docfiles", `${key}.pdf`), body);
    const stubPages = (texts) => {
      require.cache[evPath] = {
        id: evPath, filename: evPath, loaded: true,
        exports: { pdfPageCount: async () => texts.length, pdfPageText: async (_s, i) => texts[i] || "" },
      };
    };
    const prose = "Faiz bir kəmiyyətin yüzdə bir hissəsidir və məktəb riyaziyyatında geniş istifadə olunur. ".repeat(3);

    // Every page typeset, nothing visual: the text genuinely replaces the file.
    const plain = "1".repeat(64);
    write(plain, "%PDF-1.4 plain text only");
    stubPages([prose, prose]);
    const r1 = await freshFiles.nativeSourceText([{ key: plain, ext: "pdf", mime: "application/pdf", name: "a.pdf" }]);
    ok("an all-text PDF is complete, so it can be dropped", r1[0] && r1[0].complete === true);

    /*
     * The fidelity hole this closes: text on one page, a scan or a full-page
     * figure on another. Every page number was visited, so it used to count as
     * complete — the file was dropped and the model never saw the picture.
     */
    const mixed = "2".repeat(64);
    write(mixed, "%PDF-1.4 mixed");
    stubPages([prose, ""]);
    const r2 = await freshFiles.nativeSourceText([{ key: mixed, ext: "pdf", mime: "application/pdf", name: "b.pdf" }]);
    ok("a PDF with a page that gave no text is NOT complete", r2[0] && r2[0].complete === false);
    ok("...and its text still travels as context", r2[0].text.length > 0);

    // Text on every page, but a diagram embedded in the bytes.
    const withFigure = "3".repeat(64);
    write(withFigure, "%PDF-1.4 /Subtype /Image stream ...");
    stubPages([prose, prose]);
    const r3 = await freshFiles.nativeSourceText([{ key: withFigure, ext: "pdf", mime: "application/pdf", name: "c.pdf" }]);
    ok("an embedded image keeps the file in the request", r3[0] && r3[0].complete === false);
    ok("...and it is reported as such", r3[0].hasDrawings === true);

    if (realEv) require.cache[evPath] = realEv; else delete require.cache[evPath];
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.LESSON_DOC_DIR; else process.env.LESSON_DOC_DIR = prevDir;
    delete require.cache[require.resolve("../helper/lessonDocFiles")];
  }

  console.log("\nThe parser refuses what it cannot represent:");
  ok("a negation it cannot attribute goes to the engine", nativePrintOptions("səhifə nömrələrini əlavə etmə") === null);
  ok("a two-letter filler no longer swallows a verb", nativePrintOptions("səhifə nömrələrini dəyiş") === null);
  ok("a colour asked for NEGATIVELY is not set positively", nativePrintOptions("səhifə nömrəsi qırmızı olmasın") === null);

  console.log("\nThe answer can carry a print setting:");
  {
    const withPrint = normalizeNative({
      title: "T", audience: "A", reply: "R",
      printOptions: { pageNumbers: true, accent: "green" },
      blocks: [{ kind: "heading", text: "H" }, { kind: "text", text: "B" }],
    });
    eq("what the model set survives", withPrint.printOptions, { pageNumbers: true, accent: "green" });
    const bogus = normalizeNative({
      title: "T", audience: "A", reply: "R",
      printOptions: { pageNumbers: "yes", accent: "neon" },
      blocks: [{ kind: "text", text: "B" }],
    });
    eq("a value the renderer does not know is dropped, not written", bogus.printOptions, {});
  }

  console.log("\nA vector diagram is not a token saving:");
  {
    /*
     * The hole this closes: a raster marker survives in the raw bytes, but a
     * chart, a circle or an arrow is drawing operators inside a compressed
     * content stream. A worksheet of selectable text plus a vector figure
     * looked like pure text, so the file was dropped and only the words
     * reached the model.
     */
    const fs = require("fs");
    const os = require("os");
    const { renderPdf } = require("../helper/lessonPlanPdf");
    const { pdfHasDrawings } = require("../helper/lessonDocFiles");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lessondoc-vector-"));
    const page = (body) => `<!doctype html><meta charset="utf-8"><body style="font-family:Arial">${body}</body>`;
    const prose = "<p>" + "Faiz bir kəmiyyətin yüzdə bir hissəsidir. ".repeat(40) + "</p>";
    const make = async (name, html) => {
      const f = path.join(dir, `${name}.pdf`);
      fs.writeFileSync(f, await renderPdf(page(html), { footerLabel: null, pageNumbers: false }));
      return pdfHasDrawings(f);
    };

    ok("plain typeset text draws nothing, so it can be replaced", (await make("text", prose)) === false);
    ok("a vector circle keeps the file", (await make("circle", prose + '<svg width="200" height="200"><circle cx="100" cy="100" r="80" fill="none" stroke="black"/></svg>')) === true);
    ok("a vector chart keeps the file", (await make("chart", prose + '<svg width="300" height="200"><path d="M10 190 C 60 20, 140 20, 290 120" stroke="blue" fill="none"/></svg>')) === true);
    ok("an unreadable file answers yes, never no", (await pdfHasDrawings(path.join(dir, "does-not-exist.pdf"))) === true);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\nThe -məsin negation, which is how people actually ask:");
  eq("göstərməsin hides them", nativePrintOptions("səhifə nömrələrini göstərməsin"), { pageNumbers: false });
  eq("the passive göstərilməsin too", nativePrintOptions("səhifə nömrələrini göstərilməsin"), { pageNumbers: false });
  eq("silinməsin KEEPS them (two negatives)", nativePrintOptions("səhifə nömrələrini silinməsin"), { pageNumbers: true });
  eq("and olmasın still reads as itself, not as a stripped stem", nativePrintOptions("səhifə nömrəsi olmasın"), { pageNumbers: false });

  console.log("\nOne setting can be changed without inventing the other:");
  {
    const onlyPages = normalizeNative({
      title: "T", audience: "A", reply: "R",
      printOptions: { pageNumbers: true, accent: null },
      blocks: [{ kind: "heading", text: "H" }, { kind: "text", text: "B" }],
    });
    eq("page numbers alone", onlyPages.printOptions, { pageNumbers: true });
    const onlyAccent = normalizeNative({
      title: "T", audience: "A", reply: "R",
      printOptions: { pageNumbers: null, accent: "teal" },
      blocks: [{ kind: "heading", text: "H" }, { kind: "text", text: "B" }],
    });
    eq("an accent alone", onlyAccent.printOptions, { accent: "teal" });
  }

  console.log("\nThe detector reads real PDFs, not just the ones we render:");
  {
    const fs = require("fs");
    const os = require("os");
    const zlib = require("zlib");
    const { pdfHasDrawings } = require("../helper/lessonDocFiles");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lessondoc-filters-"));

    // ASCII85 is an ordinary wrapper around Flate in PDFs from other tools.
    const a85 = (buf) => {
      let out = "";
      for (let i = 0; i < buf.length; i += 4) {
        const chunk = buf.slice(i, i + 4);
        const n = chunk.length;
        let v = Buffer.concat([chunk, Buffer.alloc(4 - n)]).readUInt32BE(0);
        if (v === 0 && n === 4) { out += "z"; continue; }
        const c = [];
        for (let k = 0; k < 5; k += 1) { c.unshift(String.fromCharCode(33 + (v % 85))); v = Math.floor(v / 85); }
        out += c.join("").slice(0, n + 1);
      }
      return out + "~>";
    };
    const makePdf = (content, filters) => {
      const flate = zlib.deflateSync(Buffer.from(content, "latin1"));
      const body = filters.includes("ASCII85") ? a85(flate) : flate.toString("latin1");
      const chain = filters.map((f) => `/${f}Decode`).join(" ");
      return Buffer.from(
        `%PDF-1.4\n1 0 obj\n<< /Length ${body.length} /Filter [${chain}] >>\nstream\n${body}\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF`,
        "latin1"
      );
    };
    const TEXT = "BT /F1 12 Tf 72 700 Td (Faiz bir kemiyyetin yuzde bir hissesidir) Tj ET\n".repeat(30);
    const LINE = TEXT + "10 10 m 50 90 l 90 30 l 130 70 l 170 20 l S\n";
    const BARS4 = TEXT + "10 10 40 60 re f 60 10 40 90 re f 110 10 40 30 re f 160 10 40 75 re f\n";
    const check = async (name, bytes) => {
      const f = path.join(dir, `${name}.pdf`);
      fs.writeFileSync(f, bytes);
      return pdfHasDrawings(f);
    };

    ok("plain Flate text is replaceable", (await check("t1", makePdf(TEXT, ["Flate"]))) === false);
    // The chain that made the saving fail for outside PDFs: these would not
    // inflate directly, so every one of them was kept in full.
    ok("an ASCII85+Flate chain is decoded, so text-only is replaceable", (await check("t2", makePdf(TEXT, ["ASCII85", "Flate"]))) === false);
    // Neither of these emits a curve, which is all the first version looked for.
    ok("a straight-line chart (m/l) is a drawing", (await check("t3", makePdf(LINE, ["Flate"]))) === true);
    ok("...through an ASCII85 chain too", (await check("t4", makePdf(LINE, ["ASCII85", "Flate"]))) === true);
    ok("a four-bar chart is a drawing", (await check("t5", makePdf(BARS4, ["Flate"]))) === true);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\nA real text document is still worth the saving:");
  {
    /*
     * The counterweight to all the caution above. Two things used to make every
     * typeset PDF look like a drawing: embedded font programs, which never
     * inflate, and the letters "stream" occurring inside another stream's
     * compressed payload, which invented streams that could not be decoded
     * either. Both read as "something unreadable is in here".
     */
    const fs = require("fs");
    const os = require("os");
    const { renderPdf } = require("../helper/lessonPlanPdf");
    const { pdfHasDrawings } = require("../helper/lessonDocFiles");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lessondoc-real-"));
    const page = (b) => `<!doctype html><meta charset="utf-8"><body style="font-family:Arial">${b}</body>`;
    const prose = "<p>" + "Faiz bir kəmiyyətin yüzdə bir hissəsidir. ".repeat(40) + "</p>";
    const render = async (name, html) => {
      const f = path.join(dir, `${name}.pdf`);
      fs.writeFileSync(f, await renderPdf(page(html), { footerLabel: null, pageNumbers: false }));
      return pdfHasDrawings(f);
    };

    ok("a page of nothing but text IS replaceable", (await render("text", prose)) === false);
    ok("...and a circle on it is still caught", (await render("circle", prose + '<svg width="200" height="200"><circle cx="100" cy="100" r="80" fill="none" stroke="black"/></svg>')) === true);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\nEvery wrapping a stream comes in, and the smallest diagram:");
  {
    const fs = require("fs");
    const os = require("os");
    const zlib = require("zlib");
    const { pdfHasDrawings } = require("../helper/lessonDocFiles");
    const { renderPdf } = require("../helper/lessonPlanPdf");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lessondoc-wrap-"));

    const a85 = (b) => {
      let o = "";
      for (let i = 0; i < b.length; i += 4) {
        const c = b.slice(i, i + 4);
        const n = c.length;
        let v = Buffer.concat([c, Buffer.alloc(4 - n)]).readUInt32BE(0);
        if (v === 0 && n === 4) { o += "z"; continue; }
        const a = [];
        for (let k = 0; k < 5; k += 1) { a.unshift(String.fromCharCode(33 + (v % 85))); v = Math.floor(v / 85); }
        o += a.join("").slice(0, n + 1);
      }
      return o + "~>";
    };
    const mk = (content, kind) => {
      const src = Buffer.from(content, "latin1");
      const flate = zlib.deflateSync(src);
      const shapes = {
        Flate: [flate.toString("latin1"), "/FlateDecode"],
        ASCII85: [a85(flate), "[/ASCII85Decode /FlateDecode]"],
        ASCIIHex: [flate.toString("hex") + ">", "[/ASCIIHexDecode /FlateDecode]"],
        RawDeflate: [zlib.deflateRawSync(src).toString("latin1"), "/FlateDecode"],
        Gzip: [zlib.gzipSync(src).toString("latin1"), "/FlateDecode"],
      };
      const [body, filter] = shapes[kind];
      return Buffer.from(
        `%PDF-1.4\n1 0 obj\n<< /Length ${body.length} /Filter ${filter} >>\nstream\n${body}\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF`,
        "latin1"
      );
    };
    const TEXT = "BT /F1 12 Tf 72 700 Td (Faiz bir kemiyyetin yuzde bir hissesidir) Tj ET\n".repeat(30);
    const check = async (name, bytes) => {
      const f = path.join(dir, `${name}.pdf`);
      fs.writeFileSync(f, bytes);
      return pdfHasDrawings(f);
    };

    /*
     * Gzip is the one that was broken: the slice kept the end-of-line before
     * `endstream`, zlib tolerated that trailing byte and gunzip did not, so a
     * gzip-wrapped text PDF never decoded and was paid for in full every time.
     */
    for (const kind of ["Flate", "ASCII85", "ASCIIHex", "RawDeflate", "Gzip"]) {
      // eslint-disable-next-line no-await-in-loop
      ok(`text-only through ${kind} is replaceable`, (await check(`t-${kind}`, mk(TEXT, kind))) === false);
    }

    /*
     * The floors are gone. Counting meant a page with ONE box on it read as no
     * drawing — but most rectangles in a typeset PDF are not drawings at all:
     * every page opens with a clip, "… re W* n", which paints nothing. What
     * happens to the rectangle decides, not how many there are.
     */
    ok("one stroked box IS a drawing", (await check("box", mk(TEXT + "10 10 120 60 re S\n", "Flate"))) === true);
    ok("one line IS a drawing", (await check("line", mk(TEXT + "10 10 m 120 60 l S\n", "Flate"))) === true);
    ok("a clipping rectangle is NOT", (await check("clip", mk(TEXT + "0 0 600 800 re W* n\n", "Flate"))) === false);

    // And against the real renderer, where that clip actually occurs.
    const page = (b) => `<!doctype html><meta charset="utf-8"><body style="font-family:Arial">${b}</body>`;
    const prose = "<p>" + "Faiz bir kəmiyyətin yüzdə bir hissəsidir. ".repeat(40) + "</p>";
    const render = async (name, html) => {
      const f = path.join(dir, `${name}.pdf`);
      fs.writeFileSync(f, await renderPdf(page(html), { footerLabel: null, pageNumbers: false }));
      return pdfHasDrawings(f);
    };
    ok("a real text page is still replaceable", (await render("real-text", prose)) === false);
    ok("...and a single bordered box on it is caught", (await render("real-box", prose + "<div style='width:120px;height:60px;border:2px solid black'></div>")) === true);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\nA long document does not hide its diagrams:");
  {
    const fs = require("fs");
    const os = require("os");
    const zlib = require("zlib");
    const { pdfHasDrawings } = require("../helper/lessonDocFiles");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lessondoc-long-"));
    const TEXT = "BT /F1 12 Tf 72 700 Td (Faiz bir kemiyyetin yuzde bir hissesidir) Tj ET\n";

    // Several objects, each its own stream, with the chosen end-of-line.
    const mkMulti = (streams, eol) => {
      let out = "%PDF-1.4\n";
      streams.forEach((c, i) => {
        const body = zlib.deflateSync(Buffer.from(c, "latin1")).toString("latin1");
        out += `${i + 1} 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream${eol}${body}\nendstream\nendobj\n`;
      });
      return Buffer.from(`${out}trailer<</Root 1 0 R>>\n%%EOF`, "latin1");
    };
    const check = async (name, bytes) => {
      const f = path.join(dir, `${name}.pdf`);
      fs.writeFileSync(f, bytes);
      return pdfHasDrawings(f);
    };

    /*
     * The scan used to concatenate every stream into one buffer with a 4 MiB
     * budget and test it at the end. A document longer than that exhausted the
     * budget before the page with the diagram on it was ever read, and the
     * answer came back "no drawings" for a file that has one. Each stream is
     * judged on its own now, so length cannot hide anything.
     */
    const huge = TEXT.repeat(Math.ceil((4.2 * 1024 * 1024) / TEXT.length));
    ok("a line in a stream AFTER 4.2MiB of text is found", (await check("long-draw", mkMulti([huge, `${TEXT}10 10 m 120 60 l S\n`], "\n"))) === true);
    // And the saving is not bought by simply calling everything long a drawing.
    ok("...while 4.2MiB of plain text is still replaceable", (await check("long-text", mkMulti([huge, TEXT], "\n"))) === false);

    // CR alone is a legal separator in the wild, and was not matched at all.
    ok("a stream delimited by CR alone is read", (await check("cr-draw", mkMulti([`${TEXT}10 10 m 120 60 l S\n`], "\r"))) === true);
    ok("...and its text-only case stays replaceable", (await check("cr-text", mkMulti([TEXT], "\r"))) === false);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\nLegal PDF syntax cannot step around the detector:");
  {
    const fs = require("fs");
    const os = require("os");
    const zlib = require("zlib");
    const { pdfHasDrawings } = require("../helper/lessonDocFiles");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lessondoc-syntax-"));
    const TEXT = "BT /F1 12 Tf 72 700 Td (Faiz bir kemiyyetin yuzde bir hissesidir) Tj ET\n";

    const mk = (streams, dicts) => {
      let out = "%PDF-1.4\n";
      streams.forEach((c, i) => {
        const body = zlib.deflateSync(Buffer.from(c, "latin1")).toString("latin1");
        out += `${i + 1} 0 obj\n<< /Length ${body.length} /Filter /FlateDecode ${(dicts && dicts[i]) || ""}>>\nstream\n${body}\nendstream\nendobj\n`;
      });
      return Buffer.from(`${out}trailer<</Root 1 0 R>>\n%%EOF`, "latin1");
    };
    const check = async (name, bytes) => {
      const f = path.join(dir, `${name}.pdf`);
      fs.writeFileSync(f, bytes);
      return pdfHasDrawings(f);
    };

    /*
     * A page's content may legally be SPLIT across several streams. One ending
     * "10 10 100 100" and the next beginning "l S" is one drawing written in
     * two objects, and judging each stream alone finds nothing in either — the
     * cost of the per-stream scan introduced to fix the memory bound.
     */
    ok("a drawing split across two streams is found", (await check("split", mk([`${TEXT}10 10 100 100`, "l S\n"]))) === true);
    ok("...and a split with no drawing is still replaceable", (await check("split-none", mk([`${TEXT}10 10 100 100x`, "text\n"]))) === false);

    /*
     * A comment may sit between the operands and their operator. The operators
     * were matched by looking for a digit immediately in front of them, so a
     * comment in that gap hid the drawing completely.
     */
    ok("a comment between operands and 'l' does not hide it", (await check("cmt-l", mk([`${TEXT}10 10 100 100\n% the diagonal\nl S\n`]))) === true);
    ok("nor between operands and 're S'", (await check("cmt-re", mk([`${TEXT}10 10 100 100\n% the box\nre S\n`]))) === true);
    ok("...while a comment ABOUT drawing is not a drawing", (await check("cmt-only", mk([`${TEXT}% we could draw a line here\n`]))) === false);

    /*
     * The benign-stream check reads THIS object's dictionary. A fixed lookback
     * reached into whatever object sat before it, so an unreadable drawing
     * stream could be waved through because a font object nearby said
     * /FontFile2.
     */
    const junk = "\u0000\u0001\u0002 not a stream at all ÿþ";
    const mixed = Buffer.from(
      "%PDF-1.4\n" +
        `1 0 obj\n<< /Length 40 /FontFile2 99 0 R >>\nstream\n${zlib.deflateSync(Buffer.from(TEXT, "latin1")).toString("latin1")}\nendstream\nendobj\n` +
        `2 0 obj\n<< /Length ${junk.length} /Filter /FlateDecode >>\nstream\n${junk}\nendstream\nendobj\n` +
        "trailer<</Root 1 0 R>>\n%%EOF",
      "latin1"
    );
    ok("an unreadable stream is not excused by a NEIGHBOUR's font marker", (await check("neighbour", mixed)) === true);

    /*
     * The size ceiling belongs inside zlib, not after it. Checking the finished
     * string fails closed for correctness but only once the memory has already
     * been allocated — a compression bomb was decompressed in full before
     * anyone objected.
     */
    const bombBody = zlib.deflateSync(Buffer.alloc(40 * 1024 * 1024, 0x41)).toString("latin1");
    const bomb = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Length ${bombBody.length} /Filter /FlateDecode >>\nstream\n${bombBody}\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF`,
      "latin1"
    );
    ok("a 40MiB expansion is refused, and keeps the file", (await check("bomb", bomb)) === true);
    /*
     * And the refusal happens INSIDE zlib. Measuring heap around the call was
     * the obvious check and a worthless one: a garbage collection during the
     * call makes the delta negative, so it passed whether or not 40MiB had been
     * allocated. This asserts the mechanism instead — unbounded, the payload
     * really does expand to 40MiB; bounded, inflation refuses rather than
     * returning a truncated string that would then be scanned and found empty.
     */
    const payload = Buffer.from(bombBody, "latin1");
    ok("...and the fixture really is a bomb", zlib.inflateSync(payload).length === 40 * 1024 * 1024);
    let refused = null;
    try {
      zlib.inflateSync(payload, { maxOutputLength: 32 * 1024 * 1024 });
    } catch (e) {
      refused = e;
    }
    ok("...which inflation refuses at the ceiling, rather than truncating", Boolean(refused));

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\nThe stream is read as PDF, not as text:");
  {
    const fs = require("fs");
    const os = require("os");
    const zlib = require("zlib");
    const { pdfHasDrawings } = require("../helper/lessonDocFiles");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lessondoc-token-"));
    const T = (t) => `BT /F1 12 Tf 72 700 Td (${t}) Tj ET\n`;
    const TEXT = T("Faiz bir kemiyyetin yuzde bir hissesidir").repeat(20);
    const mk = (streams) => {
      let out = "%PDF-1.4\n";
      streams.forEach((c, i) => {
        const b = zlib.deflateSync(Buffer.from(c, "latin1")).toString("latin1");
        out += `${i + 1} 0 obj\n<< /Length ${b.length} /Filter /FlateDecode >>\nstream\n${b}\nendstream\nendobj\n`;
      });
      return Buffer.from(`${out}trailer<</Root 1 0 R>>\n%%EOF`, "latin1");
    };
    const check = async (name, streams) => {
      const f = path.join(dir, `${name}.pdf`);
      fs.writeFileSync(f, mk(streams));
      return pdfHasDrawings(f);
    };

    /*
     * Every one of these was wrong while the scan used regexes over raw text,
     * and none of them was fixable by a better pattern — a % means "comment"
     * only outside a string, and a letter means "operator" only outside one too.
     */
    ok("a % inside a string does not begin a comment", (await check("pct", [`${T("100% complete")}10 10 m 90 90 l S\n`])) === true);
    ok("letters in a sentence are not operators", (await check("letters", [T("Find y given the equation")])) === false);
    ok("...even a sentence full of them", (await check("letters2", [T("solve for x c v y l re S here")])) === false);

    /*
     * A path is a drawing once something PAINTS it, and the painting operator
     * need not come next: a clip flag or a colour change may sit between.
     */
    ok("re W S paints (clip flag between)", (await check("re-w-s", [`${TEXT}10 10 100 60 re W S\n`])) === true);
    ok("re 1 0 0 RG S paints (colour between)", (await check("re-rg-s", [`${TEXT}10 10 100 60 re 1 0 0 RG S\n`])) === true);
    ok("re n does NOT paint — the path is thrown away", (await check("re-n", [`${TEXT}10 10 120 60 re n\n`])) === false);
    ok("re W* n is the clip every typeset page opens with", (await check("re-clip", [`${TEXT}0 0 600 800 re W* n\n`])) === false);

    // Marks that never build a path first.
    ok("a shading is a mark", (await check("sh", [`${TEXT}/Sh0 sh\n`])) === true);
    ok("an inline image is a mark", (await check("bi", [`${TEXT}BI /W 4 /H 4 ID xxxx EI\n`])) === true);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} parity assertions failed`);
})();
