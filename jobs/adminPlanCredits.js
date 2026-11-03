/*
 * Monthly credits for plans with no monthly payment (owner's rule, 2026-10-27:
 * credits do not roll over — unused ones disappear when the month turns).
 *
 * Monthly card plans reset on every paid renewal (controllers/stripeBillingController.js).
 * Two kinds of plan have no such event each month, so this job does it: on each
 * aiCreditsResetAt the balance becomes the plan's monthly credits again, and the
 * next reset is a month later.
 *  - A plan the admin set by hand. One seen for the first time is scheduled from
 *    its start date without touching today's balance; a lapsed plan is left alone
 *    (the teacher is behind the card wall until they pay or the admin renews).
 *  - A card plan paid for a YEAR (2026-10-31). The year's payment set the first
 *    month (startPaidMonth); this gives the eleven after it, with the live
 *    add-ons' credits as a paid month does. Never during the trial (nothing is
 *    paid yet) and never on or after the renewal day: that month comes with the
 *    renewal's payment, so a renewal that fails never hands out credits.
 */
const User = require("../models/userModel");
const { planDef } = require("../config/plans");
const { addMonths, nextAfter } = require("../helper/calendarMonths");

const HOUR = 60 * 60 * 1000;

async function resetAdminPlanCredits({ now = new Date(), limit = 500 } = {}) {
  const due = await User.find({
    role: "teacher",
    plan: { $in: ["pro", "premium"] },
    $and: [
      {
        $or: [
          { planSource: { $in: ["admin", "migration"] } },
          { planSource: "stripe", stripeInterval: "year", stripeSubscriptionStatus: "active" },
        ],
      },
      { $or: [{ planExpiresAt: null }, { planExpiresAt: { $gt: now } }] },
      { $or: [{ aiCreditsResetAt: null }, { aiCreditsResetAt: { $lte: now } }] },
    ],
  })
    .select("plan planSource planSince aiCreditsResetAt addonCreditsMonthly +stripeInterval +stripeCurrentPeriodEnd")
    .limit(limit)
    .lean();

  let reset = 0;
  let scheduled = 0;
  for (const u of due) {
    try {
      const yearly = u.planSource === "stripe";
      if (!u.aiCreditsResetAt) {
        // A yearly card plan always has its date from its payment; one without is
        // left for that payment to set rather than guessed here.
        if (yearly) continue;
        const next = nextAfter(u.planSince || now, now);
        const r = await User.updateOne({ _id: u._id, aiCreditsResetAt: null }, { $set: { aiCreditsResetAt: next } });
        scheduled += r.modifiedCount;
        continue;
      }
      if (yearly && u.stripeCurrentPeriodEnd && new Date(u.aiCreditsResetAt).getTime() >= new Date(u.stripeCurrentPeriodEnd).getTime() - HOUR) {
        continue; // the renewal's payment brings this month
      }
      const monthly = (planDef(u.plan).credits?.monthly || 0) + (yearly ? Number(u.addonCreditsMonthly) || 0 : 0);
      const r = await User.updateOne(
        { _id: u._id, aiCreditsResetAt: u.aiCreditsResetAt },
        { $set: { aiCredits: monthly, aiCreditsResetAt: nextAfter(u.aiCreditsResetAt, now) } }
      );
      reset += r.modifiedCount;
    } catch (e) {
      console.error("[PLAN] credit reset failed for", String(u._id), e.message);
    }
  }
  if (reset || scheduled) console.log(`[PLAN] monthly credits: ${reset} reset, ${scheduled} scheduled`);
  return { checked: due.length, reset, scheduled };
}

module.exports = { resetAdminPlanCredits, addMonths, nextAfter };
