const asyncHandler = require("express-async-handler");
const User = require("../models/userModel");
const StripeEvent = require("../models/stripeEventModel");
const { planDef, PLAN_IDS } = require("../config/plans");
const { required, stripeClient, priceForPlan, planForPrice, frontendUrl } = require("../config/stripe");

const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const ENDING_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);
const periodEnd = (subscription) => {
  const seconds = Number(subscription?.current_period_end);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
};

function priceFromSubscription(subscription) {
  return subscription?.items?.data?.map((item) => item?.price?.id).find(Boolean) || "";
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

async function syncSubscription(subscription, { invoicePaid = false } = {}) {
  const priceId = priceFromSubscription(subscription);
  const plan = planForPrice(priceId);
  const metadataUserId = subscription?.metadata?.examopia_user_id;
  const customerId = typeof subscription?.customer === "string" ? subscription.customer : subscription?.customer?.id;
  const query = metadataUserId ? { _id: metadataUserId } : { stripeCustomerId: customerId };
  if (!query._id && !query.stripeCustomerId) return null;
  const user = await User.findOne(query).select("+stripeCustomerId +stripeSubscriptionId +stripePriceId plan planSince planExpiresAt aiCredits");
  if (!user) return null;

  const status = String(subscription?.status || "");
  const expiry = periodEnd(subscription);
  const paidPlan = plan && !ENDING_STATUSES.has(status) ? plan : null;
  const update = {
    stripeCustomerId: customerId || user.stripeCustomerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    stripeSubscriptionStatus: status,
    stripeCurrentPeriodEnd: expiry,
    stripeCancelAtPeriodEnd: !!subscription.cancel_at_period_end,
  };
  if (paidPlan && (ACTIVE_STATUSES.has(status) || status === "past_due")) {
    update.plan = paidPlan;
    update.planSource = "stripe";
    update.planSince = user.plan === paidPlan && user.planSince ? user.planSince : new Date();
    update.planExpiresAt = expiry;
    update.planDowngradedAt = null;
    if (invoicePaid) update.aiCredits = (user.aiCredits || 0) + (planDef(paidPlan).credits?.monthly || 0);
  } else if (!paidPlan || ENDING_STATUSES.has(status)) {
    update.plan = "free";
    update.planSource = "stripe";
    update.planExpiresAt = null;
    update.planDowngradedAt = user.plan !== "free" ? new Date() : user.planDowngradedAt;
  }
  await User.updateOne({ _id: user._id }, { $set: update });
  return user._id;
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

async function handleStripeEvent(event) {
  const claim = await markEvent(event);
  if (claim.duplicate) return;
  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;
      if (session.mode === "subscription" && session.subscription) {
        const subscription = await stripeClient().subscriptions.retrieve(session.subscription);
        await syncSubscription(subscription);
      }
    } else if (event.type === "checkout.session.async_payment_failed") {
      // The subscription lifecycle/invoice events remain authoritative. This
      // event is recorded for audit and deliberately does not grant access.
    } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await syncSubscription(event.data.object);
    } else if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      if (invoice.subscription) {
        const subscription = await stripeClient().subscriptions.retrieve(invoice.subscription);
        await syncSubscription(subscription, { invoicePaid: true });
      }
    } else if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      if (invoice.subscription) {
        const subscription = await stripeClient().subscriptions.retrieve(invoice.subscription);
        await syncSubscription(subscription);
      }
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
  const price = priceForPlan(targetPlan);
  if (!price) {
    res.status(503);
    throw new Error("Stripe qiyməti hələ konfiqurasiya edilməyib");
  }
  const user = await User.findById(req.user._id).select("name email +stripeCustomerId");
  if (!user) { res.status(404); throw new Error("İstifadəçi tapılmadı"); }
  const customer = await customerFor(user);
  const suffix = Math.random().toString(36).slice(2, 10);
  const session = await stripeClient().checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    line_items: [{ price, quantity: 1 }],
    client_reference_id: String(user._id),
    metadata: { examopia_user_id: String(user._id), target_plan: targetPlan },
    subscription_data: { metadata: { examopia_user_id: String(user._id), target_plan: targetPlan } },
    integration_identifier: `examopia_billing_v1_${suffix}`,
    success_url: `${frontendUrl()}/plan?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl()}/plan?checkout=cancelled`,
    allow_promotion_codes: true,
  });
  res.json({ url: session.url, sessionId: session.id });
});

const createPortal = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("+stripeCustomerId");
  if (!user?.stripeCustomerId) { res.status(400); throw new Error("Stripe müştəri hesabı hələ yoxdur"); }
  const portal = await stripeClient().billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: `${frontendUrl()}/plan` });
  res.json({ url: portal.url });
});

const billingStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("plan planExpiresAt +stripeCustomerId +stripeSubscriptionStatus +stripeCurrentPeriodEnd +stripeCancelAtPeriodEnd");
  res.json({
    configured: !!process.env.STRIPE_SECRET_KEY,
    pricesConfigured: { pro: !!priceForPlan("pro"), premium: !!priceForPlan("premium") },
    customer: !!user?.stripeCustomerId,
    plan: user?.plan || "free",
    expiresAt: user?.planExpiresAt || null,
    subscriptionStatus: user?.stripeSubscriptionStatus || null,
    currentPeriodEnd: user?.stripeCurrentPeriodEnd || null,
    cancelAtPeriodEnd: !!user?.stripeCancelAtPeriodEnd,
  });
});

const webhook = asyncHandler(async (req, res) => {
  const signature = req.headers["stripe-signature"];
  const event = stripeClient().webhooks.constructEvent(req.body, signature, required("STRIPE_WEBHOOK_SECRET"));
  await handleStripeEvent(event);
  res.json({ received: true });
});

module.exports = { createCheckout, createPortal, billingStatus, webhook, handleStripeEvent, syncSubscription };
