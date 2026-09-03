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
  ok("empty table rows are dropped", by("table").rows.length === 1);
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
  ok("the teacher's message is stored before the model runs", /doc\.save\(\)[\s\S]{0,400}runDocument/.test(ctl));
  ok("a hand edit never calls the model", /const updateDoc[\s\S]{0,1200}/.test(ctl) && !/const updateDoc[\s\S]{0,1200}runDocument/.test(ctl));
  ok("edits are guarded by the revision CAS", /doc_conflict/.test(ctl));
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
  ok("and how to transcribe one", S.SOURCE_RULES.includes("ÇEVİRMƏ İSTƏYİ"));
  ok("and not to invent unreadable parts", S.SOURCE_RULES.includes("[oxunmadı]"));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} lesson-doc assertions failed`);
process.exit(failed ? 1 : 0);
