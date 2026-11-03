const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const User = require("../models/userModel");
const StripeEvent = require("../models/stripeEventModel");
const MaintenanceAudit = require("../models/maintenanceAuditModel");
const { refundStatus } = require("../helper/stripeRefund");
const { needsSubscription } = require("../helper/teacherAccess");
const { planDef } = require("../config/plans");
const {
  required,
  stripeClient,
  priceForPlan,
  planForPrice,
  planOfPrice,
  frontendUrl,
  checkoutBranding,
  portalConfiguration,
  trialDays,
  trialCredits,
  billingEnabledFor,
  ADDONS,
  addonPrices,
} = require("../config/stripe");
const { addMonths, nextMonthlyBefore } = require("../helper/calendarMonths");

// Statuses of a subscription that is still running. past_due is one (Stripe keeps
// retrying the card), but its plan is stopped until the payment goes through.
const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
// Statuses that end it; paused is a trial that ended with no way to pay.
const ENDED_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);
// The plan runs this long past the paid-up date, so a renewal webhook that arrives
// late never drops a paying teacher to Free in between.
const GRACE_MS = 2 * 24 * 60 * 60 * 1000;
// Invoices that pay for a month of the plan (not a proration or a manual invoice).
const MONTH_INVOICES = new Set(["subscription_create", "subscription_cycle"]);
const PLAN_RANK = { free: 0, pro: 1, premium: 2 };

const toDate = (seconds) => {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
};

// API 2025-03-31 moved the billing period from the subscription onto each item.
const periodEnd = (subscription) => {
  const ends = (subscription?.items?.data || []).map((item) => Number(item?.current_period_end));
  ends.push(Number(subscription?.current_period_end)); // older API versions
  const latest = Math.max(0, ...ends.filter(Number.isFinite));
  return latest > 0 ? new Date(latest * 1000) : null;
};

const periodStart = (subscription) => {
  const starts = (subscription?.items?.data || []).map((item) => Number(item?.current_period_start));
  starts.push(Number(subscription?.current_period_start));
  const valid = starts.filter((n) => Number.isFinite(n) && n > 0);
  return valid.length ? new Date(Math.min(...valid) * 1000) : null;
};

// The same release moved an invoice's subscription under parent.subscription_details.
const invoiceSubscriptionId = (invoice) => {
  const ref = invoice?.parent?.subscription_details?.subscription ?? invoice?.subscription;
  return typeof ref === "string" ? ref : ref?.id || null;
};

// A Customer Portal cancel sets cancel_at (the period end) and leaves
// cancel_at_period_end false, so both mean "this subscription is ending".
const cancelDate = (subscription) =>
  toDate(subscription?.cancel_at) || (subscription?.cancel_at_period_end ? periodEnd(subscription) : null);

const customerIdOf = (object) => (typeof object?.customer === "string" ? object.customer : object?.customer?.id || null);

// An add-on (credit pack, storage) is its own subscription, tagged at checkout.
const isAddon = (subscription) => subscription?.metadata?.examopia_kind === "addon";

function priceFromSubscription(subscription) {
  return subscription?.items?.data?.map((item) => item?.price?.id).find(Boolean) || "";
}

// How often the plan is paid: Stripe says it on the price; our own price list is
// the fallback (an event without the recurring block).
function intervalOf(subscription) {
  const price = subscription?.items?.data?.map((item) => item?.price).find(Boolean);
  const said = price?.recurring?.interval;
  if (said === "year" || said === "month") return said;
  return planOfPrice(price?.id)?.interval || "month";
}

const monthlyCredits = (plan) => planDef(plan).credits?.monthly || 0;

const hasPaidPlanNow = (user) =>
  ["pro", "premium"].includes(user?.plan) && (!user.planExpiresAt || new Date(user.planExpiresAt) > new Date());

/*
 * Who gets the 7-day trial: a teacher who has never paid. Anyone who had a plan
 * (by card, by transfer, or set by the admin — the stored plan stays "pro" or
 * "premium" after it lapses, and planSince stays set), a trial, or a card
 * subscription before (one whose charge failed or that was cancelled included)
 * pays straight away. The same card on another account is caught when the
 * trial starts (trialCardUsedBefore).
 */
const everPaid = (user) =>
  !!(user?.stripeTrialUsedAt || user?.stripeSubscriptionId || user?.planDowngradedAt || user?.planSince || ["pro", "premium"].includes(user?.plan));
const trialEligible = (user) => trialDays() > 0 && !!user && !everPaid(user);

// Credits granted by Stripe leave a trail like an admin adjustment does; the guard
// fields on the user (trial stamp, invoice ids) are what stop a second grant.
const auditGrant = (action, userId, credits, ref) =>
  MaintenanceAudit.create({
    action,
    actor: "stripe",
    reason: ref,
    target: { userId: String(userId), credits },
    at: new Date(),
  }).catch((e) => console.error("[BILLING] audit write failed:", e.message));

async function reconcile(userId) {
  try {
    await require("../helper/planLimits").reconcileStudentCap(userId);
  } catch (e) {
    console.error("[BILLING] reconcileStudentCap failed:", e.message);
  }
}

/*
 * The teacher's Stripe customer if one already exists, or null. Never makes one:
 * since 2026-10-27 (owner) a customer exists only once a card was added, and the
 * plan's Checkout creates it at that moment itself.
 */
async function existingCustomer(user) {
  if (!user.stripeCustomerId) return null;
  try {
    const customer = await stripeClient().customers.retrieve(user.stripeCustomerId);
    return customer && !customer.deleted ? customer : null;
  } catch (error) {
    if (error?.code === "resource_missing") return null;
    throw error;
  }
}

/*
 * The card pages this teacher opened before. One already completed (its webhook
 * not here yet) is their plan, and is returned; one still open is closed, so a
 * page left in another tab can never start a second plan. Read from the session
 * ids noted on the teacher, because a teacher without a customer has nothing
 * else to look them up by. A Stripe hiccup skips the page rather than block.
 */
async function settleEarlierCheckouts(user) {
  for (const id of [...(user.stripeCheckoutSessions || [])].reverse()) {
    try {
      const session = await stripeClient().checkout.sessions.retrieve(id);
      if (session.status === "complete" && session.mode === "subscription" && session.subscription) {
        const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        const subscription = await stripeClient().subscriptions.retrieve(subId);
        if (LIVE_STATUSES.has(subscription.status)) return subscription;
      } else if (session.status === "open") {
        await stripeClient().checkout.sessions.expire(id);
      }
    } catch (error) {
      console.warn("[stripe] earlier checkout check failed:", error.message);
    }
  }
  return null;
}

// For an add-on: the subscriber already has a customer; one is made only if it
// was deleted at Stripe since.
async function customerFor(user) {
  const stripe = stripeClient();
  const found = await existingCustomer(user);
  if (found) return found;
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name || undefined,
    metadata: { examopia_user_id: String(user._id) },
  });
  await User.updateOne({ _id: user._id }, { $set: { stripeCustomerId: customer.id } });
  return customer;
}

async function userFor(subscription, fields) {
  const metadataUserId = subscription?.metadata?.examopia_user_id;
  const customerId = customerIdOf(subscription);
  const query = mongoose.isValidObjectId(metadataUserId)
    ? { _id: metadataUserId }
    : customerId
      ? { stripeCustomerId: customerId }
      : null;
  return query ? User.findOne(query).select(fields) : null;
}

