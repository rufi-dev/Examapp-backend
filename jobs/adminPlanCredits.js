/*
 * Monthly credits for plans the admin set by hand (owner's rule, 2026-10-27:
 * credits do not roll over — unused ones disappear when the month turns).
 *
 * Card plans reset on every paid renewal (controllers/stripeBillingController.js).
 * A plan the admin set has no renewal event, so this job does it: on each
 * aiCreditsResetAt the balance becomes the plan's monthly credits again, and the
 * next reset is a month later. A plan seen for the first time is scheduled from
 * its start date without touching today's balance; a lapsed plan is left alone
 * (the teacher is behind the card wall until they pay or the admin renews).
 */
const User = require("../models/userModel");
const { planDef } = require("../config/plans");

// Same day next month; the 31st becomes the month's last day, never the 1st after.
function addMonths(date, n = 1) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

function nextAfter(from, now) {
  let next = addMonths(from, 1);
  let guard = 0;
  while (next <= now && guard++ < 240) next = addMonths(next, 1);
  return next;
}

async function resetAdminPlanCredits({ now = new Date(), limit = 500 } = {}) {
  const due = await User.find({
    role: "teacher",
    planSource: { $in: ["admin", "migration"] },
    plan: { $in: ["pro", "premium"] },
    $and: [
      { $or: [{ planExpiresAt: null }, { planExpiresAt: { $gt: now } }] },
      { $or: [{ aiCreditsResetAt: null }, { aiCreditsResetAt: { $lte: now } }] },
    ],
  })
    .select("plan planSince aiCreditsResetAt")
    .limit(limit)
    .lean();

  let reset = 0;
  let scheduled = 0;
  for (const u of due) {
    try {
      if (!u.aiCreditsResetAt) {
        const next = nextAfter(u.planSince || now, now);
        const r = await User.updateOne({ _id: u._id, aiCreditsResetAt: null }, { $set: { aiCreditsResetAt: next } });
        scheduled += r.modifiedCount;
        continue;
      }
      const monthly = planDef(u.plan).credits?.monthly || 0;
      const r = await User.updateOne(
        { _id: u._id, aiCreditsResetAt: u.aiCreditsResetAt },
        { $set: { aiCredits: monthly, aiCreditsResetAt: nextAfter(u.aiCreditsResetAt, now) } }
      );
      reset += r.modifiedCount;
    } catch (e) {
      console.error("[PLAN] credit reset failed for", String(u._id), e.message);
    }
  }
  if (reset || scheduled) console.log(`[PLAN] admin-plan credits: ${reset} reset, ${scheduled} scheduled`);
  return { checked: due.length, reset, scheduled };
}

module.exports = { resetAdminPlanCredits, addMonths, nextAfter };
