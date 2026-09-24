/*
 * The economical lesson-material engine.
 *
 * The model supplies teaching content and semantic diagram data only. It never
 * writes HTML, CSS, or SVG coordinates. This keeps the paid request bounded and
 * makes the browser preview and PDF use the same platform-owned document body.
 */
const { renderBlock, esc } = require("./lessonDocHtml");

const { GEOMETRY_TYPES, geometrySvg, geometryUsable } = require("./lessonDocGeometry");

/*
 * The six semantic diagrams arrange LABELS; the six geometry figures construct
 * SHAPES from measurements. They are one list because a diagram block is a
 * diagram block, and the model should choose between "these four ideas relate"
 * and "this triangle has these sides" on meaning alone.
 */
const SEMANTIC_TYPES = ["flow", "cycle", "compare", "timeline", "bars", "concept"];
const DIAGRAM_TYPES = [...SEMANTIC_TYPES, ...GEOMETRY_TYPES];
/*
 * The kinds a lesson block may be — ONE list, used by the schema the model is
 * held to and by the normaliser that reads its answer. Two lists drift, and when
 * they drift the model is forbidden from sending something we are ready to
 * accept, which fails silently and looks like the model ignoring instructions.
 */
const BLOCK_KINDS = ["heading", "text", "list", "definition", "example", "task", "note", "table", "diagram", "image"];
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
          /*
           * MUST match BLOCK_KINDS below. The normaliser accepted "image" while
           * this enum did not list it, so the strict schema forbade the very
           * block the prompt asked for: the feature shipped unable to happen,
           * and every test passed because they all went through the normaliser
           * rather than through the contract the model is bound by.
           */
          kind: { type: "string", enum: BLOCK_KINDS },
          text: { type: "string" },
          term: { type: "string" },
          items: { type: "array", maxItems: MAX_ITEMS, items: { type: "string" } },
          ordered: { type: "boolean" },
          solution: { type: "string" },
          columns: { type: "array", maxItems: 8, items: { type: "string" } },
          rows: { type: "array", maxItems: 12, items: { type: "array", maxItems: 8, items: { type: "string" } } },
          tone: { type: "string", enum: ["info", "warning", "success"] },
          /*
           * Which of the teacher's attached pictures this block shows, by its
           * NUMBER in the list the prompt gives — not a filename and not a key.
           * A number is the one identifier a model cannot mistype into something
           * that resolves to a different file, and it is validated against the
           * document's own attachments before anything is read.
           */
          imageRef: { anyOf: [{ type: "integer" }, { type: "null" }] },
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
        required: ["kind", "text", "term", "items", "ordered", "solution", "columns", "rows", "tone", "diagram", "imageRef"],
      },
    },
    /*
     * Print settings the ANSWER may change.
     *
     * Without this the model had no way to say it. A request like "add page
     * numbers and shorten the text" reaches the engine whenever the local
     * shortcut declines it — and the text would be shortened while the page
     * numbers were quietly ignored, because the schema had nowhere to put them.
     * Half a request done, nothing said.
     */
    printOptions: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          /*
           * Both fields are required by the schema — strict structured output
           * demands it — but either may be null. Requiring real VALUES for both
           * meant a teacher who asked only for page numbers got an accent
           * invented alongside, silently repainting the document.
           */
          properties: {
            pageNumbers: { anyOf: [{ type: "boolean" }, { type: "null" }] },
            accent: {
              anyOf: [
                { type: "string", enum: ["red", "orange", "green", "teal", "purple", "slate"] },
                { type: "null" },
              ],
            },
          },
          required: ["pageNumbers", "accent"],
        },
        { type: "null" },
      ],
    },
  },
  required: ["title", "audience", "reply", "blocks", "printOptions"],
};

