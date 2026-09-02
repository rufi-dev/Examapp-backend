/*
 * The printable lesson plan, rendered server-side.
 *
 * Why this exists rather than a print stylesheet on the React page: a browser's
 * print dialog stamps its own header and footer onto every sheet — the date, the
 * page title and the full URL — and no CSS can remove them. That alone made the
 * output read as a printed web page instead of a document, and it is the one
 * defect the client could never fix.
 *
 * FONTS. The brief asked for Noto Serif and Inter. Neither is installed in the
 * image and fetching them from Google at render time would make PDF generation
 * depend on an outbound request that can fail or hang. DejaVu Serif and Open Sans
 * are already present, need no network, and — measured, not assumed — render
 * ə ğ ı İ ö ş ü ç as real glyphs rather than .notdef boxes. Substituting them is
 * the difference between a document that always renders and one that usually does.
 *
 * Everything here is data-driven: any number of stages with any minute split, any
 * number of tasks and worksheet variants, and every optional block omitted WITH its
 * heading when the field is empty — a dangling label on a printed page is worse
 * than a missing section.
 */

// Print is a document handed to strangers: every value is escaped, always.
const esc = (v) =>
  String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const has = (v) => String(v == null ? "" : v).trim().length > 0;
const list = (v) => (Array.isArray(v) ? v.filter(has) : []);

const TOKENS = `
  --ink:#11202B; --slate:#4C5B68; --muted:#77848F;
  --teal:#0F4C5C; --teal-soft:#2E7186; --teal-tint:#E8F1F3;
  --plum:#6E2A4B; --plum-tint:#F6EBF1;
  --ochre:#8A5A00; --ochre-tint:#FBF2DE;
  --rule:#D3DCE1; --rule-soft:#E7EDF0; --paper:#FFFFFF;
  --serif:"DejaVu Serif",Georgia,"Times New Roman",serif;
  --sans:"Open Sans","DejaVu Sans",-apple-system,"Segoe UI",Roboto,sans-serif;
`;

