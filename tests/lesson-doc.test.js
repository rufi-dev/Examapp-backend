/*
 * Lesson materials — the handout a teacher gives a class.
 *
 * Two properties carry real consequences. First: a TASK's answer must never reach
 * the printed page. This is the sheet a student writes on, and printing the answer
 * under the question hands them the paper — a mistake that is invisible on screen,
 * where the teacher legitimately sees it. Second: strict mode forces the model to
 * send every field on every block, so normalisation has to strip the noise or the
 * database and the editor both fill with meaningless keys.
 *
 * Pure functions, no DB and no model call.
 */
const assert = require("assert");
const S = require("../helper/lessonDocSchema");
const { buildLessonDocHtml } = require("../helper/lessonDocHtml");
const { assertStrict, toGeminiSchema } = require("../helper/curriculumSchema");

let passed = 0;
let failed = 0;
// A few checks need to await real I/O. They register here and the summary at the
// bottom waits for them, so the rest of the file stays plainly synchronous.
const pending = [];
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

// What strict mode actually sends: every property, on every block, always.
const full = (over) => ({
  kind: "text", text: "", term: "", items: [], ordered: false,
  solution: "", columns: [], rows: [], tone: "info", ...over,
});

console.log("\n1. The schema is valid for both providers:");
{
  assertStrict(S.DOC_SCHEMA);
  ok("OpenAI strict mode accepts it", true);
  const g = JSON.stringify(toGeminiSchema(S.DOC_SCHEMA));
  ok("the Gemini mirror drops additionalProperties", !g.includes("additionalProperties"));
  ok("no empty enum value anywhere", !g.includes('""'));
  ok("every property is required", S.BLOCK.required.length === Object.keys(S.BLOCK.properties).length);
}

console.log("\n2. Normalisation keeps only what a kind uses:");
{
  const { blocks } = S.normalizeDoc({
    title: "  Modal fellər  ",
    blocks: [
      full({ kind: "heading", text: "Giriş" }),
      full({ kind: "text", text: "İzah." }),
      full({ kind: "definition", term: "can", text: "bacarıq" }),
      full({ kind: "list", items: [" can ", "", "could"], ordered: true }),
      full({ kind: "example", text: "I can swim.", solution: "bacarıq" }),
      full({ kind: "task", text: "Doldurun.", solution: "can" }),
      full({ kind: "note", text: "Diqqət.", tone: "warning" }),
      full({ kind: "table", columns: ["A", "B"], rows: [["1", "2"], []] }),
    ],
  });

  const by = (k) => blocks.find((b) => b.kind === k);
  ok("the title is trimmed", S.normalizeDoc({ title: "  x  ", blocks: [] }).title === "x");
  ok("all eight kinds survive", blocks.length === 8, blocks.length);

  // The point of the exercise: a text block must not carry table columns.
  ok("a text block keeps only its text", Object.keys(by("text")).sort().join(",") === "id,kind,text");
  ok("a definition keeps term and text", Object.keys(by("definition")).sort().join(",") === "id,kind,term,text");
  ok("a list keeps items and ordered", Object.keys(by("list")).sort().join(",") === "id,items,kind,ordered");
  ok("a note keeps its tone", by("note").tone === "warning");
  ok("empty list items are dropped", by("list").items.length === 2, JSON.stringify(by("list").items));
  /*
   * This used to assert that an empty row was DROPPED, and that was the defect:
   * an empty cell is content in a grid, and a blank form is made of them. The row
   * is kept and squared to the header width — see section 22.
   */
  ok("an empty table row is kept, squared to the header", by("table").rows.length === 2);
  ok("and padded rather than left ragged", by("table").rows[1].length === 2 && by("table").rows[1].every((c) => c === ""));
  ok("every block gets an id", blocks.every((b) => typeof b.id === "string" && b.id.length >= 8));
  ok("ids are unique", new Set(blocks.map((b) => b.id)).size === blocks.length);
}

console.log("\n3. Content-free blocks are dropped, not rendered empty:");
{
  const { blocks } = S.normalizeDoc({
    title: "t",
    blocks: [
      full({ kind: "text", text: "   " }),
      full({ kind: "heading", text: "" }),
      full({ kind: "list", items: ["", "  "] }),
      full({ kind: "table", columns: [], rows: [["a"]] }),
      full({ kind: "table", columns: ["A"], rows: [] }),
      full({ kind: "nonsense", text: "x" }),
      full({ kind: "text", text: "real" }),
    ],
  });
  // An empty box in a handout is worse than one fewer paragraph.
  ok("only the real block survives", blocks.length === 1 && blocks[0].text === "real", JSON.stringify(blocks));

  ok("junk input does not throw", S.normalizeDoc(null).blocks.length === 0);
  ok("a missing blocks array is fine", S.normalizeDoc({ title: "x" }).blocks.length === 0);
  ok("a null block does not throw", S.normalizeDoc({ blocks: [null, full({ text: "a" })] }).blocks.length === 1);
}

console.log("\n4. Ids survive an edit, so a block stays the same block:");
{
  const first = S.normalizeDoc({ title: "t", blocks: [full({ text: "one" }), full({ text: "two" })] });
  const ids = first.blocks.map((b) => b.id);
  // The model returns the document with block two reworded; block one must not be
  // renumbered, or the editor remounts everything and the "new" highlight lies.
  const second = S.normalizeDoc(
    { title: "t", blocks: [full({ text: "one" }), full({ text: "two, changed" })] },
    { keepIds: ids }
  );
  ok("ids are reused in place", JSON.stringify(second.blocks.map((b) => b.id)) === JSON.stringify(ids));
  ok("a block added beyond the old length gets a fresh id",
    S.normalizeDoc({ title: "t", blocks: [full({ text: "a" }), full({ text: "b" }), full({ text: "c" })] }, { keepIds: ids })
      .blocks[2].id.length >= 8);
}

