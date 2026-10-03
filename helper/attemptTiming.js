/*
 * When a student started an exam, when it ended, and how it ended.
 *
 * One answer for every screen a teacher reads it on - the results list, the
 * review of a single paper, the live monitor - so the three can never disagree
 * about the same attempt.
 *
 * Where each time comes from:
 *   started  the attempt's `startedAt`, which the SERVER stamps when the attempt
 *            is opened. Not the browser's clock, so a student cannot move it.
 *   ended    the moment the result was written (`createdAt`) ...
 *
 * ...except when time ran out. Then the result is written by the finalizer, a
 * sweep that runs a little after each deadline, and `createdAt` is when the sweep
 * happened to come round - not when the student's time ended. Reporting that
 * would show a student "finishing" minutes after the clock stopped them, and a
 * teacher comparing it against the exam window would think the deadline had not
 * held. So a time-out ends at the deadline itself.
 *
 * And it says HOW it ended, because "submitted at 10:41" means something very
 * different from "time ran out at 10:41" or "stopped for violations at 10:41".
 */
function attemptTiming(result, attempt) {
  const toDate = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const startedAt = toDate(attempt?.startedAt);
  const written = toDate(result?.createdAt);
  const deadline = toDate(attempt?.expiresAt);

  let endedBy = "submitted";
  let endedAt = written;
  if (result?.terminated) {
    endedBy = "terminated";
  } else if (result?.autoSubmitted) {
    endedBy = "timeout";
    if (deadline && written && deadline < written) endedAt = deadline;
  }

  const durationSec =
    startedAt && endedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : null;

  return { startedAt, endedAt, endedBy, durationSec };
}

/*
 * Timing for a page of results, in ONE extra query rather than one per row.
 * Returns a Map of resultId -> timing. Results with no attempt (legacy rows from
 * before attempts were tracked) still get their end time; their start is null.
 */
async function timingForResults(results, Attempt) {
  const rows = Array.isArray(results) ? results : [];
  const ids = [...new Set(rows.map((r) => r?.attemptId).filter(Boolean).map(String))];
  const attempts = ids.length
    ? await Attempt.find({ _id: { $in: ids } }).select("startedAt expiresAt").lean()
    : [];
  const byId = new Map(attempts.map((a) => [String(a._id), a]));
  const out = new Map();
  for (const r of rows) {
    const a = r?.attemptId ? byId.get(String(r.attemptId)) : null;
    out.set(String(r?._id), attemptTiming(r, a));
  }
  return out;
}

module.exports = { attemptTiming, timingForResults };