/*
 * ── Add-ons ────────────────────────────────────────────────────────────────
 * What the teacher's live add-on subscriptions add up to: monthly credits on top
 * of the plan's, and storage. Read from Stripe each time, so the answer is the
 * one that is true now (an add-on cancelled at period end is gone at renewal).
 */
async function addonState(customerId) {
  const empty = { credits: 0, gb: 0, until: null, list: [] };
  if (!customerId) return empty;
  const subs = await stripeClient().subscriptions.list({ customer: customerId, status: "all", limit: 100 });
  const now = Date.now();
  const state = { ...empty, list: [] };
  for (const sub of subs.data || []) {
    if (!isAddon(sub) || !LIVE_STATUSES.has(sub.status)) continue;
    const addon = ADDONS[sub.metadata?.addon_key];
    const end = periodEnd(sub);
    if (!addon || (end && end.getTime() + GRACE_MS < now)) continue;
    const quantity = (sub.items?.data || []).reduce((n, item) => n + (Number(item.quantity) || 1), 0) || 1;
    state.credits += addon.credits * quantity;
    state.gb += addon.gb * quantity;
    if (end && (!state.until || end > state.until)) state.until = end;
    state.list.push({ key: addon.key, subscriptionId: sub.id, status: sub.status, quantity, cancelAt: cancelDate(sub), periodEnd: end });
  }
  return state;
}

// The customer's live plan subscription as Stripe sees it (add-ons aside). A
// failed lookup answers "none": the database check before it still stands, and
// a Stripe hiccup must not block a teacher from paying.
async function liveMainSubscription(customerId) {
  try {
    const subs = await stripeClient().subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    return (subs.data || []).find((sub) => !isAddon(sub) && LIVE_STATUSES.has(sub.status)) || null;
  } catch (error) {
    console.warn("[stripe] subscription lookup failed:", error.message);
    return null;
  }
}

// A Checkout page left open in another tab could still start a second plan, so
// a new one closes the old ones first.
async function expireOpenCheckouts(customerId) {
  try {
    const open = await stripeClient().checkout.sessions.list({ customer: customerId, status: "open", limit: 20 });
    for (const session of open.data || []) {
      if (session.mode !== "subscription") continue;
      await stripeClient().checkout.sessions.expire(session.id).catch((error) => console.warn("[stripe] expire checkout failed:", error.message));
    }
  } catch (error) {
    console.warn("[stripe] open checkout lookup failed:", error.message);
  }
}

async function saveAddonState(userId, state) {
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        addonCreditsMonthly: state.credits,
        cardStorageGb: state.gb,
        cardStorageUntil: state.until ? new Date(state.until.getTime() + GRACE_MS) : null,
        stripeAddons: state.list,
      },
    }
  );
  return state;
}

/*
 * Add-ons live and die with the plan: when the plan is set to end, they are set to
 * end on the same moment; when it has ended, they end within minutes (no prorated
 * credit — the month was already used). A plan cancellation that is withdrawn takes
 * the add-ons' end date away again. Uses cancel_at, which the restricted key may
 * set on its own (an outright cancel needs a human approval in Stripe).
 */
async function alignAddons(customerId, main) {
  if (!customerId) return;
  const subs = await stripeClient().subscriptions.list({ customer: customerId, status: "all", limit: 100 });
  const addons = (subs.data || []).filter((s) => isAddon(s) && LIVE_STATUSES.has(s.status));
  if (!addons.length) return;
  const nowS = Math.floor(Date.now() / 1000);
  const mainEnds = ENDED_STATUSES.has(main.status)
    ? nowS + 120
    : Number(main.cancel_at) || (main.cancel_at_period_end ? Math.floor((periodEnd(main)?.getTime() || 0) / 1000) : 0);
  for (const sub of addons) {
    try {
      if (mainEnds) {
        if (Number(sub.cancel_at) && Number(sub.cancel_at) <= mainEnds) continue;
        await stripeClient().subscriptions.update(sub.id, {
          cancel_at: mainEnds,
          proration_behavior: "none",
          metadata: { cancel_with_main: "1" },
        });
      } else if (Number(sub.cancel_at) && sub.metadata?.cancel_with_main === "1") {
        await stripeClient().subscriptions.update(sub.id, { cancel_at: "", metadata: { cancel_with_main: "" } });
      }
    } catch (e) {
      console.error("[BILLING] add-on align failed:", sub.id, e.message);
    }
  }
}

async function grantTrialCredits(userId, subscriptionId, trialEnd) {
  const amount = trialCredits();
  // The trial's credits replace whatever was there: credits never roll over.
  const result = await User.updateOne(
    { _id: userId, stripeTrialUsedAt: null },
    { $set: { stripeTrialUsedAt: new Date(), aiCredits: amount, aiCreditsResetAt: trialEnd || null } }
  );
  if (result.modifiedCount && amount > 0) await auditGrant("stripe_trial_credits", userId, amount, `trial ${subscriptionId}`);
}

/*
 * Does this invoice pay for a month of the plan? Read from its lines, because the
 * billing reason alone misleads: ending a trial early bills a full month as
 * "subscription_update", the same reason an upgrade's proration carries. A month
 * is a full-period (non-proration) subscription line with an amount, so the
 * trial's 0 ₼ line is not one and a 100% coupon month still is.
 */
function paysForAMonth(invoice) {
  const lines = invoice?.lines?.data;
  if (!Array.isArray(lines) || !lines.length) return MONTH_INVOICES.has(invoice?.billing_reason) && Number(invoice?.subtotal) > 0;
  return lines.some((line) => {
    const item = line?.parent?.subscription_item_details; // API 2025-03-31+
    const fromSubscription = item ? true : line?.type === "subscription";
    const proration = item ? item.proration : line?.proration;
    return fromSubscription && !proration && Number(line?.amount) > 0;
  });
}

/*
 * A paid month of the plan: the balance is RESET to the month's allowance (plan
 * credits + the live add-ons' credits) — unused credits from the month before do
 * not carry over. It also starts the 7-day refund window, so its date and credits
 * are remembered.
 */
async function startPaidMonth(userId, invoice, plan, subscription) {
  if (!paysForAMonth(invoice) || !invoice.id) return;
  const addons = await saveAddonState(userId, await addonState(customerIdOf(subscription)));
  const amount = monthlyCredits(plan) + addons.credits;
  const paidAt = toDate(invoice.status_transitions?.paid_at) || new Date();
  // A year paid at once still brings its credits a month at a time: the next ones
  // are due a month from the period's start (jobs/adminPlanCredits.js), not in a year.
  const nextReset = intervalOf(subscription) === "year" ? addMonths(periodStart(subscription) || paidAt, 1) : periodEnd(subscription);
  const result = await User.updateOne(
    { _id: userId, stripeLastCreditedInvoiceId: { $ne: invoice.id } },
    {
      $set: {
        aiCredits: amount,
        aiCreditsResetAt: nextReset,
        stripeLastCreditedInvoiceId: invoice.id,
        stripeLastPaidAt: paidAt,
        stripeLastCreditedAmount: amount,
      },
    }
  );
  if (result.modifiedCount) await auditGrant("stripe_invoice_credits", userId, amount, `invoice ${invoice.id} (reset)`);
}

