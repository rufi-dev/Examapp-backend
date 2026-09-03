const crypto = require("crypto");

/*
 * The lesson material the model writes, and the rules it writes under.
 *
 * OpenAI strict mode: `additionalProperties: false` everywhere AND every property
 * listed in `required`. There is no way to say "optional", so a field that does not
 * apply comes back as an empty string or an empty array and is normalised away
 * here. `minItems`, `maximum` and `pattern` are unavailable, so counts are asked
 * for in the prompt and enforced on this side.
 */

const BLOCK = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: ["heading", "text", "list", "definition", "example", "task", "note", "table"],
    },
    text: { type: "string" },
    term: { type: "string" },
    items: { type: "array", items: { type: "string" } },
    ordered: { type: "boolean" },
    solution: { type: "string" },
    columns: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "array", items: { type: "string" } } },
    tone: { type: "string", enum: ["info", "warning", "success"] },
  },
  required: ["kind", "text", "term", "items", "ordered", "solution", "columns", "rows", "tone"],
};

const DOC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    blocks: { type: "array", items: BLOCK },
  },
  required: ["title", "blocks"],
};

const BASE_RULES = `
Sən Azərbaycan məktəbləri üçün DƏRS MATERİALI hazırlayan metodistsən. Bu material
şagirdə verilir: mövzunu izah edir, nümunə göstərir və məşq etdirir.

DİL: hər şey Azərbaycan dilində, aydın və sadə. Şagirdin yaşına uyğun yaz.

BLOK TİPLƏRİ və nə vaxt istifadə edilir:
- heading — bölmə başlığı. Materialı 3–6 bölməyə ayır.
- text — izah. Bir blokda BİR fikir; uzun abzas yazma.
- definition — anlayış: "term" sahəsində termin, "text" sahəsində izahı.
- list — sadalama. Addım-addımdırsa "ordered": true.
- example — həll olunmuş nümunə. "text" şərt, "solution" addım-addım həll.
- task — şagirdin özünün edəcəyi tapşırıq. Cavabı bilirsənsə "solution"-a yaz.
- note — qeyd: "tone" = info (məsləhət), warning (tez-tez edilən səhv), success (yadda saxla).
- table — müqayisə və ya cədvəl. "columns" başlıqlar, "rows" sətirlər.

MÜTLƏQ QAYDALAR:
- Materialın strukturu olmalıdır: giriş izahı → anlayışlar → nümunələr → tapşırıqlar.
- Ən azı bir "example" və ən azı bir "task" olsun.
- İstifadə etmədiyin sahələri BOŞ qaytar: boş sətir "" və ya boş massiv [].
  Məsələn "text" blokunda "term", "items", "columns", "rows" boş olmalıdır.
- Uydurma fakt, uydurma tarix, uydurma sitat YAZMA. Bilmirsənsə, ümumi izah ver.
- Başlıq (title) qısa və mövzunu bildirən olsun.
`.trim();

const EDIT_RULES = `
REDAKTƏ REJİMİ:
- Aşağıda müəllimin HAZIRKI materialı var. Onu yenidən yazma.
- YALNIZ müəllimin istədiyi dəyişikliyi et. Qalan bloklar OLDUĞU KİMİ, eyni sözlərlə
  qaytarılmalıdır.
- Blokların sırası dəyişməməlidir, əgər müəllim məhz sıranı dəyişməyi istəmirsə.
- Yeni blok əlavə etmək istənilirsə, onu düzgün yerə qoy.
`.trim();

const describe = (d = {}) =>
  [
    d.topic ? `Mövzu: ${d.topic}` : null,
    d.grade ? `Sinif: ${d.grade}` : null,
    d.subject ? `Fənn: ${d.subject}` : null,
    d.audience ? `Kimin üçün: ${d.audience}` : null,
  ]
    .filter(Boolean)
    .join("\n");

