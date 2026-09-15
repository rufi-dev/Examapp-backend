/*
 * Handwriting OCR for paper answer cards via Google Cloud Vision
 * (DOCUMENT_TEXT_DETECTION: 1,000 images/month free, then ~$1.50 per 1,000).
 *
 * Vision returns every word with its box and a confidence. The card's printed
 * labels are the anchors: the name is what's written to the right of "Ad:",
 * "Soyad:", "Ata adı:", "Sinif:"; each open answer is what's written in the row
 * of a printed question number to the right of the bubble grid. Only answers
 * that read cleanly are accepted — the rest go to the AI fallback.
 */

const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";
const visionKey = () => process.env.GOOGLE_VISION_API_KEY || "";
const visionConfigured = () => !!visionKey();

// Words of one photo: [{ text, conf, x0, y0, x1, y1 }].
async function visionWords(jpegBuffer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let r;
  let body;
  try {
    r = await fetch(`${VISION_URL}?key=${encodeURIComponent(visionKey())}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: jpegBuffer.toString("base64") },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: { languageHints: ["az", "en"] },
          },
        ],
      }),
      signal: ctrl.signal,
    });
    body = await r.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
  const res = body?.responses?.[0];
  const err = body?.error || res?.error;
  if (!r.ok || err) throw new Error(`Vision: ${err?.message || `HTTP ${r.status}`}`);

  const words = [];
  (res?.fullTextAnnotation?.pages || []).forEach((page) =>
    (page.blocks || []).forEach((block) =>
      (block.paragraphs || []).forEach((para) =>
        (para.words || []).forEach((w) => {
          const symbols = w.symbols || [];
          const text = symbols.map((s) => s.text || "").join("");
          const vs = w.boundingBox?.vertices || [];
          if (!text || vs.length < 4) return;
          const xs = vs.map((v) => v.x || 0);
          const ys = vs.map((v) => v.y || 0);
          const confs = symbols.map((s) => s.confidence).filter((c) => typeof c === "number");
          words.push({
            text,
            conf: typeof w.confidence === "number" ? w.confidence : confs.length ? Math.min(...confs) : 0.5,
            x0: Math.min(...xs),
            x1: Math.max(...xs),
            y0: Math.min(...ys),
            y1: Math.max(...ys),
          });
        })
      )
    )
  );
  return words;
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const labelKey = (t) =>
  String(t || "")
    .toLocaleLowerCase("az")
    .replace(/[^\p{L}\p{N}]/gu, "");

/*
 * Words → { student, nameFound, nameResolved, open: [{ printed, answer, conf, multiline, empty }] }.
 * `grid` (upright bubble-grid bounds from OMR) and `flipped` orient the layout;
 * without a grid the open column is assumed to be the right half.
 */
function parseCardText(rawWords, { width, height, flipped = false, grid = null, openCount = 0 } = {}) {
  const words = rawWords.map((w) => {
    let { x0, x1, y0, y1 } = w;
    if (flipped) [x0, x1, y0, y1] = [width - 1 - w.x1, width - 1 - w.x0, height - 1 - w.y1, height - 1 - w.y0];
    return { ...w, x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h: Math.max(1, y1 - y0), key: labelKey(w.text) };
  });
  const sameLine = (label, w) => w.cy > label.y0 - 0.7 * label.h && w.cy < label.y1 + 0.7 * label.h;

  // ---- header: name boxes ----
  const headerBottom = grid ? grid.y0 : height * 0.4;
  const top = words.filter((w) => w.cy < headerBottom);
  const find = (k) => top.find((w) => w.key === k);
  const ad = find("ad");
  const soyad = find("soyad");
  const ata = find("ata");
  const adi = ata && top.find((w) => /^ad[ıil]$/.test(w.key) && sameLine(ata, w) && w.x0 >= ata.x1 - 4);
  const sinif = find("sinif");
  const ders = sinif && top.find((w) => /^d[əe]rs/.test(w.key) && sameLine(sinif, w) && w.x0 > sinif.x1);
  const labels = new Set([ad, soyad, ata, adi, sinif, ders].filter(Boolean));
  const valueAfter = (label, next) => {
    if (!label) return { text: "", conf: 1 };
    const ws = top
      .filter(
        (w) =>
          !labels.has(w) &&
          w.key &&
          sameLine(label, w) &&
          w.x0 >= label.x1 - 4 &&
          (!next || (sameLine(label, next) && w.x1 <= next.x0 + 4))
      )
      .sort((a, b) => a.x0 - b.x0);
    return { text: ws.map((w) => w.text).join(" "), conf: ws.length ? Math.min(...ws.map((w) => w.conf)) : 1 };
  };
  const first = valueAfter(ad, soyad);
  const last = valueAfter(soyad, ata);
  const father = valueAfter(adi || ata, null);
  const cls = valueAfter(sinif, ders);
  const nameFound = !!(ad && soyad);
  const student = {
    firstName: first.text.slice(0, 80),
    lastName: last.text.slice(0, 80),
    fatherName: father.text.slice(0, 80),
    className: cls.text.slice(0, 80),
  };
  const nameResolved = nameFound && first.conf >= 0.7 && last.conf >= 0.7;

  // ---- open answers: printed numbers right of the bubble grid ----
  const open = [];
  if (openCount > 0) {
    const regionX = grid ? grid.x1 : width * 0.45;
    const regionY = grid ? grid.y0 - (grid.y1 - grid.y0) * 0.15 : headerBottom * 0.5;
    const nums = words
      .filter((w) => w.x0 > regionX && w.cy > regionY && /^\d{1,2}$/.test(w.text))
      .sort((a, b) => a.x0 - b.x0);
    // Printed labels share one x; handwritten digits don't line up like that.
    const clusters = [];
    nums.forEach((w) => {
      const c = clusters.find((k) => Math.abs(k.x - w.x0) < width * 0.03);
      if (c) c.pts.push(w);
      else clusters.push({ x: w.x0, pts: [w] });
    });
    const need = Math.max(2, Math.ceil(openCount * 0.4));
    const col = clusters.filter((c) => c.pts.length >= need).sort((a, b) => a.x - b.x)[0];
    if (col) {
      const lh = median(col.pts.map((w) => w.h));
      const sorted = [...col.pts].sort((a, b) => a.cy - b.cy).filter((w, i, arr) => i === 0 || w.cy - arr[i - 1].cy > 0.5 * lh);
      const diffs = sorted.slice(1).map((w, i) => w.cy - sorted[i].cy);
      const pitch = median(diffs) || lh * 3;
      // Re-insert a label Vision missed (a gap of two or three rows).
      const rows = [];
      sorted.forEach((w, i) => {
        if (i) {
          const gap = w.cy - sorted[i - 1].cy;
          const k = Math.round(gap / pitch);
          if (k >= 2 && k <= 3 && Math.abs(gap - k * pitch) < 0.35 * pitch) {
            for (let j = 1; j < k; j++) rows.push({ printed: "", cy: sorted[i - 1].cy + (j * gap) / k, x1: w.x1, label: null });
          }
        }
        rows.push({ printed: w.text, cy: w.cy, x1: w.x1, label: w });
      });
      const labelX1 = median(sorted.map((w) => w.x1));
      const labelSet = new Set(sorted);
      const region = words.filter((w) => !labelSet.has(w) && w.cx > labelX1 + 0.2 * lh && w.cy > rows[0].cy - pitch / 2);
      const boxRight = region.length ? Math.max(...region.map((w) => w.x1)) : width;
      const span = Math.max(1, boxRight - labelX1);
      rows.forEach((row, i) => {
        const yTop = i ? (rows[i - 1].cy + row.cy) / 2 : row.cy - pitch / 2;
        const yBot = i < rows.length - 1 ? (rows[i + 1].cy + row.cy) / 2 : row.cy + pitch / 2;
        const inRow = region
          .filter((w) => w.cy >= yTop && w.cy < yBot)
          // Drop the printed pencil icons in the box corners.
          .filter(
            (w) =>
              !(
                [...w.text].length === 1 &&
                !/[\p{L}\p{N}]/u.test(w.text) &&
                (w.cx < labelX1 + 0.12 * span || w.cx > boxRight - 0.12 * span)
              )
          )
          .sort((a, b) => a.x0 - b.x0);
        const hs = median(inRow.map((w) => w.h));
        const ys = inRow.map((w) => w.cy);
        open.push({
          printed: row.printed,
          answer: inRow.map((w) => w.text).join(" "),
          conf: inRow.length ? Math.min(...inRow.map((w) => w.conf)) : 1,
          multiline: inRow.length > 1 && Math.max(...ys) - Math.min(...ys) > 0.8 * hs,
          empty: !inRow.length,
        });
      });
    }
  }

  return { student, nameFound, nameResolved, open };
}

module.exports = { visionConfigured, visionWords, parseCardText };
