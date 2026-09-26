/*
 * No questions, no exam.
 *
 * 312 of the 500 exams in production had no questions in them — 62%, across 230
 * different teachers, 297 of them more than a week old. The cause is the order of
 * the flow: the details form CREATES the exam and then sends the teacher to the
 * builder, so every abandoned build leaves a permanent exam behind, and the
 * teacher's list fills with papers that were never written.
 *
 * A name, a date and a duration now make a PROVISIONAL exam: listed nowhere,
 * costing nothing, real the moment a question is saved into it. These assertions
 * read the shipping source rather than a mock, because the thing worth protecting
 * is that every list applies the rule — one that forgets is one where the empty
 * exams come back.
 */
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ FAIL: ${label} ${extra}`);
  }
};

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), "utf8");
const ctl = read("../controllers/quizController.js");
const model = read("../models/examModel.js");
const jobs = read("../jobs/backgroundJobs.js");

/*
 * WHAT CHANGED, and why the assertions below are the opposite of what they were.
 *
 * Empty exams used to be created INVISIBLE and swept up a week later. It solved
 * the row count and created a worse problem: a teacher pressed "create" eight
 * times in half an hour, saw one exam, and had seven invisible rows counted
 * against her in the admin directory as abandoned work. She could not see them,
 * could not delete them, and did not know they existed.
 *
 * A row nobody can see is a row nobody can fix. So nothing is hidden now, and
 * emptiness is handled at its two honest ends instead: the AI path does not
 * create an exam until it has questions to put in it, and the sweep removes what
 * stayed empty — judged on being empty and old, not on a flag.
 */
console.log("\n1. Nothing is created invisible:");
ok("creation no longer marks a row provisional", !/provisional: true,\s*\n\s*provisionalSince: new Date\(\),/.test(ctl));
ok("...and says why, so it is not re-added by habit", /NOT provisional\. An exam that exists is an exam the teacher can see/.test(ctl));
/*
 * The field stays on the model. Twenty rows still carry it, the promotion path
 * still clears it, and dropping a field that live documents hold is a separate
 * job from changing what is written.
 */
ok("the field remains for the rows that already have it", /provisional: \{ type: Boolean/.test(model));

console.log("\n2. Saving a question is what makes it real:");
ok("promotion is tied to having answers",
  /const becomesReal = exam\.provisional === true && correctAnswers\.length > 0;/.test(ctl));
ok("and clears both fields", /provisional: false/.test(ctl) && /provisionalSince: ""/.test(ctl));

console.log("\n3. The allowance is spent on exams that exist:");
ok("create only checks", /await assertExamCreate\(req\.user\);/.test(ctl));
ok("the first saved question spends", /if \(becomesReal\) \{[\s\S]{0,120}consumeExamCreate\(req\.user, session\)/.test(ctl));
/*
 * An exhausted allowance must not throw away a paper that is already written.
 * blockedByPlan already means "visible to its owner with a badge, invisible to
 * students", which is exactly the right answer here.
 */
ok("and an exhausted allowance blocks rather than discards",
  /blockedByPlan: true/.test(ctl) && /allowance exhausted at first save/.test(ctl));

console.log("\n4. Listed everywhere its owner looks:");
/*
 * No teacher-facing list filters on the flag any more. This is the assertion
 * that fails if hiding is ever reintroduced — which is exactly how seven exams
 * went missing for a day.
 */
const hidden = ctl.match(/provisional: \{ \$ne: true \}/g) || [];
ok("no list hides a row by flag", hidden.length === 0, `found ${hidden.length}`);
/*
 * And not in memory either. This assertion is here because the one above was not
 * enough: it reads Mongo filters, so it went on passing while a JavaScript
 * `.filter(e => e.provisional !== true)` in `getExamsByUser` kept hiding the
 * very rows the flag was retired to stop hiding. A list can discard a row after
 * the query as easily as inside it.
 */
const hiddenInMemory = ctl.match(/provisional\s*!==\s*true/g) || [];
ok("nor after the query, in memory", hiddenInMemory.length === 0, `found ${hiddenInMemory.length}`);
ok("the class list shows everything in the class", /const examFilter = \{ class: exists\._id, deletedAt: null \};/.test(ctl));
ok("the class card counts it too", /\$match: \{ class: \{ \$in: allIds \}, deletedAt: null \} \}/.test(ctl));

/*
 * Students are the one audience that must NOT see an empty paper — they cannot
 * sit it. That gate asks for CONTENT rather than for the absence of a flag,
 * which is both the honest test and one that survives the flag going away.
 */
ok("students still only see papers they can sit",
  /\$or: \[\{ questions: \{ \$nin: \[null, undefined\] \} \}, \{ pdf: \{ \$nin: \[null, undefined\] \} \}\]/.test(ctl));

console.log("\n5. Abandoned ones are cleared, carefully:");
ok("there is a sweeper", /async function purgeAbandonedExams/.test(ctl));
ok("scheduled daily", /schedule\("abandoned-exam-purge"/.test(jobs));
/*
 * Judged on emptiness and age rather than on how the row was made. Keying on the
 * flag stopped working the moment exams stopped being created with it — and the
 * flag was the wrong test anyway: what makes a row worth removing is that there
 * is nothing in it and nobody came back, not which code path produced it.
 */
ok("it selects on emptiness, not on a flag",
  /questions: \{ \$in: \[null, undefined\] \},\s*\n\s*pdf: \{ \$in: \[null, undefined\] \},/.test(ctl));
ok("...and on age", /createdAt: \{ \$lt: cutoff \}/.test(ctl));
ok("a week is the cutoff", /7 \* 24 \* 60 \* 60 \* 1000/.test(ctl));
// The flag is a claim; the questions and attempts are the evidence.
ok("it verifies before deleting anything", /if \(qCount \|\| attempts\)/.test(ctl));
ok("and promotes what turns out to be real instead", /kept and promoted/.test(ctl));
/*
 * The predicate is restated in the delete itself, so a question saved between
 * the scan and the delete means the row no longer matches and survives.
 */
ok("the delete is fenced on the same predicate",
  /deleteOne\(\{[\s\S]{0,260}questions: \{ \$in: \[null, undefined\] \},[\s\S]{0,80}pdf: \{ \$in: \[null, undefined\] \},[\s\S]{0,40}\}\)/.test(ctl));

console.log("\n6. Only one path can make an empty exam, and it makes a provisional one:");
/*
 * There are exactly two places an exam is born. addExam is the teacher's form —
 * provisional, checked above. spawnTwin makes a variant, and it creates the twin
 * and its questions in one breath with a rollback if the second half fails, so it
 * is never empty; the remaining risk is that it INHERITS the flag from its
 * source, which would hide a finished variant from every list.
 *
 * The count is the point: a third path added later without the flag is how empty
 * exams come back, and this fails the moment one appears.
 */
const births = (ctl.match(/Exam\.create\(/g) || []).length;
ok("there are two creation paths and no more", births === 2, `found ${births}`);
ok("the twin strips the flag rather than trusting it", /"provisional", "provisionalSince",/.test(ctl));
ok("and it is removed if its questions fail", /await Exam\.deleteOne\(\{ _id: twin\._id \}\);/.test(ctl));

console.log("\n7. The teacher is told an exam exists only when it does:");
/*
 * The details form used to toast "Exam added successfully" for an exam that was
 * listed nowhere, so the teacher went looking for it. The only announcement now is
 * the save that makes it real, and the reply says which save that was.
 */
const slice = fs.readFileSync(path.join(__dirname, "../../Frontend/redux/features/quiz/quizSlice.js"), "utf8");
const assistant = fs.readFileSync(path.join(__dirname, "../../Frontend/src/components/AiAssistant.jsx"), "utf8");
ok("the save reply says when it created the exam",
  /createdExam = becomesReal;/.test(ctl) && /\n\s*createdExam,\n\s*\}\);/.test(ctl));
ok("the details form no longer announces an exam", !/Exam added successfully/.test(slice));
ok("the first save does", /p\.createdExam\)[\s\S]{0,40}toast\.success\("İmtahan yaradıldı/.test(slice));
ok("the assistant does not claim one before a question exists", !/✅ İmtahan yaradıldı/.test(assistant));

/*
 * 8. The AI runs before the exam exists.
 *
 * Both generators used to be reachable only at a URL carrying an exam id, which
 * is why the exam had to be created first, and why a generation that failed left
 * the row behind. Neither ever read the id for anything but tagging the cost row,
 * so both are mounted without one - and the tag has to survive its absence,
 * because a lost cost row is a lost billing record.
 */
console.log("\n8. The AI runs before the exam exists:");
const route = read("../routes/quizRoute.js");
const aiCtl = read("../controllers/aiController.js");
const builder = fs.readFileSync(
  path.join(__dirname, "../../Frontend/src/pages/admin/StructuredBuilder.jsx"),
  "utf8"
);

ok("questions can be written with no exam", /router\.post\("\/generateQuestions",/.test(route));
ok("a file can be read with no exam", /router\.post\(\s*"\/extractQuestionsStream",/.test(route));
ok(
  "the builder posts without an id while the exam is unsaved",
  /extractQuestionsStream\$\{[\s\S]{0,120}pending \? "" :/.test(builder)
);
ok(
  "no cost row is tagged with a raw route value",
  !/exam: req\.params\.examId,/.test(aiCtl) && /const usageExamId = \(req\) =>/.test(aiCtl)
);
ok(
  "and every tag site goes through the guard",
  (aiCtl.match(/exam: usageExamId\(req\),/g) || []).length === 3
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