// Pro → Premium mid-month: the teacher paid the prorated difference, so they get the
// same share of the extra monthly credits now; the full amount comes at renewal.
// A yearly plan's credits run a month at a time, so its share is of this month.
async function grantUpgradeCredits(userId, subscription, from, to, { creditsResetAt = null } = {}) {
  const extra = monthlyCredits(to) - monthlyCredits(from);
  const item = subscription?.items?.data?.[0];
  const monthly = intervalOf(subscription) === "year" && creditsResetAt;
  const start = monthly ? Math.floor(addMonths(creditsResetAt, -1).getTime() / 1000) : Number(item?.current_period_start);
  const end = monthly ? Math.floor(new Date(creditsResetAt).getTime() / 1000) : Number(item?.current_period_end);
  if (!(extra > 0) || !(end > start)) return;
  const left = Math.min(1, Math.max(0, (end - Date.now() / 1000) / (end - start)));
  const amount = Math.round(extra * left);
  if (!amount) return;
  const key = `${subscription.id}:${to}:${end}`;
  const result = await User.updateOne(
    { _id: userId, stripeUpgradeCreditKey: { $ne: key } },
    { $set: { stripeUpgradeCreditKey: key }, $inc: { aiCredits: amount } }
  );
  if (result.modifiedCount) await auditGrant("stripe_upgrade_credits", userId, amount, `upgrade ${key}`);
}

/*
 * A credit add-on bought mid-month: its first invoice charges the days left until
 * the plan's renewal, so it brings that share of the pack now. From the next
 * renewal on, its credits are part of the month's reset.
 */
async function grantAddonFirstCredits(userId, invoice, subscription) {
  const addon = ADDONS[subscription?.metadata?.addon_key];
  if (!addon?.credits || !invoice?.id) return;
  const items = subscription.items?.data || [];
  const quantity = items.reduce((n, item) => n + (Number(item.quantity) || 1), 0) || 1;
  const full = items.reduce((n, item) => n + (Number(item.price?.unit_amount) || 0) * (Number(item.quantity) || 1), 0);
  const share = full > 0 ? Math.min(1, Math.max(0, Number(invoice.amount_paid) / full)) : 1;
  const amount = Math.round(addon.credits * quantity * share);
  if (!amount) return;
  const result = await User.updateOne(
    { _id: userId, stripeAddonCreditedInvoices: { $ne: invoice.id } },
    { $push: { stripeAddonCreditedInvoices: { $each: [invoice.id], $slice: -50 } }, $inc: { aiCredits: amount } }
  );
  if (result.modifiedCount) await auditGrant("stripe_addon_credits", userId, amount, `add-on ${addon.key} invoice ${invoice.id}`);
}

async function syncAddonSubscription(subscription) {
  const user = await userFor(subscription, "_id");
  if (!user) return null;
  await saveAddonState(user._id, await addonState(customerIdOf(subscription)));
  return { userId: user._id, plan: null, addon: true };
}

/*
 * The card a subscription is charged to, as the admin's billing panel shows it,
 * or null when it is the one already stored (or there is none yet). Brand, last
 * four, expiry, country, debit/credit, wallet: nothing that could charge it.
 */
async function cardFor(subscription, stored) {
  const stripe = stripeClient();
  let ref = subscription?.default_payment_method;
  if (!ref) {
    const customerId = customerIdOf(subscription);
    const customer = customerId ? await stripe.customers.retrieve(customerId) : null;
    ref = customer?.invoice_settings?.default_payment_method || null;
  }
  const id = typeof ref === "string" ? ref : ref?.id;
  if (!id || id === stored?.id) return null;
  const method = typeof ref === "object" && ref?.card ? ref : await stripe.paymentMethods.retrieve(id);
  const c = method?.card || {};
  return {
    id,
    brand: c.brand || method?.type || null,
    last4: c.last4 || null,
    expMonth: c.exp_month || null,
    expYear: c.exp_year || null,
    country: c.country || null,
    funding: c.funding || null,
    wallet: c.wallet?.type || null,
    addedAt: toDate(method?.created) || new Date(),
    // Stripe's id for the card itself (the same on every account it is added
    // to): how a trial already had with this card is recognised. Never shown.
    fingerprint: c.fingerprint || null,
  };
}

/*
 * Writes a Stripe subscription onto its teacher. Returns { userId, plan } where
 * plan is the paid plan the subscription grants right now (null when it grants none).
 */
async function syncSubscription(subscription) {
  if (isAddon(subscription)) return syncAddonSubscription(subscription);
  const priceId = priceFromSubscription(subscription);
  const plan = planForPrice(priceId);
  const customerId = customerIdOf(subscription);
  const user = await userFor(
    subscription,
    "name +stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus +stripeTrialUsedAt +stripeAddons +stripeCard plan planSource planSince planExpiresAt aiCreditsResetAt"
  );
  if (!user) return null;

  const status = String(subscription?.status || "");
  // A late event about an older subscription must not overwrite the live one.
  if (
    user.stripeSubscriptionId &&
    user.stripeSubscriptionId !== subscription.id &&
    LIVE_STATUSES.has(user.stripeSubscriptionStatus) &&
    !LIVE_STATUSES.has(status)
  ) {
    return { userId: user._id, plan: null };
  }

  const expiry = periodEnd(subscription);
  const cancelAt = cancelDate(subscription);
  const update = {
    stripeCustomerId: customerId || user.stripeCustomerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    stripeInterval: intervalOf(subscription),
    stripeSubscriptionStatus: status,
    stripeCurrentPeriodEnd: expiry,
    stripeCancelAtPeriodEnd: !!cancelAt,
    stripeCancelAt: cancelAt,
    stripeTrialEnd: status === "trialing" ? toDate(subscription.trial_end) : null,
  };
  const grants = plan && LIVE_STATUSES.has(status) ? plan : null;
  if (grants) {
    const until = cancelAt && expiry && cancelAt < expiry ? cancelAt : expiry;
    update.plan = grants;
    update.planSource = "stripe";
    update.planSince = user.plan === grants && user.planSince ? user.planSince : new Date();
    // A failed charge is not a paid month (owner, 2026-10-27): the plan stops where
    // the unpaid period starts, and opens again the moment Stripe takes the payment.
    update.planExpiresAt =
      status === "past_due"
        ? periodStart(subscription) || new Date()
        : until
          ? new Date(until.getTime() + GRACE_MS)
          : null;
    update.planDowngradedAt = null;
  } else if (ENDED_STATUSES.has(status) && user.planSource === "stripe") {
    // Only a plan Stripe granted is taken away; a plan the admin set by hand stays.
    update.plan = "free";
    update.planExpiresAt = null;
    if (user.plan !== "free") update.planDowngradedAt = new Date();
  }
  if (LIVE_STATUSES.has(status)) {
    // A card that cannot be read never holds up the plan itself.
    const card = await cardFor(subscription, user.stripeCard).catch((error) => {
      console.warn("[stripe] card lookup failed:", error.message);
      return null;
    });
    if (card) update.stripeCard = card;
  }
  /*
   * One trial per card, not only per account (owner, 2026-10-27: "make sure it
   * is a charge"): a trial starting on a card that another account already used
   * for a subscription ends at once, so Stripe charges the first month now, and
   * no trial credits are given. A failed charge then stops the plan like any
   * other. Thrown on a Stripe error, so the webhook is retried, never skipped.
   */
  let cardUsedBefore = false;
  if (status === "trialing" && !user.stripeTrialUsedAt) {
    const fingerprint = (update.stripeCard || user.stripeCard)?.fingerprint;
    if (fingerprint && (await User.exists({ _id: { $ne: user._id }, "stripeCard.fingerprint": fingerprint }))) {
      await stripeClient().subscriptions.update(subscription.id, { trial_end: "now", proration_behavior: "none" });
      cardUsedBefore = true;
      update.stripeTrialUsedAt = new Date();
      update.stripeTrialCardReused = true;
      update.stripeTrialEnd = null;
      console.warn("[stripe] trial refused: card already used on another account; charging now:", String(user._id));
    }
  }
  await User.updateOne({ _id: user._id }, { $set: update });
  // A customer Checkout made when the card went in: give it the teacher's name and
  // id, as the ones made here used to carry (Stripe's lists, and userFor).
  if (customerId && customerId !== user.stripeCustomerId) {
    await stripeClient()
      .customers.update(customerId, { name: user.name || undefined, metadata: { examopia_user_id: String(user._id) } })
      .catch((error) => console.warn("[stripe] customer label failed:", error.message));
  }

  if (status === "trialing" && !user.stripeTrialUsedAt && !cardUsedBefore) await grantTrialCredits(user._id, subscription.id, toDate(subscription.trial_end));
  const upgraded =
    grants && status === "active" && user.planSource === "stripe" && user.stripeSubscriptionId === subscription.id &&
    user.plan !== "free" && PLAN_RANK[grants] > (PLAN_RANK[user.plan] || 0);
  if (upgraded) await grantUpgradeCredits(user._id, subscription, user.plan, grants, { creditsResetAt: user.aiCreditsResetAt });
  // A plan that opens again after a failed charge brings back the students the
  // lapse moved to the waitlist, as an upgrade does.
  const reopened = grants && !hasPaidPlanNow(user) && hasPaidPlanNow({ plan: grants, planExpiresAt: update.planExpiresAt });
  if ((update.plan && update.plan !== user.plan) || reopened) await reconcile(user._id);
  // Add-ons follow the plan (end with it, un-end with it).
  if ((user.stripeAddons || []).length) {
    await alignAddons(customerId, subscription);
    await saveAddonState(user._id, await addonState(customerId));
  }
  return { userId: user._id, plan: grants };
}

