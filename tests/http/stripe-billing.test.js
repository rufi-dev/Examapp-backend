/*
 * Stripe Billing against a fake Stripe client and really signed webhooks: who is
 * offered card billing, the 7-day trial (only for teachers who never paid), the
 * API-2025 field moves (the period on subscription items, the invoice's
 * subscription under `parent`), a portal cancel's `cancel_at`, credits that RESET
 * each paid month (no rollover), monthly add-ons billed on the plan's date and
 * ending with it, the refund rule, the card wall, and the cases that must NOT
 * touch a plan (an admin-set plan, a stale subscription).
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-billing";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-billing";
process.env.EXAM_PDF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bill-priv-"));
process.env.PDF_STAGING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bill-stg-"));
process.env.STRIPE_SECRET_KEY = "rk_" + "test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_" + "testfake";
process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro";
process.env.STRIPE_PRICE_PREMIUM_MONTHLY = "price_premium";
process.env.STRIPE_PRICE_PRO_YEARLY = "price_pro_year";
process.env.STRIPE_PRICE_PREMIUM_YEARLY = "price_premium_year";
process.env.STRIPE_BILLING_TESTERS = "Tester@e.com, m@e.com";
delete process.env.STRIPE_BILLING_ENABLED;
delete process.env.BILLING_TRIAL_DAYS;
delete process.env.BILLING_TRIAL_CREDITS;
delete process.env.TEACHER_PAYWALL;

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const Stripe = require("stripe");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const StripeEvent = require("../../models/stripeEventModel");
const MaintenanceAudit = require("../../models/maintenanceAuditModel");
const { generateToken } = require("../../utils");
const errorHandler = require("../../middleware/errorMiddleware");
const { protect, teacherOnly } = require("../../middleware/authMiddleware");
const { requireCapability } = require("../../helper/teacherCapabilities");
const { _setStripeForTest } = require("../../config/stripe");
const { webhook } = require("../../controllers/stripeBillingController");
const { getCatalog } = require("../../controllers/planController");
const { getUser } = require("../../controllers/userController");
const { storageStatus } = require("../../middleware/uploadLimit");
const planLimits = require("../../helper/planLimits");
const { hasPaidPlan } = require("../../helper/teacherAccess");
const { meterFor } = require("../../middleware/aiCredit");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const GRACE = 2 * DAY * 1000;
const near = (date, ms) => !!date && Math.abs(new Date(date).getTime() - ms) < 5000;

// ── the fake Stripe: records what we ask for, serves subscriptions we set up ──
const signer = new Stripe("rk_" + "test_signer").webhooks;
const subs = new Map();
const sessions = [];
const portals = [];
const updates = [];
const checkoutState = new Map();
const expired = [];
const fake = {
  webhooks: signer,
  customers: {
    retrieve: async (id) => ({ id }),
    create: async (p) => {
      createdCustomers.push(p);
      return { id: `cus_${sessions.length + 1}_${Math.random().toString(36).slice(2, 6)}` };
    },
    update: async (id, p) => {
      customerUpdates.push({ id, ...p });
      return { id };
    },
  },
  checkout: {
    sessions: {
      create: async (p) => {
        sessions.push(p);
        const id = `cs_${sessions.length}`;
        checkoutState.set(id, { id, object: "checkout.session", customer: p.customer, mode: p.mode, status: "open", metadata: p.metadata });
        return { id, url: `https://checkout.stripe.test/${sessions.length}` };
      },
      retrieve: async (id) => {
        if (!checkoutState.has(id)) throw Object.assign(new Error("No such checkout session"), { code: "resource_missing" });
        return JSON.parse(JSON.stringify(checkoutState.get(id)));
      },
      list: async ({ customer, status }) => ({ data: [...checkoutState.values()].filter((c) => c.customer === customer && c.status === status) }),
      expire: async (id) => {
        expired.push(id);
        checkoutState.get(id).status = "expired";
        return checkoutState.get(id);
      },
    },
  },
  billingPortal: { sessions: { create: async (p) => { portals.push(p); return { url: "https://billing.stripe.test/p" }; } } },
  subscriptions: {
    // The one-tap add-on: charged at once on the given card, or refused like
    // Stripe's error_if_incomplete (declined / the bank wants 3-D Secure).
    create: async (p, opts = {}) => {
      createCalls.push({ ...p, idempotencyKey: opts.idempotencyKey });
      if (opts.idempotencyKey && createdByKey.has(opts.idempotencyKey)) return JSON.parse(JSON.stringify(subs.get(createdByKey.get(opts.idempotencyKey))));
      if (createFails === "declined") {
        createFails = null;
        throw Object.assign(new Error("Your card was declined."), { type: "StripeCardError", statusCode: 402, code: "card_declined" });
      }
      if (createFails === "3ds") {
        createFails = null;
        // The code real Stripe answers with (sandbox, 2026-11-03).
        throw Object.assign(new Error("This payment requires authentication."), { type: "StripeCardError", statusCode: 402, code: "subscription_payment_intent_requires_action" });
      }
      const n = createCalls.length;
      const unit = UNIT[p.items[0].price] || 1000;
      const id = `sub_c${n}`;
      const s = {
        id, object: "subscription", status: "active", customer: p.customer, metadata: { ...p.metadata }, default_payment_method: p.default_payment_method,
        cancel_at: null, cancel_at_period_end: false, trial_end: null,
        items: { data: [{ id: `si_${id}`, quantity: 1, current_period_start: NOW, current_period_end: p.billing_cycle_anchor, price: { id: p.items[0].price, unit_amount: unit } }] },
      };
      subs.set(id, s);
      if (opts.idempotencyKey) createdByKey.set(opts.idempotencyKey, id);
      const inv = { id: `in_c${n}`, object: "invoice", status: "paid", customer: p.customer, subscription: id, billing_reason: "subscription_create", subtotal: unit / 2, amount_paid: unit / 2, amount_remaining: 0, parent: { subscription_details: { subscription: id } } };
      invoiceStore.push(inv);
      return JSON.parse(JSON.stringify({ ...s, latest_invoice: inv }));
    },
    retrieve: async (id) => {
      if (!subs.has(id)) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
      return JSON.parse(JSON.stringify(subs.get(id)));
    },
    list: async ({ customer }) => ({ data: [...subs.values()].filter((s) => s.customer === customer).map((s) => JSON.parse(JSON.stringify(s))) }),
    update: async (id, p) => {
      updates.push({ id, ...p });
      const s = subs.get(id);
      if (!s) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
      if ("cancel_at" in p) s.cancel_at = p.cancel_at === "" ? null : p.cancel_at;
      if ("default_payment_method" in p) s.default_payment_method = p.default_payment_method;
      for (const [k, v] of Object.entries(p.metadata || {})) {
        if (v === "") delete s.metadata[k];
        else s.metadata[k] = v;
      }
      return JSON.parse(JSON.stringify(s));
    },
  },
  prices: {
    list: async ({ lookup_keys }) => ({ data: lookup_keys.map((k) => ({ id: `price_${k.replace(/_v1$/, "")}`, lookup_key: k })) }),
  },
  invoices: {
    createPreview: async (p) => {
      previews.push(p);
      return { amount_due: Math.round((UNIT[p.subscription_details.items[0].price] || 1000) / 2), currency: "azn" };
    },
    list: async ({ customer, subscription, status }) => ({ data: invoiceStore.filter((i) => i.customer === customer && i.subscription === subscription && i.status === status) }),
    retrieve: async (id) => JSON.parse(JSON.stringify(invoiceStore.find((i) => i.id === id))),
    // Charges the card: declined while `declineNext` is set; an invoice is paid once.
    pay: async (id, p) => {
      payCalls.push({ id, ...p });
      const inv = invoiceStore.find((i) => i.id === id);
      if (inv.status !== "open") throw Object.assign(new Error("Invoice is already paid"), { code: "invoice_not_editable" });
      if (declineNext) {
        declineNext = false;
        throw Object.assign(new Error("Your card was declined."), { type: "StripeCardError", code: "card_declined", decline_code: "insufficient_funds" });
      }
      Object.assign(inv, { status: "paid", amount_remaining: 0, amount_paid: inv.subtotal });
      subs.get(inv.subscription).status = "active";
      return JSON.parse(JSON.stringify(inv));
    },
  },
  setupIntents: { retrieve: async (id) => ({ id, payment_method: setupCards.get(id) }) },
  // A card as Stripe describes it (never the number): the one added with the
  // trial, then the one added to pay a failed month.
  paymentMethods: {
    retrieve: async (id) => {
      cardReads.push(id);
      // The same physical card has the same fingerprint on every account.
      return { id, type: "card", created: NOW - 60, card: { brand: "visa", last4: id === "pm_good" ? "0005" : "4242", exp_month: 12, exp_year: 2034, country: "AZ", funding: "debit", wallet: null, fingerprint: id === "pm_good" ? "fp_0005" : "fp_4242" } };
    },
  },
  charges: { retrieve: async () => ({}) },
  // payment_intent → invoice, as Stripe's invoice_payments list answers it.
  invoicePayments: {
    list: async ({ payment }) => ({ data: paidBy.has(payment?.payment_intent) ? [{ invoice: paidBy.get(payment.payment_intent) }] : [] }),
  },
};
const paidBy = new Map();
const createCalls = [];
const createdByKey = new Map();
const previews = [];
let createFails = null;
const UNIT = { price_addon_credits_100: 500, price_addon_credits_300: 1200, price_addon_storage_5: 300, price_addon_storage_25: 1000 };
const invoiceStore = [];
const payCalls = [];
const customerUpdates = [];
const setupCards = new Map();
const cardReads = [];
const createdCustomers = [];
let declineNext = false;
_setStripeForTest(fake);

function sub(id, userId, { status = "active", price = "price_pro", start = NOW, end = NOW + 30 * DAY, trialEnd = null, cancelAt = null, customer = "cus_x", meta = {}, unitAmount = 1500, quantity = 1 } = {}) {
  const s = {
    id, object: "subscription", status, customer,
    metadata: { examopia_user_id: String(userId), ...meta },
    cancel_at: cancelAt, cancel_at_period_end: false, trial_end: trialEnd,
    // API 2026: no current_period_end on the subscription itself.
    items: { data: [{ id: `si_${id}`, quantity, current_period_start: start, current_period_end: end, price: { id: price, unit_amount: unitAmount } }] },
  };
  subs.set(id, s);
  return s;
}
let evn = 0;
const ev = (type, object, id) => ({ id: id || `evt_${++evn}`, object: "event", type, data: { object } });
// Lines as Stripe sends them: API 2026 nests the subscription item under `parent`,
// older versions put `type: "subscription"` and `proration` on the line itself.
const invoice = (id, subscriptionId, { reason = "subscription_cycle", subtotal = 1500, paid = subtotal, legacy = false, proration = false, lines = true } = {}) => ({
  id, object: "invoice", billing_reason: reason, subtotal, amount_paid: paid, status: "paid",
  ...(legacy ? { subscription: subscriptionId } : { parent: { type: "subscription_details", subscription_details: { subscription: subscriptionId } } }),
  ...(lines
    ? {
        lines: {
          data: [
            legacy
              ? { id: `il_${id}`, amount: subtotal, type: "subscription", proration }
              : { id: `il_${id}`, amount: subtotal, parent: { type: "subscription_item_details", subscription_item_details: { proration, subscription: subscriptionId } } },
          ],
        },
      }
    : {}),
});

function call(server, { method = "GET", path: p, token, body, raw, headers = {} }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const data = raw != null ? Buffer.from(raw) : body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...headers };
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })() }));
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  let reconciles = 0;
  const realReconcile = planLimits.reconcileStudentCap;
  planLimits.reconcileStudentCap = async (id) => { reconciles++; return realReconcile(id); };

  const mk = (o) => User.create({ password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true, ...o });
  const teacher = await mk({ name: "T", email: "t@e.com" });
  const tester = await mk({ name: "Tester", email: "tester@e.com", aiCredits: 5 });
  const admin = await mk({ name: "A", email: "a@e.com", role: "admin" });
  const manual = await mk({ name: "M", email: "m@e.com", plan: "pro", planSource: "admin", planExpiresAt: new Date(Date.now() + 20 * DAY * 1000) });
  const lapsed = await mk({ name: "L", email: "l@e.com", plan: "pro", planSource: "admin", planExpiresAt: new Date(Date.now() - 3 * DAY * 1000) });
  const dropped = await mk({ name: "D", email: "d@e.com", plan: "free", planDowngradedAt: new Date(Date.now() - 40 * DAY * 1000) });
  const student = await mk({ name: "St", email: "st@e.com", role: "student", teacherApproval: undefined });
  const tok = (u) => generateToken(u._id, u.sessionVersion);
  const fresh = (u) => User.findById(u._id).select("+stripeSubscriptionId +stripeSubscriptionStatus +stripeCurrentPeriodEnd +stripeCancelAtPeriodEnd +stripeCancelAt +stripeTrialEnd +stripeTrialUsedAt +stripeLastCreditedInvoiceId +stripeAddons +stripeCard +stripeCheckoutOpenedAt +stripeCheckoutPlan +stripeCheckoutOpens plan planSource planExpiresAt planDowngradedAt aiCredits aiCreditsResetAt addonCreditsMonthly cardStorageGb cardStorageUntil").lean();
  const setCredits = (u, n) => User.updateOne({ _id: u._id }, { $set: { aiCredits: n } });

  const app = express();
  app.post("/api/billing/stripe/webhook", express.raw({ type: "application/json" }), webhook);
  app.use(express.json());
  app.use("/api/billing", require("../../routes/stripeBillingRoute"));
  app.get("/api/plan/catalog", getCatalog);
  app.get("/api/users/getUser", protect, getUser);
  app.all("/api/teach", protect, teacherOnly, (req, res) => res.json({ ok: true }));
  app.all("/api/cap", protect, requireCapability("exam:manage:own"), (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const send = (event, secret = process.env.STRIPE_WEBHOOK_SECRET) => {
    const raw = JSON.stringify(event);
    const sig = signer.generateTestHeaderString({ payload: raw, secret });
    return call(server, { method: "POST", path: "/api/billing/stripe/webhook", raw, headers: { "stripe-signature": sig } });
  };

  // ── the gate: a sandbox key must not reach real teachers ──
  let r = await call(server, { path: "/api/billing/status", token: tok(teacher) });
  ok("gate closed: an ordinary teacher is not offered card billing", r.status === 200 && r.body.configured === false && r.body.trialEligible === false);
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(teacher), body: { plan: "pro" } });
  ok("gate closed: Checkout refused with 403", r.status === 403);
  r = await call(server, { path: "/api/billing/status", token: tok(admin) });
  ok("gate closed: an admin still sees it", r.body.configured === true);
  r = await call(server, { path: "/api/billing/status", token: tok(tester) });
  ok("gate closed: a listed tester sees it (email match ignores case)", r.body.configured === true && r.body.trialEligible === true && r.body.trialDays === 7 && r.body.trialCredits === 100);
  r = await call(server, { path: "/api/plan/catalog" });
  ok("public catalog: no card billing while the gate is closed", r.status === 200 && r.body.cardBilling === null);
  ok("public catalog: no transfer card details any more", r.body.payment === undefined);
  process.env.STRIPE_BILLING_ENABLED = "true";
  r = await call(server, { path: "/api/plan/catalog" });
  ok("public catalog: card billing + trial days once open", r.body.cardBilling && r.body.cardBilling.trialDays === 7);
  r = await call(server, { path: "/api/billing/status", token: tok(teacher) });
  ok("gate open: every teacher sees it", r.body.configured === true);

  // ── who gets the trial: only teachers who have never paid ──
  ok("trial: a teacher who never paid is offered the trial", r.body.trialEligible === true);
  r = await call(server, { path: "/api/billing/status", token: tok(lapsed) });
  ok("trial: a teacher whose transfer-paid plan lapsed pays straight away", r.body.trialEligible === false);
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(lapsed), body: { plan: "pro" } });
  ok("trial: their Checkout carries no trial", r.status === 200 && r.body.trialDays === 0 && !("trial_period_days" in sessions[sessions.length - 1].subscription_data));
  r = await call(server, { path: "/api/billing/status", token: tok(dropped) });
  ok("trial: a teacher once downgraded from a paid plan pays straight away", r.body.trialEligible === false);
  delete process.env.STRIPE_BILLING_ENABLED;

  // ── the card wall (TEACHER_PAYWALL=on) ──
  r = await call(server, { method: "POST", path: "/api/teach", token: tok(teacher) });
  ok("wall off: a teacher without a plan works as before", r.status === 200);
  process.env.TEACHER_PAYWALL = "on";
  r = await call(server, { method: "POST", path: "/api/teach", token: tok(teacher) });
  ok("wall: a teacher without a plan is stopped when doing something (402 subscription_required)", r.status === 402 && r.body.code === "subscription_required");
  r = await call(server, { method: "POST", path: "/api/cap", token: tok(teacher) });
  ok("wall: …and on capability routes (AI, exams)", r.status === 402);
  r = await call(server, { path: "/api/teach", token: tok(teacher) });
  ok("wall: looking around stays open (reads pass, owner 2026-10-28)", r.status === 200);
  r = await call(server, { path: "/api/billing/status", token: tok(teacher) });
  ok("wall: subscribing itself stays open, and says the wall is up", r.status === 200 && r.body.paywall === true);
  r = await call(server, { path: "/api/users/getUser", token: tok(teacher) });
  ok("wall: the account data tells the app to show the wall", r.status === 200 && r.body.paywall === true);
  r = await call(server, { method: "POST", path: "/api/teach", token: tok(manual) });
  ok("wall: a plan the admin set gets through without paying", r.status === 200);
  r = await call(server, { path: "/api/users/getUser", token: tok(manual) });
  ok("wall: …and is not shown the wall", r.body.paywall === false);
  r = await call(server, { method: "POST", path: "/api/teach", token: tok(lapsed) });
  ok("wall: an admin plan that has ended is stopped", r.status === 402);
  r = await call(server, { method: "POST", path: "/api/cap", token: tok(admin) });
  ok("wall: admins are never stopped", r.status === 200);
  r = await call(server, { path: "/api/users/getUser", token: tok(student) });
  ok("wall: students are never walled", r.status === 200 && r.body.paywall === false);
  delete process.env.TEACHER_PAYWALL;

  // ── Checkout carries the trial ──
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(tester), body: { plan: "pro" } });
  const s1 = sessions[sessions.length - 1];
  ok("Checkout: 200 with a URL and the trial length", r.status === 200 && /^https:\/\/checkout/.test(r.body.url) && r.body.trialDays === 7);
  ok("Checkout: subscription mode, the Pro price, quantity 1", s1.mode === "subscription" && s1.line_items[0].price === "price_pro" && s1.line_items[0].quantity === 1);
  ok("Checkout: 7-day trial, cancelled if no card at the end", s1.subscription_data.trial_period_days === 7 && s1.subscription_data.trial_settings.end_behavior.missing_payment_method === "cancel");
  ok("Checkout: the subscription is tagged with the teacher", s1.subscription_data.metadata.examopia_user_id === String(tester._id));
  ok("Checkout: Azerbaijani trial note on the pay button", /pulsuz/.test(s1.custom_text?.submit?.message || ""));
  ok("Checkout: no payment_method_types pinned (dynamic methods)", !("payment_method_types" in s1));
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(manual), body: { plan: "premium" } });
  ok("Checkout: a teacher already on a paid plan (by transfer) pays now, no trial", r.status === 200 && r.body.trialDays === 0 && !("trial_period_days" in sessions[sessions.length - 1].subscription_data) && !sessions[sessions.length - 1].custom_text);

  // ── Stripe is a step ahead of our record: never a second plan ──
  process.env.STRIPE_BILLING_ENABLED = "true";
  const twoTabs = await mk({ name: "Tabs", email: "tabs@e.com", stripeCustomerId: "cus_tabs" });
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(twoTabs), body: { plan: "pro" } });
  const firstTab = `cs_${sessions.length}`;
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(twoTabs), body: { plan: "premium" } });
  ok("Checkout: a page still open from an earlier click is closed before a new one opens", r.status === 200 && expired.includes(firstTab) && checkoutState.get(`cs_${sessions.length}`).status === "open");
  const tabsRow = await fresh(twoTabs);
  ok("Checkout: each opening of the card page is noted for the admin (when, which plan, how often)", tabsRow.stripeCheckoutOpens === 2 && tabsRow.stripeCheckoutPlan === "premium" && near(tabsRow.stripeCheckoutOpenedAt, Date.now()));
  const racer = await mk({ name: "Racer", email: "racer@e.com", stripeCustomerId: "cus_race" });
  sub("sub_race", racer._id, { status: "trialing", customer: "cus_race", trialEnd: NOW + 7 * DAY, end: NOW + 7 * DAY });
  const before = sessions.length;
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(racer), body: { plan: "pro" } });
  let raced = await fresh(racer);
  ok("Checkout: Stripe already has their plan (webhook not here yet) → 409, no second Checkout", r.status === 409 && sessions.length === before);
  ok("Checkout: …and the account is brought up to date from Stripe right then", raced.plan === "pro" && raced.stripeSubscriptionId === "sub_race" && raced.stripeSubscriptionStatus === "trialing");

  // ── no Stripe customer until a card is added (owner, 2026-10-27) ──
  const newbie = await mk({ name: "Nəzrin Quliyeva", email: "nezrin@e.com" });
  const customersBefore = createdCustomers.length;
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(newbie), body: { plan: "pro" } });
  const n1 = sessions[sessions.length - 1];
  const n1Id = `cs_${sessions.length}`;
  ok("no customer: the card page opens with the teacher's email, and no Stripe customer is made", r.status === 200 && n1.customer_email === "nezrin@e.com" && !("customer" in n1) && createdCustomers.length === customersBefore);
  ok("no customer: the teacher's record still has none", !(await User.findById(newbie._id).select("+stripeCustomerId").lean()).stripeCustomerId);
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(newbie), body: { plan: "premium" } });
  ok("no customer: opening the card page again closes the earlier one (no second plan from another tab)", r.status === 200 && checkoutState.get(n1Id).status === "expired" && createdCustomers.length === customersBefore);
  const n2Id = `cs_${sessions.length}`;
  // The teacher added the card on that page; Stripe made the customer and the plan, but the webhook is not here yet.
  sub("sub_newbie", newbie._id, { status: "trialing", customer: "cus_made_by_checkout", trialEnd: NOW + 7 * DAY, end: NOW + 7 * DAY });
  Object.assign(checkoutState.get(n2Id), { status: "complete", subscription: "sub_newbie" });
  const before3 = sessions.length;
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(newbie), body: { plan: "pro" } });
  const nb = await fresh(newbie);
  ok("card added, webhook late: a third click finds the plan the page made (409), no new page", r.status === 409 && sessions.length === before3);
  ok("…and the account takes the customer Checkout made, with the trial", nb.stripeSubscriptionId === "sub_newbie" && nb.stripeSubscriptionStatus === "trialing" && (await User.findById(newbie._id).select("+stripeCustomerId").lean()).stripeCustomerId === "cus_made_by_checkout");
  ok("…and that customer gets the teacher's name and id at Stripe", customerUpdates.some((c) => c.id === "cus_made_by_checkout" && c.name === "Nəzrin Quliyeva" && c.metadata?.examopia_user_id === String(newbie._id)));
  delete process.env.STRIPE_BILLING_ENABLED;
  reconciles = 0; // the racer's sync reconciled its roster; the checks below count from here

  // ── webhook signatures ──
  r = await call(server, { method: "POST", path: "/api/billing/stripe/webhook", raw: JSON.stringify(ev("invoice.paid", {})) });
  ok("webhook: no signature → 400, not 500", r.status === 400);
  r = await send(ev("invoice.paid", {}), "whsec_" + "wrong");
  ok("webhook: forged signature → 400", r.status === 400);
  r = await send(ev("product.created", { id: "prod_1" }));
  ok("webhook: a signed event we ignore → 200", r.status === 200 && r.body.received === true);

  // ── trial starts ──
  const trialEnd = NOW + 7 * DAY;
  sub("sub_t", tester._id, { status: "trialing", end: trialEnd, trialEnd, customer: "cus_t" });
  subs.get("sub_t").default_payment_method = "pm_trial_card";
  r = await send(ev("customer.subscription.created", subs.get("sub_t")));
  let u = await fresh(tester);
  ok("trial: webhook 200", r.status === 200);
  ok("trial: teacher is on Pro from Stripe", u.plan === "pro" && u.planSource === "stripe" && u.stripeSubscriptionStatus === "trialing");
  ok("trial: the card's restricted details are kept (brand, last 4, expiry, country, debit), and when it was added", u.stripeCard?.brand === "visa" && u.stripeCard.last4 === "4242" && u.stripeCard.expMonth === 12 && u.stripeCard.expYear === 2034 && u.stripeCard.country === "AZ" && u.stripeCard.funding === "debit" && near(u.stripeCard.addedAt, (NOW - 60) * 1000));
  ok("trial: a first card gets its trial (no other account has used it)", !updates.some((x) => x.id === "sub_t" && x.trial_end === "now"));

  // ── one trial per CARD: the same card on a new account is charged, not trialled ──
  const reconcilesBeforeTwin = reconciles; // the twin's plan reconciles its own roster; the trial checks below count the tester's
  const cardTwin = await mk({ name: "Twin", email: "twin@e.com", aiCredits: 60 });
  sub("sub_twin", cardTwin._id, { status: "trialing", end: NOW + 7 * DAY, trialEnd: NOW + 7 * DAY, customer: "cus_twin" });
  subs.get("sub_twin").default_payment_method = "pm_same_card_new_account";
  r = await send(ev("customer.subscription.created", subs.get("sub_twin")));
  const tw = await User.findById(cardTwin._id).select("+stripeTrialUsedAt +stripeTrialCardReused +stripeTrialEnd aiCredits").lean();
  ok("one trial per card: the trial on a card another account used ends at once (Stripe charges now)", r.status === 200 && updates.some((x) => x.id === "sub_twin" && x.trial_end === "now" && x.proration_behavior === "none"));
  ok("…no trial credits are given, and it counts as their trial", tw.aiCredits === 60 && !!tw.stripeTrialUsedAt && tw.stripeTrialCardReused === true && !tw.stripeTrialEnd);
  process.env.STRIPE_BILLING_ENABLED = "true";
  r = await call(server, { path: "/api/billing/status", token: tok(cardTwin) });
  ok("…and the app is told why there was no trial", r.body.trialCardReused === true && r.body.trialEligible === false);
  const hadPlan = await mk({ name: "Had plan", email: "hadplan@e.com", plan: "free", planSince: new Date(Date.now() - 90 * DAY * 1000) });
  r = await call(server, { path: "/api/billing/status", token: tok(hadPlan) });
  ok("a teacher who had a plan before (planSince) is not offered a trial", r.body.trialEligible === false);
  delete process.env.STRIPE_BILLING_ENABLED;
  reconciles = reconcilesBeforeTwin;
  ok("trial: plan runs to the trial end + 2 days grace", near(u.planExpiresAt, trialEnd * 1000 + GRACE));
  ok("trial: period end read from the subscription item", near(u.stripeCurrentPeriodEnd, trialEnd * 1000));
  ok("trial: trial end stored", near(u.stripeTrialEnd, trialEnd * 1000));
  ok("trial: the balance becomes the trial's 100 credits (old credits do not carry over)", u.aiCredits === 100 && !!u.stripeTrialUsedAt && near(u.aiCreditsResetAt, trialEnd * 1000));
  ok("trial: roster reconciled on the upgrade", reconciles === 1);
  await send(ev("checkout.session.completed", { mode: "subscription", subscription: "sub_t" }));
  await send(ev("customer.subscription.updated", subs.get("sub_t")));
  u = await fresh(tester);
  ok("trial: credits are granted once, not per event", u.aiCredits === 100 && reconciles === 1);
  await send(ev("invoice.paid", invoice("in_trial", "sub_t", { reason: "subscription_create", subtotal: 0 })));
  u = await fresh(tester);
  ok("trial: the 0 ₼ trial invoice grants no monthly credits", u.aiCredits === 100);
  r = await call(server, { path: "/api/billing/status", token: tok(tester) });
  ok("status: trialing, trial end, no second trial", r.body.subscriptionStatus === "trialing" && near(r.body.trialEnd, trialEnd * 1000) && r.body.trialEligible === false);
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(tester), body: { plan: "premium" } });
  ok("Checkout: refused with 409 while a subscription is live", r.status === 409);
  await User.updateOne({ _id: tester._id }, { $set: { stripeCustomerId: "cus_t" } });
  r = await call(server, { method: "POST", path: "/api/billing/addon", token: tok(tester), body: { addon: "credits_100" } });
  ok("add-on: not during the trial (409)", r.status === 409 && /sınaq/.test(r.body.message || ""));
  r = await call(server, { method: "POST", path: "/api/billing/portal", token: tok(tester) });
  ok("portal: Stripe's default configuration when none is set", r.status === 200 && !("configuration" in portals[portals.length - 1]));
  process.env.STRIPE_PORTAL_CONFIGURATION = "bpc_live_cfg";
  r = await call(server, { method: "POST", path: "/api/billing/portal", token: tok(tester) });
  ok("portal: the configured portal (plan switching, cancel at period end) when set", portals[portals.length - 1].configuration === "bpc_live_cfg" && portals[portals.length - 1].return_url.endsWith("/plan"));
  delete process.env.STRIPE_PORTAL_CONFIGURATION;

  // ── trial converts: the first real charge RESETS the balance ──
  const end2 = NOW + 37 * DAY;
  sub("sub_t", tester._id, { status: "active", end: end2, customer: "cus_t" });
  await setCredits(tester, 40);
  const firstPaid = ev("invoice.paid", invoice("in_1", "sub_t"));
  r = await send(firstPaid);
  u = await fresh(tester);
  ok("paid month: invoice → subscription via invoice.parent (API 2026)", r.status === 200 && u.stripeSubscriptionStatus === "active");
  ok("paid month: the balance is reset to Pro's 350 (40 unused do not roll over)", u.aiCredits === 350 && u.stripeLastCreditedInvoiceId === "in_1");
  ok("paid month: credits reset again on the next renewal date", near(u.aiCreditsResetAt, end2 * 1000));
  ok("paid month: plan runs to the new period end + grace", near(u.planExpiresAt, end2 * 1000 + GRACE));
  await setCredits(tester, 12);
  await send(firstPaid);
  await send(ev("invoice.paid", invoice("in_1", "sub_t")));
  u = await fresh(tester);
  ok("paid month: a replayed event or a second event for the same invoice changes nothing", u.aiCredits === 12);
  await send(ev("invoice.paid", invoice("in_2", "sub_t", { legacy: true })));
  u = await fresh(tester);
  ok("paid month: an older-API invoice (invoice.subscription) still works", u.aiCredits === 350);
  await setCredits(tester, 3);
  await send(ev("invoice.paid", invoice("in_early", "sub_t", { reason: "subscription_update" })));
  u = await fresh(tester);
  ok("paid month: a trial ended early bills a full month as subscription_update, and it counts", u.aiCredits === 350);
  await setCredits(tester, 3);
  await send(ev("invoice.paid", invoice("in_nolines", "sub_t", { lines: false })));
  u = await fresh(tester);
  ok("paid month: an invoice without lines falls back to its billing reason", u.aiCredits === 350);
  const audits = await MaintenanceAudit.find({ actor: "stripe", "target.userId": String(tester._id) }).lean();
  ok("credits: every Stripe grant leaves an audit row", audits.length === 5);

  // ── card fails at renewal: the plan stops at once (owner: a failed charge is not a paid month) ──
  sub("sub_t", tester._id, { status: "past_due", end: end2, customer: "cus_t" });
  await send(ev("invoice.payment_failed", invoice("in_3", "sub_t")));
  u = await fresh(tester);
  ok("past_due: status recorded, no new month's credits", u.stripeSubscriptionStatus === "past_due" && u.aiCredits === 350);
  ok("past_due: the plan stops where the unpaid period starts, no free days", near(u.planExpiresAt, NOW * 1000) && !hasPaidPlan(u));
  process.env.TEACHER_PAYWALL = "on";
  r = await call(server, { method: "POST", path: "/api/teach", token: tok(tester) });
  ok("past_due: the wall is up straight away (402)", r.status === 402 && r.body.code === "subscription_required");
  r = await call(server, { path: "/api/billing/status", token: tok(tester) });
  ok("past_due: the status tells the app why (wall + past_due)", r.body.paywall === true && r.body.subscriptionStatus === "past_due");
  invoiceStore.push({ ...invoice("in_3", "sub_t"), status: "open", customer: "cus_t", subscription: "sub_t", amount_remaining: 1500, amount_paid: 0, currency: "azn", created: NOW, hosted_invoice_url: "https://invoice.stripe.test/in_3" });
  r = await call(server, { method: "POST", path: "/api/billing/addon", token: tok(tester), body: { addon: "credits_100" } });
  ok("add-on: none while a payment is owed (409)", r.status === 409 && /ödənişi tamamla/.test(r.body.message || ""));

  // «Ödənişi tamamla»: a card is added on Stripe's page, and the month charged to it
  const addCard = async (pm) => {
    const res = await call(server, { method: "POST", path: "/api/billing/pay-due", token: tok(tester) });
    const id = `cs_${sessions.length}`;
    Object.assign(checkoutState.get(id), { status: "complete", setup_intent: `seti_${pm}` });
    setupCards.set(`seti_${pm}`, pm);
    return { res, id, params: sessions[sessions.length - 1] };
  };
  const first = await addCard("pm_also_empty");
  ok("pay-due: opens Stripe's page to ADD A CARD (setup mode), not a second plan", first.res.status === 200 && first.res.body.kind === "card" && /^https:\/\/checkout/.test(first.res.body.url) && first.params.mode === "setup" && first.params.currency === "azn" && !first.params.line_items && first.res.body.amount === 15);
  ok("pay-due: the page belongs to this teacher's unpaid invoice", first.params.metadata.examopia_kind === "pay_due" && first.params.metadata.invoice === "in_3" && first.params.metadata.subscription === "sub_t" && first.params.metadata.examopia_user_id === String(tester._id) && first.params.setup_intent_data.metadata.invoice === "in_3");
  ok("pay-due: it says the month is charged and the card kept, and returns to «Planım»", /dərhal bu kartdan çıxılır/.test(first.params.custom_text.submit.message) && /\/plan\?due=paid&session_id=\{CHECKOUT_SESSION_ID\}$/.test(first.params.success_url));
  r = await call(server, { method: "POST", path: "/api/billing/pay-due/complete", token: tok(teacher), body: { sessionId: first.id } });
  ok("complete: another teacher cannot use this page (404), nothing charged", r.status === 404 && payCalls.length === 0);
  declineNext = true;
  r = await call(server, { method: "POST", path: "/api/billing/pay-due/complete", token: tok(tester), body: { sessionId: first.id } });
  u = await fresh(tester);
  ok("complete: the new card declined too → says so, the plan stays stopped, no credits", r.status === 200 && r.body.paid === false && r.body.reason === "declined" && u.stripeSubscriptionStatus === "past_due" && !hasPaidPlan(u) && u.aiCredits === 350);
  const reconcilesBeforePay = reconciles;
  await setCredits(tester, 20);
  const second = await addCard("pm_good");
  r = await call(server, { method: "POST", path: "/api/billing/pay-due/complete", token: tok(tester), body: { sessionId: second.id } });
  u = await fresh(tester);
  ok("complete: paid with the new card, at once", r.status === 200 && r.body.paid === true && payCalls.at(-1).id === "in_3" && payCalls.at(-1).payment_method === "pm_good" && payCalls.at(-1).off_session === true);
  ok("complete: the new card becomes the subscription's (and customer's) card for next month", updates.some((x) => x.id === "sub_t" && x.default_payment_method === "pm_good") && customerUpdates.some((c) => c.id === "cus_t" && c.invoice_settings?.default_payment_method === "pm_good"));
  ok("complete: the admin sees the new card (last 4 changed)", u.stripeCard?.last4 === "0005");
  const readsBefore = cardReads.length;
  await send(ev("customer.subscription.updated", subs.get("sub_t")));
  ok("the same card is not asked of Stripe again on every event", cardReads.length === readsBefore);
  ok("paid after failing: the plan opens again to the period end", u.plan === "pro" && u.stripeSubscriptionStatus === "active" && near(u.planExpiresAt, end2 * 1000 + GRACE));
  ok("paid after failing: the month's credits arrive then (reset, not added)", u.aiCredits === 350);
  ok("paid after failing: students the lapse waitlisted come back (roster reconciled)", reconciles === reconcilesBeforePay + 1);
  r = await call(server, { method: "POST", path: "/api/teach", token: tok(tester) });
  ok("paid after failing: the wall lifts", r.status === 200);
  await setCredits(tester, 77);
  const chargesBefore = payCalls.length;
  await send(ev("checkout.session.completed", await fake.checkout.sessions.retrieve(second.id)));
  await send(ev("invoice.paid", await fake.invoices.retrieve("in_3")));
  u = await fresh(tester);
  ok("webhooks for the same page and invoice: no second charge attempt, no second credit reset", payCalls.length === chargesBefore && u.aiCredits === 77);
  r = await call(server, { method: "POST", path: "/api/billing/pay-due", token: tok(tester) });
  ok("pay-due: nothing owed → the subscription page instead", r.status === 200 && r.body.kind === "portal" && /billing\.stripe\.test/.test(r.body.url));

  // «Kartı dəyiş» (owner, 2026-10-28): a different card for the months ahead, for
  // the plan AND its add-ons (each subscription keeps its own card), nothing charged now.
  sub("sub_addon_t", tester._id, { customer: "cus_t", meta: { examopia_kind: "addon", addon_key: "credits_100" } });
  subs.get("sub_addon_t").default_payment_method = "pm_good";
  r = await call(server, { method: "POST", path: "/api/billing/card", token: tok(teacher) });
  ok("card: a teacher without a subscription has no card to change (409)", r.status === 409);
  r = await call(server, { method: "POST", path: "/api/billing/card", token: tok(tester) });
  const cc = sessions[sessions.length - 1];
  const ccId = `cs_${sessions.length}`;
  ok("card: opens Stripe's page to save a card (setup mode), for this teacher's subscription", r.status === 200 && /^https:\/\/checkout/.test(r.body.url) && cc.mode === "setup" && cc.customer === "cus_t" && !cc.line_items && cc.currency === "azn" && cc.metadata.examopia_kind === "card_update" && cc.metadata.subscription === "sub_t" && cc.metadata.examopia_user_id === String(tester._id));
  ok("card: it says nothing is charged now, and returns to «Planım»", /indi pul çıxılmır/.test(cc.custom_text.submit.message) && /\/plan\?card=changed&session_id=\{CHECKOUT_SESSION_ID\}$/.test(cc.success_url));
  r = await call(server, { method: "POST", path: "/api/billing/card/complete", token: tok(tester), body: { sessionId: ccId } });
  ok("card: back before finishing Stripe's page → nothing changes", r.status === 200 && r.body.changed === false && subs.get("sub_t").default_payment_method === "pm_good");
  Object.assign(checkoutState.get(ccId), { status: "complete", setup_intent: "seti_pm_new" });
  setupCards.set("seti_pm_new", "pm_new");
  r = await call(server, { method: "POST", path: "/api/billing/card/complete", token: tok(teacher), body: { sessionId: ccId } });
  ok("card: another teacher cannot use this page (404)", r.status === 404 && subs.get("sub_t").default_payment_method === "pm_good");
  const paysBeforeCard = payCalls.length;
  r = await call(server, { method: "POST", path: "/api/billing/card/complete", token: tok(tester), body: { sessionId: ccId } });
  u = await fresh(tester);
  ok("card: the new card becomes the plan's, every add-on's and the customer's", r.status === 200 && r.body.changed === true && subs.get("sub_t").default_payment_method === "pm_new" && subs.get("sub_addon_t").default_payment_method === "pm_new" && customerUpdates.at(-1).id === "cus_t" && customerUpdates.at(-1).invoice_settings?.default_payment_method === "pm_new");
  ok("card: nothing charged and the plan unchanged", payCalls.length === paysBeforeCard && u.stripeSubscriptionStatus === "active" && hasPaidPlan(u));
  r = await call(server, { path: "/api/billing/status", token: tok(tester) });
  ok("card: «Planım» and the admin see the new card at once (never its id or fingerprint)", u.stripeCard?.last4 === "4242" && r.body.card?.last4 === "4242" && r.body.card.brand === "visa" && !("fingerprint" in r.body.card) && !("id" in r.body.card));
  const cardUpdatesBefore = updates.filter((x) => "default_payment_method" in x).length;
  await send(ev("checkout.session.completed", await fake.checkout.sessions.retrieve(ccId)));
  ok("card: Stripe's webhook for the same page changes nothing more", updates.filter((x) => "default_payment_method" in x).length === cardUpdatesBefore);
  subs.get("sub_t").status = "past_due";
  await User.updateOne({ _id: tester._id }, { $set: { stripeSubscriptionStatus: "past_due" } });
  r = await call(server, { method: "POST", path: "/api/billing/card", token: tok(tester) });
  ok("card: while a payment is owed, «Ödənişi tamamla» is the way (409, it pays the month too)", r.status === 409 && /Ödənişi tamamla/.test(r.body.message || ""));
  subs.get("sub_t").status = "active";
  await User.updateOne({ _id: tester._id }, { $set: { stripeSubscriptionStatus: "active" } });
  subs.delete("sub_addon_t");
  delete process.env.TEACHER_PAYWALL;

  // ── refund rule: within 7 days of the payment, and no AI credits spent since ──
  const refundOf = async () => (await call(server, { path: "/api/billing/status", token: tok(tester) })).body.refund;
  await send(ev("invoice.paid", invoice("in_4", "sub_t")));
  let st = await refundOf();
  ok("refund: a fresh paid month with no AI use is refundable, for 7 days", st.eligible === true && near(st.until, Date.now() + 7 * DAY * 1000));
  const creditsBeforeRefund = (await fresh(tester)).aiCredits;
  paidBy.set("pi_4", "in_4");
  const fullRefund = { id: "ch_4", object: "charge", customer: "cus_t", payment_intent: "pi_4", amount: 1500, amount_refunded: 1500, refunded: true };
  r = await send(ev("charge.refunded", fullRefund));
  u = await fresh(tester);
  ok("refund: a full refund takes back exactly that month's 350 credits", r.status === 200 && creditsBeforeRefund - u.aiCredits === 350);
  await send(ev("charge.refunded", fullRefund));
  u = await fresh(tester);
  ok("refund: a second event for the same refund takes nothing more", creditsBeforeRefund - u.aiCredits === 350);
  st = await refundOf();
  ok("refund: the refunded month is no longer offered for refund", st.eligible === false && st.reason === "refunded");
  await send(ev("invoice.paid", invoice("in_5", "sub_t")));
  paidBy.set("pi_5", "in_5");
  const afterIn5 = (await fresh(tester)).aiCredits;
  await send(ev("charge.refunded", { id: "ch_5", object: "charge", customer: "cus_t", payment_intent: "pi_5", amount: 1500, amount_refunded: 500, refunded: false }));
  ok("refund: a partial refund takes no credits", (await fresh(tester)).aiCredits === afterIn5);
  const tUser = await User.findById(tester._id).select("aiCredits role").lean();
  meterFor({ user: tUser }, "ai.generate.questions").usable();
  await new Promise((res) => setTimeout(res, 300));
  st = await refundOf();
  ok("refund: spending AI credits after the payment ends eligibility", st.eligible === false && st.reason === "credits_used");
  await User.updateOne({ _id: tester._id }, { $set: { aiCreditsLastSpentAt: null, stripeLastPaidAt: new Date(Date.now() - 8 * DAY * 1000) } });
  st = await refundOf();
  ok("refund: after 7 days there is no refund", st.eligible === false && st.reason === "window_passed");

  // ── monthly add-ons, billed on the plan's date ──
  r = await call(server, { method: "POST", path: "/api/billing/addon", token: tok(tester), body: { addon: "nope" } });
  ok("add-on: an unknown add-on is refused (400)", r.status === 400);
  process.env.STRIPE_BILLING_ENABLED = "true";
  r = await call(server, { method: "POST", path: "/api/billing/addon", token: tok(teacher), body: { addon: "credits_100" } });
  ok("add-on: a teacher without a card subscription is told to subscribe first (409)", r.status === 409 && /abunə ol/.test(r.body.message || ""));
  delete process.env.STRIPE_BILLING_ENABLED;
  r = await call(server, { method: "POST", path: "/api/billing/addon", token: tok(tester), body: { addon: "credits_100" } });
  const a1 = sessions[sessions.length - 1];
  ok("add-on: Checkout opens for a subscriber", r.status === 200 && /^https:\/\/checkout/.test(r.body.url));
  ok("add-on: it is the +100 credits monthly price", a1.mode === "subscription" && a1.line_items[0].price === "price_addon_credits_100");
  ok("add-on: pinned to the plan's renewal date, the first month prorated", a1.subscription_data.billing_cycle_anchor === end2 && a1.subscription_data.proration_behavior === "create_prorations");
  ok("add-on: tagged as an add-on of this teacher", a1.subscription_data.metadata.examopia_kind === "addon" && a1.subscription_data.metadata.addon_key === "credits_100" && a1.subscription_data.metadata.examopia_user_id === String(tester._id));
  ok("add-on: no trial on an add-on", !("trial_period_days" in a1.subscription_data));
  const addonMeta = (key) => ({ examopia_kind: "addon", addon_key: key });
  sub("sub_a1", tester._id, { price: "price_addon_credits_100", end: end2, customer: "cus_t", meta: addonMeta("credits_100"), unitAmount: 500 });
  await send(ev("customer.subscription.created", subs.get("sub_a1")));
  u = await fresh(tester);
  ok("add-on: the plan is untouched by an add-on subscription", u.plan === "pro" && u.stripeSubscriptionId === "sub_t");
  ok("add-on: +100 credits a month recorded", u.addonCreditsMonthly === 100 && u.stripeAddons.length === 1);
  const beforeAddon = u.aiCredits;
  const firstAddon = ev("invoice.paid", invoice("in_a1", "sub_a1", { reason: "subscription_create", subtotal: 250, paid: 250 }));
  await send(firstAddon);
  u = await fresh(tester);
  ok("add-on: the first, prorated payment (half a month) brings half the pack now", u.aiCredits - beforeAddon === 50);
  await send(ev("invoice.paid", invoice("in_a1", "sub_a1", { reason: "subscription_create", subtotal: 250, paid: 250 })));
  ok("add-on: …once", (await fresh(tester)).aiCredits - beforeAddon === 50);
  sub("sub_a2", tester._id, { price: "price_addon_storage_5", end: end2, customer: "cus_t", meta: addonMeta("storage_5"), unitAmount: 300 });
  await send(ev("customer.subscription.created", subs.get("sub_a2")));
  await send(ev("invoice.paid", invoice("in_a2", "sub_a2", { reason: "subscription_create", subtotal: 300, paid: 300 })));
  u = await fresh(tester);
  ok("add-on: +5 GB storage recorded until the renewal", u.cardStorageGb === 5 && near(u.cardStorageUntil, end2 * 1000 + GRACE));
  ok("add-on: a storage add-on brings no credits", u.addonCreditsMonthly === 100);
  const storage = storageStatus ? await storageStatus(await User.findById(tester._id).lean()) : null;
  ok("add-on: the storage allowance includes the card add-on", !storage || storage.addon?.gb === 5);
  await setCredits(tester, 9);
  await send(ev("invoice.paid", invoice("in_6", "sub_t")));
  u = await fresh(tester);
  ok("renewal: the month's allowance is plan + add-ons (350 + 100), nothing carried over", u.aiCredits === 450);
  await send(ev("invoice.paid", invoice("in_a1c", "sub_a1", { subtotal: 500 })));
  ok("renewal: the add-on's own renewal invoice adds nothing on top", (await fresh(tester)).aiCredits === 450);
  r = await call(server, { path: "/api/billing/status", token: tok(tester) });
  ok("status: add-ons, their monthly credits, storage and the reset date for «Planım»", r.body.addons.length === 2 && r.body.addonCreditsMonthly === 100 && r.body.cardStorageGb === 5 && near(r.body.creditsResetAt, end2 * 1000));

  // ── one tap: the plan's card is charged for an add-on, no card page (2026-11-03) ──
  subs.get("sub_t").default_payment_method = "pm_good";
  r = await call(server, { method: "POST", path: "/api/billing/addon/quote", token: tok(tester), body: { addon: "credits_300" } });
  ok("one tap: the quote names the plan's card (brand, last 4), never more", r.status === 200 && r.body.oneTap === true && r.body.card.brand === "visa" && r.body.card.last4 === "0005" && !("id" in r.body.card));
  ok("one tap: the quote is Stripe's own preview of today's prorated charge", r.body.amountToday === 6 && r.body.monthly === 12 && near(r.body.nextDate, end2 * 1000));
  ok("one tap: …previewed on the plan's date, prorated", previews.at(-1).subscription_details.billing_cycle_anchor?.type === "timestamp" && previews.at(-1).subscription_details.billing_cycle_anchor?.timestamp === end2 && previews.at(-1).subscription_details.proration_behavior === "create_prorations" && previews.at(-1).customer === "cus_t");
  const creditsBeforeTap = (await fresh(tester)).aiCredits;
  r = await call(server, { method: "POST", path: "/api/billing/addon/charge", token: tok(tester), body: { addon: "credits_300", requestId: "tap1" } });
  const made = createCalls.at(-1);
  ok("one tap: charged at once, on the plan's card", r.status === 200 && r.body.ok === true && made.default_payment_method === "pm_good" && made.payment_behavior === "error_if_incomplete");
  ok("one tap: the same add-on subscription the card page makes (plan's date, prorated, tagged)", made.billing_cycle_anchor === end2 && made.proration_behavior === "create_prorations" && made.metadata.examopia_kind === "addon" && made.metadata.addon_key === "credits_300" && made.metadata.examopia_user_id === String(tester._id));
  ok("one tap: a double tap cannot charge twice (idempotency key)", /tap1$/.test(made.idempotencyKey));
  u = await fresh(tester);
  ok("one tap: access at once: +300 a month recorded and half the pack for the half month paid", u.addonCreditsMonthly === 400 && u.aiCredits - creditsBeforeTap === 150 && r.body.creditsAdded === 150);
  r = await call(server, { method: "POST", path: "/api/billing/addon/charge", token: tok(tester), body: { addon: "credits_300", requestId: "tap1" } });
  ok("one tap: the same tap again makes nothing new and grants nothing more", r.status === 200 && createdByKey.size === 1 && (await fresh(tester)).aiCredits - creditsBeforeTap === 150);
  const tapped = [...createdByKey.values()][0];
  await send(ev("invoice.paid", invoiceStore.find((i) => i.subscription === tapped)));
  ok("one tap: Stripe's webhook for that payment afterwards grants nothing twice", (await fresh(tester)).aiCredits - creditsBeforeTap === 150);
  createFails = "declined";
  r = await call(server, { method: "POST", path: "/api/billing/addon/charge", token: tok(tester), body: { addon: "storage_25", requestId: "tap2" } });
  ok("one tap: a declined card is not charged; the answer sends them to the card page (402)", r.status === 402 && r.body.fallback === "checkout" && /alınmadı/.test(r.body.message) && (await fresh(tester)).cardStorageGb === 5);
  createFails = "3ds";
  r = await call(server, { method: "POST", path: "/api/billing/addon/charge", token: tok(tester), body: { addon: "storage_25", requestId: "tap3" } });
  ok("one tap: a card the bank wants confirmed (3-D Secure) goes to the card page instead", r.status === 402 && r.body.fallback === "checkout" && /təsdiq/.test(r.body.message));
  subs.get("sub_t").default_payment_method = null;
  r = await call(server, { method: "POST", path: "/api/billing/addon/quote", token: tok(tester), body: { addon: "storage_25" } });
  ok("one tap: with no card on file the quote says so (no one-tap)", r.status === 200 && r.body.oneTap === false && r.body.card === null);
  const callsBefore = createCalls.length;
  r = await call(server, { method: "POST", path: "/api/billing/addon/charge", token: tok(tester), body: { addon: "storage_25", requestId: "tap4" } });
  ok("one tap: …and the charge refuses, to the card page, without calling Stripe", r.status === 409 && r.body.fallback === "checkout" && createCalls.length === callsBefore);
  // Put the account back as the tests below expect it.
  subs.delete(tapped);
  await send(ev("customer.subscription.deleted", { ...subs.get("sub_a1"), id: tapped, status: "canceled" }));
  await setCredits(tester, creditsBeforeTap);
  ok("one tap: (test reset) back to the two add-ons", (await fresh(tester)).addonCreditsMonthly === 100);

  // add-ons end with the plan, and come back if the plan's cancellation is withdrawn
  sub("sub_t", tester._id, { status: "active", end: end2, cancelAt: end2, customer: "cus_t" });
  await send(ev("customer.subscription.updated", subs.get("sub_t")));
  ok("add-ons: a plan set to end takes its add-ons with it on the same date", subs.get("sub_a1").cancel_at === end2 && subs.get("sub_a2").cancel_at === end2);
  ok("add-ons: …without a prorated credit", updates.filter((x) => x.cancel_at === end2).every((x) => x.proration_behavior === "none"));
  sub("sub_t", tester._id, { status: "active", end: end2, customer: "cus_t" });
  await send(ev("customer.subscription.updated", subs.get("sub_t")));
  ok("add-ons: withdrawing the plan's cancellation keeps the add-ons going", subs.get("sub_a1").cancel_at === null && subs.get("sub_a2").cancel_at === null);

  // ── portal cancel: cancel_at, not cancel_at_period_end ──
  sub("sub_t", tester._id, { status: "active", end: end2, cancelAt: end2, customer: "cus_t" });
  await send(ev("customer.subscription.updated", subs.get("sub_t")));
  u = await fresh(tester);
  ok("portal cancel: marked as ending, with the date", u.stripeCancelAtPeriodEnd === true && near(u.stripeCancelAt, end2 * 1000));
  ok("portal cancel: still Pro until then", u.plan === "pro" && near(u.planExpiresAt, end2 * 1000 + GRACE));
  r = await call(server, { path: "/api/billing/status", token: tok(tester) });
  ok("status: cancelAtPeriodEnd + cancelAt for the UI", r.body.cancelAtPeriodEnd === true && near(r.body.cancelAt, end2 * 1000));
  r = await call(server, { method: "POST", path: "/api/billing/addon", token: tok(tester), body: { addon: "storage_25" } });
  ok("add-on: none can be added to a plan that is ending (409)", r.status === 409);
  r = await call(server, { method: "POST", path: "/api/billing/addon/charge", token: tok(tester), body: { addon: "storage_25", requestId: "tap5" } });
  ok("one tap: nor charged in one tap to a plan that is ending (409)", r.status === 409 && !r.body.fallback);

  // ── subscription ends ──
  const reconcilesBeforeEnd = reconciles;
  const lastActive = JSON.parse(JSON.stringify(subs.get("sub_t")));
  sub("sub_t", tester._id, { status: "canceled", end: end2, customer: "cus_t" });
  await send(ev("customer.subscription.deleted", subs.get("sub_t")));
  u = await fresh(tester);
  ok("ended: back to Free, marked downgraded, no expiry", u.plan === "free" && !!u.planDowngradedAt && u.planExpiresAt === null && u.stripeSubscriptionStatus === "canceled");
  ok("ended: roster reconciled on the downgrade", reconciles === reconcilesBeforeEnd + 1);
  await send(ev("customer.subscription.updated", lastActive));
  u = await fresh(tester);
  ok("ended: an older 'active' event arriving late does not open the plan again", u.plan === "free" && u.stripeSubscriptionStatus === "canceled");
  const endSoon = (s) => s.cancel_at > NOW && s.cancel_at < Math.floor(Date.now() / 1000) + 400;
  ok("ended: the add-ons end within minutes too", endSoon(subs.get("sub_a1")) && endSoon(subs.get("sub_a2")));
  r = await call(server, { path: "/api/billing/status", token: tok(tester) });
  ok("ended: no second trial for this teacher", r.body.trialEligible === false);

  // ── the admin's billing panel («Paket idarəetməsi») ──
  r = await call(server, { path: "/api/billing/admin/teachers", token: tok(tester) });
  ok("billing panel: a teacher cannot see it", r.status === 401 || r.status === 403, `status ${r.status}`);
  r = await call(server, { path: "/api/billing/admin/teachers", token: tok(admin) });
  const rowOf = (u) => r.body.rows?.find((x) => String(x._id) === String(u._id));
  ok("billing panel: an admin sees the teachers who added a card", r.status === 200 && !!rowOf(tester) && !!rowOf(racer) && !rowOf(teacher));
  ok("billing panel: who only opened the card page is not listed", !rowOf(twoTabs) && !("opened" in (r.body.counts || {})));
  ok("billing panel: who is on the trial, and until when", rowOf(racer).stage === "trial" && near(rowOf(racer).trialEndsAt, (NOW + 7 * DAY) * 1000));
  ok("billing panel: an ended subscription, with its card (the one «Kartı dəyiş» put on) and trial start", rowOf(tester).stage === "ended" && rowOf(tester).card?.last4 === "4242" && !!rowOf(tester).trialStartedAt);
  ok("billing panel: the card carries no Stripe id, nothing chargeable", rowOf(tester).card && !("id" in rowOf(tester).card) && !JSON.stringify(r.body).includes("pm_good"));
  ok("billing panel: counts by stage", r.body.counts?.trial >= 1 && r.body.counts?.ended >= 1);
  // A price this server does not know (another env's price ids) still names the plan, from the account.
  await User.updateOne({ _id: racer._id }, { $set: { stripePriceId: "price_from_another_env" } });
  r = await call(server, { path: "/api/billing/admin/teachers", token: tok(admin) });
  ok("billing panel: an unknown price falls back to the account's plan (revenue never reads 0 for a payer)", ["pro", "premium"].includes(rowOf(racer).plan) && rowOf(racer).interval === "month");

  // ── what must NOT change a plan ──
  sub("sub_m", manual._id, { status: "incomplete_expired", customer: "cus_m" });
  await send(ev("customer.subscription.updated", subs.get("sub_m")));
  u = await fresh(manual);
  ok("an abandoned card attempt never downgrades a plan the admin set", u.plan === "pro" && u.planSource === "admin");

  const switcher = await mk({ name: "S", email: "s@e.com" });
  sub("sub_new", switcher._id, { status: "active", customer: "cus_s" });
  await send(ev("customer.subscription.created", subs.get("sub_new")));
  sub("sub_old", switcher._id, { status: "canceled", customer: "cus_s" });
  await send(ev("customer.subscription.deleted", subs.get("sub_old")));
  u = await fresh(switcher);
  ok("a late event for an old subscription does not end the live one", u.plan === "pro" && u.stripeSubscriptionId === "sub_new");

  // ── Pro → Premium in the portal, halfway through the month ──
  const creditsBefore = u.aiCredits;
  const reconcilesBefore = reconciles;
  sub("sub_new", switcher._id, { status: "active", price: "price_premium", start: NOW - 15 * DAY, end: NOW + 15 * DAY, customer: "cus_s" });
  await send(ev("customer.subscription.updated", subs.get("sub_new")));
  u = await fresh(switcher);
  ok("upgrade: Premium now, roster reconciled", u.plan === "premium" && reconciles === reconcilesBefore + 1);
  ok("upgrade: half a month left → half of Premium's extra 1650 credits", u.aiCredits - creditsBefore === 825);
  await send(ev("invoice.paid", invoice("in_up", "sub_new", { reason: "subscription_update", subtotal: 250, proration: true })));
  await send(ev("customer.subscription.updated", subs.get("sub_new")));
  u = await fresh(switcher);
  ok("upgrade: the proration invoice and later events grant nothing more", u.aiCredits - creditsBefore === 825);

  // ── paying by the year: 30% off, the credits still a month at a time (2026-10-31) ──
  const { addMonths, nextMonthlyBefore } = require("../../helper/calendarMonths");
  const { resetAdminPlanCredits } = require("../../jobs/adminPlanCredits");
  const intervalOfUser = async (x) => (await User.findById(x._id).select("+stripeInterval").lean()).stripeInterval;
  process.env.STRIPE_BILLING_ENABLED = "true";
  r = await call(server, { path: "/api/plan/catalog" });
  const catalogPlan = (id) => r.body.plans.find((p) => p.id === id);
  ok("yearly: the catalog offers it, 30% off twelve months (Pro 126 ₼, Premium 168 ₼)", r.body.cardBilling?.annual?.discountPct === 30 && catalogPlan("pro").annualPriceAzn === 126 && catalogPlan("premium").annualPriceAzn === 168 && catalogPlan("free").annualPriceAzn === null);
  const yearly = await mk({ name: "Yearly", email: "yearly@e.com" });
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(yearly), body: { plan: "premium", interval: "year" } });
  const ys = sessions[sessions.length - 1];
  ok("yearly: Checkout uses the yearly price, with the trial a never-paid teacher gets", r.status === 200 && r.body.interval === "year" && ys.line_items[0].price === "price_premium_year" && ys.metadata.target_interval === "year" && ys.subscription_data.trial_period_days === 7);
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(teacher), body: { plan: "pro" } });
  ok("monthly stays the default", sessions[sessions.length - 1].line_items[0].price === "price_pro" && r.body.interval === "month");
  delete process.env.STRIPE_PRICE_PRO_YEARLY;
  r = await call(server, { path: "/api/plan/catalog" });
  ok("yearly is not offered until both plans have their yearly price", r.body.cardBilling && r.body.cardBilling.annual === null);
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(teacher), body: { plan: "pro", interval: "year" } });
  ok("…and a yearly Checkout without its price is refused (503)", r.status === 503);
  process.env.STRIPE_PRICE_PRO_YEARLY = "price_pro_year";

  const yStart = NOW;
  const yEnd = Math.floor(addMonths(new Date(NOW * 1000), 12).getTime() / 1000);
  sub("sub_y", yearly._id, { status: "active", price: "price_premium_year", start: yStart, end: yEnd, customer: "cus_y", unitAmount: 16800 });
  await send(ev("customer.subscription.created", subs.get("sub_y")));
  u = await fresh(yearly);
  ok("yearly: Premium for the year, and remembered as yearly", u.plan === "premium" && near(u.planExpiresAt, yEnd * 1000 + GRACE) && (await intervalOfUser(yearly)) === "year");
  await setCredits(yearly, 7);
  await send(ev("invoice.paid", invoice("in_y1", "sub_y", { reason: "subscription_create", subtotal: 16800 })));
  u = await fresh(yearly);
  const firstReset = addMonths(new Date(yStart * 1000), 1);
  ok("yearly: the year's payment brings ONE month of credits (2000, reset, not added)", u.aiCredits === 2000);
  ok("yearly: the next credits are due in a month, not in a year", near(u.aiCreditsResetAt, firstReset.getTime()));
  r = await call(server, { path: "/api/billing/status", token: tok(yearly) });
  ok("yearly: «Planım» is told it is yearly", r.body.interval === "year");
  r = await call(server, { path: "/api/billing/status", token: tok(tester) });
  ok("…and a monthly plan is monthly", r.body.interval === "month");

  await setCredits(yearly, 40);
  let job = await resetAdminPlanCredits({ now: new Date(firstReset.getTime() + 3600 * 1000) });
  u = await fresh(yearly);
  ok("yearly: a month on, the job renews the credits (2000 again, no rollover)", u.aiCredits === 2000 && job.reset >= 1);
  ok("…and sets the following month", near(u.aiCreditsResetAt, addMonths(firstReset, 1).getTime()));
  await setCredits(yearly, 40);
  job = await resetAdminPlanCredits({ now: new Date(firstReset.getTime() + 2 * 3600 * 1000) });
  ok("…once a month: running again the same day gives nothing", (await fresh(yearly)).aiCredits === 40);
  await User.updateOne({ _id: yearly._id }, { $set: { stripeSubscriptionStatus: "trialing", aiCreditsResetAt: new Date(Date.now() - 3600 * 1000) } });
  await resetAdminPlanCredits({ now: new Date() });
  ok("yearly: never during the trial (nothing paid yet)", (await fresh(yearly)).aiCredits === 40);
  await User.updateOne({ _id: yearly._id }, { $set: { stripeSubscriptionStatus: "active", aiCreditsResetAt: new Date(yEnd * 1000) } });
  await resetAdminPlanCredits({ now: new Date(yEnd * 1000 + 3600 * 1000) });
  ok("yearly: never on the renewal day (that month comes with the renewal's payment)", (await fresh(yearly)).aiCredits === 40);
  await User.updateOne({ _id: yearly._id }, { $set: { aiCreditsResetAt: firstReset } });

  // Add-ons are monthly: on a yearly plan they join its monthly date, not the year's end.
  r = await call(server, { method: "POST", path: "/api/billing/addon", token: tok(yearly), body: { addon: "credits_100" } });
  const ya = sessions[sessions.length - 1];
  const monthlyDate = Math.floor(nextMonthlyBefore(new Date(yEnd * 1000), new Date()).getTime() / 1000);
  ok("yearly: an add-on is billed on the plan's monthly date", r.status === 200 && ya.subscription_data.billing_cycle_anchor === monthlyDate && monthlyDate < NOW + 32 * DAY);

  // Pro yearly → Premium yearly mid-month: the extra credits for what is left of THIS month.
  const proYear = await mk({ name: "ProYear", email: "proyear@e.com" });
  sub("sub_py", proYear._id, { status: "active", price: "price_pro_year", start: NOW - 100 * DAY, end: NOW + 265 * DAY, customer: "cus_py", unitAmount: 12600 });
  await send(ev("customer.subscription.created", subs.get("sub_py")));
  await User.updateOne({ _id: proYear._id }, { $set: { aiCredits: 300, aiCreditsResetAt: new Date((NOW + 15 * DAY) * 1000) } });
  sub("sub_py", proYear._id, { status: "active", price: "price_premium_year", start: NOW - 100 * DAY, end: NOW + 265 * DAY, customer: "cus_py", unitAmount: 16800 });
  await send(ev("customer.subscription.updated", subs.get("sub_py")));
  u = await fresh(proYear);
  ok("yearly upgrade: about half of this month's extra 1650 credits, not a share of the year", u.plan === "premium" && u.aiCredits - 300 >= 780 && u.aiCredits - 300 <= 860, String(u.aiCredits - 300));
  delete process.env.STRIPE_BILLING_ENABLED;

  r = await send(ev("customer.subscription.updated", { ...sub("sub_ghost", "not-an-id", {}), customer: "cus_nobody" }));
  ok("an event for an unknown teacher is accepted and ignored", r.status === 200);

  const rows = await StripeEvent.find({}).lean();
  const failedRows = rows.filter((e) => e.status !== "processed");
  ok("every handled event is recorded as processed", rows.length > 0 && failedRows.length === 0);
  if (failedRows.length) console.log("    failed events:", failedRows.map((e) => `${e.type}: ${e.error}`).join(" | "));

  planLimits.reconcileStudentCap = realReconcile;
  _setStripeForTest(null);
  await new Promise((res) => server.close(res));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
