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
    create: async () => ({ id: `cus_${sessions.length + 1}_${Math.random().toString(36).slice(2, 6)}` }),
  },
  checkout: {
    sessions: {
      create: async (p) => {
        sessions.push(p);
        const id = `cs_${sessions.length}`;
        checkoutState.set(id, { id, customer: p.customer, mode: p.mode, status: "open" });
        return { id, url: `https://checkout.stripe.test/${sessions.length}` };
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
  charges: { retrieve: async () => ({}) },
  // payment_intent → invoice, as Stripe's invoice_payments list answers it.
  invoicePayments: {
    list: async ({ payment }) => ({ data: paidBy.has(payment?.payment_intent) ? [{ invoice: paidBy.get(payment.payment_intent) }] : [] }),
  },
};
const paidBy = new Map();
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
  const fresh = (u) => User.findById(u._id).select("+stripeSubscriptionId +stripeSubscriptionStatus +stripeCurrentPeriodEnd +stripeCancelAtPeriodEnd +stripeCancelAt +stripeTrialEnd +stripeTrialUsedAt +stripeLastCreditedInvoiceId +stripeAddons plan planSource planExpiresAt planDowngradedAt aiCredits aiCreditsResetAt addonCreditsMonthly cardStorageGb cardStorageUntil").lean();
  const setCredits = (u, n) => User.updateOne({ _id: u._id }, { $set: { aiCredits: n } });

  const app = express();
  app.post("/api/billing/stripe/webhook", express.raw({ type: "application/json" }), webhook);
  app.use(express.json());
  app.use("/api/billing", require("../../routes/stripeBillingRoute"));
  app.get("/api/plan/catalog", getCatalog);
  app.get("/api/users/getUser", protect, getUser);
  app.get("/api/teach", protect, teacherOnly, (req, res) => res.json({ ok: true }));
  app.get("/api/cap", protect, requireCapability("exam:manage:own"), (req, res) => res.json({ ok: true }));
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
  r = await call(server, { path: "/api/teach", token: tok(teacher) });
  ok("wall off: a teacher without a plan works as before", r.status === 200);
  process.env.TEACHER_PAYWALL = "on";
  r = await call(server, { path: "/api/teach", token: tok(teacher) });
  ok("wall: a teacher without a plan is stopped on teacher routes (402 subscription_required)", r.status === 402 && r.body.code === "subscription_required");
  r = await call(server, { path: "/api/cap", token: tok(teacher) });
  ok("wall: …and on capability routes (AI, exams)", r.status === 402);
  r = await call(server, { path: "/api/billing/status", token: tok(teacher) });
  ok("wall: subscribing itself stays open, and says the wall is up", r.status === 200 && r.body.paywall === true);
  r = await call(server, { path: "/api/users/getUser", token: tok(teacher) });
  ok("wall: the account data tells the app to show the wall", r.status === 200 && r.body.paywall === true);
  r = await call(server, { path: "/api/teach", token: tok(manual) });
  ok("wall: a plan the admin set gets through without paying", r.status === 200);
  r = await call(server, { path: "/api/users/getUser", token: tok(manual) });
  ok("wall: …and is not shown the wall", r.body.paywall === false);
  r = await call(server, { path: "/api/teach", token: tok(lapsed) });
  ok("wall: an admin plan that has ended is stopped", r.status === 402);
  r = await call(server, { path: "/api/cap", token: tok(admin) });
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
  const racer = await mk({ name: "Racer", email: "racer@e.com", stripeCustomerId: "cus_race" });
  sub("sub_race", racer._id, { status: "trialing", customer: "cus_race", trialEnd: NOW + 7 * DAY, end: NOW + 7 * DAY });
  const before = sessions.length;
  r = await call(server, { method: "POST", path: "/api/billing/checkout", token: tok(racer), body: { plan: "pro" } });
  let raced = await fresh(racer);
  ok("Checkout: Stripe already has their plan (webhook not here yet) → 409, no second Checkout", r.status === 409 && sessions.length === before);
  ok("Checkout: …and the account is brought up to date from Stripe right then", raced.plan === "pro" && raced.stripeSubscriptionId === "sub_race" && raced.stripeSubscriptionStatus === "trialing");
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
  r = await send(ev("customer.subscription.created", subs.get("sub_t")));
  let u = await fresh(tester);
  ok("trial: webhook 200", r.status === 200);
  ok("trial: teacher is on Pro from Stripe", u.plan === "pro" && u.planSource === "stripe" && u.stripeSubscriptionStatus === "trialing");
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

  // ── card fails at renewal: past_due keeps the plan while Stripe retries ──
  sub("sub_t", tester._id, { status: "past_due", end: end2, customer: "cus_t" });
  await send(ev("invoice.payment_failed", invoice("in_3", "sub_t")));
  u = await fresh(tester);
  ok("past_due: still Pro, status recorded, no credits", u.plan === "pro" && u.stripeSubscriptionStatus === "past_due" && u.aiCredits === 350);
  ok("past_due: the plan holds 7 days from the missed payment, not a whole unpaid month", near(u.planExpiresAt, NOW * 1000 + 7 * DAY * 1000));
  sub("sub_t", tester._id, { status: "active", end: end2, customer: "cus_t" });
  await send(ev("customer.subscription.updated", subs.get("sub_t")));

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

  // ── subscription ends ──
  sub("sub_t", tester._id, { status: "canceled", end: end2, customer: "cus_t" });
  await send(ev("customer.subscription.deleted", subs.get("sub_t")));
  u = await fresh(tester);
  ok("ended: back to Free, marked downgraded, no expiry", u.plan === "free" && !!u.planDowngradedAt && u.planExpiresAt === null);
  ok("ended: roster reconciled on the downgrade", reconciles === 2);
  const endSoon = (s) => s.cancel_at > NOW && s.cancel_at < Math.floor(Date.now() / 1000) + 400;
  ok("ended: the add-ons end within minutes too", endSoon(subs.get("sub_a1")) && endSoon(subs.get("sub_a2")));
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
