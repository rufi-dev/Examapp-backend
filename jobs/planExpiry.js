/*
 * Plan-lapse sweep.
 *
 * Caps are evaluated lazily on each request, so NOTHING in the system ever noticed
 * the moment a paid plan ran out — a teacher whose Premium lapsed simply kept a
 * roster their tier no longer covers, for ever, because the guards only run when
 * adding a student.
 *
 * This is the thing that notices. It finds paid plans past their expiry date and
 * brings the roster down to the free-tier cap, freezing the excess onto the waitlist
 * (never deleting it — see helper/planLimits.enforceStudentCap).
 *
 * `planCapEnforcedAt` stops a lapsed account being re-counted on every pass: once
 * enforced after the expiry date there is nothing more to do, and a roster cannot
 * grow again while over cap because the add-time guards refuse it.
 */
const User = require("../models/userModel");
const { reconcileStudentCap } = require("../helper/planLimits");

async function sweepExpiredPlans({ now = new Date(), limit = 200 } = {}) {
  const due = await User.find({
    plan: { $in: ["pro", "premium"] },
    planExpiresAt: { $ne: null, $lt: now },
    $or: [
      { planCapEnforcedAt: null },
      { planCapEnforcedAt: { $exists: false } },
      { $expr: { $lt: ["$planCapEnforcedAt", "$planExpiresAt"] } },
    ],
  })
    .select("_id")
    .limit(limit)
    .lean();

  let frozen = 0;
  for (const u of due) {
    try {
      const r = await reconcileStudentCap(u._id);
      frozen += r.frozen;
      await User.updateOne({ _id: u._id }, { $set: { planCapEnforcedAt: new Date() } });
    } catch (e) {
      // One bad account must not stop the sweep.
      console.error("[PLAN] sweep failed for", String(u._id), e.message);
    }
  }
  if (due.length) console.log(`[PLAN] lapse sweep: ${due.length} account(s), ${frozen} student(s) frozen`);
  return { checked: due.length, frozen };
}

module.exports = { sweepExpiredPlans };