async function markRiskEvent(object, kind) {
  let customerId = typeof object?.customer === "string" ? object.customer : null;
  if (!customerId && object?.charge) {
    try {
      const charge = await stripeClient().charges.retrieve(object.charge);
      customerId = typeof charge?.customer === "string" ? charge.customer : null;
    } catch { /* keep the event recorded even if the charge was deleted */ }
  }
  if (!customerId) return;
  await User.updateOne(
    { stripeCustomerId: customerId },
    { $set: { stripeRiskStatus: kind, stripeLastRiskEventAt: new Date() } }
  );
}

/*
 * A full refund of the last paid month takes back the credits that month brought
 * (never below zero, once per invoice). The plan itself ends through the
 * subscription: refund from Stripe's "Cancel subscription → refund last payment".
 */
async function takeBackRefundedCredits(charge) {
  if (!charge?.refunded || Number(charge.amount_refunded) < Number(charge.amount)) return;
  const customerId = customerIdOf(charge);
  const paymentIntent = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!customerId || !paymentIntent) return;
  const payments = await stripeClient().invoicePayments.list({ payment: { type: "payment_intent", payment_intent: paymentIntent }, limit: 1 });
  const ref = payments?.data?.[0]?.invoice;
  const invoiceId = typeof ref === "string" ? ref : ref?.id;
  if (!invoiceId) return;
  const user = await User.findOne({ stripeCustomerId: customerId }).select("+stripeLastCreditedInvoiceId +stripeLastCreditedAmount");
  if (!user || user.stripeLastCreditedInvoiceId !== invoiceId) return;
  const amount = Number(user.stripeLastCreditedAmount) || 0;
  const result = await User.updateOne({ _id: user._id, stripeRefundedInvoiceId: { $ne: invoiceId } }, [
    {
      $set: {
        aiCredits: { $max: [0, { $subtract: [{ $ifNull: ["$aiCredits", 0] }, amount] }] },
        stripeRefundedInvoiceId: invoiceId,
      },
    },
  ]);
  if (result.modifiedCount && amount) await auditGrant("stripe_refund_credits", user._id, -amount, `refund ${invoiceId}`);
}

async function markEvent(event) {
  try {
    const row = await StripeEvent.create({ eventId: event.id, type: event.type, status: "processing" });
    return { row, duplicate: false };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const row = await StripeEvent.findOne({ eventId: event.id });
    if (row?.status === "processed") return { row, duplicate: true };
    await StripeEvent.updateOne({ eventId: event.id }, { $set: { status: "processing", error: "" } });
    return { row, duplicate: false };
  }
}

async function syncInvoice(invoice, { paid }) {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return;
  const subscription = await stripeClient().subscriptions.retrieve(subscriptionId);
  const synced = await syncSubscription(subscription);
  if (!paid || !synced) return;
  if (synced.addon) {
    if (invoice.billing_reason === "subscription_create") await grantAddonFirstCredits(synced.userId, invoice, subscription);
  } else if (synced.plan) {
    await startPaidMonth(synced.userId, invoice, synced.plan, subscription);
  }
}

/*
 * Stripe does not promise to deliver events in order, so a subscription event is
 * applied as the subscription stands NOW: an "active" that arrives after the
 * cancellation can never open the plan again. A subscription Stripe no longer
 * has falls back to the event's own copy.
 */
async function currentSubscription(snapshot) {
  try {
    return await stripeClient().subscriptions.retrieve(snapshot.id);
  } catch (error) {
    if (error?.code === "resource_missing") return snapshot;
    throw error;
  }
}

/*
 * A card the teacher added becomes the card of EVERYTHING they pay for: each live
 * subscription (the plan and every add-on, since each subscription Checkout made
 * keeps its own card and is charged to that one before the customer's default)
 * and the customer's default.
 */
async function useCard(customerId, card) {
  const stripe = stripeClient();
  const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
  for (const sub of subs.data || []) {
    if (!LIVE_STATUSES.has(sub.status)) continue;
    const current = typeof sub.default_payment_method === "string" ? sub.default_payment_method : sub.default_payment_method?.id;
    if (current !== card) await stripe.subscriptions.update(sub.id, { default_payment_method: card });
  }
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: card } });
}

// The card a setup-mode Checkout saved, or null.
async function setupCard(session) {
  const intentRef = session.setup_intent;
  const intent = typeof intentRef === "string" ? await stripeClient().setupIntents.retrieve(intentRef) : intentRef;
  return typeof intent?.payment_method === "string" ? intent.payment_method : intent?.payment_method?.id || null;
}

/*
 * The card a teacher added to pay a failed charge («Ödənişi tamamla»): it becomes
 * the subscription's card (so next month is charged to it, not to the card that
 * failed) and the unpaid invoice is charged to it now. Runs on the teacher's way
 * back and again from Stripe's webhook, whichever comes first; an invoice can be
 * paid only once, so the second run finds it paid. Returns { paid, ... }.
 */
