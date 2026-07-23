// Server-side checks for inline gap-fill: the authoritative grader
// (isCorrectAnswer) scores it per-blank via the multi-blank path, and the
// student-facing sanitiser never leaks the answers.
const assert = require("assert");
const { isCorrectAnswer, sanitizeQuestionItem } = require("../controllers/quizController");

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  passed += 1;
};

// A single-blank inline gap-fill with two accepted spellings.
const single = { type: "Co", inline: true, blanks: 1, blankAnswers: [["Baku", "Bakı"]] };
ok("single: exact", isCorrectAnswer(single, { answer: { 0: "Baku" } }) === true);
ok("single: alternative spelling", isCorrectAnswer(single, { answer: { 0: "Bakı" } }) === true);
ok("single: case-insensitive + spaces", isCorrectAnswer(single, { answer: { 0: "  baku " } }) === true);
ok("single: wrong", isCorrectAnswer(single, { answer: { 0: "Ganja" } }) === false);
ok("single: blank", isCorrectAnswer(single, { answer: {} }) === false);

// A two-blank inline gap-fill — all-or-nothing.
const two = {
  type: "Co",
  inline: true,
  blanks: 2,
  blankAnswers: [["Baku", "Bakı"], ["Azerbaijan", "Azərbaycan"]],
};
ok("two: both correct", isCorrectAnswer(two, { answer: { 0: "bakı", 1: "AZERBAIJAN" } }) === true);
ok("two: one wrong → whole wrong", isCorrectAnswer(two, { answer: { 0: "Baku", 1: "France" } }) === false);
ok("two: one missing → wrong", isCorrectAnswer(two, { answer: { 0: "Baku" } }) === false);

// A plain (non-inline) single open answer must still use the open path.
const open = { type: "Co", answer: "Paris", answers: ["Paris"] };
ok("open: string still graded", isCorrectAnswer(open, { answer: "paris" }) === true);

// A gap-fill READING (cloze): scored per-blank while kept as type "reading".
const cloze = { type: "reading", gapfill: true, blanks: 2, blankAnswers: [["Baku", "Bakı"], ["Caspian"]] };
ok("cloze: both blanks correct", isCorrectAnswer(cloze, { answer: { 0: "bakı", 1: "caspian" } }) === true);
ok("cloze: one wrong → whole wrong", isCorrectAnswer(cloze, { answer: { 0: "Baku", 1: "Black" } }) === false);
// A plain reading (no gapfill) is never graded true.
ok("plain reading not scored", isCorrectAnswer({ type: "reading" }, { answer: { 0: "x" } }) === false);

// Sanitisation: the student receives the anonymous text + the inline flag, but
// NEVER the answer key.
const stored = {
  type: "Co",
  inline: true,
  text: "[[1]] is the capital of [[2]].",
  blanks: 2,
  blankAnswers: [["Baku", "Bakı"], ["Azerbaijan"]],
  answer: "",
};
const sent = sanitizeQuestionItem(stored);
ok("sanitize: keeps inline flag", sent.inline === true);
ok("sanitize: keeps anonymous text", sent.text === "[[1]] is the capital of [[2]].");
ok("sanitize: keeps blanks count", sent.blanks === 2);
ok("sanitize: DOES NOT leak blankAnswers", sent.blankAnswers === undefined);
ok("sanitize: no answer key leaked", !("answer" in sent) || sent.answer === "");

// Sanitising a gap-fill reading keeps the gapfill flag + anonymous text, no key.
const storedCloze = {
  type: "reading",
  kind: "reading",
  gapfill: true,
  text: "[[1]] is the capital of [[2]].",
  blanks: 2,
  blankAnswers: [["Baku"], ["Azerbaijan"]],
};
const sc = sanitizeQuestionItem(storedCloze);
ok("cloze sanitize: gapfill flag kept", sc.gapfill === true);
ok("cloze sanitize: anonymous text kept", sc.text === "[[1]] is the capital of [[2]].");
ok("cloze sanitize: DOES NOT leak blankAnswers", sc.blankAnswers === undefined);

console.log(`gapfill.test.js: ${passed} assertions passed`);
