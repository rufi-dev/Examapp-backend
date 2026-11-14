/*
 * Visits older than a week become numbers.
 *
 * visitorsessions was the only collection in this database with no retention at
 * all: 12,455 rows, 7.5 MB, and 93% of them older than a week. Every visit to
 * the public site leaves a row carrying an IP, a user agent and a journey of up
 * to sixty paths, and none of it was ever removed — debuglogs expires after 14
 * days, healthsnapshots after 31, visits accumulated forever.
 *
 * This runs against a real MongoDB, because the thing worth proving is the
 * ORDER: the summary must be on disk before a single row is deleted, and a day
 * that failed to summarise must keep its rows. Neither can be checked by reading
 * the source.
 */
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

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

const DAY = 24 * 60 * 60 * 1000;

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: "retention" });

  const VisitorSession = require("../models/visitorSessionModel");
  const VisitorDay = require("../models/visitorDayModel");
  const { rollUpAndPruneVisitors, summarizeDay, dayKeyOf } = require("../jobs/visitorRollup");

  const now = Date.now();
  const at = (daysAgo, hourAz = 12) => {
    const key = dayKeyOf(now - daysAgo * DAY);
    return new Date(`${key}T${String(hourAz).padStart(2, "0")}:30:00.000+04:00`);
  };

  const visit = (daysAgo, extra = {}, hour = 12) => ({
    sessionId: `s${Math.random().toString(36).slice(2)}`,
    ip: "5.5.5.5",
    country: "Azerbaijan",
    affiliate: "(direct)",
    device: "mobile",
    landing: "/",
    pageViews: 3,
    durationSeconds: 40,
    opened: true,
    rendered: true,
    renderMs: 500,
    firstSeen: at(daysAgo, hour),
    lastActivity: at(daysAgo, hour),
    ...extra,
  });

  console.log("\n1. A finished day is summarised into numbers:");
  await VisitorSession.insertMany([
    visit(30, {}, 9),
    visit(30, { ip: "6.6.6.6", country: "Turkey", device: "desktop" }, 9),
    visit(30, { ip: "5.5.5.5" }, 14),
    // Localhost is excluded from the live charts, so it must be excluded here or
    // the summary would disagree with the numbers it replaces.
    visit(30, { ip: "127.0.0.1" }, 9),
  ]);
  const oldKey = dayKeyOf(now - 30 * DAY);
  const summary = await summarizeDay(oldKey);
  ok("it counts the visits", summary.visits === 3, `got ${summary.visits}`);
  ok("and leaves localhost out", summary.visits === 3);
  ok("distinct IPs are counted before the addresses are discarded", summary.uniqueIps === 2, `got ${summary.uniqueIps}`);
  ok("page views are summed", summary.pageViews === 9);
  ok("the hour histogram is kept at full resolution", summary.hours[9] === 2 && summary.hours[14] === 1);
  ok("and the unique-per-hour one too", summary.hoursUnique[9] === 1 + 1 && summary.hoursUnique[14] === 1);
  ok("countries are kept as counts", summary.countries.find((c) => c.key === "Azerbaijan")?.n === 2);
  // The summary is what remains, so what it does NOT keep is the point.
  ok("no IP survives into the summary", !JSON.stringify(summary).includes("5.5.5.5"));
  ok("no user agent or journey either", !("userAgent" in summary) && !("pages" in summary));

  console.log("\n2. The rows go only after the summary is written:");
  await VisitorSession.insertMany([visit(2), visit(1), visit(0)]);
  const before = await VisitorSession.countDocuments({});
  ok("all the visits are there to begin with", before === 7, `got ${before}`);

  const r1 = await rollUpAndPruneVisitors(now, { keepDays: 7 });
  const stored = await VisitorDay.findOne({ day: oldKey }).lean();
  ok("the old day has a summary", Boolean(stored) && stored.visits === 3);
  ok("its rows are gone", (await VisitorSession.countDocuments({ lastActivity: { $lt: at(8) } })) === 0);
  /*
   * Four, not three: the localhost row is not COUNTED but it is still a row, and
   * leaving excluded traffic behind forever would defeat the point of the sweep.
   */
  ok("the report says what it did", r1.removed === 4 && r1.summarised >= 1, JSON.stringify(r1));

  console.log("\n3. Recent visits are untouched:");
  const recent = await VisitorSession.countDocuments({});
  ok("the last week is still row-by-row", recent === 3, `got ${recent}`);
  ok("including today, which is not over", (await VisitorSession.countDocuments({ lastActivity: { $gte: at(0, 0) } })) === 1);

  console.log("\n4. Running it again changes nothing:");
  const r2 = await rollUpAndPruneVisitors(now, { keepDays: 7 });
  const again = await VisitorDay.findOne({ day: oldKey }).lean();
  // Recomputed from the rows rather than added to, so a re-run after a crash
  // produces the same number instead of double-counting.
  ok("the summary is not double-counted", again.visits === 3, `got ${again.visits}`);
  ok("and nothing more is removed", r2.removed === 0);

  console.log("\n5. A day of nothing but excluded traffic is still cleared:");
  /*
   * A day whose only rows are localhost summarises to zero visits. Skipping the
   * write for those would leave a day that has rows and no summary — which the
   * delete pass correctly refuses to touch, so they would live forever.
   */
  await VisitorSession.insertMany([visit(20, { ip: "127.0.0.1" }), visit(20, { ip: "::1" })]);
  const localKey = dayKeyOf(now - 20 * DAY);
  const r3 = await rollUpAndPruneVisitors(now, { keepDays: 7 });
  const zero = await VisitorDay.findOne({ day: localKey }).lean();
  ok("the day is recorded as zero rather than skipped", Boolean(zero) && zero.visits === 0);
  ok("and its rows are gone", (await VisitorSession.countDocuments({ lastActivity: { $lt: at(8) } })) === 0);
  ok("which the report counts", r3.removed === 2, JSON.stringify(r3));


  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("threw:", e.message);
  process.exit(1);
});