async function settleDue(sessionOrId) {
  const stripe = stripeClient();
  const session = typeof sessionOrId === "string" ? await stripe.checkout.sessions.retrieve(sessionOrId) : sessionOrId;
  const meta = session?.metadata || {};
  if (session?.mode !== "setup" || meta.examopia_kind !== "pay_due") return { paid: false, reason: "not_a_due_payment" };
  if (session.status !== "complete") return { paid: false, reason: "not_completed" };
  const card = await setupCard(session);
  if (!card) return { paid: false, reason: "no_card" };
  await useCard(customerIdOf(session), card);
  let invoice = await stripe.invoices.retrieve(meta.invoice);
  if (invoice.status === "open") {
    try {
      invoice = await stripe.invoices.pay(invoice.id, { payment_method: card, off_session: true });
    } catch (error) {
      invoice = await stripe.invoices.retrieve(meta.invoice);
      if (invoice.status !== "paid") {
        // The bank wants the teacher to confirm (3-D Secure), or this card was
        // declined too. The card is kept; Stripe's invoice page can finish it.
        return {
          paid: false,
          reason: error?.code === "invoice_payment_intent_requires_action" || error?.code === "authentication_required" ? "confirm" : "declined",
          decline: error?.decline_code || error?.code || null,
          url: invoice.hosted_invoice_url || null,
        };
      }
    }
  }
  if (invoice.status !== "paid") return { paid: false, reason: invoice.status };
  await syncInvoice(invoice, { paid: true });
  return { paid: true };
}

/*
 * «Kartı dəyiş»: the card the teacher added on Stripe's page is charged from the
 * next payment on, for the plan and every add-on; nothing is charged now. Runs on
 * the way back and from the webhook, whichever comes first (the same card twice
 * changes nothing). The subscription is read again so the admin panel and
 * «Planım» show the new card at once.
 */
async function settleCardChange(sessionOrId) {
  const stripe = stripeClient();
  const session = typeof sessionOrId === "string" ? await stripe.checkout.sessions.retrieve(sessionOrId) : sessionOrId;
  const meta = session?.metadata || {};
  if (session?.mode !== "setup" || meta.examopia_kind !== "card_update") return { changed: false, reason: "not_a_card_change" };
  if (session.status !== "complete") return { changed: false, reason: "not_completed" };
  const card = await setupCard(session);
  if (!card) return { changed: false, reason: "no_card" };
  await useCard(customerIdOf(session), card);
  if (meta.subscription) await syncSubscription(await stripe.subscriptions.retrieve(meta.subscription));
  return { changed: true };
}

async function handleStripeEvent(event) {
  const claim = await markEvent(event);
  if (claim.duplicate) return;
  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;
      if (session.mode === "subscription" && session.subscription) {
        const id = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        await syncSubscription(await stripeClient().subscriptions.retrieve(id));
      } else if (session.mode === "setup" && session.metadata?.examopia_kind === "pay_due") {
        await settleDue(session.id);
      } else if (session.mode === "setup" && session.metadata?.examopia_kind === "card_update") {
        await settleCardChange(session.id);
      }
    } else if (event.type === "checkout.session.async_payment_failed") {
      // The subscription lifecycle/invoice events remain authoritative. This
      // event is recorded for audit and deliberately does not grant access.
    } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await syncSubscription(await currentSubscription(event.data.object));
    } else if (event.type === "invoice.paid") {
      await syncInvoice(event.data.object, { paid: true });
    } else if (event.type === "invoice.payment_failed") {
      await syncInvoice(event.data.object, { paid: false });
    } else if (event.type === "charge.refunded") {
      await markRiskEvent(event.data.object, "refunded");
      await takeBackRefundedCredits(event.data.object);
    } else if (event.type === "charge.dispute.created") {
      await markRiskEvent(event.data.object, "dispute");
    } else if (event.type === "radar.early_fraud_warning.created") {
      await markRiskEvent(event.data.object, "early_fraud_warning");
    }
    await StripeEvent.updateOne({ eventId: event.id }, { $set: { status: "processed", processedAt: new Date(), error: "" } });
  } catch (error) {
    await StripeEvent.updateOne({ eventId: event.id }, { $set: { status: "failed", error: String(error?.message || error).slice(0, 1000) } }).catch(() => {});
    throw error;
  }
}

const createCheckout = asyncHandler(async (req, res) => {
  const targetPlan = String(req.body?.plan || "");
  if (!["pro", "premium"].includes(targetPlan)) {
    res.status(400);
    throw new Error("Yanlış paket");
  }
  if (!billingEnabledFor(req.user)) {
    res.status(403);
    throw new Error("Kartla ödəniş hələ aktiv deyil");
  }
  // By the month, or by the year at 30% off (2026-10-31).
  const interval = req.body?.interval === "year" ? "year" : "month";
  const price = priceForPlan(targetPlan, interval);
  if (!price) {
    res.status(503);
    throw new Error(interval === "year" ? "İllik ödəniş hələ hazır deyil" : "Stripe qiyməti hələ konfiqurasiya edilməyib");
  }
  const user = await User.findById(req.user._id).select(
    "name email plan planSince planExpiresAt planDowngradedAt +stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus +stripeTrialUsedAt +stripeCheckoutSessions"
  );
  if (!user) { res.status(404); throw new Error("İstifadəçi tapılmadı"); }
  if (user.stripeSubscriptionId && LIVE_STATUSES.has(user.stripeSubscriptionStatus)) {
    res.status(409);
    throw new Error("Artıq kartla abunəliyin var. Paketi «Abunəliyi idarə et» bölməsindən dəyiş.");
  }
  // No customer is made here: Checkout makes one only when the card goes in.
  // A teacher who paid before keeps theirs.
  const customer = await existingCustomer(user);
  // Our record can be a few seconds behind Stripe: a teacher back from Checkout
  // before the webhook landed still looks unsubscribed here. Ask Stripe (their
  // customer's plans, and the card pages they opened), so one teacher never ends
  // up with two plans (and two charges).
  const existing = (customer && (await liveMainSubscription(customer.id))) || (await settleEarlierCheckouts(user));
  if (existing) {
    await syncSubscription(existing).catch((error) => console.warn("[stripe] checkout pre-sync failed:", error.message));
    res.status(409);
    throw new Error("Abunəliyin artıq qeydə alınıb. Bir neçə saniyəyə paketin aktiv olacaq.");
  }
  if (customer) await expireOpenCheckouts(customer.id);
  const trial = trialEligible(user) ? trialDays() : 0;
  const suffix = Math.random().toString(36).slice(2, 10);
  const metadata = { examopia_user_id: String(user._id), target_plan: targetPlan, target_interval: interval };
  const session = await stripeClient().checkout.sessions.create({
    ...checkoutBranding(),
    mode: "subscription",
    ...(customer ? { customer: customer.id } : user.email ? { customer_email: user.email } : {}),
    line_items: [{ price, quantity: 1 }],
    client_reference_id: String(user._id),
    metadata,
    subscription_data: {
      metadata,
      ...(trial > 0
        ? { trial_period_days: trial, trial_settings: { end_behavior: { missing_payment_method: "cancel" } } }
        : {}),
    },
    ...(trial > 0
      ? { custom_text: { submit: { message: `İlk ${trial} gün pulsuzdur. Sınaq bitməmiş ləğv etsən, kartdan pul çıxılmayacaq. Sınaq hər karta bir dəfə verilir: bu kartla əvvəl Examopia-da abunəlik olubsa, ödəniş dərhal alınır.` } } }
      : {}),
    integration_identifier: `examopia_billing_v1_${suffix}`,
    success_url: `${frontendUrl()}/plan?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl()}/plan?checkout=cancelled`,
    allow_promotion_codes: true,
  });
  // Who reached the card page (even if they stop there), and the page itself, so
  // the next one can close it or find the plan it made (settleEarlierCheckouts).
  await User.updateOne(
    { _id: user._id },
    {
      $set: { stripeCheckoutOpenedAt: new Date(), stripeCheckoutPlan: targetPlan },
      $inc: { stripeCheckoutOpens: 1 },
      $push: { stripeCheckoutSessions: { $each: [session.id], $slice: -5 } },
    }
  ).catch((error) => console.warn("[stripe] checkout stamp failed:", error.message));
  res.json({ url: session.url, sessionId: session.id, trialDays: trial, interval });
});