console.log("\n5. THE print rule — a task's answer never reaches the handout:");
{
  const doc = {
    title: "Modal fellər",
    subject: "İngilis dili",
    grade: "11",
    blocks: [
      { id: "1", kind: "task", text: "Boşluqları doldurun.", solution: "CAVAB-GİZLİ" },
      { id: "2", kind: "example", text: "I can swim.", solution: "NÜMUNƏ-HƏLLİ" },
    ],
  };
  for (const forWord of [false, true]) {
    const html = buildLessonDocHtml(doc, { forWord });
    const where = forWord ? "word" : "pdf";
    ok(`${where}: the task question is printed`, html.includes("Boşluqları doldurun"));
    ok(`${where}: the task ANSWER is not`, !html.includes("CAVAB-GİZLİ"));
    // An example is a worked one — its solution is the teaching, and belongs there.
    ok(`${where}: a worked example keeps its solution`, html.includes("NÜMUNƏ-HƏLLİ"));
  }
}

console.log("\n6. The two documents describe the same lesson:");
{
  const doc = {
    title: "Kəsrlər",
    blocks: [
      { id: "1", kind: "heading", text: "Giriş" },
      { id: "2", kind: "definition", term: "surət", text: "yuxarıdakı ədəd" },
      { id: "3", kind: "list", ordered: true, items: ["bir", "iki"] },
      { id: "4", kind: "note", tone: "warning", text: "Diqqət" },
      { id: "5", kind: "table", columns: ["A"], rows: [["1"]] },
    ],
  };
  const pdf = buildLessonDocHtml(doc);
  const word = buildLessonDocHtml(doc, { forWord: true });

  for (const probe of ["Giriş", "surət", "yuxarıdakı ədəd", "bir", "Diqqət"]) {
    ok(`both carry ${JSON.stringify(probe)}`, pdf.includes(probe) && word.includes(probe));
  }
  ok("the ordered list is an <ol> in both", pdf.includes("<ol>") && word.includes("<ol>"));

  // LibreOffice's HTML import understands none of these and silently flattens the
  // layout into one unstyled column.
  ok("the Word sheet avoids grid", !word.includes("display:grid"));
  ok("the Word sheet avoids flex", !word.includes("display:flex"));
  ok("the Word sheet avoids custom properties", !word.includes("var(--"));
  ok("the PDF sheet may use them", pdf.includes("var(--"));

  ok("both escape markup", buildLessonDocHtml({ blocks: [{ id: "1", kind: "text", text: "<script>x</script>" }] })
    .includes("&lt;script&gt;"));
  ok("an empty document still renders", buildLessonDocHtml({ title: "x", blocks: [] }).includes("məzmun yoxdur"));
  ok("a null document does not throw", typeof buildLessonDocHtml(null) === "string");
}

