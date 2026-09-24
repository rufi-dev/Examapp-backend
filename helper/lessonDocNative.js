/*
 * The economical lesson-material engine.
 *
 * The model supplies teaching content and semantic diagram data only. It never
 * writes HTML, CSS, or SVG coordinates. This keeps the paid request bounded and
 * makes the browser preview and PDF use the same platform-owned document body.
 */
const { renderBlock, esc } = require("./lessonDocHtml");

const DIAGRAM_TYPES = ["flow", "cycle", "compare", "timeline", "bars", "concept"];
const MAX_BLOCKS = 36;
const MAX_ITEMS = 12;
const MAX_TEXT = 1200;
// 36 blocks x 1,200 characters plus JSON overhead, with room to spare. A native
// document cannot legitimately exceed this; see nativePrompt.
const MAX_CURRENT_CHARS = 120000;

const NATIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    audience: { type: "string" },
    reply: { type: "string" },
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: MAX_BLOCKS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["heading", "text", "list", "definition", "example", "task", "note", "table", "diagram"] },
          text: { type: "string" },
          term: { type: "string" },
          items: { type: "array", maxItems: MAX_ITEMS, items: { type: "string" } },
          ordered: { type: "boolean" },
          solution: { type: "string" },
          columns: { type: "array", maxItems: 8, items: { type: "string" } },
          rows: { type: "array", maxItems: 12, items: { type: "array", maxItems: 8, items: { type: "string" } } },
          tone: { type: "string", enum: ["info", "warning", "success"] },
          diagram: {
            anyOf: [{
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: DIAGRAM_TYPES },
              title: { type: "string" },
              labels: { type: "array", maxItems: 8, items: { type: "string" } },
              values: { type: "array", maxItems: 8, items: { type: "number" } },
            },
            required: ["type", "title", "labels", "values"],
            }, { type: "null" }],
          },
        },
        required: ["kind", "text", "term", "items", "ordered", "solution", "columns", "rows", "tone", "diagram"],
      },
    },
  },
  required: ["title", "audience", "reply", "blocks"],
};

const NATIVE_SYSTEM = `
Sən Azərbaycan məktəbləri üçün dərs materialının məzmununu hazırlayırsan.
Yalnız JSON qaytar. HTML, CSS, SVG, koordinat, JavaScript və markdown qaytarma.
Məzmunu blocks massivində yaz: başlıq, izah, siyahı, termin, nümunə, tapşırıq,
qeyd, cədvəl və lazım olduqda semantic diagram. Platforma görünüşü və PDF-i özü
hazırlayacaq. Mövzunu uydurma: əlavə fayl verilirsə, onun məzmununa söykən.
Hər materialda ən azı bir heading və bir text olsun. Nümunənin həlli example.solution
field-də, tapşırığın cavabı isə solution-da olsun; platforma tələbəyə cavabı göstərmir.
Diagram yalnız məna üçün seçilsin: flow, cycle, compare, timeline, bars və ya concept.
Diagramda ən çox 8 qısa label və 8 rəqəm ver. Bir diagram kifayətdir.
`.trim();

const clamp = (value, limit = MAX_TEXT) => String(value == null ? "" : value).trim().slice(0, limit);
const cleanArray = (value, limit = MAX_ITEMS) => (Array.isArray(value) ? value : []).map((x) => clamp(x, 300)).filter(Boolean).slice(0, limit);
/*
 * A table row is positional: cell 3 belongs under column 3.
 *
 * cleanArray drops empty strings, which is right for a bullet list and wrong
 * here — ["first", "", "third"] became ["first", "third"] and every value after
 * the gap moved one column to the left. A blank cell in a lesson table is
 * usually the point (the exercise the student fills in), so empties are kept and
 * the row is padded to the header width instead.
 */
const cleanRow = (value, width) => {
  const cells = (Array.isArray(value) ? value : []).slice(0, 8).map((x) => clamp(x, 300));
  const size = width > 0 ? Math.min(width, 8) : cells.length;
  while (cells.length < size) cells.push("");
  return cells.slice(0, size);
};