/*
 * A monthly add-on (credit pack or storage). It joins the plan's billing date:
 * the first payment covers only the days left until the plan renews, and from then
 * on it is charged together with the plan, on the same day. A plan paid by the
 * year renews once a year, so its add-ons join its monthly date instead (the day
 * its credits renew).
 */
// Who may add an add-on now, and on what terms: shared by the card page and the
// one-tap charge. Throws with the status set, as the handlers do.
async function addonRequest(req, res) {
  const key = String(req.body?.addon || "");
  const addon = ADDONS[key];
  if (!addon) { res.status(400); throw new Error("Yanlış əlavə"); }
  if (!billingEnabledFor(req.user)) { res.status(403); throw new Error("Kartla ödəniş hələ aktiv deyil"); }
  const user = await User.findById(req.user._id).select(
    "name email +stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus +stripeCurrentPeriodEnd +stripeCancelAt +stripeInterval"
  );
  if (!user) { res.status(404); throw new Error("İstifadəçi tapılmadı"); }
  const status = user.stripeSubscriptionStatus;
  if (status === "trialing") {
    res.status(409);
    throw new Error("Əlavələri pulsuz sınaq bitəndən sonra qoşa bilərsən.");
  }
  if (status === "past_due") {
    res.status(409);
    throw new Error("Kartından son ödəniş alınmayıb. Əvvəlcə «Planım» səhifəsində ödənişi tamamla.");
  }
  if (!user.stripeSubscriptionId || status !== "active") {
    res.status(409);
    throw new Error("Əlavələr kartla abunəliyə qoşulur: əvvəlcə Pro və ya Premium paketinə abunə ol.");
  }
  if (user.stripeCancelAt) {
    res.status(409);
    throw new Error("Abunəliyin ləğv edilib. Əlavə qoşmaq üçün əvvəlcə «Abunəliyi idarə et» bölməsində abunəliyi bərpa et.");
  }
  const periodEndAt = user.stripeCurrentPeriodEnd ? new Date(user.stripeCurrentPeriodEnd) : null;
  const anchor = periodEndAt && user.stripeInterval === "year" ? nextMonthlyBefore(periodEndAt, new Date()) : periodEndAt;
  const renewal = anchor ? Math.floor(anchor.getTime() / 1000) : 0;
  if (!renewal || renewal < Math.floor(Date.now() / 1000) + 3600) {
    res.status(409);
    throw new Error("Bu gün abunəliyin yenilənmə günüdür. Bir neçə saatdan sonra yenidən cəhd et.");
  }
  const price = (await addonPrices())[key];
  if (!price) { res.status(503); throw new Error("Bu əlavənin qiyməti hələ hazır deyil"); }
  const metadata = { examopia_user_id: String(user._id), examopia_kind: "addon", addon_key: key };
  return { key, addon, user, anchor, renewal, price, metadata };
}

const createAddonCheckout = asyncHandler(async (req, res) => {
  const { user, renewal, price, metadata } = await addonRequest(req, res);
  const customer = await customerFor(user);
  const session = await stripeClient().checkout.sessions.create({
    ...checkoutBranding(),
    mode: "subscription",
    customer: customer.id,
    line_items: [{ price, quantity: 1 }],
    client_reference_id: String(user._id),
    metadata,
    subscription_data: { metadata, billing_cycle_anchor: renewal, proration_behavior: "create_prorations" },
    integration_identifier: `examopia_addon_v1_${Math.random().toString(36).slice(2, 10)}`,
    success_url: `${frontendUrl()}/plan?addon=success`,
    cancel_url: `${frontendUrl()}/plan?checkout=cancelled`,
  });
  res.json({ url: session.url, sessionId: session.id });
});

/*
 * One tap for an add-on (owner, 2026-11-03: "they need to put card details all
 * the time"). The plan's own card is charged, so no card page: the quote says
 * what today costs (the days until the plan's date) and on which card, and the
 * charge makes the same add-on subscription the card page would, paid at once.
 * A card the bank wants confirmed (3-D Secure) or declines is not charged: the
 * answer says so (fallback "checkout") and the teacher pays on the card page.
 */
async function planCard(user) {
  const stripe = stripeClient();
  let ref = null;
  if (user.stripeSubscriptionId) {
    const plan = await stripe.subscriptions.retrieve(user.stripeSubscriptionId).catch(() => null);
    ref = plan?.default_payment_method || null;
  }
  if (!ref && user.stripeCustomerId) {
    const customer = await stripe.customers.retrieve(user.stripeCustomerId).catch(() => null);
    ref = customer?.invoice_settings?.default_payment_method || null;
  }
  const id = typeof ref === "string" ? ref : ref?.id;
  if (!id) return null;
  const method = typeof ref === "object" && ref?.card ? ref : await stripe.paymentMethods.retrieve(id).catch(() => null);
  const c = method?.card || {};
  // A card past its month cannot be charged: the card page asks for another.
  if (c.exp_year && c.exp_month && new Date(c.exp_year, c.exp_month, 1) <= new Date()) return null;
  return { id, brand: c.brand || method?.type || null, last4: c.last4 || null, expMonth: c.exp_month || null, expYear: c.exp_year || null };
}

const publicCard = (card) => (card ? { brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear } : null);

const quoteAddon = asyncHandler(async (req, res) => {
  const { key, addon, user, anchor, renewal, price } = await addonRequest(req, res);
  const card = await planCard(user);
  let amount = null;
  let currency = "azn";
  if (user.stripeCustomerId) {
    try {
      const preview = await stripeClient().invoices.createPreview({
        customer: user.stripeCustomerId,
        // API 2026: the preview takes the anchor as { type: "timestamp", timestamp }.
        subscription_details: { items: [{ price, quantity: 1 }], billing_cycle_anchor: { type: "timestamp", timestamp: renewal }, proration_behavior: "create_prorations" },
      });
      amount = Number(preview.amount_due) / 100;
      currency = preview.currency || currency;
    } catch (error) {
      console.warn("[stripe] add-on preview failed:", error.message);
    }
  }
  res.json({ addon: key, card: publicCard(card), oneTap: !!card, amountToday: amount, currency, monthly: addon.priceAzn, nextDate: anchor });
});

