const crypto = require("crypto");
const Exam = require("../models/examModel");
const Result = require("../models/resultModel");
const { sendExamReport } = require("../helper/examReport");
const { isTelegramConfigured } = require("../helper/telegram");

const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 60 * 1000;

const dueFilter = (now) => ({
  endDate: { $lte: now },
  reportSentAt: null,
  reportDeadLetterAt: null,
  $and: [
    {
      $or: [
        { reportNextAttemptAt: null },
        { reportNextAttemptAt: { $exists: false } },
        { reportNextAttemptAt: { $lte: now } },
      ],
    },
    {
      $or: [
        { reportLeaseUntil: null },
        { reportLeaseUntil: { $exists: false } },
        { reportLeaseUntil: { $lte: now } },
      ],
    },
  ],
});

async function claimDueExam({ now, workerId, leaseMs = LEASE_MS }) {
  return Exam.findOneAndUpdate(
    dueFilter(now),
    {
      $set: {
        reportLeaseOwner: workerId,
        reportLeaseUntil: new Date(now.getTime() + leaseMs),
      },
      $inc: { reportAttempts: 1 },
    },
    { new: true, sort: { endDate: 1, _id: 1 } }
  ).select("+reportLeaseOwner +reportLeaseUntil +reportAttempts");
}

async function completeClaim(exam, workerId, now) {
  const r = await Exam.updateOne(
    { _id: exam._id, reportLeaseOwner: workerId, reportSentAt: null },
    {
      $set: {
        reportSentAt: now,
        reportLeaseOwner: null,
        reportLeaseUntil: null,
        reportNextAttemptAt: null,
        reportLastFailure: null,
      },
    }
  );
  return r.modifiedCount === 1 ? "completed" : "stale";
}

async function retryClaim(exam, workerId, now, failure) {
  const attempts = Number(exam.reportAttempts) || 1;
  const dead = attempts >= MAX_ATTEMPTS;
  const backoff = Math.min(6 * 60 * 60 * 1000, BASE_BACKOFF_MS * 2 ** Math.min(attempts - 1, 8));
  const set = {
    reportLeaseOwner: null,
    reportLeaseUntil: null,
    reportLastFailure: failure,
    ...(dead
      ? { reportDeadLetterAt: now }
      : { reportNextAttemptAt: new Date(now.getTime() + backoff) }),
  };
  const r = await Exam.updateOne(
    { _id: exam._id, reportLeaseOwner: workerId, reportSentAt: null },
    { $set: set }
  );
  return r.modifiedCount === 1 ? (dead ? "dead" : "retry") : "stale";
}

async function runDueExamReports({
  workerId = `report-${crypto.randomUUID()}`,
  max = 25,
  now = new Date(),
  leaseMs = LEASE_MS,
  send = sendExamReport,
  enabled = isTelegramConfigured(),
} = {}) {
  if (!enabled) return { disabled: true, claimed: 0, completed: 0, retried: 0, dead: 0, stale: 0 };
  const stats = { claimed: 0, completed: 0, retried: 0, dead: 0, stale: 0 };

  for (let i = 0; i < max; i += 1) {
    const exam = await claimDueExam({ now, workerId, leaseMs });
    if (!exam) break;
    stats.claimed += 1;
    let outcome;
    try {
      const results = await Result.find({ examId: exam._id }).populate(
        "userId",
        "name email phone"
      );
      if (results.length) {
        const sent = await send(exam, results);
        if (sent && Number(sent.failed) > 0) {
          outcome = await retryClaim(exam, workerId, now, "delivery");
        } else {
          outcome = await completeClaim(exam, workerId, now);
        }
      } else {
        outcome = await completeClaim(exam, workerId, now);
      }
    } catch (_) {
      outcome = await retryClaim(exam, workerId, now, "generation");
    }
    if (outcome === "completed") stats.completed += 1;
    else if (outcome === "retry") stats.retried += 1;
    else if (outcome === "dead") stats.dead += 1;
    else stats.stale += 1;
  }
  return stats;
}

module.exports = {
  runDueExamReports,
  claimDueExam,
  completeClaim,
  retryClaim,
  dueFilter,
  LEASE_MS,
  MAX_ATTEMPTS,
};
