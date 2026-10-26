/*
 * Stripe Billing against a fake Stripe client and really signed webhooks: who is
 * offered card billing, the 7-day trial in Checkout, the API-2025 field moves (the
 * period on subscription items, the invoice's subscription under `parent`), a
 * portal cancel's `cancel_at`, credits granted exactly once, the downgrade, and the
 * cases that must NOT touch a plan (an admin-set plan, a stale subscription).
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
process.env.STRIPE_BILLING_TESTERS = "Tester@e.com, m@e.com";
delete process.env.STRIPE_BILLING_ENABLED;
delete process.env.BILLING_TRIAL_DAYS;
delete process.env.BILLING_TRIAL_CREDITS;

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
const { _setStripeForTest } = require("../../config/stripe");
const { webhook } = require("../../controllers/stripeBillingController");
const { getCatalog } = require("../../controllers/planController");
const planLimits = require("../../helper/planLimits");

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
const fake = {
  webhooks: signer,
  customers: {
    retrieve: async (id) => ({ id }),
    create: async () => ({ id: `cus_${sessions.length + 1}_${Math.random().toString(36).slice(2, 6)}` }),
  },
  checkout: { sessions: { create: async (p) => { sessions.push(p); return { id: `cs_${sessions.length}`, url: `https://checkout.stripe.test/${sessions.length}` }; } } },
  billingPortal: { sessions: { create: async () => ({ url: "https://billing.stripe.test/p" }) } },
  subscriptions: {
    retrieve: async (id) => {
      if (!subs.has(id)) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
      return JSON.parse(JSON.stringify(subs.get(id)));
    },
  },
  charges: { retrieve: async () => ({}) },
};
_setStripeForTest(fake);

function sub(id, userId, { status = "active", price = "price_pro", start = NOW, end = NOW + 30 * DAY, trialEnd = null, cancelAt = null, customer = "cus_x" } = {}) {
  const s = {
    id, object: "subscription", status, customer,
    metadata: { examopia_user_id: String(userId) },
    cancel_at: cancelAt, cancel_at_period_end: false, trial_end: trialEnd,
    // API 2026: no current_period_end on the subscription itself.
    items: { data: [{ id: `si_${id}`, current_period_start: start, current_period_end: end, price: { id: price } }] },
  };
  subs.set(id, s);
  return s;
}
let evn = 0;
const ev = (type, object, id) => ({ id: id || `evt_${++evn}`, object: "event", type, data: { object } });
// Lines as Stripe sends them: API 2026 nests the subscription item under `parent`,
// older versions put `type: "subscription"` and `proration` on the line itself.
const invoice = (id, subscriptionId, { reason = "subscription_cycle", subtotal = 1500, legacy = false, proration = false, lines = true } = {}) => ({
  id, object: "invoice", billing_reason: reason, subtotal, amount_paid: subtotal, status: "paid",
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
  const tok = (u) => generateToken(u._id, u.sessionVersion);
  const fresh = (u) => User.findById(u._id).select("+stripeSubscriptionId +stripeSubscriptionStatus +stripeCurrentPeriodEnd +stripeCancelAtPeriodEnd +stripeCancelAt +stripeTrialEnd +stripeTrialUsedAt +stripeLastCreditedInvoiceId plan planSource planExpiresAt planDowngradedAt aiCredits").lean();

  const app = express();
  app.post("/api/billing/stripe/webhook", express.raw({ type: "application/json" }), webhook);
  app.use(express.json());
  app.use("/api/billing", require("../../routes/stripeBillingRoute"));
  app.get("/api/plan/catalog", getCatalog);
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
  process.env.STRIPE_BILLING_ENABLED = "true";
  r = await call(server, { path: "/api/plan/catalog" });
  ok("public catalog: card billing + trial days once open", r.body.cardBilling && r.body.cardBilling.trialDays === 7);
  r = await call(server, { path: "/api/billing/status", token: tok(teacher) });
  ok("gate open: every teacher sees it", r.body.configured === true);
  delete process.env.STRIPE_BILLING_ENABLED;

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
  r = await send(ev("customer.subscription.created", subs.get("sub_t")));
  let u = await fresh(tester);
  ok("trial: webhook 200", r.status === 200);
  ok("trial: teacher is on Pro from Stripe", u.plan === "pro" && u.planSource === "stripe" && u.stripeSubscriptionStatus === "trialing");
  ok("trial: plan runs to the trial end + 2 days grace", near(u.planExpiresAt, trialEnd * 1000 + GRACE));
  ok("trial: period end read from the subscription item", near(u.stripeCurrentPeriodEnd, trialEnd * 1000));
  ok("trial: trial end stored", near(u.stripeTrialEnd, trialEnd * 1000));
  ok("trial: +100 trial credits, stamped as used", u.aiCredits === 105 && !!u.stripeTrialUsedAt);
  ok("trial: roster reconciled on the upgrade", reconciles === 1);
  await send(ev("checkout.session.completed", { mode: "subscription", subscription: "sub_t" }));
  await send(ev("customer.subscription.updated", subs.get("sub_t")));
  u = await fresh(tester);
  ok("trial: credits are granted once, not per event", u.aiCredits === 105 && reconciles === 1);
  await send(ev("invoice.paid", invoice("in_trial", "sub_t", { reason: "subscription_create", subtotal: 0 })));
  u = await fresh(tester);
  ok("trial: the 0 ₼ trial invoice grants no monthly credits", u.aiCredits === 105);
  r = await call(server, { path: "/api/billing/status", token: tok(tester) });
  ok("status: trialing, trial end, no second trial", r.body.subscriptionStatus === "trialing" && near(r.body.trialEnd, trialEnd * 1000) && r.body.trialEligible === false);
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(tester), body: { plan: "premium" } });
  ok("Checkout: refused with 409 while a subscription is live", r.status === 409);

  // ── trial converts: the first real charge ──
  const end2 = NOW + 37 * DAY;
  sub("sub_t", tester._id, { status: "active", end: end2, customer: "cus_t" });
  const firstPaid = ev("invoice.paid", invoice("in_1", "sub_t"));
  r = await send(firstPaid);
  u = await fresh(tester);
  ok("paid month: invoice → subscription via invoice.parent (API 2026)", r.status === 200 && u.stripeSubscriptionStatus === "active");
  ok("paid month: +350 Pro monthly credits", u.aiCredits === 455 && u.stripeLastCreditedInvoiceId === "in_1");
  ok("paid month: plan runs to the new period end + grace", near(u.planExpiresAt, end2 * 1000 + GRACE));
  await send(firstPaid);
  await send(ev("invoice.paid", invoice("in_1", "sub_t")));
  u = await fresh(tester);
  ok("paid month: a replayed event or a second event for the same invoice grants nothing", u.aiCredits === 455);
  await send(ev("invoice.paid", invoice("in_2", "sub_t", { legacy: true })));
  u = await fresh(tester);
  ok("paid month: an older-API invoice (invoice.subscription) still works", u.aiCredits === 805);
  await send(ev("invoice.paid", invoice("in_early", "sub_t", { reason: "subscription_update" })));
  u = await fresh(tester);
  ok("paid month: a trial ended early bills a full month as subscription_update, and it counts", u.aiCredits === 1155);
  await send(ev("invoice.paid", invoice("in_nolines", "sub_t", { lines: false })));
  u = await fresh(tester);
  ok("paid month: an invoice without lines falls back to its billing reason", u.aiCredits === 1505);
  const audits = await MaintenanceAudit.find({ actor: "stripe", "target.userId": String(tester._id) }).lean();
  ok("credits: every Stripe grant leaves an audit row", audits.length === 5);

  // ── card fails at renewal: past_due keeps the plan while Stripe retries ──
  sub("sub_t", tester._id, { status: "past_due", end: end2, customer: "cus_t" });
  await send(ev("invoice.payment_failed", invoice("in_3", "sub_t")));
  u = await fresh(tester);
  ok("past_due: still Pro, status recorded, no credits", u.plan === "pro" && u.stripeSubscriptionStatus === "past_due" && u.aiCredits === 1505);
  ok("past_due: the plan holds 7 days from the missed payment, not a whole unpaid month", near(u.planExpiresAt, NOW * 1000 + 7 * DAY * 1000));
  sub("sub_t", tester._id, { status: "active", end: end2, customer: "cus_t" });
  await send(ev("customer.subscription.updated", subs.get("sub_t")));

  // ── portal cancel: cancel_at, not cancel_at_period_end ──
  sub("sub_t", tester._id, { status: "active", end: end2, cancelAt: end2, customer: "cus_t" });
  await send(ev("customer.subscription.updated", subs.get("sub_t")));
  u = await fresh(tester);
  ok("portal cancel: marked as ending, with the date", u.stripeCancelAtPeriodEnd === true && near(u.stripeCancelAt, end2 * 1000));
  ok("portal cancel: still Pro until then", u.plan === "pro" && near(u.planExpiresAt, end2 * 1000 + GRACE));
  r = await call(server, { path: "/api/billing/status", token: tok(tester) });
  ok("status: cancelAtPeriodEnd + cancelAt for the UI", r.body.cancelAtPeriodEnd === true && near(r.body.cancelAt, end2 * 1000));

  // ── subscription ends ──
  sub("sub_t", tester._id, { status: "canceled", end: end2, customer: "cus_t" });
  await send(ev("customer.subscription.deleted", subs.get("sub_t")));
  u = await fresh(tester);
  ok("ended: back to Free, marked downgraded, no expiry", u.plan === "free" && !!u.planDowngradedAt && u.planExpiresAt === null);
  ok("ended: roster reconciled on the downgrade", reconciles === 2);
  r = await call(server, { path: "/api/billing/status", token: tok(tester) });
  ok("ended: no second trial for this teacher", r.body.trialEligible === false);

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

  r = await send(ev("customer.subscription.updated", { ...sub("sub_ghost", "not-an-id", {}), customer: "cus_nobody" }));
  ok("an event for an unknown teacher is accepted and ignored", r.status === 200);

  const rows = await StripeEvent.find({}).lean();
  ok("every handled event is recorded as processed", rows.length > 0 && rows.every((e) => e.status === "processed"));

  planLimits.reconcileStudentCap = realReconcile;
  _setStripeForTest(null);
  await new Promise((res) => server.close(res));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
