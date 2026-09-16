/*
 * Platform reading of a paper answer card — no AI.
 *
 *  - closed questions: bubbles measured by OMR (helper/sheetOmr, free);
 *  - open questions + the name: Google Vision OCR (helper/sheetOcr);
 *  - anything not read with confidence is returned in `unresolved`, for the
 *    caller to send to the AI fallback (aiController.readSheetImages).
 */
const { runOmr, runGlyphs, runBoxInk } = require("./sheetOmr");
const { visionConfigured, visionWords, parseCardText } = require("./sheetOcr");
const { alignSection, parseSheetAnswer } = require("../controllers/aiController");

const SHEET_HOST = /(^|\.)res\.cloudinary\.com$/i;
const MAX_IMAGES = 6;
const CARD_OPTIONS = 5; // A–E bubbles on the card
const LETTERS = "abcdefghij";
// Characters a typed-out math answer may contain; anything else → AI.
const ALLOWED_TEXT = /^[\p{L}\p{N}\s+\-−–=/\\.,:;()[\]{}√π^*×·<>≤≥%'"|!°]+$/u;
// Share of an answer box that must be ink before "OCR read nothing" is allowed to
// mean "the student wrote nothing". Printed rules are erased before measuring, so
// a genuinely empty box sits near 0; even a faint digit clears this.
const BLANK_INK_MAX = 0.004;

const readError = (status, message) => {
  const e = new Error(message);
  e.aiStatus = status;
  e.userMessage = message;
  return e;
};

// Uploaded sheet photo as JPEG bytes (Cloudinary resizes + converts it).
async function fetchSheetJpeg(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw readError(400, "Şəkil ünvanı yanlışdır");
  }
  if (u.protocol !== "https:" || !SHEET_HOST.test(u.hostname)) {
    throw readError(400, "Yalnız platformaya yüklənmiş şəkillər qəbul olunur");
  }
  const original = u.toString();
  const urls = [];
  if (u.pathname.includes("/image/upload/")) {
    u.pathname = u.pathname.replace("/image/upload/", "/image/upload/c_limit,w_2000,h_2000,f_jpg,q_90/");
    urls.push(u.toString());
  }
  urls.push(original);
  for (const url of urls) {
    let r;
    try {
      r = await fetch(url);
    } catch {
      continue;
    }
    if (!r.ok) continue;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 12 * 1024 * 1024) throw readError(400, "Şəkil çox böyükdür");
    if (buf[0] === 0xff && buf[1] === 0xd8) return buf;
  }
  throw readError(400, "Şəkil yüklənmədi və ya formatı dəstəklənmir");
}

// Pixel size from a JPEG header (SOF marker).
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

const blankOf = (q) => (q.type === "Cmu" || q.type === "Cma" ? {} : "");

/*
 * → {
 *   answers: [{ type, answer, confidence, note, source: "omr" | "ocr" | null }],
 *   unresolved: [question index],   // not read with confidence → AI fallback
 *   student, nameResolved,
 *   platform: { bubbles, text }     // "ok" | "failed" | "off" | "none"
 * }
 */
