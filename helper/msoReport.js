/*
 * The analytic table the teacher's brief requires at the end of an MSO:
 *
 *   № tapşırıq | Dərslikdə səh. və № | Alt-standart | Qiymətləndirmə meyarı | Nəyi yoxlayır
 *
 * Where the data comes from. The shared question schema has no fields for a page,
 * a task number, a sub-standard, a criterion or a tested skill, and adding them
 * would change what the model is asked for on every ordinary quiz in the app. So
 * the MSO prompt writes all five into the question's `title` in one fixed format
 * and this parses them back out.
 *
 * Parsing our own controlled format is a real trade-off and worth naming: it is
 * cheap and touches nothing else, but it depends on the model following the format.
 * The parser is therefore TOLERANT — a missing or malformed part becomes "—" in
 * that cell rather than losing the row. A table with one gap is still a usable
 * record; a crash, or a row silently dropped, is not.
 */

const DASH = "—";

const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

/*
 * "(Dərslik, səh. 124, № 8) · Blum: Tətbiq · Alt-standart: 3.4.1 · Meyar: … · Yoxlayır: …"
 *
 * Each field is looked for independently rather than by splitting on the separator
 * in order, so a title missing its middle part still yields everything else.
 */
function parseTitle(title) {
  const t = clean(title);
  if (!t) return { source: DASH, bloom: DASH, subStandard: DASH, criterion: DASH, skill: DASH };

  // The citation, with or without its parentheses, in either order of page/number.
  const page = t.match(/səh\.?\s*([^\s,)·]+)/iu);
  const no = t.match(/№\s*([^\s,)·]+)/u);
  const source =
    page || no
      ? `səh. ${page ? page[1] : DASH}${no ? ` №${no[1]}` : ""}`
      : DASH;

  const field = (label) => {
    const m = t.match(new RegExp(`${label}\\s*:\\s*([^·]+)`, "iu"));
    return m ? clean(m[1]) || DASH : DASH;
  };

  return {
    source,
    bloom: field("(?:Blum|Səviyyə)"),
    subStandard: field("Alt-standart"),
    criterion: field("Meyar"),
    skill: field("(?:Yoxlayır|Yoxlanılır)"),
  };
}

/*
 * One row per question, in paper order. Reading blocks are skipped — they are not
 * tasks and numbering them would make the table disagree with the paper — but the
 * question numbering still counts only real questions, exactly as the paper does.
 */
function buildReportRows(items, pointsPlan) {
  const list = Array.isArray(items) ? items : [];
  /*
   * Points come from computePointsPlan — the SAME array grading uses — aligned to
   * the original item index, readings included. A table that invented its own
   * points would disagree with the marks the students actually get, which is the
   * one error a methodologist is certain to catch.
   */
  const plan = Array.isArray(pointsPlan) ? pointsPlan : null;
  const rows = [];
  let no = 0;
  for (let i = 0; i < list.length; i += 1) {
    const q = list[i];
    if (q && q.type === "reading") continue;
    no += 1;
    rows.push({
      no,
      statement: clean(q && q.text),
      points: plan ? Number(plan[i]) || 0 : Number(q && q.points) || 0,
      ...parseTitle(q && q.title),
    });
  }
  return rows;
}

// How complete is it? A table where most cells are "—" means the model ignored the
// format, and the teacher should be told rather than left to notice.
function reportCoverage(rows) {
  const cells = rows.length * 5;
  if (!cells) return { filled: 0, cells: 0, ratio: 0 };
  let filled = 0;
  for (const r of rows) {
    for (const k of ["source", "bloom", "subStandard", "criterion", "skill"]) {
      if (r[k] && r[k] !== DASH) filled += 1;
    }
  }
  return { filled, cells, ratio: filled / cells };
}

