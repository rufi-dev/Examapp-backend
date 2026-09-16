/*
 * Paper answer-sheet reading: the regression cases from the OCR/OMR audit.
 *   node tests/paper-read.test.js        (or: npm test)
 *
 * No network and no API keys: Vision words are mocked (they are plain boxes with
 * confidences), and the OMR/ink detectors run against committed card fixtures.
 * Covers the failures that silently change a student's score:
 *   - OCR reading nothing must not become a confident blank;
 *   - printed name labels over empty boxes must not count as a read name;
 *   - matching answers (Cmu grid, Cma pairs) must survive coercion and scoring;
 *   - the bubble grid must be found on both card designs.
 */
const fs = require("fs");
const path = require("path");

const { parseCardText } = require("../helper/sheetOcr");
const { analyzeJpeg, analyzeBoxInkJpeg } = require("../helper/sheetOmr");
const { platformReadSheet } = require("../helper/paperReader");
const { readCapped } = require("../helper/fetchLimit");
const {
  coerceSheetAnswers,
  normalizePaperSelections,
  sameSheetAnswer,
} = require("../controllers/quizController");

let passed = 0;
let failed = 0;
const ok = (name, cond) => {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failed++;
    console.log("  ✗ FAIL:", name);
  }
};
const eq = (name, got, want) => ok(`${name}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, JSON.stringify(got) === JSON.stringify(want));

const w = (text, x0, y0, x1, y1, conf = 0.97) => ({ text, x0, y0, x1, y1, conf });
const fixture = (f) => fs.readFileSync(path.join(__dirname, "fixtures", f));

async function main() {
  console.log("\nHandwriting parse (mocked Vision words)");

  // Printed labels over EMPTY name boxes must not resolve a name. This is the
  // defect the audit reproduced: it skipped the name fallback entirely.
  const labelsOnly = [
    w("Ad", 60, 127, 80, 145),
    w(":", 80, 127, 86, 145),
    w("Soyad", 316, 127, 360, 145),
    w(":", 360, 127, 367, 145),
    w("Ata", 596, 127, 622, 145),
    w("adı:", 626, 127, 652, 145),
  ];
  const empty = parseCardText(labelsOnly, { width: 924, height: 1307, openCount: 0 });
  ok("labels with empty boxes: nameFound true", empty.nameFound === true);
  ok("labels with empty boxes: nameResolved FALSE", empty.nameResolved === false);
  eq("  → no invented name", [empty.student.firstName, empty.student.lastName], ["", ""]);

  // A written name still resolves.
  const written = parseCardText(
    [...labelsOnly, w("Aysel", 125, 124, 205, 148, 0.96), w("Məmmədova", 405, 123, 560, 148, 0.93)],
    { width: 924, height: 1307, openCount: 0 }
  );
  ok("written name resolves", written.nameResolved === true);
  eq("  → name read", [written.student.firstName, written.student.lastName], ["Aysel", "Məmmədova"]);

  // A single letter is not a name (OCR noise in an empty box).
  const noise = parseCardText([...labelsOnly, w("|", 125, 124, 131, 148, 0.95), w("-", 405, 123, 412, 148, 0.9)], {
    width: 924,
    height: 1307,
    openCount: 0,
  });
  ok("one-character noise does not resolve a name", noise.nameResolved === false);

  // An answer box OCR read nothing in reports confidence 0 (unknown), not 1.
  const grid = { x0: 111, y0: 288, x1: 388, y1: 694 };
  const rows = Array.from({ length: 4 }, (_, i) => w(`${14 + i}.`, 433, 277 + i * 42, 456, 293 + i * 42));
  const parsed = parseCardText([...rows, w("7", 480, 274, 500, 296, 0.95)], {
    width: 924,
    height: 1307,
    grid,
    openCount: 4,
  });
  eq("empty answer rows are flagged empty", parsed.open.map((o) => o.empty), [false, true, true, true]);
  ok("empty row confidence is 0, not 1", parsed.open.slice(1).every((o) => o.conf === 0));
  ok("every row carries a box to measure ink in", parsed.open.every((o) => o.box && o.box.x1 > o.box.x0));
  ok("raw transcription kept beside the answer", parsed.open[0].raw === "7");

  console.log("\nMatching answers survive the paper pipeline");

  // Cmu: a grid of letter indices per number, kept as-is.
  const cmu = { type: "Cmu", leftCount: 2, rightCount: 3, key: [[0, 2], [1]] };
  eq(
    "Cmu grid coerced unchanged",
    coerceSheetAnswers([cmu], [{ answer: { 0: [2, 0], 1: [1] } }]),
    [{ 0: [0, 2], 1: [1] }]
  );

  // Cma: read as a grid, but SCORED against each pair's right-hand value. The
  // conversion happens server-side; before this fix the object became "".
  const cma = { type: "Cma", pairs: [{ left: "1", right: "b" }, { left: "2", right: "a" }] };
  eq("Cma grid survives coercion", coerceSheetAnswers([cma], [{ answer: { 0: [1], 1: [0] } }]), [{ 0: [1], 1: [0] }]);
  eq(
    "Cma normalizes to the scorer's pair shape",
    normalizePaperSelections([cma], [{ answer: { 0: [0], 1: [1] } }]),
    [{ type: "Cma", answer: { 0: "b", 1: "a" } }]
  );
  eq(
    "Cma with an ambiguous (multi-pick) left is dropped, not guessed",
    normalizePaperSelections([cma], [{ answer: { 0: [0, 1] } }]),
    [{ type: "Cma", answer: {} }]
  );
  ok("matching edits compare as maps", sameSheetAnswer(cma, { 0: [1] }, { 0: [1] }) === true);
  ok("matching change is detected", sameSheetAnswer(cma, { 0: [1] }, { 0: [0] }) === false);

  console.log("\nBubble grid on the committed card fixtures");

  for (const [file, expectRows] of [["card-a4.jpg", 13], ["card-legacy.jpg", 15]]) {
    const res = await analyzeJpeg(fixture(file), { options: 5 });
    ok(`${file}: grid found`, res.ok === true);
    eq(`${file}: row count`, res.rows?.length, expectRows);
    ok(`${file}: an unmarked card reads as all-blank`, (res.rows || []).every((r) => r.status === "blank"));
  }

  console.log("\nInk detector (what makes a blank box trustworthy)");

  const a4 = await analyzeJpeg(fixture("card-a4.jpg"), { options: 5 });
  // A printed heading has ink; an empty answer box (and blank paper) does not.
  const heading = { x0: a4.grid.x0, y0: Math.max(0, a4.grid.y0 - 60), x1: a4.grid.x1, y1: a4.grid.y0 - 10 };
  const emptyBox = { x0: a4.grid.x1 + 80, y0: a4.grid.y0 + 20, x1: a4.grid.x1 + 380, y1: a4.grid.y0 + 55 };
  const [inked, blank] = await analyzeBoxInkJpeg(fixture("card-a4.jpg"), { boxes: [heading, emptyBox] });
  ok(`printed text measures as ink (${inked?.ink.toFixed(4)})`, inked && inked.ink > 0.004);
  ok(`an empty answer box measures ~no ink (${blank?.ink.toFixed(4)})`, blank && blank.ink <= 0.004);

  console.log("\nMulti-page safety (a swapped page must never re-label answers)");

  // Two pages that BOTH carry a bubble grid cannot be ordered: nothing on the
  // card tells the detector which page is which, and upload order is not proof.
  // The reading must refuse rather than map page 2's rows onto page 1's questions.
  const photo = fixture("card-a4.jpg");
  const realFetch = global.fetch;
  global.fetch = async (url) =>
    String(url).includes("res.cloudinary.com")
      ? { ok: true, headers: new Map([["content-length", String(photo.length)]]), arrayBuffer: async () => photo }
      : realFetch(url);
  delete process.env.GOOGLE_VISION_API_KEY; // keep this test to the OMR path
  const closedKey = Array.from({ length: 13 }, () => ({ type: "Cm", answer: "a", options: ["a", "b", "c", "d", "e"] }));
  const urls = ["https://res.cloudinary.com/x/image/upload/v1/p1.jpg", "https://res.cloudinary.com/x/image/upload/v1/p2.jpg"];

  const one = await platformReadSheet(closedKey, [urls[0]]);
  eq("single page: all 13 closed answers settle", one.unresolved.length, 0);

  const two = await platformReadSheet(closedKey, urls);
  eq("two grids: nothing is settled from a guessed page order", two.unresolved.length, 13);
  ok(
    "  → and the reason says so",
    /səhifə/i.test(two.answers[0].note || "")
  );
  global.fetch = realFetch;

  console.log("\nA paper exam belongs to its teacher, not to a class");

  const Exam = require("../models/examModel");
  // Paper exams are created classless on purpose (they never appear in a class).
  const paper = new Exam({
    name: "Kağız sınaq",
    mode: "paper",
    owner: new (require("mongoose").Types.ObjectId)(),
    duration: 3600,
    price: 0,
    totalMarks: 100,
    passingMarks: 50,
  });
  const paperErr = paper.validateSync();
  ok("a paper exam validates without a class", !paperErr);
  eq("  → and its class is null", paper.class, null);

  // Every other mode must still require one: the rule was narrowed, not dropped.
  const pdf = new Exam({
    name: "PDF sınaq",
    mode: "pdf",
    owner: paper.owner,
    duration: 3600,
    price: 0,
    totalMarks: 100,
    passingMarks: 50,
  });
  const pdfErr = pdf.validateSync();
  ok("a pdf exam without a class is still rejected", !!pdfErr?.errors?.class);

  console.log("\nDownload size guard (refused before buffering)");

  const oversize = {
    headers: new Map([["content-length", String(50 * 1024 * 1024)]]),
    body: { cancel: async () => {} },
    arrayBuffer: async () => {
      throw new Error("must not buffer an oversized body");
    },
  };
  ok("Content-Length over the cap is refused without reading", (await readCapped(oversize, 12 * 1024 * 1024)) === null);

  // A body that lies about its length is stopped mid-stream.
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const lying = {
    headers: new Map(),
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: chunk }),
        cancel: async () => {
          cancelled = true;
        },
      }),
    },
  };
  ok("an over-long stream is cut off", (await readCapped(lying, 4 * 1024 * 1024)) === null);
  ok("  → and the stream is cancelled", cancelled === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