const CSS = `
:root{${TOKENS}}
*{box-sizing:border-box}
html,body{background:#fff;margin:0}
body{font-family:var(--sans);font-size:10pt;line-height:1.45;color:var(--ink);
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
/* A long unbroken word must not push the gutter out of alignment. */
.stage>div,.task>div,.detail,.roles dd,.callout-box,.q{overflow-wrap:anywhere}

.masthead{border-top:2.5pt solid var(--teal);padding-top:7pt;margin-bottom:12pt}
.brandline{display:flex;justify-content:space-between;align-items:baseline;font-size:8pt;
  letter-spacing:.09em;font-weight:600;color:var(--teal);margin-bottom:8pt}
.brandline .doctype{color:var(--muted);font-weight:500;letter-spacing:.06em}
h1{font-family:var(--serif);font-size:19pt;line-height:1.18;font-weight:700;margin:0 0 4pt;max-width:34em}
.subtitle{font-size:10.5pt;font-weight:500;color:var(--teal-soft);margin:0 0 11pt}

.meta{display:grid;grid-template-columns:repeat(4,1fr);border:.75pt solid var(--rule);border-radius:2pt;overflow:hidden}
.meta>div{padding:5pt 8pt 6pt;border-right:.75pt solid var(--rule-soft)}
.meta>div:last-child{border-right:0}
.meta dt{font-size:7.5pt;font-weight:600;letter-spacing:.05em;color:var(--muted);margin:0 0 2pt}
.meta dd{margin:0;font-size:10pt;font-weight:500;min-height:12pt}
.meta dd.blank{border-bottom:.75pt dotted var(--rule);color:transparent}

.section{margin-top:14pt}
.section-head{display:flex;align-items:baseline;gap:8pt;border-bottom:1pt solid var(--teal);
  padding-bottom:3pt;margin-bottom:8pt}
.section-head h2{font-family:var(--serif);font-size:11.5pt;font-weight:700;margin:0;color:var(--teal)}
.section-head .note{margin-left:auto;font-size:8.5pt;color:var(--muted);font-weight:500}

.pair{display:grid;grid-template-columns:1fr 1fr;gap:0 16pt}
.pair>section+section{border-left:.75pt solid var(--rule-soft);padding-left:16pt}
.pair h3{font-size:8.5pt;font-weight:600;letter-spacing:.05em;color:var(--teal);margin:0 0 5pt}
ul.tight{margin:0;padding-left:0;list-style:none}
ul.tight li{position:relative;padding-left:11pt;margin-bottom:4pt;font-size:9.5pt;line-height:1.4}
ul.tight li::before{content:"";position:absolute;left:0;top:5pt;width:4pt;height:4pt;
  border:1pt solid var(--teal-soft);border-radius:50%}
ul.tight li:last-child{margin-bottom:0}

.timebar{display:flex;height:7pt;border-radius:3.5pt;overflow:hidden;margin-bottom:3pt}
.timebar span{display:block}
.timebar-legend{display:flex;font-size:7.5pt;color:var(--muted);margin-bottom:10pt}
.timebar-legend span{text-align:center}

.stage{display:grid;grid-template-columns:38pt 1fr;column-gap:12pt;padding:8pt 0 9pt;
  border-top:.75pt solid var(--rule-soft);break-inside:avoid;page-break-inside:avoid}
.stage:first-of-type{border-top:0;padding-top:0}
.gutter{text-align:right;border-right:1.5pt solid var(--teal-tint);padding-right:10pt}
.gutter .min{font-family:var(--serif);font-size:14pt;font-weight:700;color:var(--teal);line-height:1;display:block}
.gutter .unit{font-size:7.5pt;color:var(--muted);letter-spacing:.04em}
.stage h3{font-family:var(--serif);font-size:11pt;font-weight:600;margin:0 0 5pt;line-height:1.25}
.detail{margin:0 0 7pt;font-size:9.5pt;line-height:1.5;color:var(--slate)}
.roles{margin:0;display:grid;grid-template-columns:52pt 1fr;column-gap:9pt;row-gap:3.5pt;
  font-size:9pt;line-height:1.4}
.roles dt{font-weight:600;font-size:8pt;color:var(--teal);padding-top:1pt}
.roles dd{margin:0;color:var(--slate)}
.resources{margin-top:5pt;font-size:8.5pt;color:var(--muted)}
.resources b{font-weight:600;color:var(--teal)}

.notice{display:flex;gap:7pt;align-items:flex-start;font-size:8.5pt;line-height:1.4;
  padding:5pt 8pt;border-radius:2pt;margin:8pt 0}
.notice .mark{font-weight:700;flex:0 0 auto}
.notice.info{background:var(--teal-tint);color:var(--teal)}
.notice.warn{background:var(--ochre-tint);color:var(--ochre);border-left:2pt solid var(--ochre)}

.task{display:grid;grid-template-columns:20pt 1fr;column-gap:8pt;padding:7pt 0;
  border-top:.75pt solid var(--rule-soft);break-inside:avoid;page-break-inside:avoid}
.task:first-of-type{border-top:0}
.task .no{font-family:var(--serif);font-size:11pt;font-weight:700;color:var(--teal);line-height:1.3}
.q{font-family:var(--serif);font-size:10pt;line-height:1.4;margin:0 0 5pt}
.tag{display:inline-block;font-family:var(--sans);font-size:7pt;font-weight:600;letter-spacing:.05em;
  padding:1.5pt 5pt;border-radius:8pt;vertical-align:2pt;margin-left:5pt;white-space:nowrap}
.tag.apply{background:var(--teal-tint);color:var(--teal)}
.tag.analyse{background:var(--ochre-tint);color:var(--ochre)}
.tag.create{background:var(--plum-tint);color:var(--plum)}
.answer{border-left:2pt solid var(--plum);background:var(--plum-tint);padding:5pt 8pt;border-radius:0 2pt 2pt 0}
.answer .val{font-weight:600;font-size:9.5pt;color:var(--plum);margin:0 0 2pt}
.answer .why{margin:0;font-size:8.5pt;line-height:1.4;color:var(--slate);white-space:pre-line}

.callout-box{border:.75pt solid var(--rule);border-left:2.5pt solid var(--teal);border-radius:0 2pt 2pt 0;
  padding:8pt 10pt;font-size:9.5pt;line-height:1.5}
.reflect{counter-reset:rq;margin:0 0 9pt;padding:0;list-style:none}
.reflect li{counter-increment:rq;position:relative;padding-left:16pt;margin-bottom:4pt;font-size:9.5pt}
.reflect li::before{content:counter(rq);position:absolute;left:0;top:0;font-family:var(--serif);
  font-weight:700;font-size:9pt;color:var(--teal-soft)}
.criteria-check{display:grid;row-gap:5pt;font-size:9pt}
.criteria-check>div{display:grid;grid-template-columns:1fr 1.15fr;column-gap:10pt;padding-bottom:5pt;
  border-bottom:.75pt solid var(--rule-soft)}
.criteria-check>div:last-child{border-bottom:0;padding-bottom:0}
.criteria-check .what{font-weight:500}
.criteria-check .how{color:var(--slate);font-size:8.5pt}
.chips{display:flex;flex-wrap:wrap;gap:5pt}
.chips span{font-size:8.5pt;padding:2.5pt 8pt;border:.75pt solid var(--rule);border-radius:10pt;
  color:var(--slate);background:#FBFCFD}

.worksheet{break-before:page;page-break-before:always}
.ws-head{display:flex;align-items:center;gap:10pt;border-top:2.5pt solid var(--teal);padding-top:8pt;margin-bottom:9pt}
.variant-badge{font-family:var(--serif);font-size:20pt;font-weight:700;line-height:1;width:30pt;height:30pt;
  display:flex;align-items:center;justify-content:center;background:var(--teal);color:#fff;border-radius:3pt;flex:0 0 auto}
.ws-head .titles h2{font-family:var(--serif);font-size:14pt;margin:0;line-height:1.2}
.ws-head .titles p{margin:1pt 0 0;font-size:9pt;color:var(--muted)}
.ws-head .count{margin-left:auto;font-size:8.5pt;color:var(--teal);font-weight:600;background:var(--teal-tint);
  padding:3pt 9pt;border-radius:10pt}
.namebar{display:grid;grid-template-columns:2.2fr 1fr 1fr;gap:12pt;margin-bottom:12pt}
.namebar div{border-bottom:.75pt solid var(--ink);padding-bottom:2pt}
.namebar span{font-size:8pt;color:var(--muted);font-weight:600}
.ws-q{padding:0 0 9pt;margin-bottom:9pt;border-bottom:.75pt dashed var(--rule-soft);
  break-inside:avoid;page-break-inside:avoid}
.ws-q:last-child{border-bottom:0}
.ws-q p{font-family:var(--serif);font-size:10pt;line-height:1.4;margin:0 0 7pt}
.ws-q p b{font-family:var(--sans);font-size:9.5pt;color:var(--teal);margin-right:4pt}
.ruled{border-bottom:.75pt solid var(--rule);height:15pt}
.ws-foot{margin-top:14pt;padding-top:6pt;border-top:.75pt solid var(--rule);font-size:8pt;color:var(--muted);
  display:flex;justify-content:space-between}

@page{size:A4;margin:14mm 15mm 15mm}
`;