const NATIVE_SYSTEM = `
Sən Azərbaycan məktəbləri üçün dərs materialının məzmununu hazırlayırsan.
Yalnız JSON qaytar. HTML, CSS, SVG, koordinat, JavaScript və markdown qaytarma.
Məzmunu blocks massivində yaz: başlıq, izah, siyahı, termin, nümunə, tapşırıq,
qeyd, cədvəl və lazım olduqda semantic diagram. Platforma görünüşü və PDF-i özü
hazırlayacaq. Mövzunu uydurma: əlavə fayl verilirsə, onun məzmununa söykən.
Hər materialda ən azı bir heading və bir text olsun. Nümunənin həlli example.solution
field-də, tapşırığın cavabı isə solution-da olsun; platforma tələbəyə cavabı göstərmir.
Diagram bloku İKİ ayrı qrupdan ibarətdir. Qrupu qarışdırma.

1) SEMANTİK diagram — anlayışları qutularda düzür, FİQUR ÇƏKMİR:
flow, cycle, compare, timeline, bars, concept. Yalnız mərhələ, müqayisə,
ardıcıllıq və ya say üçün.

2) HƏNDƏSİ fiqur — platforma şəkli ÖLÇÜLƏRƏ görə miqyasla qurur:
- triangle: values=[a, b, c] üç tərəfin uzunluğu; labels=[a adı, b adı, c adı, A, B, C].
  Düz bucağı platforma özü tapır və işarə edir — a²+b²=c² olması kifayətdir.
- pythagoras: values=[a, b] iki katet. Hipotenuz və hər üç tərəf üzərindəki
  kvadratlar (a², b², c²) və onların sahələri avtomatik hesablanır və çəkilir.
- circle: values=[r] radius; labels=[mərkəz, radius adı, diametr adı].
- rectangle: values=[en, hündürlük]; sahə və perimetr avtomatik yazılır.
- angle: values=[dərəcə]; labels=[təpə, birinci şüa, ikinci şüa].
- grid: values=[x1, y1, x2, y2, ...] koordinat cütləri; labels=[nöqtə adları].

QAYDA: üçbucaq, çevrə, düzbucaqlı, bucaq, kvadrat və ya koordinat müstəvisi
göstərmək lazımdırsa MÜTLƏQ 2-ci qrupdan seç. Belə fiqur üçün compare, concept
və ya flow İSTİFADƏ ETMƏ — onlar sözləri qutulara yığır, fiqur çəkmir, və nəticə
səhv material olur. Pifaqor teoremi üçün həmişə pythagoras seç.

MÖVCUD MATERİALI DÜZƏLT: əgər materialda artıq fiqur yerinə compare/concept/flow
diagramı varsa, onu saxlama — düzgün həndəsi tiplə ƏVƏZ ET və ölçüləri ver.

Ölçülər mətndəki rəqəmlərlə eyni olmalıdır. Ölçü verilmirsə, sıfırdırsa və ya
mümkün deyilsə (məsələn üçbucaq bağlanmırsa) fiqur ÇƏKİLMİR və blok atılır —
ona görə ya düzgün rəqəm ver, ya da fiqur istəmə. Fiqurun içinə mətn yazma.
Müəllim çap parametrini istəyirsə (səhifə nömrəsi, rəng), onu printOptions-da qaytar;
istəməyibsə printOptions null olsun. Yalnız istənilən sahəni doldur, digərini null qoy —
soruşulmayan parametri dəyişmə. Parametri mətnin içinə yazma.
Diagramda ən çox 8 qısa label və 8 rəqəm ver. Bir diagram kifayətdir.
Müəllimin əlavə etdiyi şəkil varsa və onu materialda göstərmək istəyirsə,
kind:"image" bloku ilə imageRef nömrəsini ver — şəkil PDF-ə də düşür.
Şəkil yoxdursa imageRef həmişə null olsun.
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
  const ACCENTS = ["red", "orange", "green", "teal", "purple", "slate"];
  const print = raw.printOptions && typeof raw.printOptions === "object" ? raw.printOptions : null;
  return {
    // Only what the model actually set, and only values the renderer knows.
    printOptions: print
      ? {
          ...(typeof print.pageNumbers === "boolean" ? { pageNumbers: print.pageNumbers } : {}),
          ...(ACCENTS.includes(print.accent) ? { accent: print.accent } : {}),
        }
      : null,
    title: clamp(raw.title, 160),
    audience: clamp(raw.audience, 180),
    reply: clamp(raw.reply, 500),
    blocks: blocks
      .map((b) => ({
        kind: BLOCK_KINDS.includes(b?.kind) ? b.kind : "text",
        text: clamp(b?.text),
        term: clamp(b?.term, 180),
        items: cleanArray(b?.items),
        ordered: Boolean(b?.ordered),
        solution: clamp(b?.solution),
        columns: cleanArray(b?.columns, 8),
        rows: (Array.isArray(b?.rows) ? b.rows : []).slice(0, 12).map((r) => cleanRow(r, cleanArray(b?.columns, 8).length)),
        tone: ["info", "warning", "success"].includes(b?.tone) ? b.tone : "info",
        // A positive whole number or nothing. Which attachment it names is not
        // this function's business — it does not know what is attached.
        imageRef: Number.isInteger(b?.imageRef) && b.imageRef > 0 && b.imageRef < 100 ? b.imageRef : null,
        // A geometry figure whose measurements cannot build it is dropped here,
        // rather than drawn from substituted numbers that contradict the lesson.
        diagram: b?.diagram && DIAGRAM_TYPES.includes(b.diagram.type)
          && (!GEOMETRY_TYPES.includes(b.diagram.type) || geometryUsable(b.diagram.type, b.diagram.values))
          ? { type: b.diagram.type, title: clamp(b.diagram.title, 180), labels: cleanArray(b.diagram.labels, 8), values: (Array.isArray(b.diagram.values) ? b.diagram.values : []).map(Number).filter(Number.isFinite).slice(0, 8) }
          : null,
      }))
      .filter((b) => {
        if (b.kind === "diagram") return Boolean(b.diagram);
        // An image block is its picture; a caption is optional, and requiring
        // text would drop a perfectly good figure for having none.
        if (b.kind === "image") return Boolean(b.imageRef);
        return Boolean(b.text || b.term || b.items.length || b.columns.length || b.rows.some((r) => r.some(Boolean)));
      }),
  };
}

// A block of the shape normalizeNative produces, so anything added afterwards
// walks the same renderer as everything the model wrote.
const emptyBlock = (kind, text) => ({
  kind,
  imageRef: null,
  text: clamp(text),
  term: "",
  items: [],
  ordered: false,
  solution: "",
  columns: [],
  rows: [],
  tone: "info",
  diagram: null,
});

/*
 * Make a usable document out of a nearly-usable one.
 *
 * The turn used to be rejected unless it contained BOTH a heading block and a
 * text block. A material that came back as a heading, a list and four tasks —
 * perfectly good, and already paid for — was thrown away, and the teacher was
 * told to try again. That is the worst outcome available: the money is spent
 * either way, and the only question is whether anybody gets the material.
 *
 * So what can be repaired is repaired. A document with content but no heading
 * gets one from its own title. Only genuine emptiness is still a failure.
 */
function salvageNative(content) {
  if (!content.blocks.length) return content;
  if (content.blocks.some((b) => b.kind === "heading")) return content;
  const title = content.title || content.blocks.find((b) => b.text)?.text || "";
  if (!title) return content;
  /*
   * At the ceiling, the document keeps what it has.
   *
   * normalizeNative caps a document at MAX_BLOCKS; prepending to a full one
   * makes MAX_BLOCKS + 1, and the NEXT turn re-normalises and drops the last
   * block — so a heading added here would silently cost the teacher their
   * closing section one edit later. A document with 36 blocks and no heading is
   * vanishingly rare and perfectly readable; losing its final block is not.
   */
  if (content.blocks.length >= MAX_BLOCKS) return content;
  return { ...content, blocks: [emptyBlock("heading", title), ...content.blocks] };
}

function svgText(x, y, value, size = 14, anchor = "middle") {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial,sans-serif" font-size="${size}" fill="#222631">${esc(value)}</text>`;
}

