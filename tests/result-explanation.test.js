/*
 * The teacher's drawn explanation of one paper: what may be stored, and who may
 * see it.
 *
 * Two things are worth pinning here and nothing else is. The marks arrive from a
 * browser and are stored as Mixed, so whatever survives sanitising is what every
 * later viewer receives — a whitelist that quietly stops being one is the whole
 * risk. And the visibility rule has to keep matching the solution photos it was
 * modelled on, because a teacher who cannot see why one appears and the other
 * does not is right to be confused.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
const ok = (name, cond) => {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ FAIL: ${name}`);
  }
};

const { sanitizeExplanationMarks } = require("../controllers/quizController");

console.log("\n1. Only the fields the renderer draws survive:");
{
  /*
   * A whitelist, not a scrub. Anything the client sends that is not read here
   * would be persisted verbatim under a Mixed field and handed back to the
   * student, so the test that matters is that an UNKNOWN field cannot make the
   * trip — whatever it happens to be called.
   */
  const [mark] = sanitizeExplanationMarks([
    {
      kind: "ink",
      colour: "#e03131",
      width: 4,
      alpha: 1,
      pts: [{ x: 1, y: 2, w: 3 }],
      // None of these are drawn by anything:
      onload: "alert(1)",
      __proto__: { polluted: true },
      html: "<script>alert(1)</script>",
      nested: { deep: { deeper: true } },
    },
  ]);
  ok("a stroke is rebuilt", mark && mark.kind === "ink");
  ok("and carries only known keys", JSON.stringify(Object.keys(mark).sort()) === JSON.stringify(["alpha", "colour", "kind", "pts", "width"]));
  ok("an unknown field cannot survive", !("onload" in mark) && !("html" in mark) && !("nested" in mark));
}

console.log("\n2. Values are bounded, not trusted:");
{
  const [ink] = sanitizeExplanationMarks([
    { kind: "ink", colour: "javascript:alert(1)", width: 1e9, alpha: 99, pts: [{ x: 1e12, y: -1e12, w: 1e9 }] },
  ]);
  ok("a colour that is not a hex colour is replaced", /^#[0-9a-f]{6}$/i.test(ink.colour));
  ok("an absurd width is clamped", ink.width <= 60);
  ok("alpha stays within a fraction", ink.alpha > 0 && ink.alpha <= 1);
  ok("a point far off the page is clamped", Math.abs(ink.pts[0].x) <= 1e5);

  const [text] = sanitizeExplanationMarks([
    { kind: "text", text: "x".repeat(5000), size: 9999, x: 10, y: 20, colour: "#111" },
  ]);
  ok("a very long label is truncated", text.text.length <= 500);
  ok("and its size is bounded", text.size <= 96);

  ok("an unknown shape is dropped", sanitizeExplanationMarks([{ kind: "shape", shape: "sql", x0: 0, y0: 0, x1: 1, y1: 1 }]).length === 0);
  ok("a known shape is kept", sanitizeExplanationMarks([{ kind: "shape", shape: "ellipse", x0: 0, y0: 0, x1: 9, y1: 9 }]).length === 1);
  ok("an unknown mark kind is dropped", sanitizeExplanationMarks([{ kind: "iframe", src: "x" }]).length === 0);
  ok("junk in, empty out", sanitizeExplanationMarks("nope").length === 0 && sanitizeExplanationMarks(null).length === 0);
}

console.log("\n3. A client cannot grow the document without limit:");
{
  /*
   * A result already carries the exam; Mongo's ceiling is 16 MB and this is the
   * only field a browser can append to freely. Hence caps on the mark count, on
   * the points in one stroke, AND on the total — any one alone leaves a hole.
   */
  const many = Array.from({ length: 5000 }, () => ({ kind: "text", text: "a", x: 0, y: 0 }));
  ok("the number of marks is capped", sanitizeExplanationMarks(many).length <= 600);

  const longStroke = [{ kind: "ink", colour: "#111", width: 2, pts: Array.from({ length: 50000 }, (_, i) => ({ x: i, y: i })) }];
  ok("one enormous stroke is capped", sanitizeExplanationMarks(longStroke)[0].pts.length <= 2000);

  const manyStrokes = Array.from({ length: 400 }, () => ({
    kind: "ink",
    colour: "#111",
    width: 2,
    pts: Array.from({ length: 1500 }, (_, i) => ({ x: i, y: i })),
  }));
  const total = sanitizeExplanationMarks(manyStrokes).reduce((n, m) => n + m.pts.length, 0);
  ok("and so is the total across all of them", total <= 40000);

  const [rounded] = sanitizeExplanationMarks([{ kind: "ink", colour: "#111", width: 2, pts: [{ x: 1.23456, y: 9.87654 }] }]);
  ok("points are rounded, halving what a stroke costs", rounded.pts[0].x === 1.2 && rounded.pts[0].y === 9.9);

  ok("an empty label is not stored", sanitizeExplanationMarks([{ kind: "text", text: "   ", x: 0, y: 0 }]).length === 0);
  ok("a stroke with no points is not stored", sanitizeExplanationMarks([{ kind: "ink", pts: [] }]).length === 0);
}

console.log("\n4. It is shown under the same rule as a solution photo:");
{
  const src = fs.readFileSync(path.join(__dirname, "../controllers/quizController.js"), "utf8");
  const hidden = src.slice(src.indexOf("if (!vis.canSeeAnswers) {"), src.indexOf("// Sanitize the populated exam"));

  /*
   * A circle round a wrong answer with "səhv" beside it gives the answer key
   * away as surely as a solution photo does, and the photos already had a
   * considered rule. Matching it beats inventing a second policy for the same
   * kind of teacher-added feedback.
   */
  ok("solution photos are still hidden until answers are revealed", /obj\.photos = \[\];/.test(hidden));
  ok("and the explanation is hidden with them", /obj\.explanation = null;/.test(hidden));

  // Writing it is the exam's own author or an admin — loadResultForTeacher —
  // so one teacher cannot annotate another teacher's paper.
  ok("saving goes through the teacher-authorisation helper", /const \{ result \} = await loadResultForTeacher\(req, res, req\.params\.resultId, user\);/.test(src));
  const routes = fs.readFileSync(path.join(__dirname, "../routes/quizRoute.js"), "utf8");
  ok("and the route is teacher-gated", /router\.put\("\/result\/:resultId\/explanation", protect, teacherOnly, saveResultExplanation\);/.test(routes));

  // Clearing is an ordinary save, so there is no second permission path.
  ok("an empty save clears the explanation", /marks: undefined, width: null/.test(src));
}

console.log("\n5. The width travels with the marks:");
{
  const src = fs.readFileSync(path.join(__dirname, "../controllers/quizController.js"), "utf8");
  /*
   * Without it a phone cannot reproduce the layout the marks were placed on, and
   * the drawing lands on the wrong words. It is half the data, not metadata.
   */
  ok("the drawn-at width is stored", /const width = Math\.round\(num\(req\.body\?\.width, 200, 4000, 900\)\);/.test(src));
  const model = fs.readFileSync(path.join(__dirname, "../models/resultModel.js"), "utf8");
  ok("and the model keeps it", /width: \{ type: Number, default: null \}/.test(model));
  ok("with who explained it, for the student to see", /byName: \{ type: String, default: "" \}/.test(model));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} result-explanation assertions failed`);
process.exit(failed ? 1 : 0);