// First pass: there is no document yet, only what the teacher asked for.
function buildCreatePrompt({ doc = {}, instructions = "" } = {}) {
  return {
    system: BASE_RULES,
    prompt: [
      describe(doc),
      "",
      `MÜƏLLİMİN İSTƏYİ: ${String(instructions || "").slice(0, 4000)}`,
      "",
      "Bu istəyə uyğun tam dərs materialı hazırla.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/*
 * Every later pass. The whole current document goes in, so the model changes one
 * thing and hands the rest back untouched — the same contract as the lesson-plan
 * editor, and the reason a teacher's own wording survives a request to "add two
 * more examples".
 */
function buildEditPrompt({ doc = {}, instructions = "" } = {}) {
  const current = {
    title: doc.title || "",
    blocks: (doc.blocks || []).map((b) => ({
      kind: b.kind,
      text: b.text || "",
      term: b.term || "",
      items: b.items || [],
      ordered: b.ordered === true,
      solution: b.solution || "",
      columns: b.columns || [],
      rows: b.rows || [],
      tone: b.tone || "info",
    })),
  };
  return {
    system: [BASE_RULES, EDIT_RULES].join("\n\n"),
    prompt: [
      describe(doc),
      "",
      "HAZIRKI MATERİAL (JSON):",
      JSON.stringify(current),
      "",
      `MÜƏLLİMİN İSTƏDİYİ DƏYİŞİKLİK: ${String(instructions || "").slice(0, 4000)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

const clean = (v) => String(v == null ? "" : v).replace(/\r/g, "").trim();
const list = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);
const newId = () => crypto.randomBytes(6).toString("hex");

/*
 * Take the model's answer and make it storable.
 *
 * Strict mode forces every field on every block, so a text block arrives carrying
 * empty `columns`, `rows` and `term`. Storing that noise would put meaningless keys
 * in the database and meaningless controls in the editor, so each kind keeps only
 * what it uses. Anything unrecognisable is dropped rather than guessed at — a block
 * with no content cannot be rendered or edited, and an empty box in a handout is
 * worse than one fewer paragraph.
 */
function normalizeDoc(rawDoc = {}, { keepIds = [] } = {}) {
  // A default parameter only fires for `undefined`, so an explicit null — which a
  // provider can absolutely return — reached the property access and threw. A print
  // request is not the place to 500.
  const raw = rawDoc && typeof rawDoc === "object" ? rawDoc : {};
  const blocks = [];
  const src = Array.isArray(raw.blocks) ? raw.blocks : [];

  src.forEach((b, i) => {
    if (!b || typeof b !== "object") return;
    const kind = String(b.kind || "").trim();
    // Reuse the id in the same position where one exists, so an edit that returns
    // the document unchanged does not renumber every block.
    const id = keepIds[i] || newId();
    const text = clean(b.text);

    switch (kind) {
      case "heading":
        if (text) blocks.push({ id, kind, text });
        break;
      case "text":
        if (text) blocks.push({ id, kind, text });
        break;
      case "note":
        if (text) {
          const tone = ["info", "warning", "success"].includes(b.tone) ? b.tone : "info";
          blocks.push({ id, kind, text, tone });
        }
        break;
      case "definition": {
        const term = clean(b.term);
        if (term || text) blocks.push({ id, kind, term, text });
        break;
      }
      case "list": {
        const items = list(b.items);
        if (items.length) blocks.push({ id, kind, items, ordered: b.ordered === true });
        break;
      }
      case "example":
      case "task": {
        const solution = clean(b.solution);
        if (text) blocks.push({ id, kind, text, solution });
        break;
      }
      case "table": {
        const columns = list(b.columns);
        const rows = (Array.isArray(b.rows) ? b.rows : [])
          .map((r) => list(r))
          .filter((r) => r.length);
        if (columns.length && rows.length) blocks.push({ id, kind, columns, rows });
        break;
      }
      default:
        break;
    }
  });

  return { title: clean(raw.title), blocks };
}

// What the teacher is told after a pass, so "it did something" is never the whole
// report. Counts, not prose — the document itself is the detail.
function summarize(blocks = []) {
  const n = (kind) => blocks.filter((b) => b.kind === kind).length;
  return {
    blocks: blocks.length,
    sections: n("heading"),
    examples: n("example"),
    tasks: n("task"),
  };
}

module.exports = {
  DOC_SCHEMA,
  BLOCK,
  BASE_RULES,
  EDIT_RULES,
  buildCreatePrompt,
  buildEditPrompt,
  normalizeDoc,
  summarize,
  newId,
};
