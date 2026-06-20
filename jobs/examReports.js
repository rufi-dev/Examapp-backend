// Scheduled job: once an exam's endDate passes, send its results report
// (PDF + Excel) to the exam's Telegram recipients, then mark it sent so it
// never fires twice.
const Exam = require("../models/examModel");
const Result = require("../models/resultModel");
const { sendExamReport } = require("../helper/examReport");
const { isTelegramConfigured } = require("../helper/telegram");

// Only report exams that ended within this window. This bounds a first-deploy
// so it doesn't blast reports for every historically-ended exam — only ones
// that ended recently. The scheduler runs often enough to catch each exam as
// it ends within the window.
const WINDOW_MS = 12 * 60 * 60 * 1000;

async function runDueExamReports() {
  if (!isTelegramConfigured()) return;
  const now = Date.now();
  const exams = await Exam.find({
    endDate: { $lte: new Date(now), $gte: new Date(now - WINDOW_MS) },
    reportSentAt: null, // matches missing-or-null
  });
  for (const exam of exams) {
    // success stays true unless a send actually FAILS — so a transient failure
    // (network, cold start, Telegram hiccup) leaves reportSentAt null and the
    // next tick retries, instead of marking it sent and losing the report.
    // Nothing-to-do (0 results / 0 recipients) still counts as done.
    let success = true;
    try {
      const results = await Result.find({ examId: exam._id }).populate(
        "userId",
        "name email phone"
      );
      if (results.length) {
        const r = await sendExamReport(exam, results);
        if (r.failed > 0) success = false;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[REPORT] exam", String(exam._id), "failed:", e.message);
      success = false;
    }
    if (!success) continue; // retry on the next tick (within the window)
    try {
      exam.reportSentAt = new Date();
      await exam.save();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[REPORT] mark-sent failed:", e.message);
    }
  }
}

module.exports = { runDueExamReports };
