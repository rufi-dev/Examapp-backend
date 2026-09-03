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
      enum: ["heading", "text", "list", "definition", "example", "task", "note", "table", "figure"],
    },
    text: { type: "string" },
    term: { type: "string" },
    items: { type: "array", items: { type: "string" } },
    ordered: { type: "boolean" },
    solution: { type: "string" },
    columns: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "array", items: { type: "string" } } },
    tone: { type: "string", enum: ["info", "warning", "success"] },
    // A drawing, authored as SVG. Sanitised hard on arrival — see helper/lessonDocSvg.
    svg: { type: "string" },
  },
  required: ["kind", "text", "term", "items", "ordered", "solution", "columns", "rows", "tone", "svg"],
};

const DOC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    // What the model says to the teacher. Counting blocks is a receipt, not an
    // answer — a teacher who asks "make it simpler for weaker students" wants to
    // hear what was actually done about it.
    reply: { type: "string" },
    blocks: { type: "array", items: BLOCK },
  },
  required: ["title", "reply", "blocks"],
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
- figure — ŞƏKİL/SXEM. "svg" sahəsinə SVG kodu yaz, "text" sahəsinə şəklin altyazısı.
  Riyaziyyat, həndəsə, fizika, biologiya üçün: ədəd oxu, üçbucaq, dairə və radius,
  koordinat müstəvisi, diaqram, kəsr zolağı, hüceyrə sxemi və s.

FİQUR (figure) QAYDALARI:
- Mütləq viewBox olmalıdır, məsələn: <svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">
- YALNIZ bu elementlərdən istifadə et: line, path, rect, circle, ellipse, polygon,
  polyline, text, g, defs, marker. Script, style, foreignObject, image QADAĞANDIR.
- Rəngləri birbaşa fill/stroke atributunda yaz (style atributu işləmir).
- Şəkil izahı asanlaşdırırsa əlavə et. Sadəcə bəzək üçün fiqur çəkmə.
- Yazıları <text> ilə əlavə et ki, şəkil özü özünü izah etsin.

MÜTLƏQ QAYDALAR:
- Materialın strukturu olmalıdır: giriş izahı → anlayışlar → nümunələr → tapşırıqlar.
- Ən azı bir "example" və ən azı bir "task" olsun.
- İstifadə etmədiyin sahələri BOŞ qaytar: boş sətir "" və ya boş massiv [].
  Məsələn "text" blokunda "term", "items", "columns", "rows" boş olmalıdır.
- Uydurma fakt, uydurma tarix, uydurma sitat YAZMA. Bilmirsənsə, ümumi izah ver.
- Başlıq (title) qısa və mövzunu bildirən olsun.

"reply" SAHƏSİ: müəllimə 1–2 cümlə yaz — nə etdiyini və niyə. Söhbət tonunda, sadə.
Blokları sadalama, rəqəm hesabatı vermə (onu sistem özü göstərir). Nümunə:
"Mövzunu üç bölməyə ayırdım və hər qaydaya bir nümunə verdim. Tapşırıqları asandan
çətinə düzdüm." Nəyisə edə bilmədinsə, bunu da açıq yaz.
`.trim();

const EDIT_RULES = `
REDAKTƏ REJİMİ:
- Aşağıda müəllimin HAZIRKI materialı var. Onu yenidən yazma.
- YALNIZ müəllimin istədiyi dəyişikliyi et. Qalan bloklar OLDUĞU KİMİ, eyni sözlərlə
  qaytarılmalıdır.
- Blokların sırası dəyişməməlidir, əgər müəllim məhz sıranı dəyişməyi istəmirsə.
- Yeni blok əlavə etmək istənilirsə, onu düzgün yerə qoy.
`.trim();


/*
 * Added only when the teacher has attached something. Without it the model has a
 * file in the request and no instruction to prefer it, and will happily write from
 * general knowledge while ignoring the page it was given.
 */
const SOURCE_RULES = `
ƏLAVƏ EDİLMİŞ FAYLLAR:
- Müəllim fayl (PDF və ya şəkil) əlavə edib. O fayl BİRİNCİ MƏNBƏDİR.
- Materialı həmin faylın məzmununa əsaslandır: anlayışlar, nümunələr, tapşırıqlar
  mümkün qədər oradan götürülsün.
- Faylda olmayan şeyi "faylda yazılıb" kimi təqdim etmə. Əlavə izah verirsənsə,
  bunu öz sözlərinlə yaz.
- Müəllim faylı yalnız NÜMUNƏ (üslub, format) kimi göstəribsə, məzmunu köçürmə —
  quruluşu təkrarla.

ÇEVİRMƏ İSTƏYİ (məsələn "bu şəkli materiala çevir", "bu vərəqi Word et"):
- Şəkildəki və ya PDF-dəki BÜTÜN məzmunu oxu və blok-blok yenidən qur:
  başlıqlar → heading, izahlar → text, anlayışlar → definition, həll olunmuş
  misallar → example, çalışmalar → task, cədvəllər → table.
