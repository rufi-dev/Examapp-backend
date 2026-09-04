/*
 * The printable lesson plan.
 *
 * It is a pure function from a plan to a document, which is the whole reason it can
 * be tested at all — the Chromium step only turns that document into paper.
 *
 * What matters here: every optional block disappears WITH its heading when empty (a
 * dangling label on a printed page is worse than a missing section), the time bar
 * is computed from the data rather than assumed, nothing a teacher typed can inject
 * markup, and every block that must not split across a page says so.
 */
const assert = require("assert");
const { buildLessonPlanHtml } = require("../helper/lessonPlanPrintHtml");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

const FULL = {
  title: "Modal fellər",
  topic: "Modal fellər",
  subject: "İngilis dili",
  grade: "11",
  ownerName: "Rufi Aliyev",
  lessonMinutes: 45,
  objectives: ["Məqsəd bir", "Məqsəd iki"],
  criteria: ["Meyar bir", "Meyar iki", "Meyar üç"],
  motivation: "Giriş",
  motivationOrigin: "ai",
  stages: [
    { name: "Motivasiya", minutes: 5, teacher: "İzah edir", student: "Dinləyir", checks: "Suallar", differentiation: "Sadə nümunə", resources: "Lövhə" },
    { name: "Tədqiqat", minutes: 15, teacher: "Qaydaları izah edir", student: "Qeyd aparır" },
    { name: "Ümumiləşdirmə", minutes: 25, teacher: "Müzakirə", student: "Müqayisə edir" },
  ],
  tasks: [
    { statement: "Boşluğu doldurun: he ___ swim.", answer: "can", solution: "Bacarıq bildirir.", bloom: "Tətbiq" },
    { statement: "Səhvi tapın və düzəldin.", answer: "to artıqdır", bloom: "Təhlil" },
    { statement: "Öz cümlənizi yazın.", bloom: "Yaratma" },
  ],
  homework: "Səhifə 78, çalışma 5.",
  homeworkWarning: "İstinad yoxlanılmadı: faylda 78-ci səhifə yoxdur.",
  reflection: "Sual bir\nSual iki",
  materials: ["Dərslik", "Lövhə"],
};

console.log("\n1. A complete plan renders every section:");
{
  const h = buildLessonPlanHtml(FULL, { A: FULL.tasks, B: FULL.tasks });
  for (const [what, needle] of [
    ["masthead", "Examopia"],
    ["title", "Modal fellər"],
    ["objectives", "Məqsədlər"],
    ["criteria", "Qiymətləndirmə meyarları"],
    ["lesson flow", "Dərsin gedişi"],
    ["assignments", "Tapşırıqlar"],
    ["homework", "Ev tapşırığı"],
    ["reflection", "Refleksiya"],
    ["resources", "Resurslar"],
  ]) ok(`${what} present`, h.includes(needle));

  ok("the teacher's name reaches the meta grid", h.includes("Rufi Aliyev"));
  ok("the AI notice is shown for an AI-written flow", h.includes("süni intellekt tərəfindən"));
  ok("the unverified reference is a warning, not body text", /notice warn[\s\S]*78-ci səhifə yoxdur/.test(h));
  ok("answers render in the plum box", h.includes('class="answer"') && h.includes("Bacarıq bildirir."));
}

console.log("\n2. The time bar is computed, never assumed:");
{
  const h = buildLessonPlanHtml(FULL);
  // 5 / 15 / 25 of 45 minutes.
  ok("first segment is 5/45", h.includes("width:11.11111111111111%"), h.match(/width:[\d.]+%/g)?.slice(0, 3));
  ok("second segment is 15/45", h.includes("width:33.33333333333333%"));
  ok("third segment is 25/45", h.includes("width:55.55555555555556%"));
  ok("the legend shows real minutes", h.includes("5′") && h.includes("15′") && h.includes("25′"));
  ok("the header states the true total", h.includes("45 dəqiqə · 3 mərhələ"));

  // With no minutes recorded, drawing equal thirds would be a lie about timing.
  const noMin = buildLessonPlanHtml({ ...FULL, stages: FULL.stages.map((s) => ({ ...s, minutes: 0 })) });
  ok("no minutes → no bar at all", !noMin.includes('class="timebar"'));
  ok("but the stages still render", noMin.includes("Motivasiya"));
}

