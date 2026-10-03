/* eslint-env node */
/*
 * When a student started, when they finished, and how it ended — the same answer
 * on every screen a teacher reads it on.
 *
 * The case worth a test of its own is the time-out. The finalizer that writes a
 * result when time runs out is a sweep, so it writes a few seconds or minutes
 * AFTER the deadline. Report that moment and a student appears to have finished
 * after the clock stopped them — and a teacher checking it against the exam
 * window concludes the deadline did not hold.
 */
process.env.NODE_ENV = "test";

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

const fs = require("node:fs");
const path = require("node:path");
const { attemptTiming, timingForResults } = require("../helper/attemptTiming");
const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "quizController.js"), "utf8");

const T = (hhmm) => new Date(`2026-10-03T${hhmm}:00Z`);

async function main() {
  console.log("when an exam was started and finished");

  console.log("\na normal submission:");
  const sub = attemptTiming({ createdAt: T("10:41") }, { startedAt: T("10:02"), expiresAt: T("11:02") });
  ok("starts when the server opened the attempt", +sub.startedAt === +T("10:02"));
  ok("ends when the result was written", +sub.endedAt === +T("10:41"));
  ok("...and says it was handed in", sub.endedBy === "submitted");
  ok("39 minutes, in seconds", sub.durationSec === 39 * 60, String(sub.durationSec));

  console.log("\ntime ran out:");
  const late = attemptTiming(
    { createdAt: T("11:05"), autoSubmitted: true },
    { startedAt: T("10:02"), expiresAt: T("11:02") }
  );
  ok("ends AT the deadline, not when the sweep wrote it", +late.endedAt === +T("11:02"), String(late.endedAt));
  ok("...and says time ran out", late.endedBy === "timeout");
  ok("the duration is the full allowance, not a few minutes over", late.durationSec === 60 * 60);
  const early = attemptTiming({ createdAt: T("10:58"), autoSubmitted: true }, { startedAt: T("10:02"), expiresAt: T("11:02") });
  ok("a result written BEFORE the deadline keeps its own time", +early.endedAt === +T("10:58"));

  console.log("\nstopped for violations:");
  const stop = attemptTiming(
    { createdAt: T("10:20"), terminated: true, autoSubmitted: true },
    { startedAt: T("10:02"), expiresAt: T("11:02") }
  );
  ok("ends when it was stopped", +stop.endedAt === +T("10:20"));
  ok("...and says it was stopped, not timed out", stop.endedBy === "terminated");

  console.log("\nolder results with no attempt on record:");
  const legacy = attemptTiming({ createdAt: T("09:30") }, null);
  ok("still show when they were handed in", +legacy.endedAt === +T("09:30"));
  ok("...with no invented start", legacy.startedAt === null && legacy.durationSec === null);

  console.log("\na page of results costs one extra query, not one per row:");
  let calls = 0;
  const fakeAttempt = {
    find: () => {
      calls += 1;
      return { select: () => ({ lean: async () => [{ _id: "a1", startedAt: T("10:00"), expiresAt: T("11:00") }] }) };
    },
  };
  const map = await timingForResults(
    [{ _id: "r1", attemptId: "a1", createdAt: T("10:30") }, { _id: "r2", attemptId: null, createdAt: T("10:40") }],
    fakeAttempt
  );
  ok("one query for the page", calls === 1, String(calls));
  ok("the row with an attempt gets its start", +map.get("r1").startedAt === +T("10:00"));
  ok("the legacy row still gets its end", +map.get("r2").endedAt === +T("10:40"));

  console.log("\nit reaches every screen:");
  ok("the results list attaches it to each row", /o\.timing = timings\.get\(String\(r\._id\)\)/.test(src));
  ok("the review of a single paper carries it", /view\.timing = attemptTiming\(result, att\)/.test(src));
  ok("the live monitor uses the same rule", /finishedAt: timing\.endedAt,\s*endedBy: timing\.endedBy,/.test(src));
  ok("...and loads the deadline it needs", /\.select\("answers answeredCount violations startedAt expiresAt"\)/.test(src));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
