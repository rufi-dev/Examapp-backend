/*
 * A Stripe customer only for a teacher whose card went in (owner, 2026-10-31).
 * Checkout leaves an empty customer behind when the card step is not finished;
 * jobs/stripeEmptyCustomers removes it once its page has expired, and nothing else.
 */
process.env.NODE_ENV = "test";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0, failed = 0;
const ok = (n, c, extra = "") => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, extra); } };

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const sec = (ms) => Math.floor(ms / 1000);

// The fake Stripe: customers with what Stripe would hold for each.
function fakeStripe(customers) {
  const deleted = [];
  const by = (id) => customers.find((c) => c.id === id) || {};
  const list = (key) => async ({ customer }) => ({ data: by(customer)[key] || [] });
  return {
    deleted,
    customers: {
      list: async ({ created }) => ({
        data: customers.filter((c) => c.created >= created.gte && c.created <= created.lte).map(({ id, email, created }) => ({ id, email, created })),
        has_more: false,
      }),
      del: async (id) => { deleted.push(id); return { id, deleted: true }; },
    },
    subscriptions: { list: list("subs") },
    paymentMethods: { list: list("cards") },
    checkout: { sessions: { list: list("openPages") } },
    invoices: { list: list("invoices") },
    paymentIntents: { list: list("payments") },
  };
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const User = require("../models/userModel");
  const { sweepEmptyStripeCustomers } = require("../jobs/stripeEmptyCustomers");

  const teacher = (email, extra = {}) => User.create({ name: email, email, password: "x".repeat(12), role: "teacher", ...extra });
  await teacher("left@t.az");
  await teacher("linked@t.az", { stripeCustomerId: "cus_linked" });
  await teacher("trial@t.az");
  await teacher("card@t.az");
  await teacher("fresh@t.az");
  await teacher("open@t.az");
  await teacher("paid@t.az");
  await User.create({ name: "S", email: "student@t.az", password: "x".repeat(12), role: "student" });

  const old = sec(NOW - 30 * HOUR);
  const customers = [
    // The case seen live: card step started, never finished.
    { id: "cus_left", email: "Left@t.az", created: old, payments: [{ status: "requires_payment_method" }] },
    { id: "cus_linked", email: "linked@t.az", created: old },
    { id: "cus_trial", email: "trial@t.az", created: old, subs: [{ id: "sub_1", status: "trialing" }] },
    { id: "cus_card", email: "card@t.az", created: old, cards: [{ id: "pm_1" }] },
    { id: "cus_fresh", email: "fresh@t.az", created: sec(NOW - 2 * HOUR) },
    { id: "cus_open", email: "open@t.az", created: old, openPages: [{ id: "cs_1" }] },
    { id: "cus_paid", email: "paid@t.az", created: old, payments: [{ status: "succeeded" }] },
    { id: "cus_stranger", email: "someone@else.az", created: old },
    { id: "cus_student", email: "student@t.az", created: old },
  ];

  console.log("a dry run only reports");
  let stripe = fakeStripe(customers);
  let r = await sweepEmptyStripeCustomers({ now: NOW, client: stripe, dryRun: true });
  ok("it finds exactly the empty leftover", JSON.stringify(r.removed) === JSON.stringify(["cus_left"]), JSON.stringify(r));
  ok("…and deletes nothing", stripe.deleted.length === 0);

  console.log("\nthe sweep");
  stripe = fakeStripe(customers);
  r = await sweepEmptyStripeCustomers({ now: NOW, client: stripe });
  ok("an unfinished card step's empty customer is removed (email case ignored)", stripe.deleted.includes("cus_left"));
  ok("a customer a teacher here points at is kept", !stripe.deleted.includes("cus_linked"));
  ok("a customer with a subscription (a trial) is kept", !stripe.deleted.includes("cus_trial"));
  ok("a customer with a saved card is kept", !stripe.deleted.includes("cus_card"));
  ok("a customer whose card page may still be open (under 25 h) is not even looked at", !stripe.deleted.includes("cus_fresh"));
  ok("a customer with an open Checkout page is kept", !stripe.deleted.includes("cus_open"));
  ok("a customer with a payment is kept", !stripe.deleted.includes("cus_paid"));
  ok("a customer that is not one of our teachers is kept", !stripe.deleted.includes("cus_stranger") && !stripe.deleted.includes("cus_student"));
  ok("only the one removed", stripe.deleted.length === 1, JSON.stringify(stripe.deleted));

  delete process.env.STRIPE_SECRET_KEY;
  r = await sweepEmptyStripeCustomers({ now: NOW });
  ok("no Stripe key: nothing runs", r.skipped === "no_key");

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("test crashed:", e); process.exit(1); });