const esc = (v) =>
  String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function buildReportHtml(exam = {}, rows = []) {
  const cov = reportCoverage(rows);
  const thin = cov.cells > 0 && cov.ratio < 0.5;
  const totalPoints = rows.reduce((n, r) => n + (Number(r.points) || 0), 0);

  return `<!DOCTYPE html><html lang="az"><head><meta charset="utf-8">
<title>${esc(exam.name || "MSO")} — analitik cədvəl</title><style>
:root{--ink:#11202B;--slate:#4C5B68;--muted:#77848F;--teal:#0F4C5C;--teal-tint:#E8F1F3;
  --ochre:#8A5A00;--ochre-tint:#FBF2DE;--rule:#D3DCE1;--rule-soft:#E7EDF0;
  --serif:"DejaVu Serif",Georgia,serif;--sans:"Open Sans","DejaVu Sans",sans-serif}
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font-family:var(--sans);font-size:9pt;line-height:1.4;color:var(--ink);
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.masthead{border-top:2.5pt solid var(--teal);padding-top:6pt;margin-bottom:10pt}
.brandline{display:flex;justify-content:space-between;font-size:8pt;letter-spacing:.09em;
  font-weight:600;color:var(--teal);margin-bottom:7pt}
.brandline .doctype{color:var(--muted);font-weight:500}
h1{font-family:var(--serif);font-size:16pt;margin:0 0 3pt;line-height:1.2}
.sub{margin:0;font-size:9pt;color:var(--muted)}
.notice{display:flex;gap:7pt;font-size:8.5pt;line-height:1.4;padding:5pt 8pt;margin:9pt 0;
  background:var(--ochre-tint);color:var(--ochre);border-left:2pt solid var(--ochre)}
table{width:100%;border-collapse:collapse;margin-top:10pt}
thead th{font-size:7.5pt;font-weight:600;letter-spacing:.05em;color:var(--teal);text-align:left;
  border-bottom:1pt solid var(--teal);padding:0 6pt 4pt;vertical-align:bottom}
tbody td{font-size:8.5pt;padding:5pt 6pt;border-bottom:.75pt solid var(--rule-soft);
  vertical-align:top;overflow-wrap:anywhere}
tbody tr:nth-child(even){background:#FBFCFD}
tr{break-inside:avoid;page-break-inside:avoid}
.no{font-family:var(--serif);font-weight:700;color:var(--teal);width:24pt}
.src{width:80pt;white-space:nowrap}
.sub-col{width:66pt}
.bloom-col{width:62pt;color:var(--teal);font-weight:600}
.pts{width:26pt;text-align:right;font-variant-numeric:tabular-nums}
.q{color:var(--slate)}
tfoot td{padding-top:7pt;font-size:8pt;color:var(--muted)}
@page{size:A4 landscape;margin:14mm 14mm 15mm}
</style></head><body>
<header class="masthead">
  <div class="brandline"><span>Examopia</span><span class="doctype">Analitik cədvəl</span></div>
  <h1>${esc(exam.name || "Summativ qiymətləndirmə")}</h1>
  <p class="sub">${esc([exam.className, exam.classLevel && `${exam.classLevel}-ci sinif`].filter(Boolean).join(" · "))}${
    rows.length ? `${exam.className || exam.classLevel ? " · " : ""}${rows.length} tapşırıq · ${totalPoints} bal` : ""
  }</p>
</header>

${thin ? `<div class="notice"><b>!</b><span>Cədvəlin ${cov.cells - cov.filled}/${cov.cells} xanası boşdur — AI istinad formatına tam əməl etməyib. Boş xanaları özünüz doldurun.</span></div>` : ""}

<table>
  <thead><tr>
    <th class="no">№</th>
    <th class="src">Dərslikdə səh. və №</th>
    <th class="bloom-col">Blum</th>
    <th class="sub-col">Alt-standart</th>
    <th>Qiymətləndirmə meyarı</th>
    <th>Tapşırıq nəyi yoxlayır</th>
    <th class="pts">Bal</th>
    <th>Tapşırıq</th>
  </tr></thead>
  <tbody>
    ${rows
      .map(
        (r) => `<tr>
      <td class="no">${r.no}</td>
      <td class="src">${esc(r.source)}</td>
      <td class="bloom-col">${esc(r.bloom)}</td>
      <td class="sub-col">${esc(r.subStandard)}</td>
      <td>${esc(r.criterion)}</td>
      <td>${esc(r.skill)}</td>
      <td class="pts">${r.points || DASH}</td>
      <td class="q">${esc(r.statement).slice(0, 220)}</td>
    </tr>`
      )
      .join("")}
  </tbody>
</table>
</body></html>`;
}

module.exports = { parseTitle, buildReportRows, reportCoverage, buildReportHtml, DASH };