async function platformReadSheet(key, images, { wantName = false } = {}) {
  const list = (Array.isArray(images) ? images : []).filter((s) => typeof s === "string" && s).slice(0, MAX_IMAGES);
  if (!list.length) throw readError(400, "Ən azı bir şəkil lazımdır");
  if (!Array.isArray(key) || !key.length) throw readError(400, "Əvvəlcə cavab açarını daxil edin");

  const closedQ = [];
  const openQ = [];
  key.forEach((q, i) => {
    const item = { q, index: i, number: i + 1 };
    if (q.type === "Cm" || q.type === "Cs") closedQ.push(item);
    else if (q.type === "Co" || q.type === "Cd") openQ.push(item);
  });

  const bufs = await Promise.all(list.map(fetchSheetJpeg));
  const answers = key.map((q) => ({ type: q.type, answer: blankOf(q), confidence: "low", note: "", source: null }));
  const unresolved = new Set(key.map((_, i) => i));
  const settle = (i, answer, confidence, source) => {
    Object.assign(answers[i], { answer, confidence, note: "", source });
    unresolved.delete(i);
  };

  // ---- bubbles (first photo where the grid is found) ----
  let omr = null;
  let omrAt = -1;
  const sizes = bufs.map(jpegSize);
  for (let i = 0; i < bufs.length; i++) {
    try {
      const r = await runOmr(bufs[i], { options: CARD_OPTIONS });
      if (r.ok) {
        omr = r;
        omrAt = i;
        break;
      }
    } catch (e) {
      console.error("OMR failed:", e?.message);
    }
  }
  if (closedQ.length) {
    if (!omr) {
      closedQ.forEach((it) => (answers[it.index].note = "platforma işarələri tapa bilmədi"));
    } else if (omr.rows.length < closedQ.length) {
      // A row may be cut off the photo — positions can't be trusted.
      closedQ.forEach((it) => (answers[it.index].note = "vərəqdə bütün sətirlər görünmür"));
    } else {
      closedQ.forEach((it, k) => {
        const row = omr.rows[k];
        if (row.status === "blank") return settle(it.index, "", "high", "omr");
        if (row.status === "marked") {
          const { answer, invalid } = parseSheetAnswer(it.q, LETTERS[row.col]);
          if (!invalid) return settle(it.index, answer, "high", "omr");
          answers[it.index].note = "işarələnən variant bu sualda yoxdur";
          return undefined;
        }
        answers[it.index].note = row.note || "işarə aydın deyil";
        return undefined;
      });
    }
  }

  // ---- handwriting: open answers + name ----
  const needText = openQ.length > 0 || wantName;
  let textStatus = !needText ? "none" : visionConfigured() ? "failed" : "off";
  let student = { firstName: "", lastName: "", fatherName: "", className: "" };
  let nameResolved = false;
  if (needText && visionConfigured()) {
    const order = omrAt >= 0 ? [omrAt, ...bufs.map((_, i) => i).filter((i) => i !== omrAt)] : bufs.map((_, i) => i);
    let openDone = !openQ.length;
    for (const i of order.slice(0, 2)) {
      let words;
      try {
        words = await visionWords(bufs[i]);
      } catch (e) {
        console.error("Vision OCR failed:", e?.message);
        break;
      }
      const onGrid = i === omrAt;
      const parsed = parseCardText(words, {
        width: onGrid ? omr.width : sizes[i].width,
        height: onGrid ? omr.height : sizes[i].height,
        flipped: onGrid ? omr.flipped : false,
        grid: onGrid ? omr.grid : null,
        openCount: openQ.length,
      });
      if (wantName && !nameResolved && parsed.nameFound) {
        student = parsed.student;
        nameResolved = parsed.nameResolved;
      }
      if (!openDone && parsed.open.length) {
        openDone = true;
        // Restore marks OCR skipped between characters (fraction slash, dot, minus).
        if (parsed.open.some((o) => !o.empty)) {
          try {
            const fixes = await runGlyphs(bufs[i], {
              flipped: onGrid ? omr.flipped : false,
              rows: parsed.open.map((o) => ({ symbols: o.empty || o.multiline ? [] : o.symbols })),
            });
            fixes.forEach((f, k) => {
              if (f?.added?.length) {
                parsed.open[k].answer = f.text;
                parsed.open[k].added = f.added;
              }
            });
          } catch (e) {
            console.error("Glyph check failed:", e?.message);
          }
        }
        /*
         * A box OCR read nothing in is only blank if its own ink says so. Vision
         * returns no words for faint pencil, glare, cursive and bad crops too, and
         * scoring those as unanswered is the worst failure this pipeline has.
         */
        const emptyRows = parsed.open.filter((o) => o.empty && o.box);
        if (emptyRows.length) {
          try {
            const inks = await runBoxInk(bufs[i], {
              flipped: onGrid ? omr.flipped : false,
              boxes: emptyRows.map((o) => o.box),
            });
            emptyRows.forEach((o, k) => {
              o.inkScore = inks?.[k]?.ink ?? null;
            });
          } catch (e) {
            console.error("Box ink check failed:", e?.message);
          }
        }
        const aligned = alignSection(
          openQ,
          parsed.open.map((o) => ({ printed: o.printed, answer: o.answer, confidence: "high", note: "", o }))
        );
        openQ.forEach((it) => {
          const hit = aligned.get(it.index);
          const a = answers[it.index];
          if (!hit) {
            a.note = "cavab qutusu tapılmadı";
            return;
          }
          const { o } = hit.item;
          a.evidence = { ocrConf: o.conf, ink: o.inkScore ?? null, raw: o.raw || "" };
          if (o.empty) {
            // Unmeasured (no box / worker failure) counts as unproven, not blank.
            if (o.inkScore === null || o.inkScore === undefined) a.note = "boş olduğu yoxlanılmadı";
            else if (o.inkScore > BLANK_INK_MAX) a.note = "qutuda yazı var, oxunmadı";
            else settle(it.index, "", "high", "ocr");
          }
          else if (o.multiline) a.note = "cavab bir neçə sətirdə yazılıb";
          // Handwritten digits often read at 0.6–0.8; accept them flagged for a look.
          else if (o.conf < 0.6) a.note = "yazı aydın oxunmadı";
          else if (!ALLOWED_TEXT.test(o.answer)) a.note = "tanınmayan simvol";
          else {
            settle(it.index, o.answer.slice(0, 300), o.conf >= 0.9 && !o.added ? "high" : "medium", "ocr");
            if (o.added) a.note = `şəkildən əlavə edildi: ${[...new Set(o.added)].join(" ")}`;
          }
        });
      }
      if (parsed.nameFound || parsed.open.length) textStatus = "ok";
      if (openDone && (nameResolved || !wantName)) break;
    }
    if (!openDone) openQ.forEach((it) => (answers[it.index].note = answers[it.index].note || "açıq cavablar tapılmadı"));
  } else if (openQ.length) {
    openQ.forEach((it) => (answers[it.index].note = "mətn tanıma qoşulmayıb"));
  }

  return {
    answers,
    unresolved: [...unresolved].sort((a, b) => a - b),
    student,
    nameResolved,
    platform: {
      bubbles: !closedQ.length ? "none" : omr ? "ok" : "failed",
      text: textStatus,
    },
  };
}

module.exports = { platformReadSheet, fetchSheetJpeg };
