/*
 * Plans the admin set: their monthly credits reset each month (no rollover), a
 * plan seen for the first time is scheduled from its start without touching the
 * balance, and lapsed, card-paid and free accounts are left alone.
 */
process.env.NODE_ENV = "test";
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/userModel");
const { resetAdminPlanCredits, addMonths } = require("../jobs/adminPlanCredits");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const DAY = 24 * 60 * 60 * 1000;

async function main() {
  ok("addMonths: the 15th stays the 15th", addMonths(new Date("2026-03-15T08:00:00Z")).toISOString() === "2026-04-15T08:00:00.000Z");
  ok("addMonths: the 31st becomes February's last day, not 3 March", addMonths(new Date("2027-01-31T08:00:00Z")).toISOString() === "2027-02-28T08:00:00.000Z");

  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const now = new Date();
  const mk = (o) => User.create({ password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true, ...o });
  const firstSeen = await mk({ name: "F", email: "f@e.com", plan: "pro", planSource: "admin", planSince: new Date(now - 40 * DAY), aiCredits: 77 });
  const due = await mk({ name: "D", email: "d@e.com", plan: "premium", planSource: "admin", aiCredits: 13, aiCreditsResetAt: new Date(now - DAY) });
  const lapsed = await mk({ name: "L", email: "l@e.com", plan: "pro", planSource: "admin", planExpiresAt: new Date(now - DAY), aiCredits: 5, aiCreditsResetAt: new Date(now - DAY) });
  const card = await mk({ name: "C", email: "c@e.com", plan: "pro", planSource: "stripe", aiCredits: 9, aiCreditsResetAt: new Date(now - DAY) });
  const free = await mk({ name: "N", email: "n@e.com", plan: "free", aiCredits: 3 });

  const r = await resetAdminPlanCredits({ now });
  const get = (u) => User.findById(u._id).lean();
  const f = await get(firstSeen);
  ok("first sight: scheduled for the next monthly date after the plan started", f.aiCreditsResetAt > now && f.aiCreditsResetAt - now <= 31 * DAY);
  ok("first sight: today's balance is left alone", f.aiCredits === 77);
  const d = await get(due);
  ok("due: the balance becomes Premium's 2000 — the 13 unused do not carry over", d.aiCredits === 2000);
  ok("due: the next reset is about a month later", d.aiCreditsResetAt > now && d.aiCreditsResetAt - now > 25 * DAY);
  ok("a lapsed admin plan is not refilled", (await get(lapsed)).aiCredits === 5);
  ok("a card plan is left to Stripe's renewals", (await get(card)).aiCredits === 9);
  ok("a free account gets nothing", (await get(free)).aiCredits === 3);
  ok("the job reports what it did", r.reset === 1 && r.scheduled === 1);

  const again = await resetAdminPlanCredits({ now });
  ok("running again the same hour changes nothing", again.reset === 0 && again.scheduled === 0 && (await get(due)).aiCredits === 2000);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
