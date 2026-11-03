/*
 * A Stripe customer only for a teacher whose card went in (owner, 2026-10-27, and
 * again 2026-10-31: "only if the card is added successfully then add to Stripe").
 *
 * Checkout makes the customer when the teacher starts the card step, before the
 * bank has answered, so a card step left unfinished (page closed, 3-D Secure
 * abandoned, card refused) leaves an empty customer behind: no card, no
 * subscription, linked to nobody here. Seen live 2026-10-31. A Checkout page lives
 * at most 24 hours, so a customer older than that and still empty will never be
 * filled: this removes it. Access was never granted to it (the wall lifts only on
 * a trialing or paid subscription), so nothing else changes for the teacher.
 *
 * Only Checkout's own leftovers: the email is one of our teachers', no teacher here
 * points at the customer (stripeCustomerId), and Stripe has no subscription, saved
 * card, open Checkout page, invoice or payment for it.
 */
const User = require("../models/userModel");
const { stripeClient } = require("../config/stripe");

const HOUR = 60 * 60 * 1000;
// A Checkout page expires after 24 hours; one more hour of margin.
const MIN_AGE_MS = 25 * HOUR;
// Older leftovers were already swept (or were from before this job).
const LOOK_BACK_MS = 14 * 24 * HOUR;
const MAX_PAGES = 5;

const has = async (listing) => ((await listing)?.data || []).length > 0;

async function isEmptyLeftover(client, customer) {
  const email = String(customer.email || "").trim().toLowerCase();
  if (!email || customer.deleted) return null;
  const teacher = await User.findOne({ email }).select("_id role").lean();
  if (!teacher || teacher.role !== "teacher") return null;
  if (await User.exists({ stripeCustomerId: customer.id })) return null;
  const id = customer.id;
  if (await has(client.subscriptions.list({ customer: id, status: "all", limit: 1 }))) return null;
  if (await has(client.paymentMethods.list({ customer: id, limit: 1 }))) return null;
  if (await has(client.checkout.sessions.list({ customer: id, status: "open", limit: 1 }))) return null;
  if (await has(client.invoices.list({ customer: id, limit: 1 }))) return null;
  const payments = (await client.paymentIntents.list({ customer: id, limit: 10 }))?.data || [];
  if (payments.some((p) => !["canceled", "requires_payment_method"].includes(p.status))) return null;
  return teacher;
}

async function sweepEmptyStripeCustomers({ now = Date.now(), client = null, dryRun = false } = {}) {
  if (!client && !String(process.env.STRIPE_SECRET_KEY || "").trim()) return { skipped: "no_key" };
  const stripe = client || stripeClient();
  const created = { gte: Math.floor((now - LOOK_BACK_MS) / 1000), lte: Math.floor((now - MIN_AGE_MS) / 1000) };
  const removed = [];
  let checked = 0;
  let startingAfter;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await stripe.customers.list({ created, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const customer of res.data || []) {
      checked += 1;
      const teacher = await isEmptyLeftover(stripe, customer);
      if (!teacher) continue;
      if (!dryRun) await stripe.customers.del(customer.id);
      removed.push(customer.id);
      console.log(`[stripe] ${dryRun ? "would remove" : "removed"} an empty customer left by an unfinished card step (teacher ${teacher._id})`);
    }
    if (!res.has_more || !(res.data || []).length) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return { checked, removed, dryRun };
}

module.exports = { sweepEmptyStripeCustomers, MIN_AGE_MS };