- Mətnini dəyişdirmə, tərcümə etmə, "yaxşılaşdırma" — olduğu kimi köçür.
  Yalnız quruluşu ver: hansı hissə hansı blokdur.
- Əlyazma və ya keyfiyyətsiz şəkildə oxunmayan yer varsa, uydurma. Həmin yeri
  "[oxunmadı]" kimi qeyd et ki, müəllim özü düzəltsin.
- Şəkildə düstur, sxem və ya fiqur varsa, onu "figure" bloku kimi SVG ilə yenidən çək.
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
      // Without this the model never sees the drawing it made last turn, and an
      // unrelated edit silently loses every figure in the document.
      svg: b.svg || "",
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
      case "figure": {
        // The drawing is only worth keeping if it survives sanitising; a figure
        // block with no picture is an empty frame in a handout.
        const { sanitizeSvg } = require("./lessonDocSvg");
        const svg = sanitizeSvg(b.svg);
        if (svg) blocks.push({ id, kind, svg, text });
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

  return { title: clean(raw.title), reply: clean(raw.reply), blocks };
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


/*
 * PHASE 1 — decide what to write, before writing it.
 *
 * A single call that goes straight to prose gives the teacher nothing to look at
 * for forty seconds and no say in what is coming. This asks the model to read the
 * request and commit to a shape first: the title, who it is for, and the sections
 * it will write with a reason for each. It is small and fast, it is shown in the
 * chat immediately, and the writing pass is then held to it.
 */
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    audience: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { heading: { type: "string" }, why: { type: "string" } },
        required: ["heading", "why"],
      },
    },
  },
  required: ["title", "audience", "sections"],
};

const PLAN_RULES = `
Sən Azərbaycan məktəbləri üçün dərs materialı hazırlayan metodistsən.
Hələ material YAZMIRSAN — yalnız planlaşdırırsan.

Müəllimin istəyini oxu və qərar ver:
- "title": materialın qısa adı.
- "audience": kimin üçündür (sinif və səviyyə). Müəllim deməyibsə, mövzuya görə özün müəyyən et.
- "sections": 3–6 bölmə. Hər birinin "heading" adı və "why" — bir cümlə: bu bölmə nə üçün lazımdır.

Müəllim konkret şeylər istəyibsə (cədvəl, neçə nümunə, neçə tapşırıq, hansı səhvi
göstərmək), onları bölmələrdə əks etdir. Uydurma bölmə əlavə etmə.
`.trim();

function buildPlanPrompt({ doc = {}, instructions = "" } = {}) {
  return {
    system: PLAN_RULES,
    prompt: [describe(doc), "", `MÜƏLLİMİN İSTƏYİ: ${String(instructions || "").slice(0, 4000)}`]
      .filter(Boolean)
      .join("\n"),
  };
}

const normalizePlan = (raw = {}) => {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    title: clean(r.title),
    audience: clean(r.audience),
    sections: (Array.isArray(r.sections) ? r.sections : [])
      .map((x) => ({ heading: clean(x && x.heading), why: clean(x && x.why) }))
      .filter((x) => x.heading),
  };
};

/*
 * Reads blocks out of a half-finished JSON response, so progress can be reported
 * from what has actually been written rather than a timer. Same technique as the
 * exam streamer: walk the array, emit each object the moment it closes cleanly, and
 * wait for more bytes when it does not.
 */
function makeBlockStreamer() {
  let emitted = 0;
  return (buf) => {
    const key = buf.indexOf('"blocks"');
    if (key < 0) return [];
    const arrStart = buf.indexOf("[", key);
    if (arrStart < 0) return [];
    const fresh = [];
    let depth = 0;
    let objStart = -1;
    let inStr = false;
    let esc = false;
    let idx = 0;
    for (let i = arrStart + 1; i < buf.length; i += 1) {
      const c = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") {
        if (depth === 0) objStart = i;
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth === 0 && objStart >= 0) {
          idx += 1;
          if (idx > emitted) {
            try {
              fresh.push(JSON.parse(buf.slice(objStart, i + 1)));
              emitted = idx;
            } catch {
              return fresh; // not closed cleanly yet — wait for more bytes
            }
          }
          objStart = -1;
        }
      } else if (c === "]" && depth === 0) break;
    }
    return fresh;
  };
}

module.exports = {
  DOC_SCHEMA,
  SOURCE_RULES,
  PLAN_SCHEMA,
  PLAN_RULES,
  buildPlanPrompt,
  normalizePlan,
  makeBlockStreamer,
  BLOCK,
  BASE_RULES,
  EDIT_RULES,
  buildCreatePrompt,
  buildEditPrompt,
  normalizeDoc,
  summarize,
  newId,
};
