/* eslint-env node */
/*
 * "3-cü sual yazılır: …" - the question being written, read from the half-written
 * answer, so a teacher sees work happening before the first question is whole.
 */
process.env.NODE_ENV = "test";
const { currentQuestionDraft } = require("../helper/questionDraft");

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

console.log("the question being written");
ok("nothing before the list starts", currentQuestionDraft("```json\n{\"quest") === null);
ok("nothing between questions", currentQuestionDraft('{"questions":[{"text":"a"},') === null);
const d1 = currentQuestionDraft('```json\n{"questions":[{"type":"Cm","text":"Kəsrləri topla: 1/2 + 1/');
ok("the first question, as far as written", d1 && d1.n === 1 && d1.text === "Kəsrləri topla: 1/2 + 1/", JSON.stringify(d1));
const d3 = currentQuestionDraft('{"questions":[{"text":"a"},{"text":"b"},{"type":"Co","text":"Bakı \\"paytaxtdır\\"\\n hansı');
ok("its position counts the finished ones", d3 && d3.n === 3, JSON.stringify(d3));
ok("escapes are read, line breaks become spaces", d3 && d3.text === 'Bakı "paytaxtdır" hansı', JSON.stringify(d3));
const stemDone = currentQuestionDraft('{"questions":[{"text":"2+2=?","choices":[{"text":"3"},{"text":"');
ok("while the options are written, the stem stays shown", stemDone && stemDone.text === "2+2=?" && stemDone.n === 1, JSON.stringify(stemDone));
const begun = currentQuestionDraft('{"questions":[{"text":"x"},{"ty');
ok("a question that has begun but has no stem yet", begun && begun.n === 2 && begun.text === "", JSON.stringify(begun));
ok("a closed list is not being written", currentQuestionDraft('{"questions":[{"text":"x"}]}') === null);
ok("half an escape is left for the next piece", currentQuestionDraft('{"questions":[{"text":"a\\').text === "a");
ok("rubbish never throws", currentQuestionDraft(undefined) === null && currentQuestionDraft("{{{{") === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
