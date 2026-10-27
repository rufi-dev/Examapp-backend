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
  frontendUrl,
  portalConfiguration,
  trialDays,
  trialCredits,
  billingEnabledFor,
  ADDONS,
  addonPrices,
} = require("../config/stripe");

// Statuses that keep the paid plan; past_due keeps it while Stripe retries the card.
const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
// Statuses that end it; paused is a trial that ended with no way to pay.
const ENDED_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);
// The plan runs this long past the paid-up date, so a renewal webhook that arrives
// late never drops a paying teacher to Free in between.
const GRACE_MS = 2 * 24 * 60 * 60 * 1000;
// A failed renewal keeps the plan this long from the missed payment while Stripe
// retries the card, however the Dashboard's retry settings are set.
const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
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

const monthlyCredits = (plan) => planDef(plan).credits?.monthly || 0;

const hasPaidPlanNow = (user) =>
  ["pro", "premium"].includes(user?.plan) && (!user.planExpiresAt || new Date(user.planExpiresAt) > new Date());

/*
 * Who gets the 7-day trial: a teacher who has never paid. Anyone who had a plan
 * (by card, by transfer, or set by the admin — the stored plan stays "pro" or
 * "premium" after it lapses) or a card subscription before pays straight away.
 */
const everPaid = (user) =>
  !!(user?.stripeTrialUsedAt || user?.stripeSubscriptionId || user?.planDowngradedAt || ["pro", "premium"].includes(user?.plan));
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

async function customerFor(user) {
  const stripe = stripeClient();
  if (user.stripeCustomerId) {
    try {
      const customer = await stripe.customers.retrieve(user.stripeCustomerId);
      if (!customer.deleted) return customer;
    } catch (error) {
      if (error?.code !== "resource_missing") throw error;
    }
  }
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
  const result = await User.updateOne(
    { _id: userId, stripeLastCreditedInvoiceId: { $ne: invoice.id } },
    {
      $set: {
        aiCredits: amount,
        aiCreditsResetAt: periodEnd(subscription),
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
async function grantUpgradeCredits(userId, subscription, from, to) {
  const extra = monthlyCredits(to) - monthlyCredits(from);
  const item = subscription?.items?.data?.[0];
  const start = Number(item?.current_period_start);
  const end = Number(item?.current_period_end);
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
    "+stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus +stripeTrialUsedAt +stripeAddons plan planSource planSince planExpiresAt"
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
    stripeSubscriptionStatus: status,
    stripeCurrentPeriodEnd: expiry,
    stripeCancelAtPeriodEnd: !!cancelAt,
    stripeCancelAt: cancelAt,
    stripeTrialEnd: status === "trialing" ? toDate(subscription.trial_end) : null,
  };
  const grants = plan && LIVE_STATUSES.has(status) ? plan : null;
  if (grants) {
    const until = cancelAt && expiry && cancelAt < expiry ? cancelAt : expiry;
    const unpaidFrom = status === "past_due" ? periodStart(subscription) : null;
    update.plan = grants;
    update.planSource = "stripe";
    update.planSince = user.plan === grants && user.planSince ? user.planSince : new Date();
    update.planExpiresAt = unpaidFrom
      ? new Date(unpaidFrom.getTime() + PAST_DUE_GRACE_MS)
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
  await User.updateOne({ _id: user._id }, { $set: update });

  if (status === "trialing" && !user.stripeTrialUsedAt) await grantTrialCredits(user._id, subscription.id, toDate(subscription.trial_end));
  const upgraded =
    grants && status === "active" && user.planSource === "stripe" && user.stripeSubscriptionId === subscription.id &&
    user.plan !== "free" && PLAN_RANK[grants] > (PLAN_RANK[user.plan] || 0);
  if (upgraded) await grantUpgradeCredits(user._id, subscription, user.plan, grants);
  if (update.plan && update.plan !== user.plan) await reconcile(user._id);
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

async function handleStripeEvent(event) {
  const claim = await markEvent(event);
  if (claim.duplicate) return;
  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;
      if (session.mode === "subscription" && session.subscription) {
        const id = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        await syncSubscription(await stripeClient().subscriptions.retrieve(id));
      }
    } else if (event.type === "checkout.session.async_payment_failed") {
      // The subscription lifecycle/invoice events remain authoritative. This
      // event is recorded for audit and deliberately does not grant access.
    } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await syncSubscription(event.data.object);
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
  const price = priceForPlan(targetPlan);
  if (!price) {
    res.status(503);
    throw new Error("Stripe qiyməti hələ konfiqurasiya edilməyib");
  }
  const user = await User.findById(req.user._id).select(
    "name email plan planExpiresAt planDowngradedAt +stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus +stripeTrialUsedAt"
  );
  if (!user) { res.status(404); throw new Error("İstifadəçi tapılmadı"); }
  if (user.stripeSubscriptionId && LIVE_STATUSES.has(user.stripeSubscriptionStatus)) {
    res.status(409);
    throw new Error("Artıq kartla abunəliyin var. Paketi «Abunəliyi idarə et» bölməsindən dəyiş.");
  }
  const customer = await customerFor(user);
  // Our record can be a few seconds behind Stripe: a teacher back from Checkout
  // before the webhook landed still looks unsubscribed here. Ask Stripe, so one
  // teacher never ends up with two plans (and two charges).
  const existing = await liveMainSubscription(customer.id);
  if (existing) {
    await syncSubscription(existing).catch((error) => console.warn("[stripe] checkout pre-sync failed:", error.message));
    res.status(409);
    throw new Error("Abunəliyin artıq qeydə alınıb. Bir neçə saniyəyə paketin aktiv olacaq.");
  }
  await expireOpenCheckouts(customer.id);
  const trial = trialEligible(user) ? trialDays() : 0;
  const suffix = Math.random().toString(36).slice(2, 10);
  const metadata = { examopia_user_id: String(user._id), target_plan: targetPlan };
  const session = await stripeClient().checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
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
      ? { custom_text: { submit: { message: `İlk ${trial} gün pulsuzdur. Sınaq bitməmiş ləğv etsən, kartdan pul çıxılmayacaq.` } } }
      : {}),
    integration_identifier: `examopia_billing_v1_${suffix}`,
    success_url: `${frontendUrl()}/plan?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl()}/plan?checkout=cancelled`,
    allow_promotion_codes: true,
  });
  res.json({ url: session.url, sessionId: session.id, trialDays: trial });
});