function diagramSvg(d) {
  // A figure is built from its numbers, not laid out from its labels, so it has
  // its own renderer rather than another branch of the box-placing code below.
  if (GEOMETRY_TYPES.includes(d.type)) return geometrySvg(d);
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

/*
 * A picture's identity in a stored document: the first 16 characters of its
 * content hash. Short enough to read in the markup, long enough that it cannot
 * collide, and stable across every change to the attachment list.
 */
const stableImageId = (file) => String(file?.key || "").slice(0, 16);

function nativeBlocksToHtml(native, { images = [] } = {}) {
  const blocks = native.blocks.map((b) => {
    if (b.kind === "diagram") return { kind: "figure", text: b.diagram.title, svg: diagramSvg(b.diagram) };
    return b;
  });
  /*
   * An image block becomes a figure that NAMES a picture rather than containing
   * one. The bytes are attached later, by the platform, from the document's own
   * files — see embedDocImages. Stored this way the document stays small enough
   * to live in Mongo however many photographs it shows, and the same markup
   * serves the screen and the PDF.
   */
  /*
   * The picture is named by a STABLE id, not by its position.
   *
   * The model counts — "the teacher's first picture" — because a number is what
   * it can get right. What gets STORED must not be a number: delete the first
   * attachment and every later one shifts down, so a material saved last week
   * would quietly start showing a different photograph. The count is therefore
   * translated to the file's own identity here, once, at the moment the document
   * is written, and never resolved by position again.
   *
   * A reference to a picture that is not attached is kept as a marked figure
   * rather than dropped: the teacher asked for it, and silence is how a missing
   * illustration becomes a mystery instead of a fixable mistake.
   */
  const imageHtml = (b) => {
    const file = images[b.imageRef - 1];
    const caption = b.text ? `<figcaption>${esc(b.text)}</figcaption>` : "";
    if (!file) return `<figure class="doc-image doc-image-missing">${caption || "<figcaption>Şəkil tapılmadı</figcaption>"}</figure>`;
    return `<figure class="doc-image" data-image="${esc(stableImageId(file))}">${caption}</figure>`;
  };
  const title = native.title ? `<h1>${esc(native.title)}</h1>` : "";
  const meta = native.audience ? `<p class="meta">${esc(native.audience)}</p>` : "";
  return `${title}${meta}${blocks.map((b) => (b.kind === "image" ? imageHtml(b) : renderBlock(b, false))).join("\n")}`;
}

function nativePrompt({ request, current, sourceNotes, sourceText, images }) {
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
    images?.length
      ? `MÜƏLLİMİN ƏLAVƏ ETDİYİ ŞƏKİLLƏR (nömrə ilə):\n${images.map((f, i) => `${i + 1}. ${f.name}`).join("\n")}\n` +
        "Şəkli materiala qoymaq üçün kind:\"image\" bloku yarat, imageRef-ə həmin nömrəni yaz, " +
        "text-ə isə altyazı yaz. Şəkli təsvir edib mətnə çevirmə — nömrəsini ver, platforma şəkli özü yerləşdirir. " +
        "Müəllim şəkilləri göstərməyi istəyirsə hamısını qoy."
      : "",
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
// Stems that mean "off" on their own.
const OFF_STEMS = ["olmasın", "olmasin", "sil", "çıxar", "cixar", "gizlət", "gizlet", "istəmirəm", "istemirem", "istəmir", "istemir"];
// Stems that mean "on" on their own. Deliberately absent: "yaz" (write) and
// "qoy" (put), which is how people ask for content — "material yaz" is a
// request for a lesson, not for a setting.
const ON_STEMS = ["olmalı", "olmali", "olsun", "əlavə", "elave", "göstər", "goster", "lazımdır", "lazimdir"];
/*
 * Words with no instruction in them — matched WHOLE, never as a prefix.
 *
 * Prefix-matching these was a quiet disaster: "də" is filler, so "dəyiş"
 * (change it) matched as filler and "səhifə nömrələrini dəyiş" was answered
 * locally with page numbers switched on. A two-letter particle must not swallow
 * a verb that happens to start with it.
 */
const FILLER_WORDS = new Set([
  "və", "ve", "ilə", "ile", "et", "edin", "elə", "ele", "edək", "edek", "bu", "o",
  "material", "materialı", "materiali", "materialın", "materialin",
  "sənəd", "sened", "sənədi", "senedi", "sənədin", "senedin",
  "pdf", "fayl", "faylı", "fayli", "faylın", "faylin",
  "zəhmət", "zehmet", "olmasa", "lütfən", "lutfen",
  "hər", "her", "bütün", "butun", "yalnız", "yalniz", "da", "də", "de",
]);
const COLOR_WORDS = [
  ["qırmızı", "red"], ["qirmizi", "red"], ["narıncı", "orange"], ["narinci", "orange"],
  ["yaşıl", "green"], ["yasil", "green"], ["mavi", "teal"], ["göy", "teal"], ["goy", "teal"],
  ["bənövşəyi", "purple"], ["benovseyi", "purple"], ["boz", "slate"],
];

const stemHit = (word, stems) => stems.some((stem) => word.startsWith(stem));

/*
 * Azerbaijani negates a verb with -ma / -mə, and that inverts the instruction:
 * "göstər" is show, "göstərmə" is DON'T show. Reading the second as the first
 * turned page numbers ON for someone asking to turn them off.
 *
 * Guarded against words that merely end in those letters — "olmalıdır" (must
 * be) is not a negation, nor is "nömrə".
 */
/*
 * Whole words whose polarity is settled, checked BEFORE any suffix stripping.
 *
 * "olmasın" is the ordinary way to say "there should not be one", and it ends
 * in the negation suffix — strip it and what is left is "ol", which means
 * nothing on its own. These are read as themselves.
 */
const EXPLICIT = new Map([
  ["olmasın", false], ["olmasin", false],
  ["olsun", true], ["olmalı", true], ["olmali", true], ["olmalıdır", true], ["olmalidir", true],
  ["lazımdır", true], ["lazimdir", true],
]);

/*
 * The negation suffix, with the endings that actually follow it.
 *
 * -ma / -mə is the negation; what comes after is person and mood, and the most
 * common request form in the wild is -məsin ("let it not…"): "göstərməsin",
 * "silinməsin". Those were falling through and producing the OPPOSITE setting —
 * someone asking for page numbers to be hidden got them switched on.
 */
const NEGATION = /(ma|mə)(sın|sin|sun|sün|dan|dən|yın|yin|yun|yün)?$/;
const looksNegated = (word) =>
  !EXPLICIT.has(word) &&
  NEGATION.test(word) &&
  !/^(olmalı|olmali|nömrə|nomre|əlavə|elave|rəngi|rengi)/.test(word);

/*
 * Is this turn ONLY about how the material prints?
 *
 * Every word has to be one this shortcut knows, and every negation has to
 * attach to a word whose meaning it can actually invert. Anything else — an
 * unknown verb, a negation on a filler word, a quantity, a colour it is being
 * asked NOT to use — is handed to the engine, which can read the sentence.
 *
 * The asymmetry is deliberate. A settings request that reaches the model costs
 * a couple of cents; a content request answered locally silently throws away
 * the teacher's work. Every doubt resolves toward the model.
 */
function nativePrintOptions(request) {
  const raw = String(request || "").trim();
  // A settings instruction is short. Anything longer is a request about the
  // material with a setting mentioned along the way.
  if (!raw || raw.length > 60) return null;
  const words = raw.toLocaleLowerCase("az").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;

  /*
   * A digit is a quantity, and a quantity is about content: "2 səhifə material
   * yaz" is two pages of lesson. Page-number and colour requests never need a
   * number, so any digit hands the turn over.
   */
  if (words.some((w) => /\d/.test(w))) return null;

  let page = false;
  let colour = null;
  let polarity = null; // null = unstated, true = on, false = off

  for (const word of words) {
    if (EXPLICIT.has(word)) { polarity = EXPLICIT.get(word); continue; }
    const negated = looksNegated(word);
    const base = negated ? word.replace(NEGATION, "") : word;

    if (stemHit(base, PAGE_STEMS)) {
      if (negated) return null; // "nömrələmə"? not a shape this can read safely
      page = true;
      continue;
    }
    const named = COLOR_WORDS.find(([w]) => base.startsWith(w));
    if (named) {
      if (negated) return null; // "yaşıl olmasın" — a single accent cannot say NOT green
      colour = named[1];
      continue;
    }
    if (stemHit(base, COLOR_STEMS) || stemHit(base, PRINT_STEMS)) {
      if (negated) return null;
      continue;
    }

    if (stemHit(base, OFF_STEMS)) { polarity = negated ? true : false; continue; }
    if (stemHit(base, ON_STEMS)) {
      if (negated) polarity = false;
      else if (polarity === null) polarity = true;
      continue;
    }

    if (FILLER_WORDS.has(base)) {
      /*
       * A negation on a word carrying no instruction cannot be attributed:
       * "əlavə etmə" is don't ADD, but the -mə sits on "et", and guessing which
       * verb it belongs to is how "don't add page numbers" became "add page
       * numbers". The engine gets it.
       */
      if (negated) return null;
      continue;
    }
    // A word this shortcut does not know.
    return null;
  }

  const patch = {};
  if (page) patch.pageNumbers = polarity !== false;
  if (colour) {
    /*
     * "səhifə nömrəsi qırmızı olmasın" names a colour AND asks for something
     * off. The accent is one colour for the whole document, so there is no way
     * to express "not red" — and setting red would be the opposite of the ask.
     */
    if (polarity === false) return null;
    patch.accent = colour;
  }
  return Object.keys(patch).length ? patch : null;
}

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

module.exports = { salvageNative, BLOCK_KINDS, stableImageId, NATIVE_SCHEMA, NATIVE_SYSTEM, MAX_BLOCKS, normalizeNative, nativeBlocksToHtml, nativePrompt, nativePrintOptions, diagramSvg, nativeCanHandle };
