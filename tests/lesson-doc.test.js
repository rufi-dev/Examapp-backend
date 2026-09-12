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
  // An edit now sends only the changed fragments, so the instruction about
  // untouched text moved: it applies to the write_material fallback, and the
  // stronger rule is that untouched text is not sent at all.
  ok("and says to leave everything else identical", /hərfi-hərfinə eyni olsun/.test(edit.system));
  ok("it is told to patch, not to rewrite", /edit_material İŞLƏT/.test(edit.system));
  ok("and that untouched text stays put by itself", /Toxunulmayan mətni ümumiyyətlə göndərmə/.test(edit.system));
  ok("and forbids a rewrite", /YENİDƏN YAZMA/.test(edit.system));
  /*
   * The attachment stays on the document for its whole life, so on turn ten it is
   * still there — and being told the file is what to reproduce is what made an
   * edit rebuild the document from the PDF and throw the last two turns away.
   */
  /*
   * Replaced, deliberately. That line stopped an OLD attachment causing a
   * rebuild and then stopped a NEW one being used at all — see the fresh-file
   * rules below. What survives is the true half: files already on the document
   * are background unless the model goes and reads one.
   */
  ok("an attachment from an earlier turn stays in the background",
    /read_source ilə oxu/.test(edit.system));

  // The real failure: an html document sent NOTHING, because only blocks were
  // serialised. The model cannot preserve what it was never shown.
  const htmlEdit = S.buildEditPrompt({
    doc: { topic: "Kəsrlər", html: "<h2>Bölmə</h2><p>qalmalıdır</p>" },
    instructions: "boş sətirləri sil",
  });
  ok("an html document is sent whole", htmlEdit.prompt.includes("<p>qalmalıdır</p>"));
  ok("and named as the thing being changed", /DƏYİŞDİRİLƏCƏK SƏNƏD BUDUR/.test(htmlEdit.prompt));

  const fs = require("fs");
  const path = require("path");
  const ctl = fs.readFileSync(path.join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const svcSrc = fs.readFileSync(path.join(__dirname, "../services/lessonDocService.js"), "utf8");
  // A provider timeout must not lose what the teacher typed: they should reopen
  // the page and find their own words with a failure beside them.
  // One route now (LS-R3-004): the message is appended before the plan pass.
  ok("the teacher's message is stored before the model runs", ctl.indexOf('role: "user",') > 0 && ctl.indexOf('role: "user",') < ctl.indexOf("await runDocument({"));
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
  /*
   * The bytes are sent ONCE, on the turn they are attached — this asserted the
   * opposite, that every turn resends every file the document has ever held. That
   * cost a teacher a re-upload of their textbook page on every later message, and
   * kept handing the model a source, with source instructions attached, on turns
   * that were about the document. What has to survive is the knowledge that the
   * file was sent, and that is what the transcript carries.
   */
  ok("the turn sends this turn's attachments", (ctl.match(/toParts\(sending\)/g) || []).length === 1);
  ok("and nothing resends the whole file list", !/toParts\(doc\.files/.test(ctl));
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
  ok("and how big the document is", edit.prompt.includes("3 hissə"));
  // Counted from whichever shape the document has, or an html document reports
  // itself as empty to the pass that is meant to be planning changes to it.
  ok("an html document reports its real size",
    S.buildPlanPrompt({ doc: { html: "<h2>A</h2><p>b</p><table><tr><td>c</td></tr></table>" }, instructions: "x", editing: true }).prompt.includes("3 hissə"));
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
  ok("the turn stamps the files onto the message", (ctl.match(/const sent = stagedFiles\(doc\);/g) || []).length === 1);
  /*
   * Staging asked the transcript — "has this key been mentioned yet?" — and a key
   * is a content hash, so re-uploading a page the document already held answered
   * "yes, long ago" and the upload did nothing. The teacher's file went up and no
   * card appeared, and the only way to reuse a page was to never have used it.
   * The file carries its own staging now.
   */
  ok("staging is a property of the file", /\.filter\(\(f\) => f\.stagedAt\)/.test(ctl));
  ok("not a gap in the transcript", !/already\.has\(f\.key\)/.test(ctl));
  ok("attaching a file the document already holds stages it again", /svc\.stageFile\(doc\._id, doc\.owner, saved\.key\)/.test(ctl));
  ok("a new attachment arrives staged", /push: \{ files: \{ \.\.\.saved, stagedAt: new Date\(\) \} \}/.test(ctl));
  ok("and a turn takes them with it", (ctl.match(/svc\.clearStaged\(doc\._id, doc\.owner,/g) || []).length === 1);
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
  ok("salvaged content is sanitised like a real turn's", /sanitizeDocHtml\(repaired\.html\)/.test(ctl));

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
  /*
   * This used to pin the exact ternary `throw admin ? httpError(403, …) : missing()`.
   * That line sat INSIDE `if (!admin && …)`, so its 403 half could never run —
   * the test was holding unreachable code in place, under a name describing
   * behaviour the reachable half already provided.
   *
   * So assert the guarantee instead of the spelling: the ownership guard throws
   * `missing()`, and no "not_owner" answer exists anywhere in the controller to
   * distinguish a foreign material from an absent one.
   */
  ok(
    "a non-admin gets the missing answer for a foreign doc",
    /if \(!admin && String\(doc\.owner\) !== String\(req\.user\._id\)\) throw missing\(\);/.test(ctlSrc)
  );
  ok("and no 403 tells them the material exists", !/not_owner/.test(ctlSrc));
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
    ok("the turn checks readability", (ctlSrc.match(/^\s+assertSourcesReadable\(sending, parts, unreadable\);$/gm) || []).length === 1);
    /*
     * Asked about THIS turn's attachments, not the document's whole file list.
     * Attachments live on the document forever, so against that list a turn that
     * attaches nothing looks exactly like a turn whose every source failed to
     * read — and the check would refuse to run at all.
     */
    ok("only this turn's attachments are sent to the model",
      /const sending = \(doc\.files \|\| \[\]\)\.filter\(/.test(ctlSrc) && /sent\.some\(\(x\) => x\.key === f\.key\)/.test(ctlSrc));
    ok("and the readability check counts the same set", /const attached = sending\.length;/.test(ctlSrc));
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
  ok("the report is streamed before the plan", /send\("sources"[\s\S]{0,2400}send\("plan"/.test(ctl3));
  /*
   * And written down. The file itself travels only when the model asks for it,
   * so without this its knowledge of the source lasted exactly one turn: the
   * design it studied on turn one was gone by turn three, and "make it like the
   * PDF" was being asked of something that had never seen a PDF.
   */
  ok("what it read is kept the first time", /!\(doc\.sourceNotes \|\| \[\]\)\.length/.test(ctl3));
  /*
   * Saved the moment they are read, not with the document.
   *
   * They used to be written only on the path where a document got written — so
   * the turn that read ÇEVRƏ.pdf and answered by changing a print setting threw
   * away everything it had learned, and the next turn had neither the file nor a
   * note about it. Reading is what happened; what the model did next does not
   * change that.
   */
  ok("what was read is saved as soon as it is read",
    /\$set: \{ sourceNotes: notesToKeep \}/.test(ctl3));
  ok("and not only when a document is written",
    !/\.\.\.\(notesToKeep\?\.length \? \{ sourceNotes/.test(ctl3));
  /*
   * And the files keep travelling until something HAS read them: a first draft
   * that answers with a settings change must not cost the teacher their source.
   */
  ok("an unread source is sent again", /const neverRead = !\(doc\.sourceNotes \|\| \[\]\)\.length;/.test(ctl3));
  ok("and stops being sent once it has been read",
    /\(f\) => neverRead \|\| sent\.some\(\(x\) => x\.key === f\.key\)/.test(ctl3));
  ok("then carried on every later prompt",
    S.sourceList({ files: [{ name: "a.pdf" }], sourceNotes: [{ name: "page 1", found: "şaquli gün adları" }] })
      .includes("şaquli gün adları"));
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


console.log("\n23. The agent acts through tools, so it cannot fake a capability:");
{
  /*
   * Asked to add page numbers, the model wrote "Səhifə 1" and "Səhifə 2" into the
   * document as text blocks. Numbers that cannot be right — a block does not know
   * which page it lands on — and stale after the next edit.
   *
   * The instinctive fix is a rule: "never write page markers". That is the wrong
   * shape of fix and it scales the wrong way: the prompt grows by one prohibition
   * per discovered mistake, each one is a rule the model can forget, and the real
   * gap stays open — there was no way to express the thing being asked for. The
   * model had exactly one output shape, document content, so every request that
   * was not about content still had to come out as content.
   *
   * The fix is a capability, not a prohibition.
   */
  const fs4 = require("fs");
  const path4 = require("path");

  const names = S.DOC_TOOLS.map((t) => t.name);
  ok("there is a tool for content", names.includes("write_material"));
  ok("and a separate one for how it prints", names.includes("set_print_options"));

  const print = S.DOC_TOOLS.find((t) => t.name === "set_print_options");
  ok("the print tool cannot touch content", !JSON.stringify(print.input_schema.properties).includes("blocks"));
  ok("it carries the page-number switch", print.input_schema.properties.pageNumbers.type === "boolean");
  ok("and a sentence for the teacher", Boolean(print.input_schema.properties.reply));
  // Strict mode: every property required, or the call is rejected outright.
  assertStrict(print.input_schema);
  ok("the print tool's schema is strict-valid", true);

  const write = S.DOC_TOOLS.find((t) => t.name === "write_material");
  assertStrict(write.input_schema);
  ok("the write tool's schema is strict-valid", true);
  ok("the write tool is told not to run for a non-content change", write.description.includes("ÇAĞIRMA"));

  /*
   * The prohibition is GONE from the brief. That is the point of the change: the
   * rule is not needed once the capability exists, and leaving it would be the
   * habit this was meant to break.
   */
  ok("no page-number prohibition in the brief", !S.BASE_RULES.includes("SƏHİFƏ NÖMRƏSİ YAZMA"));

  const ctl4 = fs4.readFileSync(path4.join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  ok("the turn runs through the tool path", /runTools\(\{/.test(ctl4));
  // A settings change must not rewrite the document: that is what makes it instant
  // and what stops a print tweak from mangling the content on the way past.
  ok("a settings-only turn commits only the setting", /if \(printed && !wrote\)/.test(ctl4));
  ok("and writes no blocks", /svc\.commit\([\s\S]{0,120}printOptions\(printed\.input\)/.test(ctl4));
  // A tool input is model output: what reaches document state is read off it
  // deliberately, never spread, and an unknown accent is ignored rather than stored.
  ok("only known options reach the document", /ACCENTS\[input\.accent\]/.test(ctl4));
  ok("a turn that calls nothing says so instead of inventing", /action: \"noop\"/.test(ctl4));

  // The renderer has to honour it, or the setting is decoration.
  ok("the export reads the setting", /pageNumbers: doc\.settings\?\.pageNumbers !== false/.test(ctl4));

  const pdf = fs4.readFileSync(path4.join(__dirname, "../helper/lessonPlanPdf.js"), "utf8");
  ok("the renderer can turn the footer off", /footerTemplate: pageNumbers \? footerFor\(footerLabel\) : \"<div><\/div>\"/.test(pdf));
  /*
   * displayHeaderFooter must stay true even with numbers off: switching it off
   * hands the page back to Chromium's own header and footer — the date, the title
   * and the file URL — which is the exact thing this renderer exists to remove.
   */
  ok("and never by handing the sheet back to Chromium", /displayHeaderFooter: true/.test(pdf));

  const model4 = fs4.readFileSync(path4.join(__dirname, "../models/lessonDocModel.js"), "utf8");
  ok("the setting is real state on the document", /settings: \{[\s\S]{0,120}pageNumbers/.test(model4));
  ok("and defaults to on, as it always printed", /pageNumbers: \{ type: Boolean, default: true \}/.test(model4));
}

console.log("\n24. The export is the preview, not a branded copy of it:");
{
  /*
   * The PDF opened with "EXAMOPIA" and "DƏRS MATERİALI" stamped across the top —
   * words that appear nowhere in the preview beside it, on a document a teacher
   * hands to a methodologist as their own work. And it was drawn in a teal palette
   * the app does not use anywhere, so the preview was a decoration rather than a
   * promise about what would print.
   */
  const doc = { title: "Dərs", blocks: [{ id: "1", kind: "heading", text: "Bölmə" }] };
  const pdf = buildLessonDocHtml(doc);
  const word = buildLessonDocHtml(doc, { forWord: true });

  ok("no brand line in the PDF", !pdf.includes("brandline") && !pdf.includes("Examopia"));
  ok("no document-type stamp either", !pdf.includes("Dərs materialı</span>"));
  ok("the masthead rules went with it", !pdf.includes("masthead"));

  // The app's own tokens, resolved to hex — --primary 68 92 202 is #445CCA.
  ok("the PDF uses the app's primary", pdf.includes("#445CCA"));
  ok("and its text colour", pdf.includes("#222631"));
  ok("Word matches the same palette", word.includes("#445CCA"));
  ok("the old teal identity is gone from both", !pdf.includes("0F4C5C") && !word.includes("0F4C5C"));

  const pdfSrc = require("fs").readFileSync(require("path").join(__dirname, "../helper/lessonPlanPdf.js"), "utf8");
  ok("a material's footer can carry no product name", /label \? `<span>Examopia · \$\{label\}<\/span>` : \"\"/.test(pdfSrc));
}


console.log("\n25. The model writes the document; the schema stops being the ceiling:");
{
  /*
   * The document was nine block kinds, and everything a teacher asked for had to
   * be expressible in those nine or it could not be built. A blank lesson-plan
   * form — merged cells, a Procedure grid, empty fields to write in — is not
   * expressible in them, so asking for one back produced a flat list of field
   * names, and every fix was another negotiation with the schema.
   *
   * The model now writes the document as HTML and this sanitises it. The gain is
   * not only fidelity: the SAME string renders on screen, into the PDF and into
   * Word, so the preview stops being a second rendering that can disagree with
   * the file.
   */
  const { sanitizeDocHtml, droppedStyles } = require("../helper/lessonDocSanitize");

  // The form that could not be built before.
  const form =
    '<table><tr><th colspan="3">Lesson Plan</th></tr>' +
    '<tr><td style="width:33%;border:1pt solid #333">Teacher:</td><td></td><td></td></tr>' +
    "<tr><td colspan=\"3\">Context:</td></tr></table>";
  const clean = sanitizeDocHtml(form);
  ok("a table survives", clean.includes("<table>"));
  ok("merged cells survive", clean.includes('colspan="3"'));
  ok("column widths survive", clean.includes("width:33%"));
  ok("cell borders survive", clean.includes("border:1pt solid"));
  ok("an empty field cell is kept", /<td><\/td>/.test(clean));

  /*
   * IT IS UNTRUSTED MARKUP: it reaches the page through dangerouslySetInnerHTML
   * and Chromium through a renderer with network access, so what this allows IS
   * the security boundary.
   */
  const attacks = {
    script: "<p>ok</p><script>alert(1)</script>",
    handler: '<p onclick="alert(1)">x</p>',
    iframe: '<iframe src="http://evil"></iframe>',
    link: '<a href="http://evil">x</a>',
    image: '<img src="http://evil/track.png">',
    styleUrl: '<p style="background-image:url(http://evil)">x</p>',
    expression: '<p style="width:expression(alert(1))">x</p>',
    importCss: '<style>@import url(http://evil)</style><p>x</p>',
    object: '<object data="http://evil"></object>',
    form: '<form action="http://evil"><input name="p"></form>',
    svgScript: '<svg viewBox="0 0 1 1"><script>alert(1)</script><circle r="1"/></svg>',
    svgHandler: '<svg viewBox="0 0 1 1"><circle r="1" onload="alert(1)"/></svg>',
    svgExternal: '<svg viewBox="0 0 1 1"><use href="https://evil/x#a"/></svg>',
  };
  for (const [name, html] of Object.entries(attacks)) {
    const out = sanitizeDocHtml(html);
    ok(`${name} cannot survive`, !/evil|alert|expression|@import|<script|<iframe|<object|<form|<input|onclick|onload|href=|src=/i.test(out), out.slice(0, 60));
  }

  // A drawing must still draw: the SVG rules own SVG, and the HTML pass must not
  // strip the shapes on its way past.
  const fig = sanitizeDocHtml('<figure><svg viewBox="0 0 10 10"><circle r="4" fill="#445CCA"/></svg><figcaption>Şəkil</figcaption></figure>');
  ok("a figure keeps its drawing", fig.includes("<circle") && fig.includes("viewBox"));
  ok("and its caption", fig.includes("Şəkil"));

  /*
   * A blank form came back with a non-breaking space in every empty cell — the
   * model's way of stopping the cells collapsing — and every one of them DREW, as
   * a hex box reading "A0", in a font with no glyph for it. The document was
   * right; it was unrenderable. Spacers are not the document's job, so the cells
   * take their height from CSS in all three renderers instead.
   */
  const spaced = sanitizeDocHtml("<table><tr><td> </td><td>Mət​n</td></tr></table>");
  ok("a non-breaking space cannot reach the document", !/ /.test(spaced));
  ok("neither can a zero-width space, which also breaks copy-paste", !/[​﻿­]/.test(spaced));
  ok("and the word it was hiding inside survives whole", spaced.includes("Mətn"));
  ok("an empty cell is still a cell", /<td>\s*<\/td>/.test(spaced));

  ok("empty input is refused", sanitizeDocHtml("") === "" && sanitizeDocHtml(null) === "");
  // A handout, not a book: past this something upstream has gone wrong.
  ok("an absurdly large document is refused", sanitizeDocHtml("<p>x</p>".repeat(80000)) === "");

  // The renderers take the model's html, and old documents keep working.
  const doc = { title: "T", html: "<h2>Bölmə</h2><table><tr><td>a</td></tr></table>" };
  const pdf = buildLessonDocHtml(doc);
  const word = buildLessonDocHtml(doc, { forWord: true });
  ok("the PDF is built from the model's html", pdf.includes("<h2>Bölmə</h2>"));
  ok("and so is Word — the same string", word.includes("<h2>Bölmə</h2>"));
  ok("a document written before this still renders from blocks",
    buildLessonDocHtml({ title: "x", blocks: [{ id: "1", kind: "heading", text: "H" }] }).includes("<h2>H</h2>"));

  const ctl5 = require("fs").readFileSync(require("path").join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  // Sanitised BEFORE the write, so nothing unsafe is ever at rest and no reader
  // has to re-check what the database holds.
  /*
   * Every "does this document have anything in it" test in the controller asked
   * about blocks, so an html document answered "no" to all of them at once: the
   * turn was planned as a first draft, the copy rules fired again on an
   * attachment from ten turns ago, the transcript said "created", and the export
   * refused a finished document as empty.
   */
  ok("the turn asks the document, not its blocks", /const hadBlocks = S\.countParts\(doc\) > 0/.test(ctl5));
  ok("export asks the same question", /if \(!S\.countParts\(doc\)\) \{/.test(ctl5));
  // Scoped to a first draft OR a turn the teacher attached something to — the
  // case that made "copy this exactly" do nothing at all.
  ok("copy mode is scoped to a first draft or a fresh attachment",
    /if \(parts\.length && \(freshFiles \|\| !hadBlocks\)\) \{/.test(ctl5));
  ok("and no block count is left deciding content exists", !/\(doc\.blocks \|\| \[\]\)\.length[^;]*\?|!\(doc\.blocks \|\| \[\]\)\.length/.test(ctl5));

  /*
   * "Create an exact duplicate" produced the attached timetable under a heading
   * and an invented "Müəllimlər üçün" subtitle — neither of which is in the file.
   * They were ours: the renderer printed the stored title and audience above
   * every document. A document the model wrote is the whole document.
   */
  const dup = buildLessonDocHtml({ title: "Timetable", audience: "Müəllimlər üçün", html: "<h2>2026/2027</h2>" });
  ok("nothing is printed above a document the model wrote", !dup.includes("<h1>Timetable</h1>") && !dup.includes("Müəllimlər üçün"));
  ok("and the document itself is untouched", dup.includes("<h2>2026/2027</h2>"));
  ok("a block document keeps the masthead it was designed with",
    buildLessonDocHtml({ title: "Kəsrlər", blocks: [{ id: "1", kind: "text", text: "a" }] }).includes("<h1>Kəsrlər</h1>"));
  ok("so the model is told the heading is its job", /SƏNƏDİN BAŞLIĞINI ÖZÜN YAZIRSAN/.test(S.BASE_RULES));

  // A serif source reproduced in our sans is not a duplicate — but a font name is
  // still a style value, and style values may never reach the network.
  ok("a font can be named", sanitizeDocHtml('<p style="font-family:Times New Roman, serif">x</p>').includes("font-family"));
  ok("but not fetched", !/url|evil/i.test(sanitizeDocHtml('<p style="font-family:url(http://evil)">x</p>')));

  /*
   * The chat was a series of first meetings: one instruction, no transcript. So
   * "make it shorter" had nothing to resolve "it" against, "put that back" could
   * not be answered at all, and the model could not tell that the document in
   * front of it was its own work from two turns ago rather than something to
   * replace. Bounded on purpose — the last few exchanges carry the intent, the
   * document carries the state.
   */
  const chatty = {
    html: "<h2>A</h2>",
    messages: [
      { role: "user", text: "bu faylı köçür", files: [{ name: "4750.pdf" }] },
      { role: "assistant", text: "Köçürdüm." },
      { role: "user", text: "rəngi qırmızı et" },
      { role: "assistant", text: "Etdim." },
    ],
  };
  const withHistory = S.buildEditPrompt({ doc: chatty, instructions: "boşluqları saxla" });
  ok("an edit carries what was said before", /ƏVVƏLKİ SÖHBƏT/.test(withHistory.prompt));
  ok("in both voices", /MÜƏLLİM:/.test(withHistory.prompt) && /SƏN:/.test(withHistory.prompt));
  /*
   * The file itself is no longer resent, so the transcript is the only thing that
   * can answer "the file I sent earlier" — it has to name it.
   */
  ok("and names an attachment the bytes of which are not resent", withHistory.prompt.includes("4750.pdf"));
  ok("a document with nothing said yet gets no transcript",
    !/ƏVVƏLKİ SÖHBƏT/.test(S.buildEditPrompt({ doc: { html: "<p>x</p>", messages: [{ role: "user", text: "a" }] }, instructions: "b" }).prompt));
  ok("history is bounded", S.historyOf({ messages: Array.from({ length: 60 }, (_, i) => ({ role: "user", text: `m${i}` })) }).split("\n").length <= 13);

  /*
   * Sent "continue" with nothing left to continue, the model appended two blank
   * tables nobody had asked for to a document that was meant to be an exact copy
   * of a file. It was not being careless: write_material and set_print_options
   * were the entire vocabulary, so guessing was the only move it could express.
   */
  const ask = S.DOC_TOOLS.find((t) => t.name === "ask_teacher");
  ok("the model can ask instead of guessing", Boolean(ask));
  ok("and asking takes nothing but a question", Object.keys(ask.input_schema.properties).join() === "question");
  ok("a question leaves the document alone", /if \(asked && !wrote && !printed\) \{/.test(ctl5));
  ok("and is not committed as a document change", /action: "asked"/.test(ctl5));

  /*
   * A timetable copied out of a black-and-white PDF came back with blue,
   * uppercased month names — our table house style, applied to a document the
   * model wrote. In that teacher's source a coloured date marks a holiday, so the
   * colour did not merely look wrong: it said something the file does not say.
   */
  const copied = buildLessonDocHtml({ title: "T", html: "<table><tr><th>September</th></tr></table>" });
  ok("a copied table is not recoloured or capitalised", /text-transform:none/.test(copied) && /color:inherit/.test(copied));
  ok("a block document keeps the house table style",
    !/text-transform:none/.test(buildLessonDocHtml({ title: "T", blocks: [{ id: "1", kind: "text", text: "a" }] })));

  /*
   * Sending every attachment on every turn was wasteful and kept pushing "copy
   * the file" at turns that were about the document, so it stopped. Right for
   * edits, quietly disastrous for copies: asked on turn twelve to match the PDF
   * exactly, the model no longer had the PDF — what it had were the teacher's
   * screenshots OF OUR OWN PREVIEW, so it copied our rendering back to us and
   * reported it as matching the source. The file was on the document the whole
   * time. Now the model can ask for it.
   */
  const read = S.DOC_TOOLS.find((t) => t.name === "read_source");
  ok("the model can fetch a source it was given earlier", Boolean(read));
  ok("by name", read.input_schema.required.join() === "name");
  /*
   * And optionally by page. Without this the whole file came every read — a
   * twelve-page scan for a turn that needed three pages of it.
   */
  ok("and optionally by page", Boolean(read.input_schema.properties.pages));
  ok("pages stay optional", !read.input_schema.required.includes("pages"));
  ok("the description says an omitted range means the whole file",
    /Boş buraxsan bütün fayl göndərilir/.test(read.input_schema.properties.pages.description));
  ok("and the prompt tells it which names exist",
    S.sourceList({ files: [{ name: "4750.pdf" }] }).includes("4750.pdf"));
  ok("saying plainly that they are not sent automatically",
    /read_source ilə oxu/.test(S.sourceList({ files: [{ name: "a.pdf" }] })));
  ok("a document with no files says nothing", S.sourceList({}) === "");
  ok("the turn can serve one", /fetchSource: async \(name, pages\) =>/.test(ctl5));
  /*
   * And it tells the model what it actually served. A teacher's scan is numbered
   * by its PRINTED pages ("с. 22-33") on a file that holds twelve, so a request
   * for page 22 is reasonable and needs the count back, not a refusal.
   */
  ok("the reply names the pages sent", /səhifəsi aşağıda göndərildi/.test(ctl5));
  ok("and the file's real page count", /Bu faylda cəmi \$\{got\.total\} səhifə var/.test(ctl5));
  ok("an impossible page is an error, not a silent whole-file send", /isError: true,/.test(ctl5));
  ok("from the document's own list only", /const all = doc\.files \|\| \[\];/.test(ctl5));
  /*
   * The loop moved out of aiDocument when the same conversation had to run on
   * three providers: one driver that knows what a turn is, three adapters that
   * know what a provider wants. These facts are about the turn, so they are read
   * from the driver.
   */
  const ai = require("fs").readFileSync(require("path").join(__dirname, "../helper/aiDocDrivers.js"), "utf8");
  const adapters = require("fs").readFileSync(require("path").join(__dirname, "../helper/aiDocAdapters.js"), "utf8");
  // Served as the real file, not as text describing it — a description of a page
  // is exactly what produced a copy of our preview instead of a copy of the PDF.
  ok("and sends the file itself back", /files\.push\(found\.part\)/.test(ai) && /claudeContentParts\(parts\)/.test(adapters));
  ok("bounded, and not out of the budget for fixing a table", /reads < MAX_READS/.test(ai) && /attempt -= 1; \/\/ a fetch is not a failed attempt/.test(ai));

  /*
   * The most distinctive thing about the timetable is that the day names run
   * vertically up the left-hand column. The model may well have written that;
   * the allow-list deleted it and said nothing, so from where the model stood the
   * instruction had simply been carried out. It would write the same thing again
   * next turn and the copy would come back flat a second time, with both sides
   * sure they had done the work.
   */
  const rot = sanitizeDocHtml('<table><tr><td style="writing-mode:vertical-rl;transform:rotate(180deg)">Wednesday</td></tr></table>');
  ok("a vertical label survives", /writing-mode:vertical-rl/.test(rot) && /rotate\(180deg\)/.test(rot));
  ok("so do fixed column widths", /table-layout:fixed/.test(sanitizeDocHtml('<table style="table-layout:fixed"><tr><td>a</td></tr></table>')));
  ok("rotation still cannot carry a url", !/url/i.test(sanitizeDocHtml('<p style="transform:rotate(1deg) url(x)">y</p>')));
  // Silence is right for an attack and wrong for a design.
  ok("what was deleted is reportable",
    droppedStyles('<td style="box-shadow:0 0 2px #000;color:#c00">x</td>', sanitizeDocHtml('<table><tr><td style="box-shadow:0 0 2px #000;color:#c00">x</td></tr></table>')).join() === "box-shadow");
  ok("and is handed back to the model", /const gone = droppedStyles\(raw, sanitizeDocHtml\(raw\)\);/.test(ctl5));

  /*
   * The colours came out right to the cell and the ruling was absent: five empty
   * September cells had been merged into the lecture block. Every other check
   * here is arithmetic on the markup, and arithmetic cannot see that. The model
   * had never once looked at what it wrote.
   */
  const ai2 = require("fs").readFileSync(require("path").join(__dirname, "../helper/aiDocDrivers.js"), "utf8");
  const ad2 = require("fs").readFileSync(require("path").join(__dirname, "../helper/aiDocAdapters.js"), "utf8");
  const aiSrc = require("fs").readFileSync(require("path").join(__dirname, "../helper/aiDocument.js"), "utf8");
  ok("the model is shown its own draft", /images: shots/.test(ai2) && /type: "image"[\s\S]{0,160}b\.toString\("base64"\)/.test(ad2));
  ok("once, because the second look says nothing new", /if \(shots\.length \|\| pages\) \{[\s\S]{0,60}looked = true;/.test(ai2));
  /*
   * The first version captured the top 1500 pixels, so a teacher asking about the
   * Wednesday table was answered by a model looking at a picture of Monday. It
   * reported the lines as correct, and in what it could see they were. One tall
   * full-page strip is no better: it is downscaled to fit the vision limit, and
   * hairline table rules are the first thing to vanish.
   */
  ok("and shown the WHOLE page, in readable bands", /images\.map\(\(b\) => \(\{/.test(ad2) && /\$\{bands\} hissə/.test(ai2));
  const pdfSrc = require("fs").readFileSync(require("path").join(__dirname, "../helper/lessonPlanPdf.js"), "utf8");
  ok("captured band by band at full scale", /const bands = wantBands \? Math\.min\(maxBands/.test(pdfSrc));
  ok("with no image of empty trailing margin", /if \(i > 0 && height < 120\) break;/.test(pdfSrc));
  ok("and looking is not counted as a failed attempt", /attempt -= 1; \/\/ verifying is not failing/.test(ai2));
  /*
   * The pictures need a source to be compared against; the PAGE COUNT does not.
   * "I asked for two pages and got five" is a fault on every kind of turn, and
   * the count comes out of the same browser session that would take the
   * screenshots — so it is measured always, and the images are sent only when
   * there is something to hold them against.
   */
  ok("pictures only when there is a source", /const hasSource = sending\.length > 0/.test(ctl5) && /bands: hasSource/.test(ctl5));
  ok("but the page count on every turn", /look: async \(html\) => \{/.test(ctl5));
  ok("measured by paginating the real stylesheet, not guessed",
    pdfSrc.includes("await page.pdf({ format: \"A4\"") && pdfSrc.includes("Type"));
  ok("and the model is told what to do with it", /PDF-də \$\{pages\} səhifə çıxır/.test(ai2));
  ok("a failed render costs the teacher nothing", /logStudioEvent\("draft_render_failed"/.test(ctl5));
  ok("the renderer exists", typeof require("../helper/lessonPlanPdf").renderPng === "function");

  /*
   * The teacher said the class runs three weeks. The model agreed, said it had
   * done it, and shipped a cell sitting on ONE column — the browser then
   * stretched that column wide enough to hold the sentence, so the picture showed
   * a wide block roughly where a wide block belonged. Both sides were describing
   * the same image and meaning different markup, and no amount of looking settles
   * that. Column arithmetic does.
   */
  const { gridMap } = require("../helper/lessonDocTables");
  const grid = gridMap(
    "<table>" +
      '<tr><td></td><td colspan="5">September</td><td colspan="4">October</td></tr>' +
      "<tr><td></td><td>2</td><td>9</td><td>16</td><td>23</td><td>30</td><td>7</td><td>14</td><td>21</td><td>28</td></tr>" +
      '<tr><td>18:00</td><td colspan="6"></td><td colspan="3">Big Data</td></tr>' +
      "</table>"
  );
  ok("a merged header reports its real span", /2-6:"September"/.test(grid));
  ok("a lesson block reports the columns it lands on", /8-10:"Big Data"/.test(grid));
  ok("so it can be checked against the dates on those columns", /8:"14"/.test(grid) && /10:"28"/.test(grid));
  ok("an empty run is counted, not skipped", /2-7:boş/.test(grid));
  ok("and it is sent with the render", /gridOf: \(html\) => gridMap\(html \|\| ""\)/.test(ctl5));
  ok("warning that a wide-looking cell need not be wide", /geniş görünən xana geniş olmaya bilər/.test(ai2));
  ok("the loop is written once, not once per provider", !/api\.openai\.com|generativelanguage/.test(ai2));

  /*
   * "Try again a bit later" is right about a provider having a bad minute and a
   * false promise about a credit balance at zero. The teacher retries, waits,
   * retries, and concludes the feature is broken — it is not broken, it is unpaid,
   * and the only person who can act on that is the owner.
   */
  ok("an exhausted account is not reported as a bad minute", /credit balance is too low/.test(ad2));
  ok("and is not told to wait", /kredit bitib və ya hesab aktiv deyil/.test(ad2));
  /*
   * The old text said "contact the administrator" — which the administrator also
   * read, on their own platform, unable to tell whether it meant their Examopia
   * account, their role, or something else. It meant an outside API account.
   * Naming the provider is what makes it diagnosable.
   */
  ok("the provider is named", /PROVIDER_LABEL/.test(ad2) && /Claude \(Anthropic\)/.test(ad2));
  ok("and each call site says which one it is",
    ["billingError(\"claude\")", "billingError(\"openai\")", "billingError(\"gemini\")"].every((c) => ad2.includes(c)));
  /*
   * With three providers on the picker, the useful advice is one the teacher can
   * act on alone: switch model and carry on. "Contact the administrator" never
   * was, least of all for the administrator.
   */
  ok("and the reader is told what they can do", /başqa model seçib davam edə/.test(ad2));

  // The wordings that actually arrive, each verified against the real body.
  const { OUT_OF_CREDIT } = require("../helper/aiDocAdapters");
  ok("OpenAI: no credits remaining", OUT_OF_CREDIT.test('{"code":"credit_balance_exhausted","message":"You have no credits remaining. Add credits to continue"}'));
  ok("OpenAI: account deactivated", OUT_OF_CREDIT.test('{"code":"account_deactivated","message":"has been deactivated"}'));
  ok("Anthropic: balance too low", OUT_OF_CREDIT.test("Your credit balance is too low to access the Anthropic API."));
  ok("Gemini: resource exhausted", OUT_OF_CREDIT.test('{"error":{"status":"RESOURCE_EXHAUSTED"}}'));
  // And an ordinary failure is still an ordinary failure.
  ok("a plain error is not a billing error", !OUT_OF_CREDIT.test('{"error":{"message":"internal server error"}}'));
  ok("the owner is shouted at in the log", /\[AI BILLING\]/.test(ad2));
  // A 400 that is not about credit still reads as an ordinary failure.

  // And every provider says it its own way, so every provider is matched.
  ok("every provider's wording is covered",
    ["insufficient", "quota", "billing hard limit", "deactivated"].every((w) => ad2.includes(w)));
  // Every adapter runs the check, and every one of them says which provider it
  // was — a message that does not name the provider is not diagnosable.
  // By the SET of providers, not by a count: OpenAI has two failure paths now
  // (a streamed turn and a plain one) and both must run the check.
  ok("every adapter checks it", (ad2.match(/OUT_OF_CREDIT\.test/g) || []).length >= 3);
  ok(
    "and every one names itself",
    new Set([...ad2.matchAll(/billingError\("(claude|openai|gemini)"\)/g)].map((m) => m[1])).size === 3
  );

  /*
   * The model id is sent straight to the provider, so it is an allow-list and not
   * a free-text field — a document that stores whatever a client typed is a
   * document that can be made to bill against a model nobody chose.
   */
  ok("the catalogue is a fixed list", S.DOC_MODELS.length >= 2 && S.DOC_MODELS.every((m) => m.id && m.label));
  ok("junk cannot reach the provider", S.pickModel("gpt-4o; rm -rf") === S.DEFAULT_DOC_MODEL);
  ok("an empty choice is the default", S.pickModel("") === S.DEFAULT_DOC_MODEL && S.pickModel(undefined) === S.DEFAULT_DOC_MODEL);
  ok("a listed model passes through", S.pickModel(S.DOC_MODELS[1].id) === S.DOC_MODELS[1].id);
  /*
   * Every entry must support the tool use the whole studio path is built on — a
   * model without it could not write a document here at all — and must name the
   * provider that owns it, because the wire format is the only thing that differs
   * between them and the adapter is chosen by this field.
   */
  ok("every entry names its provider", S.DOC_MODELS.every((m) => ["claude", "openai", "gemini"].includes(m.provider)));
  /*
   * Two providers, not three. Gemini was dropped from the picker — writing a
   * material is the hardest thing asked of a model here and the cheap tiers were
   * on the list for being cheap, which is not a property anybody wants in a
   * handout. It still extracts exams elsewhere.
   */
  ok("more than one provider is offered", new Set(S.DOC_MODELS.map((m) => m.provider)).size >= 2);
  ok("the provider is read from the catalogue, not the name", S.providerOf("gpt-5.6-sol") === "openai");
  ok("an unknown id routes to the default's provider", S.providerOf("nope") === S.DOC_MODELS[0].provider);
  /*
   * Which of them stream. Claude reports the document as it is written, so live
   * progress is real work finished; the other two do not, and the note says so —
   * a teacher choosing a cheaper model should know what they give up.
   */
  ok("a model that cannot stream progress says so",
    S.DOC_MODELS.filter((m) => m.provider !== "claude").every((m) => /gedişat yoxdur/.test(m.note)));
  ok("the turn validates what it was sent", /S\.pickModel\(String\(\(req\.body && req\.body\.model\)/.test(ctl5));
  ok("and remembers it on the document", /"settings\.model": model/.test(ctl5));
  // The fallback is the catalogue's default, not a second hand-written copy of
  // it — that copy had already drifted a model generation behind the picker.
  ok("the request carries it", /model: model \|\| require\("\.\/lessonDocSchema"\)\.DEFAULT_DOC_MODEL/.test(aiSrc));

  /*
   * The wire format each provider wants, checked without calling anyone. A tool
   * conversation is easy to get subtly wrong — an output with no call to attach
   * to, an image in the wrong turn — and the failure arrives as a 400 in
   * production rather than as a wrong document, so it is worth pinning here.
   */
  {
    const { openaiAdapter, geminiAdapter } = require("../helper/aiDocAdapters");
    const srcParts = [{ mime: "application/pdf", data: "AAA", isPdf: true }];

    const oa = openaiAdapter({ model: "gpt-4.1-mini", tools: S.DOC_TOOLS, maxTokens: 100 });
    const oh = oa.start({ parts: srcParts, prompt: "salam", system: "sys" });
    ok("openai opens with a system turn and a user turn", oh[0].role === "system" && oh[1].role === "user");
    ok("and the pdf rides in it", JSON.stringify(oh[1].content).includes("input_file"));
    oa.reply(
      oh,
      { raw: [{ type: "function_call", call_id: "c1", name: "read_source", arguments: '{"name":"a.pdf"}' }] },
      [{ call: { id: "c1", name: "read_source" }, isError: false, text: "ok" }],
      { parts: srcParts, images: [Buffer.from("x")] }
    );
    // The call must be replayed before its output or there is nothing to attach to.
    ok("openai replays the call, then its output", oh[2].type === "function_call" && oh[3].type === "function_call_output");
    /*
     * And the WHOLE turn, not a filtered version of it. Filtering to
     * function_call items works on gpt-4.1-mini and breaks a reasoning model
     * outright: gpt-5.6-sol emits a `reasoning` item that its call belongs to,
     * and replaying the call without it is refused — "provided without its
     * required 'reasoning' item". Found by running the loop on the model the
     * picker offers first, not by reading the code.
     */
    const reasoningTurn = {
      raw: [
        { type: "reasoning", id: "rs_1" },
        { type: "function_call", call_id: "c2", name: "write_material", arguments: "{}" },
      ],
    };
    const rh = oa.start({ parts: [], prompt: "p", system: "s" });
    oa.reply(rh, reasoningTurn, [{ call: { id: "c2", name: "write_material" }, isError: false, text: "ok" }], {});
    ok("and keeps the reasoning item the call belongs to",
      rh.some((x) => x.type === "reasoning") && rh.some((x) => x.type === "function_call"));
    ok("and the picture arrives as its own user turn", JSON.stringify(oh[4]).includes("input_image"));

    const ga = geminiAdapter({ model: "gemini-2.5-flash", tools: S.DOC_TOOLS, maxTokens: 100 });
    const gh = ga.start({ parts: srcParts, prompt: "salam" });
    ok("gemini opens with a user turn carrying the file", gh[0].role === "user" && JSON.stringify(gh[0]).includes("inline_data"));
    ga.reply(gh, { raw: { role: "model", parts: [] } }, [{ call: { name: "read_source" }, isError: false, text: "ok" }], { images: [Buffer.from("x")] });
    // Gemini has no call ids: a result is matched back by name.
    ok("gemini answers by name", JSON.stringify(gh[2]).includes("functionResponse") && JSON.stringify(gh[2]).includes("read_source"));
    ok("and takes the picture inline", JSON.stringify(gh[2]).includes("inline_data"));

    // Gemini rejects the JSON-Schema keywords the other two require.
    const gs = require("../helper/curriculumSchema").toGeminiSchema(
      S.DOC_TOOLS.find((t) => t.name === "write_material").input_schema
    );
    ok("the tool schema is converted for gemini", !("additionalProperties" in gs) && gs.properties.html);
  }

  /*
   * A round after the first is a REPLY — to a finding, or to a render — and "the
   * draft is fine as it is" can be answered with silence. Gemini in particular
   * returns a STOP with no parts, having spent its thinking budget agreeing with
   * itself. That was read as an empty turn, so a document the model had already
   * written and finished was thrown away and the teacher got "AI cavabı oxunmadı"
   * over a material that existed.
   */
  ok("silence after work keeps the work", /if \(calls\.length\) lastWork = \{ calls, said \};/.test(ai2));
  ok("and only when there was work to keep", /else if \(lastWork\) \{/.test(ai2));
  // Agreement in words is the same as silence here: the model answering the
  // render with "it looks right" is not an empty turn either.
  ok("agreeing in words also keeps the work", /said = said \|\| lastWork\.said;/.test(ai2));
  // A 200 with nothing in it is how a Gemini failure arrives, and the reason is
  // in the response and nowhere else.
  ok("an empty gemini response is written down", /gemini returned no parts/.test(ad2));
  ok("with the reason it gives", /finishReason/.test(ad2));

  /*
   * The whole turn runs where the teacher chose.
   *
   * The plan pass routed itself: it inferred a provider from a model id via the
   * exam price table, and the studio's ids are mostly not in that table — both
   * Gemini entries and both Claude entries fell through to the default, which is
   * an OpenAI model. So choosing "Gemini 2.5 Pro" planned on OpenAI and billed
   * there, and a turn could be planned by one company and written by another
   * with nothing saying so.
   */
  const aiFull = require("fs").readFileSync(require("path").join(__dirname, "../helper/aiDocument.js"), "utf8");
  ok("an explicit provider is accepted", /async function runDocument\(\{[^}]*provider/.test(aiFull));
  /*
   * And is EXCLUSIVE, not merely first.
   *
   * The chain existed so a turn could still be done when one provider was down —
   * sensible when nobody had asked for a particular one. The picker makes it an
   * instruction: a teacher who selects Claude and receives OpenAI's work has been
   * handed another company's answer under the name of the one they chose, with
   * no way to know, and a different bill. Where nothing was chosen, the exam
   * paths keep the full chain.
   */
  ok("a chosen provider is used alone", /const order = provider[\s\S]{0,8}\? \[provider\]/.test(aiFull));
  ok("and an unchosen one still falls back",
    /\[picked\?\.provider, "openai", "gemini", "claude"\]/.test(aiFull));
  ok("the plan pass passes the choice through", /provider: S\.providerOf\(model\),/.test(ctl5));
  // The fallback chain behind it is the point of runDocument and must survive.
  ok("the fallback chain is still there", /"openai", "gemini", "claude"/.test(aiFull));

  /*
   * What may be split across a page, and what may not.
   *
   * A heading is glued to what follows it, which is right. But when the block
   * underneath was ALSO unbreakable, the pair became one lump: a section heading
   * plus a tall example box could not fit in what was left of the page, so both
   * jumped to the next one and left a third of the previous page blank. Measured
   * on the same document: 3 pages with the old rule, 2 with this one.
   *
   * Tall containers may break; short ones may not. Splitting a definition, a
   * callout, a figure or a table row is how you get a heading on one page and its
   * meaning on the next.
   */
  const sheet = buildLessonDocHtml({ title: "T", html: "<p>x</p>" });
  ok("a worked example may continue overleaf", !/\.ex\{[^}]*break-inside:avoid/.test(sheet));
  ok("so may an exercise set", !/\.task\{[^}]*break-inside:avoid/.test(sheet));
  ok("a definition may not be split", /\.def\{[^}]*break-inside:avoid/.test(sheet));
  ok("nor a callout", /\.note\{[^}]*break-inside:avoid/.test(sheet));
  ok("nor a figure", /\.fig\{[^}]*break-inside:avoid/.test(sheet));
  ok("nor a table row", /tr\{break-inside:avoid\}/.test(sheet));
  ok("a heading is still kept with what follows", /break-after:avoid/.test(sheet));
  // So a permitted break is never an ugly one.
  ok("and no paragraph leaves a single line behind", /orphans:2;widows:2/.test(sheet));

  /*
   * A file arriving WITH the message changes what the message means.
   *
   * A teacher attached ÇEVRƏ.pdf to a document about inequalities and wrote
   * "copy exactly as is keep everything the same". The edit rules said "even if a
   * file is attached, the thing to change is this document, not the file" — a
   * line written to stop a ten-turn-old attachment causing a rebuild — so the
   * model read the instruction as "leave the document alone", replied "heç bir
   * dəyişiklik edilmədi", and was obeying precisely.
   *
   * Attaching is an ACTION, not a phrasing to be guessed at, so it is what the
   * rules turn on.
   */
  const stale = S.buildEditPrompt({ doc: { html: "<p>x</p>" }, instructions: "copy exactly as is" }).system;
  const fresh = S.buildEditPrompt({ doc: { html: "<p>x</p>" }, instructions: "copy exactly as is", freshFiles: true }).system;
  ok("without an attachment the document is protected", /YENİ fayl əlavə edilməyib/.test(stale));
  ok("with one, the words are read as being about the file", /BU HALDA FAYLA aiddir/.test(fresh));
  ok("and the two are not the same instruction", stale !== fresh);
  // The line that caused it is gone from both.
  ok("nothing tells the model to ignore an attachment", !/DƏYİŞDİRİLƏCƏK ŞEY bu sənəddir/.test(stale + fresh));
  ok("the turn decides by what the teacher did", /const freshFiles = sent\.length > 0;/.test(ctl5));
  ok("and copy mode follows the attachment, not just a first draft",
    /if \(parts\.length && \(freshFiles \|\| !hadBlocks\)\) \{/.test(ctl5));

  /*
   * Why the documents stopped having drawings.
   *
   * Figures were explained in exactly one place: inside the list headed "old
   * block types, for reference only, you write HTML now" — and the explanation
   * there said to put the drawing in an `svg` FIELD and the caption in a `text`
   * FIELD, neither of which exists any more. The only description of how to draw
   * sat under a heading saying it did not apply, in a shape that could not be
   * used. A geometry PDF came back as text with every diagram missing, and it
   * looked like a limit of the product rather than a stale paragraph.
   */
  const rules = S.BASE_RULES;
  const liveAt = rules.indexOf("ÜSLUB SİNİFLƏRİ");
  const legacyAt = rules.indexOf("KÖHNƏ BLOK TİPLƏRİ");
  const figAt = rules.indexOf("<figure><svg viewBox");
  ok("drawing is documented", figAt > 0);
  ok("in the live section, not the legacy one", figAt > liveAt && figAt < legacyAt);
  ok("and not as a block field that no longer exists", !/sahəsinə SVG kodu yaz/.test(rules));
  // A copied page loses half its meaning if the diagrams are dropped.
  ok("a source diagram must be redrawn, not skipped", /çertyoj varsa, onu SVG/.test(rules));
  // The pipeline was never the limit: this is what a drawing has to survive.
  const drawn = sanitizeDocHtml(
    '<figure><svg viewBox="0 0 200 160"><circle cx="100" cy="80" r="60" fill="none" stroke="#222"/>' +
      '<path d="M40 80 L100 20" stroke="#222" fill="none"/><text x="30" y="78">A</text></svg>' +
      "<figcaption>Çevrə</figcaption></figure>"
  );
  ok("a drawing survives sanitising whole", /<circle/.test(drawn) && /<path/.test(drawn) && /<text/.test(drawn));
  ok("with its frame and its caption", /viewBox/.test(drawn) && /Çevrə/.test(drawn));
  ok("and reaches both files", /<circle/.test(buildLessonDocHtml({ title: "T", html: drawn })) &&
    /<circle/.test(buildLessonDocHtml({ title: "T", html: drawn }, { forWord: true })));

  ok("html is sanitised before it is stored", /const html = sanitizeDocHtml\(wrote\.input\.html\)/.test(ctl5));
  ok("an input that sanitises to nothing is refused", /if \(!html\) \{/.test(ctl5));
  ok("blocks are cleared so there is one source of truth", /blocks: \[\],/.test(ctl5));

  const tool = S.DOC_TOOLS.find((t) => t.name === "write_material");
  ok("the write tool takes html", Boolean(tool.input_schema.properties.html));
  ok("and no longer takes blocks", !tool.input_schema.properties.blocks);
  ok("the brief tells the model it writes a document", S.BASE_RULES.includes("SƏNƏDİ HTML KİMİ YAZIRSAN"));
  ok("and gives it the house styles to use", S.BASE_RULES.includes('class="def"'));
}

console.log("\nAn edit changes part of the document, not all of it:");
{
  const { applyEdits, MAX_EDITS } = require("../helper/lessonDocPatch");
  const DOC = '<h1>Faizlər</h1><p class="def">Faiz yüzdə birdir.</p><p>Misal: 20%</p><p>Son söz.</p>';

  /*
   * write_material re-emitted the WHOLE document for every edit — 31 KB of HTML
   * to move one heading. Output bills at five times input, and once caching
   * landed the rewrite became the largest line on a turn: 64,100 output tokens,
   * $1.60 of $2.94, most of it retyping text that was already correct.
   */
  const one = applyEdits(DOC, [{ find: "Faiz yüzdə birdir.", replace: "Faiz yüzdə bir hissədir." }]);
  ok("a unique quote is replaced", one.problems.length === 0 && one.applied === 1);
  ok("and only that part changes", one.html === DOC.replace("Faiz yüzdə birdir.", "Faiz yüzdə bir hissədir."));
  ok("the rest is byte-identical", one.html.includes('<h1>Faizlər</h1>') && one.html.includes("<p>Son söz.</p>"));

  /*
   * THE RULE THAT MAKES IT SAFE. A quote matching nothing means the model retyped
   * from memory; matching twice means the edit is ambiguous and the first hit
   * would be a coin toss with a teacher's document. Both are refused AND
   * reported, because the report is what lets the model fix it itself.
   */
  const missing = applyEdits(DOC, [{ find: "Bu mətn sənəddə yoxdur", replace: "x" }]);
  ok("a quote that matches nothing is refused", missing.applied === 0 && missing.problems.length === 1);
  ok("and the document is untouched", missing.html === DOC);
  ok("the report tells it to copy, not recall", /YADDAŞDAN/.test(missing.problems[0]));

  const twice = applyEdits("<p>bir</p><p>bir</p>", [{ find: "<p>bir</p>", replace: "<p>iki</p>" }]);
  ok("an ambiguous quote is refused", twice.applied === 0);
  ok("and says how many places it matched", /2 yerdə/.test(twice.problems[0]));
  ok("nothing is applied on ambiguity", twice.html === "<p>bir</p><p>bir</p>");

  // All or nothing: a batch where one edit fails must not half-apply the rest.
  const mixed = applyEdits(DOC, [
    { find: "Misal: 20%", replace: "Misal: 25%" },
    { find: "yoxdur-bu", replace: "x" },
  ]);
  ok("one bad edit rejects the whole batch", mixed.applied === 0 && mixed.html === DOC);

  const many = applyEdits(DOC, [
    { find: "<h1>Faizlər</h1>", replace: "<h1>Faiz</h1>" },
    { find: "<p>Son söz.</p>", replace: "" },
  ]);
  ok("several edits apply together", many.applied === 2 && many.problems.length === 0);
  ok("an empty replace deletes", !many.html.includes("Son söz"));
  ok("and order does not matter to the result", many.html.startsWith("<h1>Faiz</h1>"));

  // Two edits over the same characters cannot both be honoured, and the loser
  // would lose silently.
  const overlap = applyEdits(DOC, [
    { find: "Faiz yüzdə birdir.", replace: "A" },
    { find: "yüzdə birdir.</p>", replace: "B" },
  ]);
  ok("overlapping edits are refused", overlap.applied === 0 && /eyni hissəsini/.test(overlap.problems[0]));

  ok("an empty document says to write instead", applyEdits("", [{ find: "a", replace: "b" }]).problems.length === 1);
  ok("an empty edit list is refused", applyEdits(DOC, []).problems.length === 1);
  const flood = Array.from({ length: MAX_EDITS + 1 }, () => ({ find: "x", replace: "y" }));
  ok("a flood of edits is sent back as a rewrite", /write_material/.test(applyEdits(DOC, flood).problems[0]));
}

console.log("\nA patch edit reaches the document through one commit path:");
{
  const path6 = require("path");
  const ctl6 = require("fs").readFileSync(path6.join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const drv6 = require("fs").readFileSync(path6.join(__dirname, "../helper/aiDocDrivers.js"), "utf8");
  const S6 = require("../helper/lessonDocSchema");

  const tool = S6.DOC_TOOLS.find((t) => t.name === "edit_material");
  ok("the tool exists", Boolean(tool));
  ok("it takes a list of find/replace edits", Boolean(tool.input_schema.properties.edits.items.properties.find));
  ok("and a sentence for the teacher", tool.input_schema.required.includes("reply"));
  ok("it tells the model to copy the quote exactly", /HƏRFİ-HƏRFİNƏ/.test(tool.description));
  ok("and that the quote must be unique", /YALNIZ BİR yerə uyğun/.test(tool.description));
  ok("write_material is named as the whole-rewrite fallback", /write_material işlət/.test(tool.description));

  /*
   * ONE commit path, not two. The patch is resolved into the same shape
   * write_material produces, so sanitising, the summary, the revision CAS and
   * the reply the teacher reads stay a single code path — two would drift.
   */
  ok("a patch is resolved into the write shape", /name: "write_material",\s*\n\s*input: \{ html: r\.html/.test(ctl6));
  ok("and only when the model did not write outright", /if \(!wrote && patch\)/.test(ctl6));
  ok("a patch that will not apply commits nothing", /logStudioEvent\("patch_unapplicable"/.test(ctl6));

  // The loop has to know a patch produced a document, or its "you described the
  // work instead of doing it" guards would fire on a perfectly good edit.
  ok("the loop counts either tool as producing a document", /c\.name === "write_material" \|\| c\.name === "edit_material"/.test(drv6));
  ok("and asks the caller to resolve the html", /typeof opts\.htmlOf === "function"/.test(drv6));
  ok("the render check reviews the finished page, not the diff", /await look\(produced\.html\)/.test(drv6));
  ok("the caller resolves a patch for that check", /if \(c\.name === "edit_material"\)/.test(ctl6));

  // An unmatched quote must come back as a tool error the model can act on.
  ok("an unapplicable patch is reported to the model", /if \(name === "edit_material"\)/.test(ctl6));
  ok("and a valid patch still faces the table check", /const findings = \[checkTables\(patched\)\]/.test(ctl6));

  /*
   * Progress in the unit the running tool produces. A patch streams find/replace
   * pairs whose values are full of markup — twice per edit — so counting closed
   * tags would report a two-line change as a hundred-part rewrite. That number
   * is not merely wrong, it is a claim about work that did not happen.
   */
  const prog = S6.makeProgressStreamer();
  ok("the turn uses the adaptive streamer", /S\.makeProgressStreamer\(\)/.test(ctl6));
  const asHtml = prog('{"title":"T","html":"<h1>A</h1><p>one</p><p>two</p>');
  ok("a document counts parts", asHtml.length === 3 && asHtml[0].kind === "hissə");

  const p2 = S6.makeProgressStreamer();
  const asEdits = p2('{"reply":"ok","edits":[{"find":"<p>a</p>","replace":"<p>b</p>"},{"find":"<p>c</p>","replace":"<p>d</p>"}');
  ok("a patch counts changes, not tags", asEdits.length === 2);
  ok("and names the unit", asEdits[0].kind === "dəyişiklik");

  // The unit is fixed by the first key seen; a counter that changed units
  // halfway would run backwards in front of the teacher.
  const p3 = S6.makeProgressStreamer();
  p3('{"reply":"x","edits":[{"find":"<p>a</p>","replace":"<p>b</p>"}');
  const later = p3('{"reply":"x","edits":[{"find":"<p>a</p>","replace":"<p>b</p>"},{"find":"q","replace":"r"}');
  ok("the unit never switches mid-turn", later.every((b) => b.kind === "dəyişiklik"));
  ok("nothing is emitted before a shape is known", S6.makeProgressStreamer()('{"repl').length === 0);
}

console.log("\nOnly the pages the model asks for:");
{
  const F7 = require("../helper/lessonDocFiles");
  const p = F7.parsePages;

  /*
   * A twelve-page scan was sent whole on every read. Measured on a real 9.95 MB
   * bank: pages 1-3 come out at 1.18 MB and one page at 0.37 MB — 8x and 27x
   * less, at the SAME resolution. This is the one saving that costs no fidelity.
   */
  ok("a single page", JSON.stringify(p("3")) === "[3]");
  ok("a range", JSON.stringify(p("22-24")) === "[22,23,24]");
  ok("a mixed list", JSON.stringify(p("1,4,7-9")) === "[1,4,7,8,9]");
  ok("spaces and semicolons", JSON.stringify(p(" 2 ; 5 ")) === "[2,5]");
  ok("an en-dash, as a person would type it", JSON.stringify(p("3–5")) === "[3,4,5]");
  ok("a reversed range is read the obvious way", JSON.stringify(p("24-22")) === "[22,23,24]");
  ok("duplicates collapse", JSON.stringify(p("2,2,3")) === "[2,3]");
  ok("nothing asked for is null", p("") === null && p(null) === null && p(undefined) === null);
  ok("junk is null, not page zero", p("abc") === null && p("0") === null);
  // A runaway range must not be able to ask for ten thousand pages.
  ok("an absurd range is capped", p("1-9999").length <= 64);

  ok("a slicer exists", typeof F7.slicePdf === "function");
  ok("and a page counter", typeof F7.pageCountOf === "function");
  ok("and a one-call fetch that reports what it served", typeof F7.partForPages === "function");

  const src7 = require("fs").readFileSync(require("path").join(__dirname, "../helper/lessonDocFiles.js"), "utf8");
  ok("the slice is a real page range", /-dFirstPage=\$\{a\}/.test(src7) && /-dLastPage=\$\{b\}/.test(src7));
  ok("a slice that is not a PDF is thrown away", /head\.toString\("latin1"\) !== "%PDF-"/.test(src7));
  /*
   * Derived copies are matched by key PREFIX rather than by rebuilding each
   * name. The set of derived shapes has grown once already (a downscale, then
   * per-page slices) and a list of guesses would silently miss the next one.
   */
  ok("every derived copy dies with its original", /n\.startsWith\(`\$\{key\}\.`\)/.test(src7));
}

console.log("\nWhat a turn costs, and the three things that decide it:");
{
  const path8 = require("path");
  const ad8 = require("fs").readFileSync(path8.join(__dirname, "../helper/aiDocAdapters.js"), "utf8");
  const doc8 = require("fs").readFileSync(path8.join(__dirname, "../helper/aiDocument.js"), "utf8");
  const ctl8 = require("fs").readFileSync(path8.join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const F8 = require("../helper/lessonDocFiles");

  /*
   * 1. CACHING. A turn is up to seven API calls and each re-sends the whole
   * conversation, attachments included. One measured turn: 267,264 input tokens,
   * cache_read 0, $1.34 of input on a $2.94 bill. The breakpoints are the fix.
   */
  ok("the system block is cached", /system: \[\{ type: "text", text: system, cache_control: LONG_LIVED \}\]/.test(ad8));
  ok("breakpoints are re-placed before every call", /markCachePoints\(history\);/.test(ad8));
  ok("the file-bearing first user turn is cached", /setCache\(history\[users\[0\]\], LONG_LIVED\)/.test(ad8));
  ok("and the growing tail too", /setCache\(history\[users\[users\.length - 1\]\]\)/.test(ad8));

  // Three live breakpoints, not one per loop step: the cap is four, and a stale
  // one is a breakpoint spent on a prefix nothing reads again.
  {
    const hist = [
      { role: "user", content: [{ type: "text", text: "files+prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "finding 1" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
      { role: "user", content: [{ type: "text", text: "finding 2" }] },
    ];
    // Reach the module's private helper the way the adapter does — through a send
    // that cannot reach the network, so only the marking runs.
    const { claudeAdapter } = require("../helper/aiDocAdapters");
    const a = claudeAdapter({
      client: { messages: { stream: () => { throw new Error("no network in test"); } } },
      model: "claude-opus-5",
      tools: [],
      maxTokens: 10,
    });
    // The send throws before any request is made; the marking has already run.
    pending.push(
      a.send(hist, { system: "s" }).catch(() => {
        const marked = hist.filter((m) => (m.content || []).some((b) => b.cache_control));
        ok("exactly two message breakpoints are live", marked.length === 2);
        ok("the first is the attachment turn", marked[0] === hist[0]);
        ok("the second is the newest turn", marked[1] === hist[4]);
        ok("the middle turn's stale breakpoint is cleared", !(hist[2].content || []).some((b) => b.cache_control));
      })
    );
  }
}

console.log("\nEffort, ceiling and attachment size:");
{
  const path8b = require("path");
  const ad8b = require("fs").readFileSync(path8b.join(__dirname, "../helper/aiDocAdapters.js"), "utf8");
  const doc8b = require("fs").readFileSync(path8b.join(__dirname, "../helper/aiDocument.js"), "utf8");
  const ctl8b = require("fs").readFileSync(path8b.join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const F8b = require("../helper/lessonDocFiles");

  /*
   * 2. EFFORT. Thinking bills at the output rate and was the larger half of the
   * measured turn. Creation earns it; an edit against an existing document
   * mostly re-derives decisions already made.
   */
  ok("effort is a parameter, not a constant", /output_config: \{ effort \}/.test(ad8b));
  ok("it defaults to full", /effort = "high"/.test(ad8b));
  ok("creation and an edit both read the effort dial", /effort: hadBlocks \? EFFORT_EDIT : EFFORT_CREATE/.test(ctl8b));
  ok("and it reaches the adapter", /effort,/.test(doc8b));

  /*
   * 3. THE ATTACHMENT. The 10.4 MB scan was the biggest single input, re-sent
   * every step. Downscaling is the one change here that must never be able to
   * blind the model, so every failure path returns the original.
   */
  ok("a slimmer is exported", typeof F8b.slimPdf === "function");
  ok("only large files are touched", F8b.SLIM_OVER_BYTES >= 1024 * 1024);
  ok("at a resolution that keeps digits legible", F8b.SLIM_DPI >= 200);
  const src = require("fs").readFileSync(path8b.join(__dirname, "../helper/lessonDocFiles.js"), "utf8");
  /*
   * The two flags that make it do anything. Without them the function ran, exited
   * 0, and changed a 9.95 MB scan by nothing: AutoFilter left the original
   * encoding in place, and the default downsample threshold of 1.5 meant a 200
   * dpi target only triggered above 300 dpi. With both set the same file came out
   * at 4.65 MB. A silent no-op is the failure mode worth a test here.
   */
  ok("image encoding is forced, not inherited", /-dAutoFilterColorImages=false/.test(src) && /-dColorImageFilter=\/DCTEncode/.test(src));
  ok("and the downsample threshold is lowered", /-dColorImageDownsampleThreshold=1\.0/.test(src));
  /*
   * Quality is set for FIDELITY, not size. count_tokens settled it: the same
   * 12-page scan bills 18,921 tokens at 9.95 MB and 18,921 at 4.65 MB — a page
   * costs the same whatever its resolution, because the provider normalises it
   * before tokenising. Re-encoding buys request-cap headroom and nothing else,
   * so trading legibility for bytes would now be a loss on both sides.
   */
  ok("JPEG quality favours legibility over size", F8b.SLIM_JPEG_Q >= 75);
  ok("and only cap-threatening files are touched", F8b.SLIM_OVER_BYTES >= 4 * 1024 * 1024);
  ok("it verifies the output is really a PDF", /head\.toString\("latin1"\) !== "%PDF-"/.test(src));
  ok("it keeps the original unless the copy is meaningfully smaller", /after\.size >= before\.size \* 0\.9/.test(src));
  ok("a failed conversion falls back to the original", /return srcPath;/.test(src));
  ok("the derived copy is deleted with its original", /\$\{key\}\.s\$\{SLIM_DPI\}\.pdf/.test(src));

  // max_tokens is a ceiling, not a charge — and a truncated document costs more
  // than a generous ceiling, because the repair or retry pays for the prefix again.
  ok("the streaming loop has its own higher ceiling", /const DOC_MAX_TOKENS_STREAMING = 64000;/.test(doc8b));
  ok("and the tool loop uses it", /maxTokens = DOC_MAX_TOKENS_STREAMING/.test(doc8b));
}

console.log("\nThe model picker, and the meter behind it:");
{
  const S9 = require("../helper/lessonDocSchema");
  const A9 = require("../controllers/aiController");
  const ids = S9.DOC_MODELS.map((m) => m.id);

  // Gemini still extracts exams; it is only gone as a Studio choice.
  ok("no Gemini model is offered in Studio", !S9.DOC_MODELS.some((m) => m.provider === "gemini"));
  ok("Gemini remains available to the rest of the app", typeof A9.computeGeminiCost === "function");

  ok("the default is a Claude model", S9.providerOf(S9.DOC_MODELS[0].id) === "claude");
  ok("a retired id falls back rather than failing", S9.pickModel("gemini-2.5-pro") === S9.DOC_MODELS[0].id);
  ok("a known id is kept", S9.pickModel("claude-sonnet-5") === "claude-sonnet-5");

  /*
   * EVERY offered model must be priced. Studio has no rate limit and no budget
   * guard by decision, so its usage row is the only meter on it — and an
   * unpriced model computes to $0, which on a spend page does not read as
   * "unknown", it reads as "free". This is the check that stops a newer,
   * pricier model being added to the picker before its price is.
   */
  const usage = { input_tokens: 10000, output_tokens: 10000 };
  for (const m of S9.DOC_MODELS) {
    if (m.provider === "claude") {
      ok(`${m.id} is priced`, (A9.computeCost(usage, m.id) || {}).usd > 0);
    } else {
      const c = A9.computeOpenAIGenCost(
        { prompt_tokens: 10000, completion_tokens: 10000, total_tokens: 20000, prompt_tokens_details: { cached_tokens: 0 } },
        m.id,
        m.id
      );
      ok(`${m.id} is priced`, (c || {}).usd > 0);
    }
  }

  /*
   * A model may be priced here without being offered on the EXAM picker.
   *
   * gpt-6-astra needs a price because this table is what prices a Studio turn,
   * but at $10/$50 it is ~25x gpt-4.1-mini on input, and the exam picker's own
   * rule is that no click should cost far more than a teacher expects. So it is
   * priced everywhere and offered only where it was chosen deliberately.
   */
  const astra = A9.findAiModel("gpt-6-astra");
  ok("gpt-6-astra has a real price", astra && astra.usd && astra.usd.in === 10 && astra.usd.out === 50);
  ok("and is flagged off the exam picker", astra.studioOnly === true);
  ok("while still being offered in Studio", ids.includes("gpt-6-astra"));

  /*
   * The 5.6 prices were each one model's row out of step — sol carried gpt-5.5's
   * numbers, terra carried gpt-5.4's, and luna was five times its real rate — so
   * OpenAI spend was over-reported. Pinned against OpenAI's published table.
   */
  const published = {
    "gpt-6-astra": { in: 10, cached: 1, out: 50 },
    "gpt-5.6-sol": { in: 4, cached: 0.4, out: 20 },
    "gpt-5.6-terra": { in: 2, cached: 0.2, out: 12 },
    "gpt-5.6-luna": { in: 0.2, cached: 0.02, out: 1.2 },
  };
  for (const [id, want] of Object.entries(published)) {
    const got = A9.findAiModel(id)?.usd || {};
    ok(`${id} is priced as published`, got.in === want.in && got.cached === want.cached && got.out === want.out);
  }

  // The tiers span 10x, so one flat rate would misreport by a multiple — and
  // always downward for the models that cost the most.
  const usd = (id) => A9.computeCost(usage, id).usd;
  ok("Fable 5.1 costs more than Opus 5", usd("claude-fable-5-1") > usd("claude-opus-5"));
  ok("Opus 5 costs more than Sonnet 5", usd("claude-opus-5") > usd("claude-sonnet-5"));
  ok("a dated snapshot prices as its family", usd("claude-haiku-4-5-20251001") === usd("claude-haiku-4-5"));
  ok("an unknown model is priced, never free", usd("some-unreleased-model") > 0);
  ok("and the row records the model it was asked for", A9.computeCost(usage, "claude-sonnet-5").model === "claude-sonnet-5");

  /*
   * The accumulator. `cost` began at 0 and the Claude adapter did
   * `cost + computeCost(...)` — adding an object to a number, which produced
   * the string "0[object Object]". logStudioUsage then read .usd/.inputTokens
   * off it, found undefined, and wrote a real $0.28 turn as $0 with no tokens:
   * 19 of the 32 rows in production. A turn is several calls, so they must add.
   */
  const { claudeAdapter } = require("../helper/aiDocAdapters");
  const ad = claudeAdapter({ client: null, model: "claude-opus-5", tools: [], maxTokens: 1000 });
  const turn = { usage: { input_tokens: 12000, output_tokens: 9000 } };
  const once = ad.addCost(null, turn);
  ok("a turn's spend is a breakdown, not a scalar", once && typeof once === "object");
  ok("it is never a string", typeof once !== "string");
  ok("it carries dollars", once.usd > 0);
  ok("and the tokens the row records", once.inputTokens === 12000 && once.outputTokens === 9000);
  ok("and the model that ran", once.model === "claude-opus-5");

  const twice = ad.addCost(once, turn);
  ok("a second call adds rather than replaces", twice.inputTokens === 24000);
  ok("dollars add too", Math.abs(twice.usd - once.usd * 2) < 1e-6);
  ok("and the model is not overwritten", twice.model === "claude-opus-5");

  // What logStudioUsage actually reads off it.
  for (const f of ["model", "inputTokens", "outputTokens", "totalTokens", "usd"]) {
    ok(`the usage row can read .${f}`, twice[f] !== undefined);
  }
}

console.log("\nFailures are logged by code, never by message (LS-R3-014):");
{
  /*
   * Six sites logged `e.message`. A provider error carries request fragments,
   * model output, a source filename, sometimes a URL with credentials; a Mongo
   * error carries the connection string. The SSE frame was curated long ago;
   * the log line was the channel still open. Throw an error stuffed with
   * canaries through both loggers and read the console back.
   */
  const CANARIES = ["mongodb://leak-user:LEAK-PASS@leak-host", "sk-ant-LEAKKEY", "teacher@leak.test", "SECRET-SOURCE-TEXT", "leaked-filename.pdf"];
  const canary = new Error(`boom ${CANARIES.join(" ")}`);
  canary.code = "provider_unavailable";
  canary.aiStatus = 502;
  canary.provider = "claude";
  canary.body = CANARIES.join("|");

  const captured = [];
  const orig = console.error;
  console.error = (...a) => captured.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  try {
    const c = require("../controllers/lessonDocController");
    const pub = c.publicFailure(canary);
    c.logStudioEvent("turn_failed", canary);
    c.logStudioEvent("usage_settlement_failed", canary, { attempts: 3, usd: 0.28 });
    c.logStudioEvent("patch_unapplicable", null, { problems: 2 });
    ok("the teacher gets the curated line", pub.code === "provider_unavailable" && !CANARIES.some((x) => pub.message.includes(x)));
  } finally {
    console.error = orig;
  }
  const all = captured.join("\n");
  ok("something was logged", captured.length >= 3);
  ok("the event and the code are there", /turn_failed/.test(all) && /"code":"provider_unavailable"/.test(all) && /"provider":"claude"/.test(all));
  ok("no canary reaches the console", !CANARIES.some((x) => all.includes(x)));
  ok("not even through an extra field", /"usd":0\.28/.test(all) && !/leak/.test(all));

  const ctlSrc = require("fs").readFileSync(require("path").join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  ok("no console.error in the controller prints a message field", !/console\.error\([^)]*\.message/.test(ctlSrc));
  ok("every failure site goes through the one logger", (ctlSrc.match(/logStudioEvent\(/g) || []).length >= 7);
}

console.log("\nAn upload is what its bytes say it is (LS-R3-006):");
{
  const F = require("../helper/lessonDocFiles");
  const pdf = Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0, 0, 0]);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

  /*
   * `mimetype` is a header the browser fills in from the filename, and it was
   * the only gate between an upload and the disk, the model and every later
   * viewer. The bytes are the one thing the client cannot assert.
   */
  ok("a PDF is a PDF whatever it is called", F.trustedType({ buffer: pdf, name: "photo.png" }).ext === "pdf");
  ok("and gets its real mime, not the declared one", F.trustedType({ buffer: pdf, name: "photo.png" }).mime === "application/pdf");
  ok("a PNG is a PNG", F.trustedType({ buffer: png, name: "a.png" }).ext === "png");
  ok("plain text named .pdf is refused", F.trustedType({ buffer: Buffer.from("hello"), name: "x.pdf" }).ok === false);
  ok("an empty upload is refused", F.trustedType({ buffer: Buffer.alloc(0), name: "x.pdf" }).ok === false);

  ok("a ZIP named .docx is an Office file awaiting the deep check", (() => { const t = F.trustedType({ buffer: zip, name: "dərs.docx" }); return t.ok && t.office && t.ext === "docx"; })());
  ok("an OLE file named .doc likewise", (() => { const t = F.trustedType({ buffer: ole, name: "old.doc" }); return t.ok && t.office && t.ext === "doc"; })());
  ok("a ZIP named .pdf is refused, not stored as a PDF", F.trustedType({ buffer: zip, name: "fake.pdf" }).ok === false);
  ok("a ZIP named .doc is refused — the bytes disagree with the name", F.trustedType({ buffer: zip, name: "fake.doc" }).reason === "mismatch");
  ok("a ZIP named .exe is refused", F.trustedType({ buffer: zip, name: "run.exe" }).ok === false);

  const ctlSrc = require("fs").readFileSync(require("path").join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const addSrc = ctlSrc.slice(ctlSrc.indexOf("const addFile = asyncHandler"), ctlSrc.indexOf("const getFile = asyncHandler"));
  ok("the upload path types by bytes", /F\.trustedType\(\{ buffer: f\.buffer, name: f\.originalname \}\)/.test(addSrc));
  ok("and no longer consults the declared mimetype", !/F\.ACCEPT\[f\.mimetype\]/.test(addSrc) && !/mime: f\.mimetype/.test(addSrc));
  ok("a mismatch is refused with its own reason", /typed\.reason === "mismatch"/.test(addSrc));

  // Office files: deep-validated, converted through the queue, stored as PDF.
  ok("an Office file gets the structural check", /validateUploadFile\(src, `\.\$\{typed\.ext\}`\)/.test(addSrc));
  ok("is converted through the shared LibreOffice queue", /enqueueConversion\(String\(req\.user\._id\), \(\) => convertOfficeToPdf\(src, dir\)\)/.test(addSrc));
  ok("and is stored as a PDF under the teacher's own name", /saveFile\(\{ buffer: pdf, mime: "application\/pdf", ext: "pdf", name: f\.originalname \}\)/.test(addSrc));
  ok("the scratch directory is always removed", /fsp\.rm\(dir, \{ recursive: true, force: true \}\)/.test(addSrc));
  ok("a conversion failure is logged by code, told generically", /logStudioEvent\("office_convert_failed"/.test(addSrc) && /"convert_failed"/.test(addSrc));
}

console.log("\nDeleting a material releases its bytes (LS-R3-006):");
{
  const ctlSrc = require("fs").readFileSync(require("path").join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const rm = ctlSrc.slice(ctlSrc.indexOf("const removeDoc = asyncHandler"), ctlSrc.indexOf("const exportDoc = asyncHandler"));
  /*
   * Deleting the row used to leave every attached file on disk forever — a
   * teacher's textbook pages under a hash nothing would look up again.
   */
  ok("attachments are released with the document", /F\.removeIfUnused\(f\.key, f\.ext, Boolean\(stillUsed\)\)/.test(rm));
  ok("after the row is gone, so the reference check excludes it", rm.indexOf("deleteOne") < rm.indexOf("removeIfUnused"));
  ok("and only when no other material still holds the same bytes", /LessonDoc\.exists\(\{ "files\.key": f\.key \}\)/.test(rm));
  ok("only the request that actually deleted the row does this", rm.indexOf("gone.deletedCount === 1") < rm.indexOf("removeIfUnused"));
}

console.log("\nThere is one AI route (LS-R3-004):");
{
  const routes = require("fs").readFileSync(require("path").join(__dirname, "../routes/lessonDocRoute.js"), "utf8");
  const c = require("../controllers/lessonDocController");
  /*
   * A non-streaming POST /:id/message ran the older whole-document generation —
   * no tool loop, no patch edits, no render check, no read_source — and was
   * still mounted after the app stopped calling it. Two editing contracts that
   * evolve separately is a bug factory.
   */
  ok("the legacy route is gone", !/router\.post\("\/:id\/message",/.test(routes));
  ok("the streaming route remains", /router\.post\("\/:id\/message\/stream"/.test(routes));
  ok("the legacy handler is gone from the controller", typeof c.sendMessage === "undefined");
}

console.log("\nStop keeps the half-written page (LS-R3-018):");
{
  const ctlSrc = require("fs").readFileSync(require("path").join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const salvage = ctlSrc.slice(ctlSrc.indexOf("let salvaged = false;"), ctlSrc.indexOf("if (!salvaged) {"));
  /*
   * What streams is the write_material call's input — JSON whose `html` is the
   * document. The salvage repaired it into the old block shape and looked for
   * `blocks`, which the model has not written for some time, so every Stop
   * threw the half-page away.
   */
  ok("salvage reads the html the model actually writes", /typeof repaired\.html === "string"/.test(salvage));
  ok("and no longer looks for blocks that are never there", !/normalizeDoc\(repaired/.test(salvage) && !/next\?\.blocks\?\.length/.test(salvage));
  ok("it is sanitised before it is stored", /sanitizeDocHtml\(repaired\.html\)/.test(salvage));
  ok("committed through the CAS, not around it", /svc\.commit\(/.test(salvage) && /baseRevision/.test(salvage));
  ok("and recorded as a stop, with its stats", /action: "stopped"/.test(salvage) && /stats: sum/.test(salvage));
  ok("a cut-off patch is never applied", !/edits/.test(salvage.replace(/\/\*[\s\S]*?\*\//g, "")));
}

console.log("\nUsage settlement retries before it gives up (LS-R3-008):");
{
  const ctlSrc = require("fs").readFileSync(require("path").join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const usage = ctlSrc.slice(ctlSrc.indexOf("const logStudioUsage = async"), ctlSrc.indexOf("async function commitTurn"));
  ok("three attempts with backoff", /attempt < 3/.test(usage) && /wait\(200 \* 4 \*\* attempt\)/.test(usage));
  ok("the final failure says how much went unmetered", /usage_settlement_failed/.test(usage) && /usd: row\.usd/.test(usage));
  ok("and still never fails the teacher's turn", !/throw/.test(usage));
}

console.log("\nThe transcript is bounded and the quota heals (LS-R3-015, LS-R3-017):");
{
  const svc = require("../services/lessonDocService");
  const svcSrc = require("fs").readFileSync(require("path").join(__dirname, "../services/lessonDocService.js"), "utf8");
  ok("there is a cap on messages", svc.MAX_MESSAGES === 400);
  ok("the append path keeps the newest", /\$slice: -MAX_MESSAGES/.test(svcSrc));
  ok("the commit's push path uses the same cap", /k === "messages" \? pushMessages\(v\)/.test(svcSrc));
  // The counter is a projection of the documents; a projection can drift.
  ok("a refused claim recounts from the documents", /const actual = await LessonDoc\.countDocuments\(\{ owner: ownerId, archivedAt: null \}\)/.test(svcSrc));
  ok("repairs the counter and claims again", /\$set: \{ lessonDocCount: actual \}/.test(svcSrc));
  ok("a failed release is retried and then said out loud", /slot_release_failed/.test(svcSrc));
}

console.log("\nEvery tool call is answered, or the API refuses the whole conversation:");
{
  /*
   * The live failure behind "AI sənədi hazırlaya bilmədi", three times in a
   * row on "copy this PDF": the model called set_print_options for the page's
   * accent colour AND write_material in one response, the render check replied
   * to the write alone, and the next call was a 400 — "tool_use ids were found
   * without tool_result blocks". The contract is the API's, so it is enforced
   * in the adapter, where no loop path can get around it.
   */
  const { claudeAdapter } = require("../helper/aiDocAdapters");
  const ad = claudeAdapter({ client: null, model: "claude-opus-5", tools: [], maxTokens: 10 });
  const history = [{ role: "user", content: [{ type: "text", text: "start" }] }];
  const turn = {
    raw: {
      content: [
        { type: "text", text: "Rəngi saxladım, sənədi yazıram." },
        { type: "tool_use", id: "toolu_print", name: "set_print_options", input: { accent: "orange" } },
        { type: "tool_use", id: "toolu_write", name: "write_material", input: { html: "<h1>x</h1>" } },
      ],
    },
  };
  // The loop answers only the write, as the render check does.
  ad.reply(history, turn, [{ call: { id: "toolu_write" }, isError: false, text: "render note" }], {});
  const user = history[history.length - 1];
  const results = user.content.filter((b) => b.type === "tool_result");
  ok("the assistant turn is replayed as it was", history[history.length - 2].content === turn.raw.content);
  ok("both calls get a result", results.map((r) => r.tool_use_id).sort().join() === "toolu_print,toolu_write");
  ok("the loop's own answer is kept verbatim", results.find((r) => r.tool_use_id === "toolu_write").text === undefined && results.find((r) => r.tool_use_id === "toolu_write").content === "render note");
  ok("the unanswered one is acknowledged, not errored", results.find((r) => r.tool_use_id === "toolu_print").content === "Qəbul edildi." && !results.find((r) => r.tool_use_id === "toolu_print").is_error);
  ok("tool results lead the message", user.content[0].type === "tool_result");

  // With an image handed back, the results still come first.
  const h2 = [{ role: "user", content: [{ type: "text", text: "start" }] }];
  ad.reply(h2, turn, [], { images: [Buffer.from("png")] });
  const u2 = h2[h2.length - 1];
  ok("even a reply with no findings answers every call", u2.content.filter((b) => b.type === "tool_result").length === 2);
  ok("and the picture follows them", u2.content[u2.content.length - 1].type === "image");
}

console.log("\nA known error code does not make its message safe (LS-R3-014):");
{
  /*
   * publicFailure used to fall through to `e.message` for any error carrying a
   * recognised code — so a provider error tagged provider_unavailable handed
   * its raw body to the teacher's toast. Only text written FOR a teacher
   * passes: a docError's userMessage, an AppError's message, or the fixed line.
   */
  const c = require("../controllers/lessonDocController");
  const raw = new Error("500 upstream at https://leak.example/?key=SECRET-LEAK");
  raw.code = "provider_unavailable";
  const pub = c.publicFailure(raw);
  ok("a raw error with a known code gets the fixed line", pub.code === "provider_unavailable" && !/SECRET-LEAK/.test(pub.message));
  const { httpError } = require("../utils/appError");
  const app = httpError(422, "validation_failed", "Cədvəl sətri qısadır.");
  ok("an AppError's own sentence still passes", c.publicFailure(app).message === "Cədvəl sətri qısadır.");
  const docErr = new Error("anthropic 500 <html>");
  docErr.code = "provider_unavailable";
  docErr.userMessage = "AI xidməti cavab vermir.";
  ok("a docError's userMessage still passes", c.publicFailure(docErr).message === "AI xidməti cavab vermir.");
}

console.log("\nA turn says what it is doing while it does it:");
{
  const path7 = require("path");
  const fs7 = require("fs");
  const drvSrc = fs7.readFileSync(path7.join(__dirname, "../helper/aiDocDrivers.js"), "utf8");
  const ctlSrc = fs7.readFileSync(path7.join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const adSrc = fs7.readFileSync(path7.join(__dirname, "../helper/aiDocAdapters.js"), "utf8");
  const docSrc = fs7.readFileSync(path7.join(__dirname, "../helper/aiDocument.js"), "utf8");
  const S7 = require("../helper/lessonDocSchema");
  const { runToolLoop } = require("../helper/aiDocDrivers");

  const fake = (script) => {
    let i = 0;
    return {
      name: "fake",
      cancelled: () => new Error("cancelled"),
      start: () => [],
      send: async () => script[Math.min(i++, script.length - 1)],
      addCost: (c) => c,
      nudge: () => {},
      reply: () => {},
    };
  };
  const DOC = "<h1>A</h1><p>one</p>";

  /*
   * THE COMPLAINT: a turn showed its plan once and then nothing moved for
   * sixteen minutes. Every event below is one of the things it was doing in
   * that silence.
   */
  pending.push(
    (async () => {
      const seen = [];
      const out = await runToolLoop(
        fake([
          { raw: {}, usage: {}, calls: [{ id: "1", name: "read_source", input: { name: "x.pdf", pages: "1-3" } }], said: "" },
          { raw: {}, usage: {}, calls: [{ id: "2", name: "write_material", input: { html: DOC } }], said: "" },
          { raw: {}, usage: {}, calls: [], said: "uygundur" },
        ]),
        {
          onEvent: (k, d) => seen.push([k, d]),
          fetchSource: async () => ({ name: "x.pdf", part: { mime: "application/pdf", data: "" }, served: { from: 1, to: 3 }, total: 12 }),
          look: async () => ({ shots: [], pages: 2 }),
          gridOf: () => "",
        }
      );
      const kinds = seen.map((s) => s[0]);
      ok("it reports asking for a source", kinds.includes("read"));
      ok("and what was actually served", kinds.includes("served") && seen.find((s) => s[0] === "served")[1].total === 12);
      ok("it reports rendering the draft", kinds.includes("look") && kinds.includes("looked"));
      ok("it reports the document it wrote", kinds.includes("wrote"));
      ok("it reports agreement rather than ending in silence", kinds.includes("agree"));
      ok("and the turn counts its own rounds", out.stats && out.stats.rounds === 3 && out.stats.reads === 1 && out.stats.looked === true);
    })()
  );

  /*
   * THE COST: a fix used to mean re-emitting the whole document, because a
   * patch could only apply to what was on disk — which during a creation is
   * nothing. The loop carries the draft now, so a later round patches the
   * page the model just wrote instead of typing it again.
   */
  pending.push(
    (async () => {
      const out = await runToolLoop(
        fake([
          { raw: {}, usage: {}, calls: [{ id: "1", name: "write_material", input: { html: DOC } }], said: "" },
          { raw: {}, usage: {}, calls: [{ id: "2", name: "edit_material", input: { edits: [{ find: "one", replace: "two" }] } }], said: "" },
          { raw: {}, usage: {}, calls: [], said: "hazirdir" },
        ]),
        {
          onEvent: () => {},
          // A finding on the first document is what makes a second round
          // happen at all — and the fix for it must land on that document.
          validate: (name) => (name === "write_material" ? "cədvəl sətri qısadır" : ""),
          htmlOf: (c, draft) => {
            if (c.name === "write_material") return c.input.html;
            if (c.name === "edit_material") return String(draft || "").replace("one", "two");
            return "";
          },
          look: async () => null,
        }
      );
      ok("a patch in a later round applies to the draft, not to an empty document", out.document?.html === "<h1>A</h1><p>two</p>");
      ok("and the turn commits what it ended on", out.document.call.name === "edit_material");
    })()
  );

  ok("the loop offers the draft to the caller's resolver", /htmlOf\(c, draft\)/.test(drvSrc));
  ok("and to its validator", /validate\(c\.name, c\.input \|\| \{\}, draft\)/.test(drvSrc));
  ok("the controller patches against the draft", /applyEdits\(draft \|\| doc\.html \|\| ""/.test(ctlSrc));
  ok("and commits the document the loop ended on", /if \(out\.document && out\.document\.html\)/.test(ctlSrc));
  ok("a finding tells the model to patch rather than retype", /PATCH_HINT/.test(drvSrc));
  ok("the render check no longer asks for the whole document back", !/eyni HTML-i yenidən göndər\./.test(drvSrc));
  ok("it asks for a sentence instead", /HEÇ BİR alət çağırma/.test(drvSrc));

  // The narration: codes in, sentences out, never model text.
  const { activityText } = require("../controllers/lessonDocController");
  ok("a read names the file", /x\.pdf/.test(activityText("read", { name: "x.pdf", pages: "1-3" })));
  ok("a render says what it measured", /səhifə/.test(activityText("looked", { pages: 2, bands: 0 })));
  ok("a finding says how many", /2 problem/.test(activityText("finding", { n: 2 })));
  ok("an unknown code says nothing at all", activityText("whatever", {}) === "");
  ok("the controller sends them as they happen", /send\("activity", entry\)/.test(ctlSrc));
  ok("and keeps them on the saved turn", /steps: plan\?\.sections \|\| \[\], activity \}/.test(ctlSrc));
  ok("the list is bounded", /activity\.length < 80/.test(ctlSrc));

  /*
   * THE OTHER MODELS: only Claude streamed, so a GPT turn was minutes of
   * nothing at all. The Responses API streams the tool call's arguments,
   * which IS the document being written.
   */
  const { readResponseStream } = require("../helper/aiDocAdapters");
  ok("the OpenAI adapter accepts a progress callback", /function openaiAdapter\(\{ model, tools, maxTokens, onText \}\)/.test(adSrc));
  ok("and asks for a stream when one is listening", /\.\.\.\(live \? \{ stream: true \} : \{\}\)/.test(adSrc));
  ok("the document path hands it one", /openaiAdapter\(\{ model, tools, maxTokens, onText \}\)/.test(docSrc));

  pending.push(
    (async () => {
      const frames = [
        'event: response.function_call_arguments.delta\ndata: {"item_id":"a","delta":"{\\"html\\":\\"<h1>A<"}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"item_id":"a","delta":"/h1>\\"}"}\n\n',
        'event: response.completed\ndata: {"response":{"output":[{"type":"function_call","call_id":"c1","name":"write_material","arguments":"{}"}],"usage":{"input_tokens":5,"output_tokens":6}}}\n\n',
      ];
      const all = frames.join("");
      const body = (async function* gen() {
        // Cut at 37 bytes: a chunk boundary is not a frame boundary.
        for (let i = 0; i < all.length; i += 37) yield Buffer.from(all.slice(i, i + 37));
      })();
      const snaps = [];
      const res = await readResponseStream(body, (t) => snaps.push(t), null);
      ok("a streamed OpenAI turn reports progress as it writes", snaps.length === 2 && snaps[1].includes("</h1>"));
      ok("and still returns the whole response at the end", res.output[0].call_id === "c1" && res.usage.output_tokens === 6);
    })()
  );

  // Progress names the part rather than counting anonymously.
  const named = S7.makeProgressStreamer()('{"title":"T","reply":"salam","html":"<h1>Çevrə</h1><p>Radius nədir</p>');
  ok("a finished part carries its tag", named[0].tag === "h1" && named[1].tag === "p");
  ok("and its own words", named[0].text === "Çevrə" && named[1].text === "Radius nədir");
  ok("the title and the reply are not read as the document", !named.some((b) => /salam/.test(b.text)));
}

console.log("\nWhat a turn costs, and why it took sixteen minutes:");
{
  const path8 = require("path");
  const fs8 = require("fs");
  const ctl = fs8.readFileSync(path8.join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const ad = fs8.readFileSync(path8.join(__dirname, "../helper/aiDocAdapters.js"), "utf8");
  const doc = fs8.readFileSync(path8.join(__dirname, "../helper/aiDocument.js"), "utf8");
  const S8 = require("../helper/lessonDocSchema");
  const { summarizeHtml } = require("../controllers/lessonDocController");

  /*
   * THE BUG, and it is the reason every material read "0 hissə".
   *
   * A `\b` word boundary was written into this regex as a literal BACKSPACE
   * byte, so it demanded a control character in the middle of HTML and
   * matched nothing at all. It parsed, it linted, and it printed correctly in
   * a terminal — a backspace shows as nothing. Only the bytes gave it away.
   */
  const real =
    '<div style="font-family:Georgia"><h1>ÇEVRƏ</h1><p>Mətn</p>' +
    '<svg><polygon points="0,0"/><circle r="4"/></svg><table><tr><td>a</td></tr></table></div>';
  ok("a document with parts does not report zero", summarizeHtml(real).blocks > 0);
  // <h1>, <p>, <table>. Not <tr>, not <td>, and — the point of the boundary —
  // not <polygon> or <path>, which both begin "<p".
  ok("it counts the real parts", summarizeHtml(real).blocks === 3, summarizeHtml(real).blocks);
  ok("and <polygon> is not a paragraph", summarizeHtml("<polygon/><path/>").blocks === 0);
  ok("one rule, shared with the create-or-edit decision", summarizeHtml(real).blocks === S8.countParts({ html: real }));
  ok("the controller no longer keeps its own copy of the rule", /blocks: S\.countParts\(\{ html \}\)/.test(ctl));

  // The canary that would have caught it, on every shipping file.
  const check = fs8.readFileSync(path8.join(__dirname, "../scripts/staticCheck.cjs"), "utf8");
  ok("the static check refuses a control character in source", /control character \$\{code\} in source/.test(check));
  {
    // Prove the canary actually fires, rather than trusting that it is present.
    const rule = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
    ok("it catches a backspace written into a regex", rule.test("count(/<p\x08/gi)"));
    ok("it leaves tabs and newlines alone", !rule.test("a\tb\r\nc"));
  }

  /*
   * WHERE THE MONEY WENT. The measured turn: 16 minutes, $3.18, 92,721 output
   * tokens for a document of ~11,800 — the document twice plus ~69,000 tokens
   * of thinking, all billed at the output rate.
   */
  ok("effort is a dial, not a constant", /STUDIO_EFFORT_CREATE/.test(ctl) && /STUDIO_EFFORT_EDIT/.test(ctl));
  ok("creation no longer thinks at full effort by default", /effortFrom\(process\.env\.STUDIO_EFFORT_CREATE, "medium"\)/.test(ctl));
  ok("the write pass reads the dial", /effort: hadBlocks \? EFFORT_EDIT : EFFORT_CREATE/.test(ctl));
  ok("a junk value falls back rather than reaching the provider", /EFFORT\.has\(String\(value \|\| ""\)\)/.test(ctl));
  ok("the plan pass thinks less than the writing pass", /effort: hadBlocks \? "low" : "medium"/.test(ctl));

  /*
   * THE CACHE. Rounds are minutes apart, and the default cache lives five
   * minutes — so the prefix expired between rounds and was re-WRITTEN at
   * 1.25x instead of read at 0.1x (124,559 cache-write tokens on one turn).
   */
  ok("the stable prefix is cached for an hour", /ttl: "1h"/.test(ad));
  ok("the system block uses it", /cache_control: LONG_LIVED/.test(ad));
  ok("so do the attached files", /setCache\(history\[users\[0\]\], LONG_LIVED\)/.test(ad));
  ok("the moving tail keeps the cheap five-minute write", /setCache\(history\[users\[users\.length - 1\]\]\);/.test(ad));

  // The plan pass: the teacher's model, and counted in the bill.
  ok("the first pass runs on the model the teacher chose", /const usedModel = /.test(doc));
  ok("it is no longer hard-coded", !/model: "claude-opus-4-8",\n        max_tokens/.test(doc));
  ok("it is priced at the model it ran on", /computeCost\(message\.usage, usedModel\)/.test(doc));
  ok("and its cost joins the turn's bill", /sumCost\(out\.cost, planCost\)/.test(ctl));
  ok("where the minutes went is logged", /turn_done/.test(ctl) && /planMs: t\.planMs/.test(ctl));
}

console.log("\nA turn is metered (LS-R3-001, owner decision 2026-09-13):");
{
  const { meterFor, chargeAi } = require("../middleware/aiCredit");
  const routes = require("fs").readFileSync(require("path").join(__dirname, "../routes/lessonDocRoute.js"), "utf8");
  const ctlSrc = require("fs").readFileSync(require("path").join(__dirname, "../controllers/lessonDocController.js"), "utf8");

  // The guards every other paid AI route carries.
  ok("the route rate-limits", /aiRateLimit,/.test(routes.slice(routes.indexOf("const aiChain"))));
  ok("and caps daily spend", /aiBudgetGuard,/.test(routes.slice(routes.indexOf("const aiChain"))));
  ok("both operations must be active for the route to exist", /requireActiveOperation\("ai\.edit\.material"\)/.test(routes));

  /*
   * The charge is decided in the controller because the route cannot know
   * whether this is a creation or an edit — and it is decided BEFORE the SSE
   * headers, so a refusal is a JSON 402 the client can read.
   */
  const stream = ctlSrc.slice(ctlSrc.indexOf("const streamMessage = asyncHandler"));
  const meterAt = stream.indexOf("req.aiCredit = meterFor(req, hadBlocks");
  ok("the meter runs in the controller", meterAt > 0);
  ok("before the headers go out", meterAt < stream.indexOf("res.writeHead(200"));
  ok("and before the teacher's message is stored, so a refused turn leaves no orphan", meterAt < stream.indexOf("await svc.appendMessages(doc._id, doc.owner, {\n    role: \"user\""));
  ok("a creation and an edit are priced differently", /hadBlocks \? "ai\.edit\.material" : "ai\.generate\.material"/.test(stream));

  // The decision itself, against a fake request.
  const teacher = (credits) => ({ user: { _id: "t", role: "teacher", aiCredits: credits } });
  let refused = null;
  try { meterFor(teacher(1), "ai.generate.material"); } catch (e) { refused = e; }
  ok("a teacher who cannot afford it is refused", refused && refused.code === "insufficient_credits");
  ok("with a 402", refused && (refused.status === 402 || refused.statusCode === 402));
  ok("and told the cost and the balance", refused && /6 kredit/.test(refused.message) && /balansınızda 1/.test(refused.message));
  const m = meterFor(teacher(10), "ai.edit.material");
  ok("a teacher who can afford it gets a one-shot meter", m && m.cost === 2 && typeof m.usable === "function");
  ok("an admin is never charged", meterFor({ user: { _id: "a", role: "admin", aiCredits: 0 } }, "ai.generate.material") === null);
  ok("an unpriced operation cannot be metered at all", (() => { try { meterFor(teacher(100), "ai.generate.lessonplan"); return true; } catch { return false; } })() === true);
  ok("the route middleware is a wrapper over the same meter", typeof chargeAi("ai.generate.material") === "function");

  /*
   * Charged at the genuine success points, and not at a question back — the
   * model has not done the work yet — nor on failure, stop or refusal.
   */
  const doneSites = (stream.match(/send\("done", \{/g) || []).length;
  const chargedSites = (stream.match(/chargeTurn\(req, send\);\n\s*send\("done", \{/g) || []).length;
  ok("every done except the question is charged", doneSites >= 3 && chargedSites === doneSites - 1);
  const askedBlock = stream.slice(stream.indexOf('action: "asked"'), stream.indexOf('action: "asked"') + 700);
  ok("a question back is free", !/chargeTurn/.test(askedBlock));
  ok("a failed turn is free", !/chargeTurn/.test(stream.slice(stream.indexOf("const pub = publicFailure(e);"), stream.indexOf("const pub = publicFailure(e);") + 400)));
  ok("the client is told what it cost", /send\("credits", \{ operation: m\.operation, charged: m\.cost, left:/.test(ctlSrc));
  const stopAt = stream.indexOf("salvaged = true;");
  ok("a stop that kept content is charged", /req\.aiCredit\.usable\(\)/.test(stream.slice(stopAt, stopAt + 500)));
  const noneAt = stream.indexOf("if (!salvaged) {");
  ok("a stop that kept nothing is not", !/usable/.test(stream.slice(noneAt, noneAt + 300)));

  /*
   * Idempotency: the same send twice is one turn. The id is the browser's, stored
   * on the teacher's message, and a second arrival is refused before anything
   * is stored or charged.
   */
  ok("a repeated turn id is refused", /"duplicate_turn"/.test(stream));
  ok("before the meter and the message", stream.indexOf('"duplicate_turn"') < meterAt);
  ok("and the id is kept with the message", /\.\.\.\(turnId \? \{ turnId \} : \{\}\)/.test(stream));
}

console.log("\nAn admin's library lists every teacher's materials:");
{
  const path9 = require("path");
  const ctl9 = require("fs").readFileSync(path9.join(__dirname, "../controllers/lessonDocController.js"), "utf8");
  const listSrc = ctl9.slice(ctl9.indexOf("const listDocs ="), ctl9.indexOf("// POST /"));

  /*
   * mine() has always let an admin OPEN any material; nothing listed them, so an
   * admin could reach one only by being handed its URL. The pairing is what
   * matters — read access that cannot discover anything is not access — so both
   * halves are pinned here.
   */
  ok("mine() exempts an admin", /const admin = req\.user\?\.role === "admin"/.test(ctl9));
  ok("the list scope is owner-based for a teacher", /owner: req\.user\._id, archivedAt: null/.test(listSrc));
  ok("and unscoped for an admin", /isAdmin\s*\?\s*\{ archivedAt: null \}/.test(listSrc));

  // A teacher's rows are all their own, so the owner id is of no use to them and
  // is dropped rather than shipped.
  ok("a teacher's response carries no owner id", /if \(!isAdmin\) \{[\s\S]{0,160}map\(\(\{ owner, \.\.\.d \}\) => d\)/.test(listSrc));

  // Without the author, a platform-wide grid is indistinguishable from the
  // admin's own work.
  ok("an admin's rows name the author", /ownerName: author\?\.name/.test(listSrc));
  ok("and mark which rows are the admin's own", /mine: String\(owner\) === String\(req\.user\._id\)/.test(listSrc));
  ok("a deleted author still renders", /Silinmiş istifadəçi/.test(listSrc));

  // One query for the page's authors, not one per row.
  ok("authors are fetched in a single query", /\$in: ownerIds/.test(listSrc));

  /*
   * A teacher's list is bounded by MAX_DOCS; the admin's is every teacher's
   * added together and grows with the platform. The cap keeps the response
   * renderable and `total` is what stops a truncated page reading as the whole
   * library.
   */
  ok("the admin list is capped", /\$limit: ADMIN_LIST_CAP/.test(listSrc));
  ok("and the cap is configurable", /STUDIO_ADMIN_LIST_MAX/.test(ctl9));
  ok("the true total is reported alongside", /total = await LessonDoc\.countDocuments\(match\)/.test(listSrc));
}

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} lesson-doc assertions failed`);
  process.exit(failed ? 1 : 0);
});
