/* eslint-env node */
/*
 * The AI knows which class the exam is for, and a one-answer question has one.
 *
 * 11 Oct 2026, Aynure Qənbərova, first session:
 *   class "11-Azerbaycan dili", prompt "11 buraxilis modeline uygun" → a mixed
 *   paper (maths, biology, chemistry, history, English). The class name never
 *   reached the model.
 *   Q1 «"Müəllim şagirdlərə tapşırıq verdi" cümləsində tamamlıq hansıdır?» was
 *   single-choice with one key, but B and C are both tamamlıq. She fixed it
 *   herself with "B ve c dogrudur".
 */
process.env.NODE_ENV = "test";

const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log("  ✓", label);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", label, extra ? `- ${extra}` : "");
  }
};

const Exam = require("../models/examModel");
const Class = require("../models/classModel");
const C = require("../helper/classContext");

const TEACHER = "6acbb5e481cd539432fc5872";
const OTHER = "6acbb5e481cd539432fc5899";
const CLASS_ID = "6acbb5e481cd539432fc0001";
const EXAM_ID = "6acbb5e481cd539432fc0002";

// In-memory stand-ins for the two lookups, honouring the owner scope.
const classes = [{ _id: CLASS_ID, owner: TEACHER, name: "  11-Azerbaycan   dili " }];
const exams = [{ _id: EXAM_ID, owner: TEACHER, class: CLASS_ID }];
const fake = (rows) => (q) => ({
  select: () => ({
    lean: async () =>
      rows.find((r) => String(r._id) === String(q._id) && (q.owner == null || String(r.owner) === String(q.owner))) || null,
  }),
});
Exam.findOne = fake(exams);
Class.findOne = fake(classes);

const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "aiController.js"), "utf8");
const between = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));

(async () => {
  console.log("finding the class");
  ok("a new exam finds it by the classId the builder sends", (await C.classNameFor({ user: { _id: TEACHER, role: "teacher" }, params: { examId: "new" }, body: { classId: CLASS_ID } })) === "11-Azerbaycan dili");
  ok("a saved exam finds it through the exam", (await C.classNameFor({ user: { _id: TEACHER, role: "teacher" }, params: { examId: EXAM_ID }, body: {} })) === "11-Azerbaycan dili");
  ok("another teacher's class is not read", (await C.classNameFor({ user: { _id: OTHER, role: "teacher" }, params: { examId: "new" }, body: { classId: CLASS_ID } })) === "");
  ok("...nor through their exam", (await C.classNameFor({ user: { _id: OTHER, role: "teacher" }, params: { examId: EXAM_ID }, body: {} })) === "");
  ok("an admin may read it", (await C.classNameFor({ user: { _id: OTHER, role: "admin" }, params: { examId: "new" }, body: { classId: CLASS_ID } })) === "11-Azerbaycan dili");
  ok("no class, no context", (await C.classNameFor({ user: { _id: TEACHER, role: "teacher" }, params: { examId: "new" }, body: {} })) === "");
  ok("a junk classId is ignored", (await C.classNameFor({ user: { _id: TEACHER }, params: {}, body: { classId: "x'; drop" } })) === "");
  const saved = Class.findOne;
  Class.findOne = () => { throw new Error("db down"); };
  ok("a failed lookup means no context, not a failed generation", (await C.classNameFor({ user: { _id: TEACHER }, params: { examId: "new" }, body: { classId: CLASS_ID } })) === "");
  Class.findOne = saved;

  console.log("\nwhat the model reads");
  const p = C.withClassContext("11 buraxilis modeline uygun", "11-Azerbaycan dili");
  ok("the class comes first", p.startsWith("SİNİF: «11-Azerbaycan dili»"));
  ok("the teacher's words follow, unchanged", p.endsWith("MÜƏLLİMİN TƏSVİRİ: 11 buraxilis modeline uygun"));
  ok("it says to take the subject from the class", /çatışmayanı sinfin adından götür/.test(p) && /başqa fənlərdən sual QATMA/.test(p));
  ok("the teacher's own subject wins", /fənn AÇIQ deyilibsə, təsvir üstündür/.test(p));
  ok("no class leaves the prompt as it was", C.withClassContext("5-ci sinif kəsrlər", "") === "5-ci sinif kəsrlər");

  console.log("\nthe generators use it");
  const gen = between("const generateQuestions = asyncHandler", "const generateQuestionsStream = asyncHandler");
  const stream = between("const generateQuestionsStream = asyncHandler", "const regenerateQuestion = asyncHandler");
  for (const [name, h] of [["generateQuestions", gen], ["generateQuestionsStream", stream]]) {
    ok(`${name} builds the class-aware prompt`, /const aiPrompt = withClassContext\(prompt, await classNameFor\(req\)\)/.test(h));
    ok(`${name} writes with it`, /runGeneration\(\{[^}]*prompt: aiPrompt/.test(h));
    ok(`${name} tops up with it`, /topUpToCount\(\{\s*prompt: aiPrompt/.test(h));
    ok(`${name} reviews with it`, /questions: topped\.questions,\s*prompt: aiPrompt/.test(h));
    ok(`${name} still counts from the teacher's own words`, /parseRequestedCount\(prompt\)/.test(h) && !/parseRequestedCount\(aiPrompt\)/.test(h));
  }
  const regen = between("const regenerateQuestion = asyncHandler", "// ============================ Teacher chat assistant");
  ok("a rewrite knows the class too", /const className = await classNameFor\(req\)/.test(regen) && /SİNİF: «\$\{className\}»/.test(regen));

  console.log("\none answer means one");
  const sys = between("const GEN_SYSTEM_PROMPT = `", "// ── the engines a teacher may pick");
  ok("the writer checks every option of a single-choice question", /TƏK SEÇİM \(Cm\) — YALNIZ BİR VARİANT DÜZGÜN OLA BİLƏR/.test(sys));
  ok("...using her tamamlıq question as the example", /həm «şagirdlərə» \(vasitəli tamamlıq\), həm «tapşırıq» \(vasitəsiz tamamlıq\)/.test(sys));
  ok("...and says what to do instead", /tipi «Cs» et və BÜTÜN düzgünləri/.test(sys));
  ok("'B ve c dogrudur' becomes multiple choice with both marked", /«B və C doğrudur», «b ve c dogrudur»\) → tipi «Cs»/.test(regen));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
