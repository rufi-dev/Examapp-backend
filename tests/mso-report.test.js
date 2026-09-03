/*
 * The MSO analytic table.
 *
 * The whole table is reconstructed from a string the model wrote, so the risk is
 * not that it crashes — it is that a slightly different string silently produces
 * an empty or shifted table that a teacher then hands to a methodologist. These
 * tests pin the two properties that matter: a well-formed title yields exactly
 * the five columns, and a malformed one loses only the cell it broke.
 *
 * Pure functions, no DB and no Chromium: the HTML is checked as text.
 */
const assert = require("assert");
const r = require("../helper/msoReport");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

const FULL =
  "(Dərslik, səh. 124, № 8) · Blum: Tətbiq · Alt-standart: 3.4.1 · Meyar: Sahəni hesablayır · Yoxlayır: Sahə düsturunun bilinməsi";

console.log("\n1. The exact format the prompt asks for:");
{
  const p = r.parseTitle(FULL);
  ok("page and task number are read together", p.source === "səh. 124 №8", p.source);
  ok("bloom", p.bloom === "Tətbiq", p.bloom);
  ok("sub-standard", p.subStandard === "3.4.1", p.subStandard);
  ok("criterion", p.criterion === "Sahəni hesablayır", p.criterion);
  ok("tested skill", p.skill === "Sahə düsturunun bilinməsi", p.skill);
  ok("no field bleeds into the next", !p.criterion.includes("Yoxlayır"));
}

console.log("\n2. A broken title loses only the broken cell:");
{
  // This is the point of the whole parser. The model omitting one label must not
  // cost the teacher the other four columns, and must never shift a value into
  // the wrong column — a criterion printed under "Alt-standart" is worse than a dash.
  const p = r.parseTitle("(Dərslik, səh. 90) · Alt-standart: 2.1.1");
  ok("the page survives", p.source === "səh. 90", p.source);
  ok("the sub-standard survives", p.subStandard === "2.1.1", p.subStandard);
  ok("the missing criterion is a dash, not a guess", p.criterion === r.DASH, p.criterion);
  ok("the missing skill is a dash", p.skill === r.DASH, p.skill);

  const none = r.parseTitle("nothing useful here at all");
  ok("an unparseable title yields five dashes, not a throw",
    Object.values(none).every((v) => v === r.DASH), JSON.stringify(none));
  ok("an empty title is handled", r.parseTitle("").source === r.DASH);
  ok("null is handled", r.parseTitle(null).source === r.DASH);
  ok("undefined is handled", r.parseTitle(undefined).source === r.DASH);
}

console.log("\n3. Tolerant of the ways the model actually drifts:");
{
  ok("reordered fields still parse",
    r.parseTitle("Alt-standart: 1.2.3 · (səh. 7, № 2) · Meyar: Oxuyur").subStandard === "1.2.3");
  ok("no parentheses around the citation",
    r.parseTitle("Dərslik səh. 44 № 9 · Meyar: X").source === "səh. 44 №9");
  ok("a literal page label is kept as a string",
    r.parseTitle("(Dərslik, səh. 12a, № 3)").source === "səh. 12a №3");
  ok("a roman page label is kept",
    r.parseTitle("(Dərslik, səh. iv, № 1)").source === "səh. iv №1");
  ok("a task number without a page still shows",
    r.parseTitle("(Dərslik, № 8) · Meyar: X").source === `səh. ${r.DASH} №8`);
  ok("'Yoxlanılır' is accepted alongside 'Yoxlayır'",
    r.parseTitle("Yoxlanılır: Fikri əsaslandırma").skill === "Fikri əsaslandırma");
  ok("extra whitespace and line breaks are collapsed",
    r.parseTitle("  Alt-standart:   2.2.2  \n · Meyar:  Y ").subStandard === "2.2.2");
  ok("a label with no value is a dash, not an empty cell",
    r.parseTitle("Alt-standart:  · Meyar: Y").subStandard === r.DASH);
}

console.log("\n4. Row numbering must match the paper:");
{
  const rows = r.buildReportRows([
    { type: "Cm", text: "Birinci", title: FULL, points: 5 },
    { type: "reading", text: "Uzun oxu mətni", title: "Mətn 1" },
    { type: "Co", text: "İkinci", title: "(Dərslik, səh. 91, № 3)" },
    { type: "Cm", text: "Üçüncü", title: "" },
  ]);
  ok("reading blocks are not rows", rows.length === 3, rows.length);
  // A reading block counted as a task would make every row after it point at the
  // wrong question — the table would look complete and be wrong throughout.
  ok("numbering skips the reading block", rows.map((x) => x.no).join(",") === "1,2,3");
  ok("the row after a reading block keeps its own citation", rows[1].source === "səh. 91 №3");
  ok("a question with no title still gets a row", rows[2].source === r.DASH);
  ok("the statement is carried for the last column", rows[0].statement === "Birinci");
  ok("points are carried", rows[0].points === 5);
  ok("a question with no points is 0, not NaN", rows[2].points === 0);

  ok("an empty exam yields no rows", r.buildReportRows([]).length === 0);
  ok("a non-array is handled", r.buildReportRows(null).length === 0);
  ok("a null question does not throw", r.buildReportRows([null]).length === 1);
}

