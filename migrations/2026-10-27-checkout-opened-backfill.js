#!/usr/bin/env node
/*
 * Who opened Stripe's card page before Examopia started noting it.
 *
 * From 2026-10-27 createCheckout stamps stripeCheckoutOpenedAt / Plan / Opens on
 * the teacher, so the admin's billing panel shows who reached the card page and
 * stopped. Teachers who opened it before that have no stamp; their Checkout
 * pages are still listed at Stripe (with examopia_user_id), so this copies the
 * latest moment, the plan and the count from there. Only teachers without a stamp
 * are written; the card itself and the subscription are not touched.
 *
 *   node migrations/2026-10-27-checkout-opened-backfill.js --dry-run
 *   node migrations/2026-10-27-checkout-opened-backfill.js --apply
 */
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/userModel");
const { stripeClient } = require("../config/stripe");

const modes = ["dry-run", "apply"].filter((m) => process.argv.includes(`--${m}`));
if (modes.length !== 1) {
  console.error("REFUSED: pass exactly one of --dry-run, --apply");
  process.exit(2);
}
const apply = modes[0] === "apply";

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const byUser = new Map();
  for await (const session of stripeClient().checkout.sessions.list({ limit: 100 })) {
    if (session.mode !== "subscription") continue;
    const uid = session.metadata?.examopia_user_id || session.client_reference_id;
    if (!mongoose.isValidObjectId(uid)) continue;
    const at = new Date(session.created * 1000);
    const seen = byUser.get(uid) || { opens: 0, openedAt: null, plan: null };
    seen.opens += 1;
    if (!seen.openedAt || at > seen.openedAt) {
      seen.openedAt = at;
      seen.plan = session.metadata?.target_plan || seen.plan;
    }
    byUser.set(uid, seen);
  }
  let written = 0;
  for (const [uid, seen] of byUser) {
    const user = await User.findOne({ _id: uid, role: "teacher" }).select("name +stripeCheckoutOpenedAt").lean();
    if (!user || user.stripeCheckoutOpenedAt) continue;
    console.log(`${apply ? "set" : "would set"}: ${String(user.name || "").split(" ")[0] || uid} · opened ${seen.opens}× · last ${seen.openedAt.toISOString().slice(0, 16)} · ${seen.plan || "?"}`);
    if (apply) {
      const res = await User.updateOne(
        { _id: uid, stripeCheckoutOpenedAt: null },
        { $set: { stripeCheckoutOpenedAt: seen.openedAt, stripeCheckoutPlan: seen.plan, stripeCheckoutOpens: seen.opens } }
      );
      written += res.modifiedCount;
    }
  }
  console.log(apply ? `done: ${written} teacher(s) stamped` : `dry run: ${byUser.size} teacher(s) seen at Stripe`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