function normalizeNative(raw = {}) {
  const blocks = Array.isArray(raw.blocks) ? raw.blocks.slice(0, MAX_BLOCKS) : [];
  return {
    title: clamp(raw.title, 160),
    audience: clamp(raw.audience, 180),
    reply: clamp(raw.reply, 500),
    blocks: blocks
      .map((b) => ({
        kind: ["heading", "text", "list", "definition", "example", "task", "note", "table", "diagram"].includes(b?.kind) ? b.kind : "text",
        text: clamp(b?.text),
        term: clamp(b?.term, 180),
        items: cleanArray(b?.items),
        ordered: Boolean(b?.ordered),
        solution: clamp(b?.solution),
        columns: cleanArray(b?.columns, 8),
        rows: (Array.isArray(b?.rows) ? b.rows : []).slice(0, 12).map((r) => cleanRow(r, cleanArray(b?.columns, 8).length)),
        tone: ["info", "warning", "success"].includes(b?.tone) ? b.tone : "info",
        diagram: b?.diagram && DIAGRAM_TYPES.includes(b.diagram.type)
          ? { type: b.diagram.type, title: clamp(b.diagram.title, 180), labels: cleanArray(b.diagram.labels, 8), values: (Array.isArray(b.diagram.values) ? b.diagram.values : []).map(Number).filter(Number.isFinite).slice(0, 8) }
          : null,
      }))
      .filter((b) => (b.kind === "diagram"
        ? Boolean(b.diagram)
        : Boolean(b.text || b.term || b.items.length || b.columns.length || b.rows.some((r) => r.some(Boolean))))),
  };
}

function svgText(x, y, value, size = 14, anchor = "middle") {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial,sans-serif" font-size="${size}" fill="#222631">${esc(value)}</text>`;
}