console.log("\n5. Coverage tells the teacher when the model ignored the format:");
{
  const good = r.buildReportRows([{ type: "Cm", text: "x", title: FULL }]);
  ok("a fully-cited row is 5/5", r.reportCoverage(good).filled === 5);
  ok("ratio is 1", r.reportCoverage(good).ratio === 1);

  const bad = r.buildReportRows([{ type: "Cm", text: "x", title: "" }]);
  ok("an uncited row is 0/5", r.reportCoverage(bad).filled === 0);
  ok("no division by zero on an empty table", r.reportCoverage([]).ratio === 0);
}

console.log("\n6. The rendered document:");
{
  const rows = r.buildReportRows([{ type: "Cm", text: "Sual mətni", title: FULL }]);
  const html = r.buildReportHtml({ name: "MSO 1", className: "Riyaziyyat", classLevel: 6 }, rows);

  ok("all five column headers are present",
    ["Dərslikdə səh. və №", "Alt-standart", "Qiymətləndirmə meyarı", "Tapşırıq nəyi yoxlayır"]
      .every((h) => html.includes(h)));
  // "Hər sualdan əvvəl Blum səviyyəsi göstərilməlidir" — it was parsed and then
  // thrown away, so the one document that records the paper never showed it.
  ok("the Bloom level is shown per task", html.includes("Blum") && html.includes("Tətbiq"));
  ok("the exam name is in the masthead", html.includes("MSO 1"));
  ok("the class line renders", html.includes("Riyaziyyat · 6-ci sinif"));
  ok("the point total is stated", html.includes("bal"));
  ok("the parsed values reach the table", html.includes("3.4.1") && html.includes("Sahəni hesablayır"));
  // Landscape, because five text columns at portrait width wrap into unreadable
  // slivers — the table is the document, not an appendix to one.
  ok("the page is landscape", /size:\s*A4 landscape/.test(html));
  ok("backgrounds are forced to print", html.includes("print-color-adjust:exact"));
  ok("rows do not split across pages", /break-inside:avoid/.test(html));
  ok("only installed fonts are named",
    html.includes("DejaVu Serif") && html.includes("Open Sans") && !html.includes("Inter") && !html.includes("Noto"));
  ok("no external resource is referenced", !/https?:\/\//.test(html));

  const thin = r.buildReportHtml({ name: "x" }, r.buildReportRows([{ type: "Cm", text: "y", title: "" }]));
  ok("a mostly-empty table warns the teacher", thin.includes("AI istinad formatına tam əməl etməyib"));
  ok("a complete table does not warn", !html.includes("əməl etməyib"));
}

console.log("\n7. Injection through model output:");
{
  // Every cell in this document came from a model that was shown a teacher's PDF.
  // Escaping is what keeps a crafted heading from becoming markup in a file the
  // teacher then prints and shares.
  const html = r.buildReportHtml(
    { name: '<script>alert(1)</script>' },
    r.buildReportRows([{ type: "Cm", text: "<b>bold</b>", title: "Meyar: \" onload=x" }])
  );
  ok("the exam name is escaped", !html.includes("<script>") && html.includes("&lt;script&gt;"));
  ok("the statement is escaped", html.includes("&lt;b&gt;bold&lt;/b&gt;"));
  ok("quotes are escaped", html.includes("&quot;"));
}

console.log("\n8. The prompt still writes what the parser reads:");
{
  // The format lives in two places — the prompt that produces it and the parser
  // that consumes it. Nothing else couples them, so this asserts the contract
  // textually rather than letting a prompt edit quietly empty the table.
  const fs = require("fs");
  const path = require("path");
  const ai = fs.readFileSync(path.join(__dirname, "../controllers/aiController.js"), "utf8");

  ok("the prompt names all five parts",
    ["səh.", "Blum:", "Alt-standart:", "Meyar:", "Yoxlayır:"].every((k) => ai.includes(k)));
  ok("the separator the parser splits on is specified", ai.includes("·"));
  ok("the prompt says the printed page, not the file position", /faylın neçənci səhifəsi olduğu YOX/.test(ai));

  // And the example line in the prompt must itself parse — a malformed example is
  // the one thing guaranteed to be copied.
  const example = (ai.match(/\(Dərslik, səh\. 124, № 8\)[^"]*/) || [""])[0];
  const p = r.parseTitle(example);
  ok("the prompt's own example parses to five filled cells",
    [p.source, p.bloom, p.subStandard, p.criterion, p.skill].every((v) => v && v !== r.DASH),
    JSON.stringify(p));

  const ctl = fs.readFileSync(path.join(__dirname, "../controllers/quizController.js"), "utf8");
  ok("the report is served as a PDF", /application\/pdf/.test(ctl));
  ok("an empty exam is refused rather than printing a blank table", /exam_empty/.test(ctl));
  ok("the route is owner-scoped", /msoReport[\s\S]{0,400}loadOwnedExam/.test(ctl));

  const route = fs.readFileSync(path.join(__dirname, "../routes/quizRoute.js"), "utf8");
  ok("the route is behind protect", /mso-report\/:examId", protect, msoReport/.test(route));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} mso-report assertions failed`);
process.exit(failed ? 1 : 0);
