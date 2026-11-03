/*
 * The analytics page's traffic for any range (2026-11-03): finished days come
 * from their summaries, today (and a finished day not yet rolled up) from its
 * rows, so a range a month long draws true numbers instead of falling to zero a
 * week back. Sources are grouped into the categories the visitor list filters by.
 * Runs against a real MongoDB, like visitor-retention.
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
  await mongoose.connect(mongod.getUri(), { dbName: "overview" });
  const VisitorSession = require("../models/visitorSessionModel");
  const VisitorDay = require("../models/visitorDayModel");
  const { dayKeyOf } = require("../jobs/visitorRollup");
  const { overview, sourceCategory } = require("../controllers/visitorController");

  const now = Date.now();
  const key = (daysAgo) => dayKeyOf(now - daysAgo * DAY);
  const at = (daysAgo, hour = 12) => new Date(`${key(daysAgo)}T${String(hour).padStart(2, "0")}:30:00.000+04:00`);
  const visit = (daysAgo, extra = {}, hour = 12) => ({
    sessionId: `s${Math.random().toString(36).slice(2)}`, ip: "5.5.5.5", country: "Azerbaijan", affiliate: "(direct)", device: "mobile", landing: "/",
    pageViews: 2, durationSeconds: 30, opened: true, rendered: true, firstSeen: at(daysAgo, hour), lastActivity: at(daysAgo, hour), ...extra,
  });

  // Today: live rows only (3 visits, 2 IPs, one from Instagram, one opened but never rendered).
  await VisitorSession.create([
    visit(0, { ip: "1.1.1.1", affiliate: "instagram.com" }, 9),
    visit(0, { ip: "1.1.1.1" }, 9),
    visit(0, { ip: "2.2.2.2", rendered: false, country: "Türkiyə" }, 21),
  ]);
  // 20 days ago: only a summary (its rows are long gone).
  await VisitorDay.create({
    day: key(20), visits: 10, uniqueIps: 7, signedIn: 2, pageViews: 30, durationSeconds: 600, opened: 10, rendered: 9,
    hours: Array.from({ length: 24 }, (_, h) => (h === 9 ? 10 : 0)), hoursUnique: Array.from({ length: 24 }, (_, h) => (h === 9 ? 7 : 0)),
    sources: [{ key: "l.facebook.com", n: 4 }, { key: "(direct)", n: 5 }, { key: "google", n: 1 }], countries: [{ key: "Azerbaijan", n: 10 }], devices: [{ key: "mobile", n: 8 }, { key: "desktop", n: 2 }], landings: [{ key: "/", n: 10 }],
  });
  // 2 days ago: rows not rolled up yet, no summary (the job has not run).
  await VisitorSession.create([visit(2, { ip: "3.3.3.3", affiliate: "tiktok" }), visit(2, { ip: "127.0.0.1" })]);

  const call = async (query) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    let err = null;
    await new Promise((resolve) => {
      res.json = function json(b) { this.body = b; resolve(); return this; };
      overview({ query }, res, (e) => { err = e; resolve(); });
    });
    return { ...res, err };
  };

  let r = await call({ from: key(29), to: key(0) });
  ok("a 30-day range answers 30 days", r.body?.days?.length === 30, JSON.stringify(r.err?.message || ""));
  const dayOf = (k) => r.body.days.find((d) => d.day === k);
  ok("a day long past comes from its summary", dayOf(key(20)).visits === 10 && dayOf(key(20)).uniqueIps === 7);
  ok("today comes from its live rows (localhost excluded everywhere)", dayOf(key(0)).visits === 3 && dayOf(key(0)).uniqueIps === 2);
  ok("a finished day not yet rolled up is summarised from its rows, not shown as zero", dayOf(key(2)).visits === 1);
  ok("a day with neither is zero, not missing", dayOf(key(10)).visits === 0);
  ok("totals add the days", r.body.totals.visits === 14 && r.body.totals.signedIn === 2 && r.body.totals.opened === 14 && r.body.totals.rendered === 12);
  ok("the hour histogram merges summaries and live rows", r.body.hours[9] === 12 && r.body.hours[21] === 1 && r.body.hoursUnique[9] === 8);
  const src = Object.fromEntries(r.body.sources.map((s) => [s.key, s.n]));
  ok("sources are grouped into the list's categories", src.direct === 7 && src.facebook === 4 && src.instagram === 1 && src.google === 1 && src.tiktok === 1, JSON.stringify(src));
  ok("sources come largest first", r.body.sources[0].key === "direct");
  ok("countries and devices merged", r.body.countries.find((c) => c.key === "Azerbaijan").n === 13 && r.body.devices[0].key === "mobile");
  ok("it says how long single visits are kept", r.body.keepDays === 7 && r.body.today === key(0));

  r = await call({});
  ok("no range: today", r.body.days.length === 1 && r.body.days[0].day === key(0));
  r = await call({ from: key(0), to: key(3) });
  ok("a reversed range is refused (400)", r.code === 400 && /Yanlış/.test(r.err?.message || ""));
  r = await call({ from: "2020-01-01", to: key(0) });
  ok("a range past 400 days is refused", r.code === 400);
  ok("a summary is not written by reading (no side effects)", (await VisitorDay.countDocuments()) === 1);

  ok("category of an affiliate", sourceCategory("m.facebook.com") === "facebook" && sourceCategory("(direct)") === "direct" && sourceCategory("") === "direct" && sourceCategory("bing.com") === "other" && sourceCategory("igsh") === "instagram");

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