function diagramSvg(d) {
  const labels = d.labels.slice(0, 8);
  const w = 640;
  // Two rows of boxes need the room; a short canvas would clip the second row.
  const wrapped = !["bars", "cycle"].includes(d.type) && d.labels.length > (d.type === "compare" ? 2 : 4);
  const h = d.type === "bars" ? 250 : wrapped ? 240 : 190;
  const title = d.title ? svgText(w / 2, 24, d.title, 16) : "";
  const base = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(d.title || "Sxem")}"><rect width="100%" height="100%" rx="16" fill="#F4F6FF"/><g>${title}`;
  let art = "";
  if (d.type === "bars") {
    const values = d.values.length ? d.values : labels.map(() => 1);
    const max = Math.max(...values, 1);
    const bw = Math.max(24, Math.min(68, 460 / Math.max(labels.length, 1)));
    art += `<line x1="76" y1="205" x2="600" y2="205" stroke="#8D96B4" stroke-width="2"/>`;
    labels.forEach((label, i) => {
      const x = 92 + i * (500 / Math.max(labels.length, 1));
      const bh = 145 * (Number(values[i] || 0) / max);
      art += `<rect x="${x}" y="${195 - bh}" width="${bw}" height="${bh}" rx="8" fill="#5369D6"/>${svgText(x + bw / 2, 222, label, 12)}${svgText(x + bw / 2, 188 - bh, String(values[i] || 0), 12)}`;
    });
  } else if (d.type === "cycle") {
    /*
     * Every label the schema accepts is drawn. It used to stop at six while the
     * schema took eight, so a seven-step cycle lost two steps with nothing said —
     * a diagram that quietly omits content is worse than no diagram.
     */
    const n = labels.length;
    const cx = 320, cy = 112, r = 68;
    const at = (i) => {
      const a = -Math.PI / 2 + i * ((Math.PI * 2) / Math.max(n, 1));
      return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, a };
    };
    // Arcs between the nodes, so a cycle reads as a cycle rather than as dots on
    // a ring. Drawn first, so the nodes sit on top of them.
    if (n > 1) {
      for (let i = 0; i < n; i += 1) {
        const from = at(i);
        const to = at((i + 1) % n);
        const pull = 22; // step back from each node so the arrow does not sit under it
        const dx = to.x - from.x, dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        const sx = from.x + (dx / len) * pull, sy = from.y + (dy / len) * pull;
        const ex = to.x - (dx / len) * pull, ey = to.y - (dy / len) * pull;
        art += `<path d="M${sx.toFixed(1)} ${sy.toFixed(1)} L${ex.toFixed(1)} ${ey.toFixed(1)}" stroke="#9AA8DA" stroke-width="2" fill="none" marker-end="url(#arrow)"/>`;
      }
    }
    labels.forEach((label, i) => {
      const { x, y } = at(i);
      art += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="24" fill="#5369D6"/><text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="white">${esc(label.slice(0, 12))}</text>`;
    });
    art += `<circle cx="${cx}" cy="${cy}" r="30" fill="white" stroke="#C9D2F0" stroke-width="3"/>${svgText(cx, cy + 5, "dövr", 13)}`;
  } else {
    // Up to four across, so eight labels fit in two rows instead of being cut at
    // six. `compare` stays two-wide because that is what makes it a comparison.
    const n = labels.length;
    const cols = d.type === "compare" ? Math.min(2, Math.max(1, n)) : Math.min(n, 4) || 1;
    const rows = Math.ceil(n / cols);
    const gap = 18, boxW = (560 - gap * (cols - 1)) / cols;
    const rowH = rows > 1 ? 52 : 60;
    labels.forEach((label, i) => {
      const x = 40 + (i % cols) * (boxW + gap), y = 48 + Math.floor(i / cols) * rowH;
      art += `<rect x="${x.toFixed(1)}" y="${y}" width="${boxW.toFixed(1)}" height="38" rx="10" fill="white" stroke="#C9D2F0" stroke-width="2"/>${svgText(x + boxW / 2, y + 24, label, 12)}`;
      // The arrow joins neighbours ON THE SAME ROW; wrapping to the next row has
      // no straight line to draw, so none is invented.
      const sameRow = Math.floor(i / cols) === Math.floor((i + 1) / cols);
      if (d.type === "flow" && i < n - 1 && sameRow) {
        art += `<path d="M${(x + boxW).toFixed(1)} ${y + 19}h${gap - 4}" stroke="#5369D6" stroke-width="2" marker-end="url(#arrow)"/>`;
      }
    });
  }
  return `${base}<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#5369D6"/></marker></defs>${art}</g></svg>`;
}

function nativeBlocksToHtml(native) {
  const blocks = native.blocks.map((b) => {
    if (b.kind === "diagram") return { kind: "figure", text: b.diagram.title, svg: diagramSvg(b.diagram) };
    return b;
  });
  const title = native.title ? `<h1>${esc(native.title)}</h1>` : "";
  const meta = native.audience ? `<p class="meta">${esc(native.audience)}</p>` : "";
  return `${title}${meta}${blocks.map((b) => renderBlock(b, false)).join("\n")}`;
}

function nativePrompt({ request, current, sourceNotes, sourceText }) {
  /*
   * The whole document, or none of it.
   *
   * This used to slice the serialised material at 18,000 characters, which cut
   * mid-JSON and simply dropped the blocks at the end — and since the model is
   * asked to return the material COMPLETE, whatever fell off the end was gone
   * from the answer too. A teacher's last three sections could disappear because
   * of a number in a helper.
   *
   * The schema bounds a native document to 36 blocks of 1,200 characters, so a
   * legitimate one always fits. Anything past this ceiling is damaged or from
   * somewhere else, and refusing is the only safe answer: an edit that silently
   * loses the tail is worse than an edit that does not happen.
   */
  const currentText = current ? JSON.stringify(current) : "";
  if (currentText.length > MAX_CURRENT_CHARS) {
    const e = new Error("native_document_too_large");
    e.aiStatus = 422;
    e.userMessage = "Material həddindən böyükdür. Bir neçə hissəyə bölüb yenidən cəhd edin.";
    throw e;
  }
  return [
    current ? "HAZIR MATERİALI DƏYİŞ: aşağıdakı semantic materialı qoruyaraq yalnız müəllimin istədiyini yenilə." : "YENİ MATERIAL YARAT.",
    currentText ? `HAZIR SEMANTİK MATERİAL:\n${currentText}` : "",
    sourceNotes?.length ? `MƏNBƏ QEYDLƏRİ:\n${sourceNotes.map((x) => `${x.name}: ${x.found}`).join("\n")}` : "",
    sourceText?.length ? `YERLİ ÇIXARILMIŞ MƏTN (PDF serverdə oxundu):\n${sourceText.map((x) => `${x.name}: ${x.text}`).join("\n")}` : "",
    `MÜƏLLİMİN İSTƏYİ:\n${clamp(request, 4000)}`,
    "Bütün nəticəni blocks-da qaytar. Əsas məzmunu itirmə; bir dəyişiklik tələb olunanda qalan blokları saxla.",
  ].filter(Boolean).join("\n\n");
}

/*
 * Is this turn ONLY about how the material prints?
 *
 * Substring matching kept getting this wrong, and each way it was wrong cost
 * something real:
 *   "səhifə nömrələrini sil"        turned page numbers ON  (it only looked for "olma")
 *   "səhifə nömrələri olmalıdır"    turned them OFF         ("olmalıdır" contains "olma")
 *   "rəngini yaşıl et"              turned page numbers ON  (a field nobody mentioned)
 *   "...və ingilis dilinə tərcümə"  was answered locally    (the translation never happened)
 *
 * So the request is parsed instead of scanned: every word must be one this
 * shortcut knows. One unknown word — "tərcümə", "nümunə", anything — and the
 * turn goes to the engine like any other. A settings request that reaches the
 * model costs a couple of cents; a content request answered locally loses the
 * teacher's work, so the doubt is always resolved toward the model.
 *
 * Matching is by STEM, because Azerbaijani inflects: "nömrələrini" and "nömrəsi"
 * are both the page-number stem. Stems are ordered longest-first where one is a
 * prefix of another, so "olmasın" is never read as "olmalı".
 */
const PAGE_STEMS = ["səhifə", "sehife", "nömrə", "nomre", "nomer"];
const COLOR_STEMS = ["rəng", "reng", "accent"];
const PRINT_STEMS = ["çap", "cap", "print"];
// Stems that mean "turn it off" on their own.
const OFF_STEMS = ["olmasın", "olmasin", "sil", "çıxar", "cixar", "gizlət", "gizlet", "istəmirəm", "istemirem", "istəmir", "istemir", "lazımsız", "lazimsiz"];
// Stems that mean "turn it on" on their own. Deliberately NOT here: "yaz"
// (write) and "qoy" (put), which are how people ask for content — "material
// yaz" is a request for a lesson, not for a setting.
const ON_STEMS = ["olmalı", "olmali", "olsun", "əlavə", "elave", "göstər", "goster", "lazımdır", "lazimdir"];
const FILLER_STEMS = [
  "və", "ve", "ile", "ilə", "et", "elə", "ele", "edin", "edək", "edek", "bu", "o",
  "material", "materialın", "materialin", "sənəd", "sened", "sənədin", "senedin",
  "pdf", "faylın", "faylin", "fayl", "zəhmət", "zehmet", "olmasa", "lütfən", "lutfen",
  "hər", "her", "bütün", "butun", "ancaq", "yalnız", "yalniz", "da", "də", "de",
];
const COLOR_WORDS = [
  ["qırmızı", "red"], ["qirmizi", "red"], ["narıncı", "orange"], ["narinci", "orange"],
  ["yaşıl", "green"], ["yasil", "green"], ["mavi", "teal"], ["göy", "teal"], ["goy", "teal"],
  ["bənövşəyi", "purple"], ["benovseyi", "purple"], ["boz", "slate"],
];

const stemHit = (word, stems) => stems.some((stem) => word.startsWith(stem));

/*
 * Azerbaijani negates a verb with -ma / -mə, and that inverts the instruction.
 *
 * "göstər" is show; "göstərmə" is DON'T show — and reading the second as the
 * first turned page numbers on for someone asking to turn them off. The same
 * suffix flips the other direction too: "sil" is delete, "silmə" is don't
 * delete, which means keep them.
 *
 * Guarded against the words that merely happen to contain those letters:
 * "olmalıdır" (must be) is not a negation, and neither is "nömrə".
 */
const NEGATION = /(ma|mə)(dan|dən|yın|yin|yun|yün)?$/;
const isNegated = (word) =>
  NEGATION.test(word) && !/^(olmalı|olmali|nömrə|nomre|əlavə|elave|rəngi|rengi)/.test(word);

function nativePrintOptions(request) {
  const raw = String(request || "").trim();
  // A settings instruction is short. Anything longer is a request about the
  // material with a setting mentioned along the way, and belongs to the engine.
  if (!raw || raw.length > 60) return null;
  const words = raw.toLocaleLowerCase("az").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;

  /*
   * A digit means a quantity, and a quantity is about content: "2 səhifə
   * material yaz" is two pages of lesson, not a page-number setting. Page-number
   * and colour requests never need a number, so any digit hands the turn over.
   */
  if (words.some((w) => /\d/.test(w))) return null;

  let page = false;
  let colour = null;
  let polarity = null; // null = unstated, true = on, false = off
  let negatedSomething = false;

  for (const word of words) {
    const negated = isNegated(word);
    // The stem to classify is the word without its negation suffix.
    const base = negated ? word.replace(NEGATION, "") : word;

    if (stemHit(base, PAGE_STEMS)) { page = true; continue; }
    const named = COLOR_WORDS.find(([w]) => base.startsWith(w));
    if (named) { colour = named[1]; continue; }
    if (stemHit(base, COLOR_STEMS) || stemHit(base, PRINT_STEMS)) continue;

    if (stemHit(base, OFF_STEMS)) { polarity = negated ? true : false; negatedSomething ||= negated; continue; }
    if (stemHit(base, ON_STEMS)) {
      if (negated) { polarity = false; negatedSomething = true; }
      else if (polarity === null) polarity = true;
      continue;
    }
    if (stemHit(base, FILLER_STEMS)) { negatedSomething ||= negated; continue; }
    // A word this shortcut does not know. Not a settings-only request.
    return null;
  }

  const patch = {};
  if (page) patch.pageNumbers = polarity !== false;
  /*
   * A negated colour cannot be expressed. "rəngi yaşıl etmə" asks for NOT green,
   * and the setting only holds one colour — so rather than guess at green, the
   * turn goes to the engine, which can read the sentence properly.
   */
  if (colour) {
    if (negatedSomething) return null;
    patch.accent = colour;
  }
  return Object.keys(patch).length ? patch : null;
}

/*
 * May the platform engine take this turn?
 *
 * Only for a material it can rebuild: one it wrote itself, or one with nothing
 * in it yet. Anything else is an older material whose content this engine
 * cannot read, and running it would replace the teacher's work with a freshly
 * written document.
 *
 * `countParts` is passed in rather than imported: lessonDocSchema pulls in
 * Mongoose, and this module is required by a test that has no database.
 */
function nativeCanHandle(doc = {}, countParts) {
  /*
   * A native source means blocks this engine actually wrote. An empty object
   * was enough before, so a document whose aiMeta was damaged — `native: {}` —
   * looked native, got rebuilt from nothing, and lost its contents.
   */
  const native = doc.aiMeta && doc.aiMeta.native;
  if (native && typeof native === "object" && Array.isArray(native.blocks) && native.blocks.length) {
    return true;
  }
  /*
   * Otherwise it may only write into a document that is genuinely empty.
   *
   * `countParts` counts block-level tags, so a body made of <div>, <section> or
   * an SVG figure counted as ZERO and an older material was treated as a blank
   * page. Anything with visible text or a drawing in it is somebody's work and
   * belongs to the engine that understands it.
   */
  const html = String(doc.html || "");
  const hasText = html.replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/gi, " ").trim().length > 0;
  const hasDrawing = /<(svg|img|figure|table|canvas)\b/i.test(html);
  if (hasText || hasDrawing) return false;
  if (Array.isArray(doc.blocks) && doc.blocks.length) return false;
  const parts = typeof countParts === "function" ? countParts(doc) : 0;
  return !parts;
}

module.exports = { NATIVE_SCHEMA, NATIVE_SYSTEM, MAX_BLOCKS, normalizeNative, nativeBlocksToHtml, nativePrompt, nativePrintOptions, diagramSvg, nativeCanHandle };