console.log("\n7. The prompts carry the contract:");
{
  const create = S.buildCreatePrompt({ doc: { topic: "Kəsrlər", grade: "5" }, instructions: "sadə izah" });
  ok("the create prompt names the topic", create.prompt.includes("Kəsrlər"));
  ok("and the class", create.prompt.includes("5"));
  ok("and the teacher's request", create.prompt.includes("sadə izah"));
  ok("it does NOT carry edit rules", !create.system.includes("REDAKTƏ REJİMİ"));

  const edit = S.buildEditPrompt({
    doc: { topic: "Kəsrlər", blocks: [{ kind: "text", text: "qalmalıdır" }] },
    instructions: "bir nümunə əlavə et",
  });
  ok("the edit prompt sends the current document", edit.prompt.includes("qalmalıdır"));
  ok("and says to leave the rest alone", /OLDUĞU KİMİ, eyni sözlərlə/.test(edit.system));
  ok("and forbids a rewrite", /Onu yenidən yazma/.test(edit.system));

  const fs = require("fs");
  const path = require("path");
  const ctl = fs.readFileSync(path.join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const svcSrc = fs.readFileSync(path.join(__dirname, "../services/lessonDocService.js"), "utf8");
  // A provider timeout must not lose what the teacher typed: they should reopen
  // the page and find their own words with a failure beside them.
  ok("the teacher's message is stored before the model runs", /appendMessages\([\s\S]{0,300}role: "user"[\s\S]{0,600}runDocument/.test(ctl));
  ok("a hand edit never calls the model", /const updateDoc[\s\S]{0,1200}/.test(ctl) && !/const updateDoc[\s\S]{0,1200}runDocument/.test(ctl));
  ok("edits are guarded by the revision CAS", /svc\.commit\(/.test(ctl) && /doc_conflict/.test(svcSrc));
  ok("Word is sent as an attachment", /attachment/.test(ctl));

  const docx = fs.readFileSync(path.join(__dirname, "../helper/lessonDocDocx.js"), "utf8");
  // Concurrent exports otherwise block on LibreOffice's single user profile.
  ok("each conversion gets its own LibreOffice profile", /UserInstallation/.test(docx));
  ok("the result is checked for a zip header", /0x50/.test(docx) && /0x4b/.test(docx));
  ok("the scratch directory is always removed", /finally[\s\S]{0,120}rm\(/.test(docx));
}

console.log("\n8. Figures — the model draws, the allow-list decides:");
{
  /*
   * SVG is a full document format: it can carry <script>, event handlers,
   * <foreignObject> with arbitrary HTML and external references. It goes into the
   * page with dangerouslySetInnerHTML, so what this filter lets through IS the
   * security boundary.
   */
  const { sanitizeSvg } = require("../helper/lessonDocSvg");
  const good =
    '<svg viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg">' +
    '<line x1="5" y1="25" x2="95" y2="25" stroke="#333" stroke-width="2"/>' +
    '<circle cx="50" cy="25" r="4" fill="#0F4C5C"/>' +
    '<text x="50" y="45" text-anchor="middle" font-size="10">0</text></svg>';

  const clean = sanitizeSvg(good);
  ok("a real diagram survives intact", clean.includes("<line") && clean.includes("<circle") && clean.includes("<text"));
  ok("viewBox keeps its capital B", clean.includes("viewBox="));

  ok("script is stripped", !sanitizeSvg('<svg viewBox="0 0 1 1"><script>alert(1)</script><circle r="1"/></svg>').includes("alert"));
  ok("event handlers are stripped", !sanitizeSvg('<svg viewBox="0 0 1 1"><circle r="1" onload="alert(1)"/></svg>').includes("onload"));
  ok("foreignObject is stripped", !sanitizeSvg('<svg viewBox="0 0 1 1"><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>').includes("onerror"));
  ok("external references are stripped", !sanitizeSvg('<svg viewBox="0 0 1 1"><image href="http://evil/x.png"/></svg>').includes("evil"));
  ok("style attributes are stripped", !sanitizeSvg('<svg viewBox="0 0 1 1"><rect style="background:url(http://evil)"/></svg>').includes("evil"));
  ok("animate is stripped", !sanitizeSvg('<svg viewBox="0 0 1 1"><animate attributeName="x"/></svg>').includes("animate"));

  // Without a viewBox the browser falls back to 300x150 and crops the drawing.
  ok("no viewBox is refused", sanitizeSvg('<svg><circle r="1"/></svg>') === "");
  ok("non-svg is refused", sanitizeSvg("<div>hi</div>") === "");
  ok("an oversized blob is refused", sanitizeSvg('<svg viewBox="0 0 1 1">' + "x".repeat(30000) + "</svg>") === "");

  // A figure whose drawing does not survive is dropped whole: an empty frame in a
  // handout helps nobody.
  const kept = S.normalizeDoc({
    title: "t",
    blocks: [
      full({ kind: "figure", svg: good, text: "Ədəd oxu" }),
      full({ kind: "figure", svg: "<svg><script>x</script></svg>" }),
    ],
  }).blocks;
  ok("a good figure is kept with its caption", kept.length === 1 && kept[0].text === "Ədəd oxu");
  ok("an unsafe figure is dropped whole", kept.length === 1);

  const pdfF = buildLessonDocHtml({ blocks: kept });
  ok("the PDF inlines the svg", pdfF.includes("<svg viewBox") && pdfF.includes("<line"));
  ok("Word renders nothing without a raster", !buildLessonDocHtml({ blocks: kept }, { forWord: true }).includes("<figure"));
  ok(
    "Word uses the raster when it has one",
    buildLessonDocHtml({ blocks: [{ ...kept[0], pngSrc: "data:image/png;base64,AA" }] }, { forWord: true }).includes(
      '<img src="data:image/png'
    )
  );

  // The edit prompt must carry the drawing, or an unrelated edit loses every figure.
  ok("the edit prompt sends svg", S.buildEditPrompt({ doc: { blocks: kept } }).prompt.includes("viewBox"));
}

console.log("\n9. Attached references travel with every turn:");
{
  const fs2 = require("fs");
  const path2 = require("path");
  const F = require("../helper/lessonDocFiles");

  // Only what the providers can actually read. Anything else would be accepted and
  // then silently ignored at the exact point it was supposed to help.
  ok("PDF is accepted", Boolean(F.ACCEPT["application/pdf"]));
  ok("images are accepted", Boolean(F.ACCEPT["image/png"] && F.ACCEPT["image/jpeg"]));
  ok(
    "Word documents are refused",
    !F.ACCEPT["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
  );
  ok("there is a per-file cap", F.MAX_FILE_MB > 0 && F.MAX_FILE_MB <= 50);
  ok("and a total cap", F.MAX_TOTAL_MB >= F.MAX_FILE_MB);
  ok("and a count cap", F.MAX_FILES > 1 && F.MAX_FILES <= 10);

  ok("keys are content hashes", F.isValidKey("a".repeat(64)));
  ok("a short key is refused", !F.isValidKey("abc"));
  ok(
    "traversal is refused",
    (() => {
      try {
        F.pathForKey("../../etc/passwd", "pdf");
        return false;
      } catch {
        return true;
      }
    })()
  );

  const ctl = fs2.readFileSync(path2.join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  // The reference is needed on turn five as much as on turn one.
  ok("both turns send the files", (ctl.match(/toParts\(doc\.files \|\| \[\]\)/g) || []).length === 2);
  ok("the PLAN pass sees them too", /buildPlanPrompt[\s\S]{0,140}parts,/.test(ctl));
  ok("a shared file is not deleted while another doc holds it", /stillUsed/.test(ctl));
  ok("attachments are owner-scoped", /const getFile[\s\S]{0,120}mine\(req/.test(ctl));

  ok("the model is told a source is present", S.SOURCE_RULES.includes("BİRİNCİ MƏNBƏDİR"));
  ok("and how to transcribe one", S.SOURCE_RULES.includes("KÖÇÜRMƏ REJİMİ"));
  ok("and not to invent unreadable parts", S.SOURCE_RULES.includes("[oxunmadı]"));
}


console.log("\n10. Figures that actually draw:");
{
  /*
   * The bug this section exists for, reported from production: a percentage grid
   * where the 25 red cells were invisible and the title was cut in half.
   *
   * Neither was the model's fault. It wrote `<defs><rect id="s"/></defs>` and a
   * hundred `<use href="#s">`, which is the correct way to draw a grid — and the
   * sanitiser dropped `href` as a fetch vector, leaving a hundred elements that
   * referenced nothing. The drawing looked authored and rendered empty, and nothing
   * anywhere said it had been broken.
   */
  const { sanitizeSvg } = require("../helper/lessonDocSvg");

  const grid =
    '<svg viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><rect id="s" width="20" height="20"/></defs>' +
    '<g fill="red"><use href="#s" x="0" y="0"/><use href="#s" x="20" y="0"/></g>' +
    "</svg>";
  const gridOut = sanitizeSvg(grid);
  ok("a use reference survives", /<use[^>]*href="#/.test(gridOut));
  ok("and still points at a shape that exists", (() => {
    const ref = /href="#([^"]+)"/.exec(gridOut);
    return ref && gridOut.includes(`id="${ref[1]}"`);
  })());

  const arrow =
    '<svg viewBox="0 0 400 150" xmlns="http://www.w3.org/2000/svg">' +
    '<line x1="10" y1="70" x2="150" y2="70" stroke="black" marker-end="url(#a)"/>' +
    '<defs><marker id="a" markerWidth="10" markerHeight="7"><polygon points="0 0, 10 3.5, 0 7" fill="black"/></marker></defs>' +
    "</svg>";
  const arrowOut = sanitizeSvg(arrow);
  ok("a marker reference survives", /marker-end="url\(#/.test(arrowOut));
  ok("and resolves inside the same figure", (() => {
    const ref = /marker-end="url\(#([^)"]+)\)"/.exec(arrowOut);
    return ref && arrowOut.includes(`id="${ref[1]}"`);
  })());

  // Two figures in one handout both defining #arrowhead used to collide, and the
  // second drawing silently borrowed the first one's marker.
  const idOf = (s) => /id="([^"]+)"/.exec(s)[1];
  ok("two figures do not share ids", idOf(sanitizeSvg(arrow)) !== idOf(sanitizeSvg(arrow)));

  // Fragments are namespaced precisely so a reference cannot reach the host page.
  const escape = '<svg viewBox="0 0 10 10"><use href="#login-form"/></svg>';
  ok("a reference to the page is dropped", !sanitizeSvg(escape).includes("login-form"));
  const escapeUrl = '<svg viewBox="0 0 10 10"><rect fill="url(#page-thing)" width="5" height="5"/></svg>';
  ok("a url() into the page is dropped", !sanitizeSvg(escapeUrl).includes("page-thing"));
  // The dangerous case is the figure with NO ids of its own: every reference in it
  // necessarily points outside itself.
  ok("even when the figure defines nothing of its own", !/href|url\(/.test(sanitizeSvg(escape)));

  const external = '<svg viewBox="0 0 10 10"><use href="https://evil/x.svg#a"/></svg>';
  ok("an external href is dropped", !sanitizeSvg(external).includes("evil"));
  ok("a javascript href is dropped", !sanitizeSvg('<svg viewBox="0 0 10 10"><use href="javascript:alert(1)"/></svg>').includes("javascript"));
  ok("a protocol-relative href is dropped", !sanitizeSvg('<svg viewBox="0 0 10 10"><use xlink:href="//evil/x#a"/></svg>').includes("evil"));
  ok("an external url() fill is dropped", !sanitizeSvg('<svg viewBox="0 0 10 10"><rect fill="url(http://evil/a#b)" width="5" height="5"/></svg>').includes("evil"));
  // The whole point of the allow-list still has to hold.
  ok("script is still stripped", !sanitizeSvg('<svg viewBox="0 0 1 1"><script>alert(1)</script><circle r="1"/></svg>').includes("alert"));
  ok("handlers are still stripped", !sanitizeSvg('<svg viewBox="0 0 1 1"><circle r="1" onload="alert(1)"/></svg>').includes("onload"));

  // A plain colour must not be mistaken for a reference and thrown away.
  ok("a plain fill is untouched", sanitizeSvg('<svg viewBox="0 0 10 10"><rect fill="#2563eb" width="5" height="5"/></svg>').includes('fill="#2563eb"'));
  ok("a named colour is untouched", sanitizeSvg('<svg viewBox="0 0 10 10"><rect fill="red" width="5" height="5"/></svg>').includes('fill="red"'));
  ok("none is untouched", sanitizeSvg('<svg viewBox="0 0 10 10"><rect fill="none" stroke="black" width="5" height="5"/></svg>').includes('fill="none"'));
}

console.log("\n11. Nothing is drawn outside the frame:");
{
  /*
   * An SVG clips to its viewport, so a title at `y="-5"` loses its top half against
   * the edge of the figure — the second half of the same production report. The
   * model is told to leave margins, but a rule it may forget is not a guarantee,
   * and the cost of forgetting is a handout that looks unfinished.
   */
  const { sanitizeSvg } = require("../helper/lessonDocSvg");
  const vbOf = (s) => (/viewBox="([^"]+)"/.exec(s) || [])[1];

  const clipped =
    '<svg viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg">' +
    '<text x="100" y="-5" text-anchor="middle" font-size="12">Bütöv (100%)</text>' +
    '<rect x="10" y="10" width="200" height="200" fill="none" stroke="black"/></svg>';
  const box = vbOf(sanitizeSvg(clipped)).split(/\s+/).map(Number);
  ok("a title above the frame widens the frame", box[1] < 0);
  ok("far enough to clear the glyphs", box[1] <= -12);
  ok("and the drawing still starts where it did", box[0] <= 0);

  // Only ever enlarged. A drawing that fits must come back byte-identical, or every
  // existing figure in every saved document shifts.
  const fits =
    '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="10" y="10" width="100" height="50" fill="#2563eb"/></svg>';
  ok("a drawing that fits is left alone", vbOf(sanitizeSvg(fits)) === "0 0 200 100");

  // Translation is the common case: the grid drew its title inside translate(10,10).
  const translated =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<g transform="translate(10,10)"><rect x="0" y="0" width="120" height="20" fill="red"/></g></svg>';
  const tb = vbOf(sanitizeSvg(translated)).split(/\s+/).map(Number);
  ok("a translated overflow is measured through the transform", tb[2] > 100);

  // Anything that cannot be placed exactly must leave the drawing alone rather than
  // compute a box it cannot stand behind.
  const rotated =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<g transform="rotate(45)"><rect x="0" y="0" width="400" height="20" fill="red"/></g></svg>';
  ok("a rotate makes it decline to guess", vbOf(sanitizeSvg(rotated)) === "0 0 100 100");

  // A shape inside <defs> is a template painted wherever `use` puts it, never at
  // its own coordinates — measuring it would inflate the box for nothing.
  const defsOnly =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><rect id="t" x="0" y="0" width="900" height="900"/></defs>' +
    '<use href="#t" x="0" y="0"/></svg>';
  ok("a template in defs does not inflate the frame", vbOf(sanitizeSvg(defsOnly)) === "0 0 100 100");

  // A measurement several times the declared size is the measurement being wrong.
  const wild =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="0" y="0" width="9000" height="9000" fill="red"/></svg>';
  ok("a wild measurement is not trusted", vbOf(sanitizeSvg(wild)) === "0 0 100 100");

  ok("a figure with no viewBox is still refused", sanitizeSvg('<svg><circle r="1"/></svg>') === "");
}

console.log("\n12. An edit says what it is about to do:");
{
  /*
   * An edit used to run straight to the writing pass, so a long change showed
   * nothing but "Dəyişirəm…" — a spinner with a word on it. It never said what was
   * understood, so a misunderstanding surfaced only after the rewrite had landed.
   */
  const doc = {
    topic: "Faiz",
    blocks: [
      { kind: "heading", text: "Faiz nədir" },
      { kind: "text", text: "İzah" },
      { kind: "heading", text: "Məsələlər" },
    ],
  };
  const edit = S.buildPlanPrompt({ doc, instructions: "alman nümunələri əlavə et", editing: true });
  const create = S.buildPlanPrompt({ doc: { topic: "Faiz" }, instructions: "material yaz" });

  ok("an edit plan is a different brief", edit.system !== create.system);
  ok("it plans operations, not sections", edit.system.includes("ƏMƏLİYYAT"));
  ok("it is told not to rewrite everything", /Bütün materialı yenidən yazmağı planlaşdırma/.test(edit.system));
  ok("it keeps the existing title", /DƏYİŞMƏ/.test(edit.system));

  // "add examples to the second section" is unanswerable without the outline.
  ok("the current headings go with it", edit.prompt.includes("Faiz nədir") && edit.prompt.includes("Məsələlər"));
  ok("and how big the document is", edit.prompt.includes("3 blok"));
  ok("the teacher's words are carried", edit.prompt.includes("alman nümunələri"));
  ok("a creation is not given an outline", !create.prompt.includes("HAZIRKI BÖLMƏLƏR"));

  /*
   * The two plans mean opposite things and must not reach the writer with the same
   * sentence: on an edit those list items are OPERATIONS, and telling the writer
   * they are the document's sections would replace a 26-block handout with four
   * blocks named after the work.
   */
  const ctl = require("fs").readFileSync(require("path").join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  ok("the plan pass runs for edits too", /send\("phase", \{ phase: "plan", editing: hadBlocks \}\)/.test(ctl));
  ok("an edit hands the writer steps, not sections", /RAZILAŞDIRILMIŞ ADDIMLAR/.test(ctl));
  ok("a creation still hands it sections", /RAZILAŞDIRILMIŞ PLAN — bölmələr/.test(ctl));
  ok("and the two are chosen by hadBlocks", /hadBlocks\s*\?\s*`\$\{base\.prompt\}\\n\\nRAZILAŞDIRILMIŞ ADDIMLAR/.test(ctl));
}

console.log("\n13. The transcript shows what the model was given:");
{
  /*
   * Attaching a PDF and sending a message looked exactly like sending the message
   * alone, so the only way to find out whether the book had been read was to read
   * the answer and guess.
   */
  const ctl = require("fs").readFileSync(require("path").join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  /*
   * Only the NEWLY attached files, not every file the document holds. Stamping
   * the full list made one upload appear as two cards on the message, then three
   * — the model still receives them all, but the message shows what was attached
   * for it.
   */
  ok("both turns stamp the files onto the message", (ctl.match(/const sent = stagedFiles\(doc\);/g) || []).length === 2);
  ok("and only the ones not already carried by an earlier message", /already\.has\(f\.key\)/.test(ctl));
  ok("names and keys only — never the bytes", /key: f\.key, name: f\.name, mime: f\.mime/.test(ctl));
  ok("a turn with no attachment stays clean", /\.\.\.\(sent\.length \? \{ files: sent \} : \{\}\)/.test(ctl));

  const model = require("fs").readFileSync(require("path").join(__dirname, "../models/lessonDocModel.js"), "utf8");
  ok("the message schema can carry them", /files: \{ type: \[\{ _id: false, key: String, name: String, mime: String \}\]/.test(model));
}

console.log("\n14. The figure brief is specific enough to follow:");
{
  // Every rule here answers a defect seen in a real generated figure.
  ok("nothing outside the viewBox", S.BASE_RULES.includes("KƏSİLİR"));
  ok("no negative y for a title", S.BASE_RULES.includes("MƏNFİ y qiyməti YAZMA"));
  ok("a margin is demanded", /ən azı 16 vahid boş yer/.test(S.BASE_RULES));
  ok("every shape names its fill", S.BASE_RULES.includes("HƏR FİQURUN RƏNGİ AÇIQ YAZILIR"));
  ok("white on white is called out", S.BASE_RULES.includes("Ağ fonda ağ yazı"));
  ok("the drawing must match its caption", S.BASE_RULES.includes("DƏQİQLİK"));
  ok("href must resolve locally", S.BASE_RULES.includes("Xarici ünvana işarə edən href SİLİNİR"));
  ok("there is a worked example to copy", S.BASE_RULES.includes("<svg viewBox=\"0 0 320 120\""));
  ok("with a palette that matches the handout", S.BASE_RULES.includes("#2563eb"));
}


console.log("\n15. A response cut off by the token ceiling is salvaged, not discarded:");
{
  /*
   * Real production report: a 40-block edit, asked to add more from an attached
   * PDF, hit the token ceiling and came back "AI cavabı oxunmadı" — every block
   * the teacher had already watched stream in was thrown away because the FULL
   * response never became valid JSON. repairTruncatedJson recovers everything
   * that closed cleanly before the cut.
   */
  const A = require("../helper/aiDocument");

  const cut = (s, n) => s.slice(0, n);
  const full = JSON.stringify({
    title: "Faiz",
    reply: "Üç bölmə əlavə etdim.",
    blocks: [
      { kind: "heading", text: "Giriş", term: "", items: [], ordered: false, solution: "", columns: [], rows: [], tone: "info", svg: "" },
      { kind: "text", text: "Faiz hesablamaq üçün...", term: "", items: [], ordered: false, solution: "", columns: [], rows: [], tone: "info", svg: "" },
      { kind: "task", text: "100 manatın 20%-i neçədir?", term: "", items: [], ordered: false, solution: "20", columns: [], rows: [], tone: "info", svg: "" },
    ],
  });

  // Cut mid-way through the third block's "text" string — the exact shape a
  // token-ceiling cutoff produces.
  const midString = cut(full, full.indexOf("100 manat") + 4);
  const repaired = A.repairTruncatedJson(midString);
  ok("recovers a document object", repaired && typeof repaired === "object");
  ok("keeps the title", repaired?.title === "Faiz");
  ok("keeps the reply", repaired?.reply === "Üç bölmə əlavə etdim.");
  // The cut lands right after `"kind":"task"` closed but before its "text" did,
  // so the third block survives as a bare stub (kind only) — the repair layer is
  // schema-agnostic and does not know a task needs text. It IS the normaliser's
  // job to drop a block with nothing in it, checked next.
  ok("keeps the two blocks that fully closed before the cut, plus the open stub", repaired?.blocks?.length === 3);
  ok("does not invent the cut-off block's content", (repaired?.blocks || []).every((b) => !String(b.text || "").includes("100 manat")));

  const throughPipeline = S.normalizeDoc(repaired, { keepIds: [] });
  ok("the normaliser drops the content-less stub the teacher never saw finish", throughPipeline.blocks.length === 2);
  ok("and keeps the two the teacher actually watched arrive", throughPipeline.blocks.every((b) => b.text));

  // Cut cleanly at a container boundary — nothing to repair, JSON.parse alone
  // must succeed and no fabricated closers get appended.
  ok("a complete document needs no repair", JSON.parse(full).blocks.length === 3);

  // Cut before ANYTHING closed (e.g. truncated inside the very first string).
  ok("nothing safe to recover returns null, not a guess", A.repairTruncatedJson('{"title":"Fa') === null);

  // Non-JSON input (a refusal written as prose, an empty string) must not throw
  // and must not be mistaken for a document.
  ok("prose is refused, not salvaged", A.repairTruncatedJson("Bağışlayın, bunu edə bilmərəm.") === null);
  ok("empty input is refused", A.repairTruncatedJson("") === null);

  // parseDoc's own contract: truncated=true only when repair was actually used.
  const clean = JSON.stringify({ a: 1 });
  ok("parseDoc reports untruncated on a clean parse", A.parseDoc(clean).truncated === false);
  ok("parseDoc reports truncated when repair kicked in", A.parseDoc('{"a":1,"b":2').truncated === true);
  ok("parseDoc still throws when nothing is recoverable", (() => {
    try {
      A.parseDoc("{");
      return false;
    } catch (e) {
      return e.aiStatus === 502;
    }
  })());

  // The higher ceiling this repair was paired with.
  ok("the write pass has real headroom now, not 8000", A.DOC_MAX_TOKENS >= 32000);
}

console.log("\n16. Stop actually stops the bill, and salvages what streamed:");
{
  const fs2 = require("fs");
  const path2 = require("path");
  const ctl = fs2.readFileSync(path2.join(__dirname, "../controllers/lessonDocController.js"), "utf8");

  ok("the stream route aborts the upstream call on client disconnect", /req\.on\("close"/.test(ctl) && /ac\.abort\(\)/.test(ctl));
  ok("both the plan and write calls carry the signal", (ctl.match(/signal: ac\.signal/g) || []).length === 2);
  ok("an abort during planning does not fall through to the write pass", /if \(ac\.signal\.aborted\) throw e;/.test(ctl));
  ok("a stop is recorded as its own outcome, not a failure", /"Dayandırıldı/.test(ctl) && /action: "stopped"/.test(ctl));
  ok("a stop still tries to save whatever had streamed", /repairTruncatedJson\(lastSnapshot\)/.test(ctl));
  ok("salvaged content is saved through the same normaliser as a real turn", /next\?\.blocks\?\.length/.test(ctl));

  // documentWithClaude must actually forward the signal into the SDK call — the
  // whole point is that stopping in the browser stops the bill, not just the UI.
  const aiDoc = fs2.readFileSync(path2.join(__dirname, "../helper/aiDocument.js"), "utf8");
  ok("the Claude call is given the abort signal", /signal \? \{ signal \} : undefined/.test(aiDoc));
  ok("an abort during the Claude call surfaces as a stop, not a generic failure", /if \(signal\?\.aborted\) throw docError\(499/.test(aiDoc));
}


console.log("\n17. Nothing internal reaches the teacher (LS-010):");
{
  /*
   * The streamed failure path used to send `e?.userMessage || e?.message`. That
   * second fallback is a raw-egress channel with nothing in front of it, and it
   * cannot be caught by errorMiddleware because the 200 and the headers are long
   * gone by then. Whatever the exception happened to carry — a Mongo URI, a
   * provider body, a filesystem path — went into the teacher's toast.
   *
   * Canary-shaped, after tests/http/mail-redaction.test.js.
   */
  const path3 = require("path");
  const ctlPath = path3.join(__dirname, "../controllers/lessonDocController.js");
  delete require.cache[require.resolve(ctlPath)];
  const ctlSrc = require("fs").readFileSync(ctlPath, "utf8");

  ok("the raw-message fallback is gone from the SSE path", !/send\("failed",\s*\{\s*message:\s*e\?\.userMessage \|\| e\?\.message/.test(ctlSrc));
  ok("failures go through one curated funnel", /send\("failed", pub\)/.test(ctlSrc));

  // The funnel itself, exercised directly.
  const CANARY = "mongodb://secret-host/internal/path.js";
  const { publicFailure } = require("../controllers/lessonDocController");
  if (typeof publicFailure === "function") {
    const raw = publicFailure(new Error(CANARY));
    ok("an unknown error is reported generically", !JSON.stringify(raw).includes(CANARY));
    ok("and still carries a stable code", typeof raw.code === "string" && raw.code.length > 0);

    const { httpError } = require("../utils/appError");
    const curated = publicFailure(httpError(422, "source_unreadable", "Fayl oxunmadı."));
    ok("a curated AppError message survives", curated.message === "Fayl oxunmadı.");
    ok("with its own code", curated.code === "source_unreadable");

    // A docError from helper/aiDocument carries userMessage, not code.
    const docErr = new Error("anthropic 500: <html>internal</html>");
    docErr.userMessage = "AI xidməti cavab vermir.";
    docErr.aiStatus = 502;
    const fromDoc = publicFailure(docErr);
    ok("a provider error shows its curated line", fromDoc.message === "AI xidməti cavab vermir.");
    ok("and never the provider's own body", !JSON.stringify(fromDoc).includes("<html>"));
  } else {
    ok("publicFailure is exported for testing", false);
  }
}

console.log("\n18. A foreign material is indistinguishable from a missing one (LS-019):");
{
  const path3 = require("path");
  const ctlSrc = require("fs").readFileSync(path3.join(__dirname, "../controllers/lessonDocController.js"), "utf8");

  // 403-on-foreign vs 404-on-missing answers "does this id exist and belong to
  // someone" for anyone who can type a URL.
  ok("both answers come from one helper", /const missing = \(\) => httpError\(404, "doc_missing"/.test(ctlSrc));
  ok("a non-admin gets the missing answer for a foreign doc", /throw admin \? httpError\(403, "not_owner"[\s\S]{0,40}: missing\(\);/.test(ctlSrc));
  // A mistyped id used to throw a CastError and surface as a 500.
  ok("a malformed id is a 404, not a 500", /catch \{\s*throw missing\(\);/.test(ctlSrc));
}

console.log("\n19. A dropped source is never silently improvised over (LS-007):");
{
  const F = require("../helper/lessonDocFiles");
  const path3 = require("path");
  const ctlSrc = require("fs").readFileSync(path3.join(__dirname, "../controllers/lessonDocController.js"), "utf8");

  // toParts used to swallow an unreadable attachment with a console line, so the
  // model wrote from general knowledge in the same grounded-sounding voice.
  const shape = F.toParts([]);
  ok("toParts reports what it could not read", shape instanceof Promise);
  pending.push(shape.then((r) => {
    ok("it returns parts and the unreadable list", Array.isArray(r.parts) && Array.isArray(r.unreadable));
    ok("nothing attached means nothing unreadable", r.parts.length === 0 && r.unreadable.length === 0);

    // Calls only — the declaration has the same signature and must not be counted.
    ok("both turns check readability", (ctlSrc.match(/^\s+assertSourcesReadable\(doc, parts, unreadable\);$/gm) || []).length === 2);
    ok("a partial read warns rather than fails", /send\("source_warning", \{ unreadable \}\)/.test(ctlSrc));
    ok("nothing readable at all fails closed", /source_unreadable[\s\S]{0,200}oxunmadı/.test(ctlSrc));
    // It must be inside the try: the SSE headers are already sent by then, so a
    // throw past that point kills the socket with no terminal event.
    ok("the check runs inside the streamed try block", /try \{[\s\S]{0,600}assertSourcesReadable/.test(ctlSrc));
  }));
}



console.log("\n20. It reports what it actually read (the 'did it open my PDF?' question):");
{
  /*
   * A teacher asked directly whether the attached PDF was being read at all, and
   * the interface could not answer: the progress said "writing" whether the file
   * had been opened or invented around. The plan pass now reports, per file, what
   * it can see — a page count and a topic it could only know by looking.
   */
  const fs3 = require("fs");
  const path3 = require("path");

  ok("the plan schema carries a source report", Boolean(S.PLAN_SCHEMA.properties.sources));
  const req = S.PLAN_SCHEMA.properties.sources.items.required;
  ok("every source names the file", req.includes("name"));
  ok("says what was found in it", req.includes("found"));
  ok("and whether it could be read at all", req.includes("readable"));
  // Strict mode needs every property required, or the default OpenAI model 400s.
  assertStrict(S.PLAN_SCHEMA);
  ok("the plan schema is still strict-valid", true);

  // Vague reports are the failure mode: "PDF oxundu" proves nothing.
  ok("the brief refuses a vague report", S.PLAN_RULES.includes("Ümumi söz yazma"));
  ok("and shows what specific looks like", S.PLAN_RULES.includes("12 səhifə"));
  ok("an unreadable file must say so", S.PLAN_RULES.includes("readable=false"));
  ok("and gives the reason rather than inventing", S.PLAN_RULES.includes("SƏBƏBİ yaz"));
  ok("an off-topic file is called out", S.PLAN_RULES.includes("mövzuya AİD DEYİLSƏ"));

  // An edit reports on its sources too, or attaching a file mid-conversation
  // tells the teacher nothing.
  const editBrief = S.buildPlanPrompt({ doc: { blocks: [] }, instructions: "x", editing: true }).system;
  ok("the edit brief asks for the same report", editBrief.includes('"sources" SAHƏSİ'));

  const norm = S.normalizePlan({
    title: "t",
    sources: [
      { name: "a.pdf", found: "12 səhifə, faiz mövzusu", readable: true },
      { name: "b.pdf", found: "skan oxunmur", readable: false },
      { name: "", found: "" },
    ],
    sections: [{ heading: "h", why: "w" }],
  });
  ok("a readable source survives normalisation", norm.sources[0].readable === true);
  // The most useful line on the whole report is the one that says it failed.
  ok("an UNREADABLE one is kept, not dropped", norm.sources.some((x) => x.readable === false));
  ok("empty rows are dropped", norm.sources.length === 2);
  ok("a plan with no sources is fine", S.normalizePlan({ title: "t", sections: [] }).sources.length === 0);

  const ctl3 = fs3.readFileSync(path3.join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  ok("the report is streamed before the plan", /send\("sources"[\s\S]{0,200}send\("plan"/.test(ctl3));
}


console.log("\n21. 'Copy this form exactly' must not become a tutorial about the form:");
{
  /*
   * A teacher attached a blank lesson-plan form and asked, in Azerbaijani, to
   * reproduce it exactly: "hər şeyi eyni, nə var o formada, köçür, heç nəyi
   * dəyişmə". What came back was a GUIDE explaining what each field means, with
   * invented sample values — a teacher's name, a room number, a date in March —
   * and two examples and two tasks bolted on.
   *
   * The model was not disobeying. The brief made the job impossible: it opened by
   * declaring the output is "given to the student", and then listed as MANDATORY
   * that the structure be intro → concepts → examples → tasks and that there be
   * at least one example and one task. A blank teacher's form is none of those
   * things, so the only way to satisfy the rules was to write something else.
   *
   * These assertions pin the resolution: the teaching-material shape is scoped to
   * requests that ask for new material, and a copy request outranks it.
   */

  // The shape rules must no longer be unconditional.
  ok("the teaching arc is scoped to new material", S.BASE_RULES.includes("YENİ MATERİAL YARADARKƏN"));
  ok("and says so where it used to be absolute", S.BASE_RULES.includes("YALNIZ SIFIRDAN MATERİAL ÜÇÜNDÜR"));
  ok("a copy request outranks them", S.BASE_RULES.includes("KÖÇÜRMƏ REJİMİ qaydaları bunlardan ÜSTÜNDÜR"));
  ok("adding examples to a copy is forbidden", S.BASE_RULES.includes("nümunə və tapşırıq\nəlavə etmək QADAĞANDIR"));

  // The trigger has to match how a teacher actually writes, not one phrasing.
  const triggers = ["köçür", "olduğu kimi", "dəyişmə", "bu formanı hazırla", "bu şablonu yarat"];
  ok("the copy triggers cover real phrasings", triggers.every((t) => S.SOURCE_RULES.includes(t)));
  // The reported request was ambiguous-ish; ambiguity must not default to inventing.
  ok("ambiguity defaults to copying, not inventing", S.SOURCE_RULES.includes("Şübhə varsa"));

  // The specific defects in the output that was produced.
  ok("no explanations may be added", S.SOURCE_RULES.includes("ƏLAVƏ ETMƏ"));
  ok("no invented names or dates", S.SOURCE_RULES.includes("uydurduğun adla, tarixlə"));
  ok("a blank form stays blank", S.SOURCE_RULES.includes("BOŞ FORMA BOŞ QALIR"));
  ok("with the bad case spelled out", S.SOURCE_RULES.includes("Əliyeva Aygün"));
  ok("a table stays a table", S.SOURCE_RULES.includes("sadalamaya çevirmə"));
  ok("field labels keep their own language", S.SOURCE_RULES.includes("ingiliscə qalsın"));

  /*
   * The planning pass is the other half of the failure. It forced 3–6 sections,
   * and the writer is then held to exactly those ("bölmələr məhz bunlar
   * olmalıdır") — so even a writer that understood the copy request would have
   * been constrained back into an invented structure.
   */
  ok("the plan pass knows about copying too", S.PLAN_RULES.includes("KÖÇÜRMƏ İSTƏYİ İSTİSNADIR"));
  ok("and drops its section count for it", S.PLAN_RULES.includes("3–6 məhdudiyyəti burada keçərli deyil"));
  ok("and must not invent its own sections", S.PLAN_RULES.includes("Öz bölməni"));

  // Fabrication was already banned in general; it now names what was fabricated.
  ok("inventing a name is banned by name", S.BASE_RULES.includes("uydurma ad"));
}


console.log("\n22. A blank form survives — the empty cell IS the content:");
{
  /*
   * The second half of the copy-a-form failure, and this one was ours, not the
   * model's. Table cells went through `list()`, which ends in `.filter(Boolean)`:
   * right for a bullet list, where an empty bullet is noise, and catastrophic for
   * a grid. A blank form is almost entirely empty cells, so every value cell was
   * deleted, the surviving labels slid into the wrong columns, and any row that
   * was blank across was dropped whole — taking the table with it, because a
   * table with no rows is not stored.
   *
   * The teacher asked for their lesson-plan form back and got a flat list of
   * field names. The model had almost certainly sent the tables; this discarded
   * them.
   */
  const formBlock = (columns, rows) =>
    full({ kind: "table", columns, rows });

  const { blocks } = S.normalizeDoc({
    title: "Lesson Plan",
    blocks: [
      formBlock(["Teacher:", "Observer:", "Date and Time:"], [["", "", ""]]),
      formBlock(["Procedure", "Phase", "Timing", "Interaction"], [["", "", "", ""], ["", "", "", ""]]),
      formBlock(["Context:"], [[""]]),
    ],
  });

  ok("an all-empty form row keeps its table", blocks.length === 3, `${blocks.length} of 3 survived`);
  ok("the empty cells are still there", blocks[0].rows[0].length === 3);
  ok("and are empty, not dropped", blocks[0].rows[0].every((c) => c === ""));
  ok("a multi-row grid keeps every row", blocks[1].rows.length === 2);
  ok("a single-field table survives", blocks[2].columns[0] === "Context:");

  // A ragged grid renders as a broken one, so rows are squared to the header.
  const ragged = S.normalizeDoc({
    blocks: [formBlock(["A", "B", "C"], [["1"], ["1", "2", "3", "4"]])],
  }).blocks[0];
  ok("a short row is padded to the header width", ragged.rows[0].length === 3);
  ok("and keeps its real cell in the right column", ragged.rows[0][0] === "1" && ragged.rows[0][1] === "");
  ok("an overlong row is trimmed", ragged.rows[1].length === 3);

  // Cells still get cleaned, just not deleted.
  const messy = S.normalizeDoc({ blocks: [formBlock(["A", "B"], [["  x  ", "  "]])] }).blocks[0];
  ok("cell text is trimmed", messy.rows[0][0] === "x");
  ok("a whitespace-only cell becomes empty, not missing", messy.rows[0][1] === "");

  // A table with nothing to head it is still not a table.
  ok("no columns means no table", S.normalizeDoc({ blocks: [formBlock([], [["a"]])] }).blocks.length === 0);
  ok("blank headers mean no table", S.normalizeDoc({ blocks: [formBlock(["", ""], [["a", "b"]])] }).blocks.length === 0);
  ok("no rows means no table", S.normalizeDoc({ blocks: [formBlock(["A"], [])] }).blocks.length === 0);

  // A model that loops must not write a document nobody can open.
  const flood = S.normalizeDoc({
    blocks: [formBlock(["A"], Array.from({ length: 500 }, () => [""]))],
  }).blocks[0];
  ok("a runaway row count is capped", flood.rows.length <= 80, `${flood.rows.length} rows`);

  /*
   * And it has to PRINT as a form. An empty <td> collapses to a hair line in both
   * renderers, so the teacher would get labels with nowhere to write.
   */
  const doc = { title: "F", blocks: [{ id: "1", kind: "table", columns: ["Teacher:", "Observer:"], rows: [["", ""]] }] };
  const pdf = buildLessonDocHtml(doc);
  const word = buildLessonDocHtml(doc, { forWord: true });
  ok("the PDF gives an empty cell a line box", (pdf.match(/&nbsp;/g) || []).length >= 2);
  ok("so does Word", (word.match(/&nbsp;/g) || []).length >= 2);
  ok("a filled cell is unaffected", buildLessonDocHtml({ blocks: [{ id: "1", kind: "table", columns: ["A"], rows: [["real"]] }] }).includes("real"));

  // The brief has to ask for a table, or the model writes headings and text and
  // there is no grid to preserve in the first place.
  ok("a form is specified as a table block", S.SOURCE_RULES.includes("FORMA/ŞABLON KÖÇÜRƏNDƏ"));
  ok("with headings explicitly refused", S.SOURCE_RULES.includes('"heading" və "text" bloklarının siyahısı kimi'));
  ok("and a worked example of the shape", S.SOURCE_RULES.includes('"rows": [["", "", ""]]'));
}

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} lesson-doc assertions failed`);
  process.exit(failed ? 1 : 0);
});