/*
 * A monthly add-on (credit pack or storage). It joins the plan's billing date:
 * the first payment covers only the days left until the plan renews, and from then
 * on it is charged together with the plan, on the same day.
 */
const createAddonCheckout = asyncHandler(async (req, res) => {
  const key = String(req.body?.addon || "");
  const addon = ADDONS[key];
  if (!addon) { res.status(400); throw new Error("Yanlış əlavə"); }
  if (!billingEnabledFor(req.user)) { res.status(403); throw new Error("Kartla ödəniş hələ aktiv deyil"); }
  const user = await User.findById(req.user._id).select(
    "name email +stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus +stripeCurrentPeriodEnd +stripeCancelAt"
  );
  if (!user) { res.status(404); throw new Error("İstifadəçi tapılmadı"); }
  const status = user.stripeSubscriptionStatus;
  if (status === "trialing") {
    res.status(409);
    throw new Error("Əlavələri pulsuz sınaq bitəndən sonra qoşa bilərsən.");
  }
  if (!user.stripeSubscriptionId || !["active", "past_due"].includes(status)) {
    res.status(409);
    throw new Error("Əlavələr kartla abunəliyə qoşulur: əvvəlcə Pro və ya Premium paketinə abunə ol.");
  }
  if (user.stripeCancelAt) {
    res.status(409);
    throw new Error("Abunəliyin ləğv edilib. Əlavə qoşmaq üçün əvvəlcə «Abunəliyi idarə et» bölməsində abunəliyi bərpa et.");
  }
  const renewal = user.stripeCurrentPeriodEnd ? Math.floor(new Date(user.stripeCurrentPeriodEnd).getTime() / 1000) : 0;
  if (!renewal || renewal < Math.floor(Date.now() / 1000) + 3600) {
    res.status(409);
    throw new Error("Bu gün abunəliyin yenilənmə günüdür. Bir neçə saatdan sonra yenidən cəhd et.");
  }
  const price = (await addonPrices())[key];
  if (!price) { res.status(503); throw new Error("Bu əlavənin qiyməti hələ hazır deyil"); }
  const customer = await customerFor(user);
  const metadata = { examopia_user_id: String(user._id), examopia_kind: "addon", addon_key: key };
  const session = await stripeClient().checkout.sessions.create({
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

const billingStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "role plan planExpiresAt planDowngradedAt starterUntil starterPending aiCreditsLastSpentAt aiCreditsResetAt addonCreditsMonthly cardStorageGb +stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus +stripeCurrentPeriodEnd +stripeCancelAtPeriodEnd +stripeCancelAt +stripeTrialEnd +stripeTrialUsedAt +stripeLastPaidAt +stripeLastCreditedInvoiceId +stripeRefundedInvoiceId +stripeAddons"
  );
  const enabled = billingEnabledFor(req.user);
  res.json({
    configured: enabled,
    pricesConfigured: { pro: !!priceForPlan("pro"), premium: !!priceForPlan("premium") },
    customer: !!user?.stripeCustomerId,
    plan: user?.plan || "free",
    expiresAt: user?.planExpiresAt || null,
    subscriptionStatus: user?.stripeSubscriptionStatus || null,
    currentPeriodEnd: user?.stripeCurrentPeriodEnd || null,
    cancelAtPeriodEnd: !!user?.stripeCancelAtPeriodEnd,
    cancelAt: user?.stripeCancelAt || null,
    trialEnd: user?.stripeTrialEnd || null,
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

module.exports = { createCheckout, createAddonCheckout, createPortal, billingStatus, webhook, handleStripeEvent, syncSubscription };
