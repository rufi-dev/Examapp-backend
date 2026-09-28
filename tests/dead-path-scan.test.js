"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const backend = path.join(__dirname, "..");
const frontend = path.resolve(backend, "..", "Frontend");
const read = (file) => fs.readFileSync(file, "utf8");

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

check("retired question handlers are not imported or exported", () => {
  const controller = read(path.join(backend, "controllers", "quizController.js"));
  const routes = read(path.join(backend, "routes", "quizRoute.js"));
  for (const symbol of ["editQuestion", "deleteQuestion", "getQuestionsByExam"]) {
    assert(!new RegExp(`\\b${symbol}\\b`).test(controller), `${symbol} still ships in controller`);
    assert(!new RegExp(`^\\s*${symbol}\\s*,`, "m").test(routes), `${symbol} still imported`);
  }
});

check("legacy question routes are measured 410 compatibility endpoints", () => {
  const routes = read(path.join(backend, "routes", "quizRoute.js"));
  assert(routes.includes('deprecatedRoute("legacy_question_crud"'));
  for (const route of ["editQuestion", "deleteQuestion", "getQuestionsByExam"]) {
    const line = routes.split(/\r?\n/).find((value) => value.includes(`/${route}`));
    assert(line, `missing compatibility route ${route}`);
  }
  assert(routes.match(/retiredQuestionPath/g).length >= 4);
});

check("deleted frontend question and payment modules stay deleted", () => {
  const removed = [
    "src/components/HeroVideo.jsx",
    "src/components/PDFPreview.jsx",
    "src/components/PayButton.jsx",
    "src/pages/QuestionList.jsx",
    "src/pages/Questions.jsx",
    "src/serviceWorkerRegistration.js",
    "src/serviceWorker.js",
  ];
  for (const relative of removed) {
    assert(!fs.existsSync(path.join(frontend, relative)), `${relative} was reintroduced`);
  }
});

/*
 * Telegram was removed whole: the bot, its webhook, the teacher settings card,
 * the end-of-exam report worker and every field that existed to serve them. A
 * removal that is not enforced comes back one import at a time, so the files
 * are named here and the API surface is named below.
 */
check("the retired Telegram integration stays retired", () => {
  const gone = [
    [backend, "helper/telegram.js"],
    [backend, "controllers/telegramController.js"],
    [backend, "routes/telegramRoute.js"],
    [backend, "jobs/examReports.js"],
    [backend, "helper/examReport.js"],
    [frontend, "src/components/TelegramNotifications.jsx"],
  ];
  for (const [root, relative] of gone) {
    assert(!fs.existsSync(path.join(root, relative)), `${relative} was reintroduced`);
  }
  // The scheduler must not grow the job back either.
  const jobs = read(path.join(backend, "jobs", "backgroundJobs.js"));
  assert(!/telegram-reports|runDueExamReports/.test(jobs), "the report job is back in the scheduler");
});

check("frontend does not call retired question CRUD or Stripe surfaces", () => {
  const roots = [path.join(frontend, "src"), path.join(frontend, "redux")];
  const queue = [...roots];
  const forbidden = [
    /\/editQuestion\//,
    /\/deleteQuestion\//,
    /\/getQuestionsByExam\//,
    /\/api\/stripe\//i,
    /\/api\/telegram\//i,
    /\bpayExam\b/,
    /serviceWorkerRegistration/,
  ];
  while (queue.length) {
    const current = queue.pop();
    if (!fs.existsSync(current)) continue;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) queue.push(path.join(current, entry));
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(current)) continue;
    const source = read(current);
    for (const pattern of forbidden) {
      assert(!pattern.test(source), `${path.relative(frontend, current)} matched ${pattern}`);
    }
  }
});

check("legacy route removal has a dated operational runbook", () => {
  const runbook = read(path.join(backend, "docs", "runbooks", "legacy-question-route-removal.md"));
  assert(runbook.includes("2026-10-31"));
  assert(runbook.includes("30"));
  assert(runbook.includes("legacy_question_crud"));
});

console.log(`dead-path scan: ${passed}/${passed} passed`);