console.log("\n3. Empty optional blocks vanish WITH their headings:");
{
  const bare = buildLessonPlanHtml({ title: "Boş plan" });
  for (const heading of ["Dərsin gedişi", "Tapşırıqlar", "Ev tapşırığı", "Resurslar", "Məqsədlər"])
    ok(`no dangling "${heading}"`, !bare.includes(heading));
  ok("the masthead still renders", bare.includes("Boş plan") && bare.includes("Dərs planı"));
  ok("missing fields get a writable dotted line", bare.includes('class="blank"'));

  const noHw = buildLessonPlanHtml({ ...FULL, homework: "", homeworkWarning: "" });
  ok("no homework → no homework section", !noHw.includes("Ev tapşırığı"));
  const noWarn = buildLessonPlanHtml({ ...FULL, homeworkWarning: "" });
  ok("homework without a warning shows no warning box", noWarn.includes("Ev tapşırığı") && !noWarn.includes("notice warn"));
  const human = buildLessonPlanHtml({ ...FULL, motivationOrigin: "teacher" });
  ok("a teacher-written flow carries no AI notice", !human.includes("süni intellekt"));
}

console.log("\n4. Nothing a teacher typed can inject markup:");
{
  const nasty = "<script>alert(1)</script> & \"quotes\" <b>bold</b>";
  const h = buildLessonPlanHtml({
    title: nasty,
    ownerName: nasty,
    stages: [{ name: nasty, minutes: 10, teacher: nasty }],
    tasks: [{ statement: nasty, answer: nasty, solution: nasty }],
    homework: nasty,
    materials: [nasty],
  });
  ok("no live script tag anywhere", !h.includes("<script>"));
  ok("it is escaped instead", h.includes("&lt;script&gt;"));
  ok("quotes are escaped", h.includes("&quot;"));
  ok("ampersands are escaped", h.includes("&amp;"));
  ok("no injected bold survives", !h.includes("<b>bold</b>"));
}

console.log("\n5. Page-break control and worksheets:");
{
  const h = buildLessonPlanHtml(FULL, { A: FULL.tasks, B: FULL.tasks, C: FULL.tasks });
  ok("stages never split", /\.stage\{[^}]*break-inside:avoid/.test(h));
  ok("tasks never split", /\.task\{[^}]*break-inside:avoid/.test(h));
  ok("worksheet questions never split", /\.ws-q\{[^}]*break-inside:avoid/.test(h));
  ok("each worksheet starts a page", /\.worksheet\{[^}]*break-before:page/.test(h));

  ok("three variants render", (h.match(/class="variant-badge"/g) || []).length === 3);
  ok("badge letters come from the data, not hardcoded", h.includes(">C</div>"));
  ok("answer lines are provided", h.includes('class="ruled"'));
  ok("a working question gets two lines", (h.match(/<div class="ruled"><\/div><div class="ruled">/g) || []).length > 0);
  ok("the name bar is writable", h.includes("Ad, soyad"));

  const none = buildLessonPlanHtml(FULL, null);
  ok("no variants → no worksheet pages", !none.includes('class="variant-badge"'));
  const empty = buildLessonPlanHtml(FULL, { A: [] });
  ok("an empty variant is skipped, not printed blank", !empty.includes('class="variant-badge"'));
}

