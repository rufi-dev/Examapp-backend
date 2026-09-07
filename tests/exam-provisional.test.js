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

console.log("\n1. A described exam is not yet an exam:");
ok("the flag exists on the model", /provisional: \{ type: Boolean/.test(model));
ok("with the timestamp the janitor keys on", /provisionalSince: \{ type: Date/.test(model));
ok("creating one sets both", /provisional: true,\s*\n\s*provisionalSince: new Date\(\),/.test(ctl));

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

console.log("\n4. Listed nowhere until then:");
const filters = ctl.match(/provisional: \{ \$ne: true \}/g) || [];
ok("every exam list applies the rule", filters.length >= 3, `found ${filters.length}`);
ok("the class list", /class: exists\._id, deletedAt: null, provisional: \{ \$ne: true \}/.test(ctl));
ok("the results list", /deletedAt: null,\s*\n\s*provisional: \{ \$ne: true \},/.test(ctl));
ok("and the count on the class card",
  /\$match: \{ class: \{ \$in: allIds \}, deletedAt: null, provisional: \{ \$ne: true \} \}/.test(ctl));

console.log("\n5. Abandoned ones are cleared, carefully:");
ok("there is a sweeper", /async function purgeAbandonedExams/.test(ctl));
ok("scheduled daily", /schedule\("abandoned-exam-purge"/.test(jobs));
/*
 * The historical 312 have no provisionalSince, so this can never reach them —
 * they are the owner's to decide about, not a sweep's.
 */
ok("it keys on the timestamp, so it cannot reach the backfilled ones",
  /provisionalSince: \{ \$lt: cutoff \}/.test(ctl));
ok("a week is the cutoff", /7 \* 24 \* 60 \* 60 \* 1000/.test(ctl));
// The flag is a claim; the questions and attempts are the evidence.
ok("it verifies before deleting anything", /if \(qCount \|\| attempts\)/.test(ctl));
ok("and promotes what turns out to be real instead", /kept and promoted/.test(ctl));
ok("the delete is fenced on the same predicate",
  /deleteOne\(\{ _id: exam\._id, provisional: true, provisionalSince: \{ \$lt: cutoff \} \}\)/.test(ctl));

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