const chargeAddon = asyncHandler(async (req, res) => {
  const { key, addon, user, renewal, price, metadata } = await addonRequest(req, res);
  const card = await planCard(user);
  if (!card || !user.stripeCustomerId) {
    res.status(409);
    return res.json({ message: "Kart tapılmadı: ödəniş səhifəsində kartını daxil et.", fallback: "checkout" });
  }
  // The same tap sent twice charges once.
  const requestId = String(req.body?.requestId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  const idempotencyKey = `addon_${user._id}_${key}_${requestId || Math.floor(Date.now() / 60000)}`;
  let subscription;
  try {
    subscription = await stripeClient().subscriptions.create(
      {
        customer: user.stripeCustomerId,
        items: [{ price, quantity: 1 }],
        default_payment_method: card.id,
        billing_cycle_anchor: renewal,
        proration_behavior: "create_prorations",
        payment_behavior: "error_if_incomplete",
        metadata,
        expand: ["latest_invoice"],
      },
      { idempotencyKey }
    );
  } catch (error) {
    const declined = error?.type === "StripeCardError" || error?.statusCode === 402 || /requires_action|authentication_required|card_declined/.test(String(error?.code || ""));
    console.warn("[stripe] one-tap add-on not charged:", error?.code || error?.type || error?.message, String(user._id));
    // Anything else Stripe refuses (a permission, an API change) is not the
    // teacher's problem: the card page still works.
    if (!declined) {
      res.status(503);
      return res.json({ message: "Ödəniş səhifəsi açılır…", fallback: "checkout" });
    }
    res.status(402);
    return res.json({
      message: /authentication|requires_action/.test(String(error?.code || error?.message || ""))
        ? "Bankın ödənişi təsdiqləməyini istəyir: ödəniş səhifəsi açılır."
        : "Kartdan ödəniş alınmadı: başqa kartla ödəniş səhifəsində cəhd et.",
      fallback: "checkout",
    });
  }
  // Grant at once; the webhook arriving after finds it done (both are idempotent).
  const synced = await syncAddonSubscription(subscription);
  const invoice = subscription.latest_invoice && typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null;
  const before = await User.findById(user._id).select("aiCredits").lean();
  if (synced && invoice?.status === "paid") await grantAddonFirstCredits(synced.userId, invoice, subscription);
  const after = await User.findById(user._id).select("aiCredits addonCreditsMonthly cardStorageGb").lean();
  res.json({
    ok: true,
    addon: key,
    paid: invoice ? Number(invoice.amount_paid) / 100 : null,
    creditsAdded: Math.max(0, (after?.aiCredits || 0) - (before?.aiCredits || 0)),
    aiCredits: after?.aiCredits ?? null,
    storageGb: after?.cardStorageGb ?? null,
    card: publicCard(card),
    gb: addon.gb,
  });
});

// Not behind the billing gate: whoever subscribed must always be able to cancel.
const createPortal = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("+stripeCustomerId");
  if (!user?.stripeCustomerId) { res.status(400); throw new Error("Stripe müştəri hesabı hələ yoxdur"); }
  const configuration = portalConfiguration();
  const portal = await stripeClient().billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${frontendUrl()}/plan`,
    ...(configuration ? { configuration } : {}),
  });
  res.json({ url: portal.url });
});

/*
 * A charge that failed: the teacher adds a card on Stripe's page (Checkout in
 * setup mode: the card is saved and checked, 3-D Secure included), and on the way
 * back settleDue charges the unpaid invoice to it and keeps it for the months
 * after. Not Stripe's invoice page: paying there leaves the card unsaved unless
 * the teacher ticks a box, and next month fails on the old card again (seen on a
 * test clock). With nothing to pay (or Stripe not answering), the subscription page.
 */
const payDue = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("+stripeCustomerId +stripeSubscriptionId");
  if (!user?.stripeCustomerId) { res.status(400); throw new Error("Stripe müştəri hesabı hələ yoxdur"); }
  const stripe = stripeClient();
  let due = null;
  if (user.stripeSubscriptionId) {
    try {
      const open = await stripe.invoices.list({ customer: user.stripeCustomerId, subscription: user.stripeSubscriptionId, status: "open", limit: 10 });
      due = (open.data || []).filter((invoice) => Number(invoice.amount_remaining) > 0).sort((a, b) => b.created - a.created)[0] || null;
    } catch (error) {
      console.warn("[stripe] open invoice lookup failed:", error.message);
    }
  }
  if (due) {
    const amount = Number(due.amount_remaining) / 100;
    const metadata = { examopia_user_id: String(user._id), examopia_kind: "pay_due", invoice: due.id, subscription: user.stripeSubscriptionId };
    const session = await stripe.checkout.sessions.create({
      ...checkoutBranding(),
      mode: "setup",
      customer: user.stripeCustomerId,
      currency: due.currency,
      client_reference_id: String(user._id),
      metadata,
      setup_intent_data: { metadata },
      custom_text: { submit: { message: `Kart yadda saxlanılır və ${amount} ₼ dərhal bu kartdan çıxılır. Sonrakı aylar da bu kartdan ödənilir.` } },
      success_url: `${frontendUrl()}/plan?due=paid&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl()}/plan?due=cancelled`,
    });
    return res.json({ url: session.url, kind: "card", amount, currency: due.currency });
  }
  const configuration = portalConfiguration();
  const portal = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${frontendUrl()}/plan`,
    ...(configuration ? { configuration } : {}),
  });
  res.json({ url: portal.url, kind: "portal" });
});

// Back from adding the card: charge the unpaid invoice to it now, so the plan is
// open by the time the page loads (the webhook does the same if they never return).
// A Checkout page this teacher opened (the session id they came back with), or a 404.
async function ownSession(req, res, notFound) {
  const sessionId = String(req.body?.sessionId || "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) { res.status(400); throw new Error("Yanlış sessiya"); }
  const user = await User.findById(req.user._id).select("+stripeCustomerId");
  const session = await stripeClient().checkout.sessions.retrieve(sessionId).catch(() => null);
  if (!session || !user?.stripeCustomerId || customerIdOf(session) !== user.stripeCustomerId || session.metadata?.examopia_user_id !== String(user._id)) {
    res.status(404);
    throw new Error(notFound);
  }
  return session;
}

const completeDue = asyncHandler(async (req, res) => {
  const session = await ownSession(req, res, "Ödəniş tapılmadı");
  res.json(await settleDue(session));
});

/*
 * «Kartı dəyiş» (owner, 2026-10-28): a different card for the months ahead, on
 * Stripe's page (Checkout in setup mode, 3-D Secure included; nothing charged
 * now). Not the billing portal's card section: that sets the customer's default,
 * while each subscription keeps the card it was started with and is charged to it.
 * A teacher whose last charge failed adds the card with «Ödənişi tamamla», which
 * pays the month as well.
 */
const changeCard = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("+stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus");
  const status = user?.stripeSubscriptionStatus;
  if (status === "past_due") {
    res.status(409);
    throw new Error("Son ödəniş kartından alınmayıb: yeni kartı «Ödənişi tamamla» ilə əlavə et, ödəniş də ondan çıxılır.");
  }
  if (!user?.stripeCustomerId || !user.stripeSubscriptionId || !LIVE_STATUSES.has(status)) {
    res.status(409);
    throw new Error("Kart abunəliyə qoşulur: əvvəlcə Pro və ya Premium paketinə abunə ol.");
  }
  const sub = await stripeClient().subscriptions.retrieve(user.stripeSubscriptionId);
  const metadata = { examopia_user_id: String(user._id), examopia_kind: "card_update", subscription: user.stripeSubscriptionId };
  const session = await stripeClient().checkout.sessions.create({
    ...checkoutBranding(),
    mode: "setup",
    customer: user.stripeCustomerId,
    currency: sub.currency || sub.items?.data?.[0]?.price?.currency || "azn",
    client_reference_id: String(user._id),
    metadata,
    setup_intent_data: { metadata },
    custom_text: { submit: { message: "Kart yadda saxlanılır: indi pul çıxılmır, növbəti ödənişlər bu kartdan çıxılır." } },
    success_url: `${frontendUrl()}/plan?card=changed&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl()}/plan?card=cancelled`,
  });
  res.json({ url: session.url });
});