console.log("\n6. It survives real-world content:");
{
  const long = "söz ".repeat(400) + "Unbreakablesupercalifragilisticexpialidociousword".repeat(3);
  const h = buildLessonPlanHtml({
    title: "Uzun",
    stages: Array.from({ length: 8 }, (_, i) => ({ name: `Mərhələ ${i + 1}`, minutes: 6, teacher: long })),
    tasks: Array.from({ length: 20 }, (_, i) => ({ statement: `Tapşırıq ${i + 1}`, bloom: "Tətbiq" })),
  });
  ok("eight stages all render", (h.match(/class="stage"/g) || []).length === 8);
  ok("twenty tasks all render", (h.match(/class="task"/g) || []).length === 20);
  ok("an unbreakable word cannot overflow the column", h.includes("overflow-wrap:anywhere"));
  ok("A4 page size is declared", /@page\{size:A4/.test(h));
  ok("Azerbaijani text is preserved verbatim", h.includes("Mərhələ 1"));
  ok("an unknown Bloom level still gets a tag", buildLessonPlanHtml({ tasks: [{ statement: "x", bloom: "Sintez" }] }).includes("Sintez"));
  ok("no Bloom level → no empty tag", !buildLessonPlanHtml({ tasks: [{ statement: "x" }] }).includes('class="tag'));
  ok("junk input does not throw", typeof buildLessonPlanHtml(null) === "string" && typeof buildLessonPlanHtml(undefined, undefined) === "string");
}

console.log("\n8. The renderer must hand Express a Buffer:");
{
  /*
   * Puppeteer 24 returns a Uint8Array where older versions returned a Buffer, and
   * Express's res.send() sends a Buffer as bytes but falls through to res.json()
   * for ANY other object. A Uint8Array therefore reached the browser as
   * {"0":37,"1":80,…} under a Content-Type of application/pdf — ten times the size
   * and not a PDF, which is "Failed to load PDF document" against a body that had
   * arrived perfectly intact.
   *
   * Chromium is not launched here: the contract is textual, and what this guards
   * against is a silent revert on the next upgrade.
   */
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "../helper/lessonPlanPdf.js"), "utf8");

  ok("the pdf result is wrapped in Buffer.from", /return Buffer\.from\(await page\.pdf\(/.test(src));
  ok("printBackground is on, or every tint prints blank", /printBackground:\s*true/.test(src));
  // The renderer is shared with the MSO analytic table, so the label is a
  // parameter — but a footer of OUR making must still be what displaces the
  // browser's date/title/URL stamp.
  /*
   * A lesson material can now turn page numbers off, so the footer is
   * conditional — but BOTH branches must be ours. Falling back to Chromium's
   * default would put the date, the title and the file URL back on every sheet,
   * which is the whole reason this renderer exists.
   */
  ok("our own footer replaces the browser's", /footerTemplate:\s*pageNumbers \? footerFor\(footerLabel\) : "<div><\/div>"/.test(src));
  ok("and header/footer rendering is never handed back", !/displayHeaderFooter:\s*false/.test(src));
  ok("the lesson plan's own label is still the default", /footerLabel = "dərs planı"/.test(src));
  ok("the header template is emptied", /headerTemplate:\s*"<div><\/div>"/.test(src));
  ok("fonts are awaited before rendering", /document\.fonts\.ready/.test(src));
  ok("the browser is always closed", /finally\s*\{[\s\S]*browser\.close/.test(src));

  const ctl = fs.readFileSync(path.join(__dirname, "../controllers/lessonPlanController.js"), "utf8");
  ok("the response declares application/pdf", /application\/pdf/.test(ctl));
  ok("and is not cached", /private, no-store/.test(ctl));
}

console.log("\n9. One variant on its own:");
{
  /*
   * What a teacher hands to a row of desks. The full plan carries the objectives,
   * the stage timing and the ANSWERS — none of which belong on a sheet a student
   * writes on, and the last of which would hand them the paper.
   */
  const { buildWorksheetHtml } = require("../helper/lessonPlanPrintHtml");
  const plan = {
    title: "Modal fellər",
    topic: "Modal fellər",
    subject: "İngilis dili",
    grade: 11,
    ownerName: "Rufi",
    objectives: ["Məqsəd bir", "Məqsəd iki"],
    stages: [{ name: "Motivasiya", minutes: 5 }],
    reflection: "Refleksiya mətni",
  };
  const rows = [
    { statement: "Boşluqları can ilə doldurun.", answer: "can", solution: "can — bacarıq bildirir" },
    { statement: "İkinci tapşırıq." },
  ];
  const html = buildWorksheetHtml(plan, "A", rows);

  ok("it is a complete document", html.startsWith("<!DOCTYPE html>") && html.includes("</html>"));
  ok("the variant is named", html.includes("Variant A"));
  ok("both tasks are on the sheet", html.includes("can ilə doldurun") && html.includes("İkinci tapşırıq"));
  ok("there is somewhere to write a name", html.includes("Ad, soyad"));
  ok("ruled writing lines are drawn", html.includes("ruled"));

  // The whole point of it being a separate document.
  ok("the objectives are NOT on it", !html.includes("Məqsəd bir"));
  ok("the stage timing is NOT on it", !html.includes("Motivasiya"));
  ok("the reflection is NOT on it", !html.includes("Refleksiya mətni"));
  ok("the ANSWER is not printed", !html.includes("bacarıq bildirir"));

  ok("it shares the plan stylesheet", html.includes("worksheet"));
  ok("only installed fonts are named", !html.includes("Inter") && !html.includes("Noto"));
  ok("no external resource is referenced", !/https?:\/\//.test(html));

  // Junk must not throw: a print request is not the place to 500.
  ok("no rows still yields a document", buildWorksheetHtml(plan, "B", []).includes("tapşırıq yoxdur"));
  ok("a null plan does not throw", typeof buildWorksheetHtml(null, "A", rows) === "string");
  ok("a non-array rows value does not throw", typeof buildWorksheetHtml(plan, "A", null) === "string");

  // The route contract.
  const fs2 = require("fs");
  const path2 = require("path");
  const ctl = fs2.readFileSync(path2.join(__dirname, "../controllers/lessonPlanController.js"), "utf8");
  ok("the route reads ?variant", /req\.query\.variant/.test(ctl));
  ok("an unknown variant is refused, not served as the whole plan", /variant_missing/.test(ctl));
  ok("the footer says which document it is", /footerLabel: wanted/.test(ctl));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} lesson-plan-print assertions failed`);
process.exit(failed ? 1 : 0);