// Five tints of teal, cycled, so any number of stages colours cleanly.
const BAND = ["#0F4C5C", "#2E7186", "#5E97A8", "#8CB6C2", "#B9D3DA"];

/*
 * Bloom level -> the tag's colour. Anything unrecognised gets the neutral teal
 * rather than no tag: the level is information even when it is not one of the
 * three the design names.
 */
function tagFor(bloom) {
  const b = String(bloom || "").toLowerCase();
  if (!b) return "";
  if (/təhlil|analiz/.test(b)) return `<span class="tag analyse">${esc(bloom)}</span>`;
  if (/yaratma/.test(b)) return `<span class="tag create">${esc(bloom)}</span>`;
  return `<span class="tag apply">${esc(bloom)}</span>`;
}

function stageBlock(s) {
  const rows = [
    ["Müəllim", s.teacher],
    ["Şagird", s.student],
    ["Yoxlama", s.checks],
    ["Fərqləndirmə", s.differentiation],
  ].filter(([, v]) => has(v));

  return `<article class="stage">
    <div class="gutter"><span class="min">${esc(Math.max(0, Math.round(Number(s.minutes) || 0)))}</span><span class="unit">dəq</span></div>
    <div>
      ${has(s.name) ? `<h3>${esc(s.name)}</h3>` : ""}
      ${rows.length ? `<dl class="roles">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
      ${has(s.resources) ? `<p class="resources"><b>Resurslar</b> ${esc(s.resources)}</p>` : ""}
    </div>
  </article>`;
}

function taskBlock(t, i) {
  const answer = has(t.answer) || has(t.solution)
    ? `<div class="answer">
         ${has(t.answer) ? `<p class="val">${esc(t.answer)}</p>` : ""}
         ${has(t.solution) ? `<p class="why">${esc(t.solution)}</p>` : ""}
       </div>`
    : "";
  return `<article class="task">
    <div class="no">${i + 1}</div>
    <div>
      <p class="q">${esc(t.statement)}${tagFor(t.bloom)}</p>
      ${answer}
    </div>
  </article>`;
}

// Fill-in-the-blank needs one line; anything asking for working needs two.
const linesFor = (text) => (/(izah|həll|yaz|düzəlt|tamamla|göstər)/i.test(String(text || "")) ? 2 : 1);

function worksheetSheet(letter, rows, plan) {
  return `<section class="worksheet">
    <div class="ws-head">
      <div class="variant-badge">${esc(letter)}</div>
      <div class="titles">
        <h2>İş vərəqi — ${esc(plan.topic || plan.title)}</h2>
        <p>${esc([plan.subject, plan.grade && `${plan.grade}-ci sinif`].filter(Boolean).join(" · "))}</p>
      </div>
      <div class="count">${rows.length} tapşırıq</div>
    </div>
    <div class="namebar">
      <div><span>Ad, soyad</span></div><div><span>Sinif</span></div><div><span>Tarix</span></div>
    </div>
    ${rows
      .map(
        (q, i) => `<div class="ws-q">
          <p><b>${i + 1}.</b> ${esc(q.statement)}</p>
          ${'<div class="ruled"></div>'.repeat(linesFor(q.statement))}
        </div>`
      )
      .join("")}
    <div class="ws-foot">
      <span>Examopia · ${esc(plan.topic || plan.title)} · Variant ${esc(letter)}</span>
      <span>${has(plan.ownerName) ? `Müəllim: ${esc(plan.ownerName)}` : ""}</span>
    </div>
  </section>`;
}

/*
 * `variants` is an object of { A: [...], B: [...] } — any letters, any count. The
 * badge letter comes from the key, so a third variant needs no code change.
 */
function buildLessonPlanHtml(rawPlan = {}, variants = null) {
  // A null plan is a caller bug, not a reason to 500 on a print request.
  const plan = rawPlan && typeof rawPlan === "object" ? rawPlan : {};
  const stages = Array.isArray(plan.stages) ? plan.stages.filter((s) => has(s && s.name)) : [];
  const total = stages.reduce((a, s) => a + (Number(s.minutes) || 0), 0);
  const objectives = list(plan.objectives);
  const criteria = list(plan.criteria);
  const tasks = Array.isArray(plan.tasks) ? plan.tasks.filter((t) => has(t && t.statement)) : [];
  const materials = list(plan.materials);
  const reflection = String(plan.reflection || "")
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

  // Segment widths come from the data. With no minutes recorded the bar is simply
  // omitted rather than drawn as equal thirds, which would be a lie about timing.
  const bar =
    total > 0
      ? `<div class="timebar">${stages
          .map((s, i) => `<span style="width:${((Number(s.minutes) || 0) / total) * 100}%;background:${BAND[i % BAND.length]}"></span>`)
          .join("")}</div>
         <div class="timebar-legend">${stages
           .map((s) => `<span style="width:${((Number(s.minutes) || 0) / total) * 100}%">${Math.round(Number(s.minutes) || 0)}′</span>`)
           .join("")}</div>`
      : "";

  const sheets = variants
    ? Object.entries(variants)
        .filter(([, rows]) => Array.isArray(rows) && rows.length)
        .map(([letter, rows]) => worksheetSheet(letter, rows, plan))
        .join("")
    : "";

  return `<!DOCTYPE html><html lang="az"><head><meta charset="utf-8">
<title>${esc(plan.title || "Dərs planı")}</title><style>${CSS}</style></head><body>

<header class="masthead">
  <div class="brandline"><span>Examopia</span><span class="doctype">Dərs planı</span></div>
  <h1>${esc(plan.title || plan.topic || "Dərs planı")}</h1>
  ${has(plan.topic) && plan.topic !== plan.title ? `<p class="subtitle">${esc(plan.topic)}</p>` : ""}
  <dl class="meta">
    <div><dt>Fənn</dt><dd${has(plan.subject) ? "" : ' class="blank"'}>${has(plan.subject) ? esc(plan.subject) : "."}</dd></div>
    <div><dt>Sinif</dt><dd${has(plan.grade) ? "" : ' class="blank"'}>${has(plan.grade) ? `${esc(plan.grade)}-ci sinif` : "."}</dd></div>
    <div><dt>Müəllim</dt><dd${has(plan.ownerName) ? "" : ' class="blank"'}>${has(plan.ownerName) ? esc(plan.ownerName) : "."}</dd></div>
    <div><dt>Tarix</dt><dd class="blank">.</dd></div>
  </dl>
</header>

${objectives.length || criteria.length ? `<div class="section"><div class="pair">
  ${objectives.length ? `<section><h3>Məqsədlər</h3><ul class="tight">${objectives.map((o) => `<li>${esc(o)}</li>`).join("")}</ul></section>` : ""}
  ${criteria.length ? `<section><h3>Qiymətləndirmə meyarları</h3><ul class="tight">${criteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></section>` : ""}
</div></div>` : ""}

${stages.length ? `<div class="section">
  <div class="section-head"><h2>Dərsin gedişi</h2>
    <span class="note">${total} dəqiqə · ${stages.length} mərhələ</span></div>
  ${bar}
  ${has(plan.motivation) ? `<p class="detail">${esc(plan.motivation)}</p>` : ""}
  ${stages.map(stageBlock).join("")}
  ${plan.motivationOrigin === "ai" ? `<div class="notice info"><span class="mark">AI</span><span>Dərsin gedişi süni intellekt tərəfindən yazılıb — dərslikdən götürülməyib.</span></div>` : ""}
</div>` : ""}

${tasks.length ? `<div class="section">
  <div class="section-head"><h2>Tapşırıqlar</h2>
    <span class="note">${tasks.length} tapşırıq${tasks.some((t) => has(t.answer) || has(t.solution)) ? " · cavablarla" : ""}</span></div>
  ${tasks.map(taskBlock).join("")}
</div>` : ""}

${has(plan.homework) ? `<div class="section">
  <div class="section-head"><h2>Ev tapşırığı</h2></div>
  ${has(plan.homeworkWarning) ? `<div class="notice warn"><span class="mark">!</span><span>${esc(plan.homeworkWarning)}</span></div>` : ""}
  <div class="callout-box">${esc(plan.homework)}</div>
</div>` : ""}

${reflection.length || criteria.length ? `<div class="section">
  <div class="section-head"><h2>Refleksiya və qiymətləndirmə</h2></div>
  ${reflection.length ? `<ol class="reflect">${reflection.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>` : ""}
</div>` : ""}

${materials.length ? `<div class="section">
  <div class="section-head"><h2>Resurslar</h2></div>
  <div class="chips">${materials.map((m) => `<span>${esc(m)}</span>`).join("")}</div>
</div>` : ""}

${sheets}
</body></html>`;
}

module.exports = { buildLessonPlanHtml, esc, CSS };
