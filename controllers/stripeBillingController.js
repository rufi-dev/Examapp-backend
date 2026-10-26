const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const User = require("../models/userModel");
const StripeEvent = require("../models/stripeEventModel");
const MaintenanceAudit = require("../models/maintenanceAuditModel");
const { planDef } = require("../config/plans");
const {
  required,
  stripeClient,
  priceForPlan,
  planForPrice,
  frontendUrl,
  trialDays,
  trialCredits,
  billingEnabledFor,
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

function priceFromSubscription(subscription) {
  return subscription?.items?.data?.map((item) => item?.price?.id).find(Boolean) || "";
}

const hasPaidPlanNow = (user) =>
  ["pro", "premium"].includes(user?.plan) && (!user.planExpiresAt || new Date(user.planExpiresAt) > new Date());

// A first-time card subscriber gets the trial: no trial before, no Stripe
// subscription before, and not already on a paid plan paid by transfer.
const trialEligible = (user) =>
  trialDays() > 0 && !!user && !user.stripeTrialUsedAt && !user.stripeSubscriptionId && !hasPaidPlanNow(user);

// Credits granted by Stripe leave a trail like an admin adjustment does; the guard
// fields on the user (trial stamp, last invoice id) are what stop a second grant.
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

async function grantTrialCredits(userId, subscriptionId) {
  const amount = trialCredits();
  const result = await User.updateOne(
    { _id: userId, stripeTrialUsedAt: null },
    { $set: { stripeTrialUsedAt: new Date() }, ...(amount > 0 ? { $inc: { aiCredits: amount } } : {}) }
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

// A paid month brings the plan's monthly credits; the trial has its own grant.
async function grantInvoiceCredits(userId, invoice, plan) {
  if (!paysForAMonth(invoice)) return;
  const amount = planDef(plan).credits?.monthly || 0;
  if (!amount || !invoice.id) return;
  const result = await User.updateOne(
    { _id: userId, stripeLastCreditedInvoiceId: { $ne: invoice.id } },
    { $set: { stripeLastCreditedInvoiceId: invoice.id }, $inc: { aiCredits: amount } }
  );
  if (result.modifiedCount) await auditGrant("stripe_invoice_credits", userId, amount, `invoice ${invoice.id}`);
}

// Pro → Premium mid-month: the teacher paid the prorated difference, so they get the
// same share of the extra monthly credits now; the full amount comes at renewal.
async function grantUpgradeCredits(userId, subscription, from, to) {
  const extra = (planDef(to).credits?.monthly || 0) - (planDef(from).credits?.monthly || 0);
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
 * Writes a Stripe subscription onto its teacher. Returns { userId, plan } where
 * plan is the paid plan the subscription grants right now (null when it grants none).
 */
async function syncSubscription(subscription) {
  const priceId = priceFromSubscription(subscription);
  const plan = planForPrice(priceId);
  const metadataUserId = subscription?.metadata?.examopia_user_id;
  const customerId = typeof subscription?.customer === "string" ? subscription.customer : subscription?.customer?.id;
  const query = mongoose.isValidObjectId(metadataUserId)
    ? { _id: metadataUserId }
    : customerId
      ? { stripeCustomerId: customerId }
      : null;
  if (!query) return null;
  const user = await User.findOne(query).select(
    "+stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus +stripeTrialUsedAt plan planSource planSince planExpiresAt"
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

  if (status === "trialing" && !user.stripeTrialUsedAt) await grantTrialCredits(user._id, subscription.id);
  const upgraded =
    grants && status === "active" && user.planSource === "stripe" && user.stripeSubscriptionId === subscription.id &&
    user.plan !== "free" && PLAN_RANK[grants] > (PLAN_RANK[user.plan] || 0);
  if (upgraded) await grantUpgradeCredits(user._id, subscription, user.plan, grants);
  if (update.plan && update.plan !== user.plan) await reconcile(user._id);
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
  if (paid && synced?.plan) await grantInvoiceCredits(synced.userId, invoice, synced.plan);
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
    "name email plan planExpiresAt +stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus +stripeTrialUsedAt"
  );
  if (!user) { res.status(404); throw new Error("İstifadəçi tapılmadı"); }
  if (user.stripeSubscriptionId && LIVE_STATUSES.has(user.stripeSubscriptionStatus)) {
    res.status(409);
    throw new Error("Artıq kartla abunəliyin var. Paketi «Abunəliyi idarə et» bölməsindən dəyiş.");
  }
  const trial = trialEligible(user) ? trialDays() : 0;
  const customer = await customerFor(user);
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

// Not behind the billing gate: whoever subscribed must always be able to cancel.
const createPortal = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("+stripeCustomerId");
  if (!user?.stripeCustomerId) { res.status(400); throw new Error("Stripe müştəri hesabı hələ yoxdur"); }
  const portal = await stripeClient().billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: `${frontendUrl()}/plan` });
  res.json({ url: portal.url });
});

const billingStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "plan planExpiresAt +stripeCustomerId +stripeSubscriptionId +stripeSubscriptionStatus +stripeCurrentPeriodEnd +stripeCancelAtPeriodEnd +stripeCancelAt +stripeTrialEnd +stripeTrialUsedAt"
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

module.exports = { createCheckout, createPortal, billingStatus, webhook, handleStripeEvent, syncSubscription };