// Back from adding the card: make it the card now (the webhook does the same if they never return).
const completeCardChange = asyncHandler(async (req, res) => {
  const session = await ownSession(req, res, "Kart tapılmadı");
  res.json(await settleCardChange(session));
});

/*
 * Admin («Paket idarəetməsi»): the teachers who added a card successfully, newest
 * first (owner, 2026-10-27: only them; who merely opened the card page is not
 * listed). On the trial, paying, owing a failed charge, cancelling or ended;
 * when the card went in, and the card as far as an admin may see it.
 */
const cardStage = (u) => {
  const status = u.stripeSubscriptionStatus;
  if (status === "trialing") return u.stripeCancelAt ? "trial_cancelled" : "trial";
  if (status === "active") return u.stripeCancelAt ? "cancelling" : "paying";
  if (status === "past_due") return "past_due";
  if (status && ENDED_STATUSES.has(status)) return "ended";
  return null; // no subscription, or one whose first payment never went through
};
const CARD_STAGES = ["trial", "trial_cancelled", "paying", "cancelling", "past_due", "ended"];

const adminCardTeachers = asyncHandler(async (req, res) => {
  const users = await User.find({ role: "teacher", stripeSubscriptionId: { $nin: [null, ""] } })
    .select(
      "name email phone createdAt plan planExpiresAt aiCredits +stripeSubscriptionId +stripeSubscriptionStatus +stripePriceId +stripeInterval +stripeCurrentPeriodEnd +stripeCancelAt +stripeTrialEnd +stripeTrialUsedAt +stripeLastPaidAt +stripeCard"
    )
    .limit(1000)
    .lean();
  const at = (d) => (d ? new Date(d).getTime() : 0);
  const rows = users
    .filter((u) => cardStage(u))
    .map((u) => {
      const stage = cardStage(u);
      const c = u.stripeCard;
      return {
        _id: u._id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        signedUpAt: u.createdAt,
        stage,
        // The price names the plan; when this server does not know that price (a
        // local or sandbox env with other price ids) the plan on the account does,
        // so the admin's monthly revenue never reads 0 ₼ for a paying teacher.
        plan: planForPrice(u.stripePriceId) || (u.plan === "pro" || u.plan === "premium" ? u.plan : null),
        interval: u.stripeInterval || planOfPrice(u.stripePriceId)?.interval || "month",
        trialStartedAt: u.stripeTrialUsedAt || null,
        trialEndsAt: stage === "trial" || stage === "trial_cancelled" ? u.stripeTrialEnd || u.stripeCurrentPeriodEnd || null : null,
        nextChargeAt: stage === "trial" || stage === "paying" || stage === "past_due" ? u.stripeCurrentPeriodEnd || null : null,
        endsAt: u.stripeCancelAt || null,
        lastPaidAt: u.stripeLastPaidAt || null,
        card: c ? { brand: c.brand, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear, country: c.country, funding: c.funding, wallet: c.wallet, addedAt: c.addedAt } : null,
        aiCredits: u.aiCredits || 0,
        // Sort key: the latest billing moment of this teacher.
        latest: Math.max(at(u.stripeTrialUsedAt), at(u.stripeLastPaidAt), at(c?.addedAt)),
      };
    })
    .sort((a, b) => b.latest - a.latest || at(b.signedUpAt) - at(a.signedUpAt));
  const counts = Object.fromEntries(CARD_STAGES.map((k) => [k, rows.filter((r) => r.stage === k).length]));
  for (const r of rows) delete r.latest;
  res.json({ rows, counts });
});

const billingStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "role plan planSince planExpiresAt planDowngradedAt starterUntil starterPending +stripeTrialCardReused aiCreditsLastSpentAt aiCreditsResetAt addonCreditsMonthly cardStorageGb +stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus +stripeCurrentPeriodEnd +stripeCancelAtPeriodEnd +stripeCancelAt +stripeTrialEnd +stripeTrialUsedAt +stripeLastPaidAt +stripeLastCreditedInvoiceId +stripeRefundedInvoiceId +stripeAddons +stripeCard +stripeInterval"
  );
  const enabled = billingEnabledFor(req.user);
  res.json({
    configured: enabled,
    pricesConfigured: { pro: !!priceForPlan("pro"), premium: !!priceForPlan("premium") },
    customer: !!user?.stripeCustomerId,
    plan: user?.plan || "free",
    expiresAt: user?.planExpiresAt || null,
    subscriptionStatus: user?.stripeSubscriptionStatus || null,
    // "month" or "year" (null without a card plan).
    interval: user?.stripeSubscriptionId ? user?.stripeInterval || "month" : null,
    currentPeriodEnd: user?.stripeCurrentPeriodEnd || null,
    cancelAtPeriodEnd: !!user?.stripeCancelAtPeriodEnd,
    cancelAt: user?.stripeCancelAt || null,
    trialEnd: user?.stripeTrialEnd || null,
    trialCardReused: !!user?.stripeTrialCardReused,
    trialEligible: enabled && trialEligible(user),
    trialDays: trialDays(),
    trialCredits: trialCredits(),
    refund: refundStatus(user),
    paywall: needsSubscription(user),
    starterUntil: user?.starterUntil || null,
    creditsResetAt: user?.aiCreditsResetAt || null,
    addons: (user?.stripeAddons || []).map((a) => ({ key: a.key, quantity: a.quantity, status: a.status, cancelAt: a.cancelAt, periodEnd: a.periodEnd })),
    addonCreditsMonthly: user?.addonCreditsMonthly || 0,
    cardStorageGb: user?.cardStorageGb || 0,
    // The card the months ahead are charged to, as the teacher may see it.
    card: user?.stripeCard?.last4
      ? { brand: user.stripeCard.brand || "", last4: user.stripeCard.last4, expMonth: user.stripeCard.expMonth || null, expYear: user.stripeCard.expYear || null }
      : null,
  });
});

const webhook = asyncHandler(async (req, res) => {
  const secret = required("STRIPE_WEBHOOK_SECRET");
  let event;
  try {
    event = stripeClient().webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  } catch {
    // A missing or forged signature is the caller's fault, not a server error.
    res.status(400);
    throw new Error("Invalid Stripe signature");
  }
  await handleStripeEvent(event);
  res.json({ received: true });
});

module.exports = { createCheckout, createAddonCheckout, quoteAddon, chargeAddon, createPortal, payDue, completeDue, changeCard, completeCardChange, adminCardTeachers, billingStatus, webhook, handleStripeEvent, syncSubscription };
