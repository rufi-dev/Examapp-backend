const Stripe = require("stripe");

let client;
let testClient = null;

const required = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    const error = new Error(`${name} is not configured`);
    error.code = "stripe_not_configured";
    error.status = 503;
    throw error;
  }
  return value;
};

function stripeClient() {
  if (testClient) return testClient;
  const key = required("STRIPE_SECRET_KEY");
  if (!client || client._examopiaKey !== key) {
    // stripe@23 exposes the Node client as the Stripe constructor. Keep this
    // instance private and reuse it; the secret is never returned to callers.
    client = new Stripe(key, { apiVersion: Stripe.API_VERSION });
    Object.defineProperty(client, "_examopiaKey", { value: key, enumerable: false });
  }
  return client;
}

const priceForPlan = (plan) => {
  if (plan === "pro") return String(process.env.STRIPE_PRICE_PRO_MONTHLY || "").trim();
  if (plan === "premium") return String(process.env.STRIPE_PRICE_PREMIUM_MONTHLY || "").trim();
  return "";
};

const planForPrice = (priceId) => {
  const id = String(priceId || "");
  if (id && id === priceForPlan("pro")) return "pro";
  if (id && id === priceForPlan("premium")) return "premium";
  return null;
};

const frontendUrl = () => String(process.env.FRONTEND_URL || "https://examopia.com").replace(/\/$/, "");

const wholeNumber = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
};
// 0 turns the trial off. The trial grants a smaller credit pack than a paid month,
// so "start a trial, spend a month of AI, cancel" is not worth doing.
const trialDays = () => wholeNumber(process.env.BILLING_TRIAL_DAYS, 7);
const trialCredits = () => wholeNumber(process.env.BILLING_TRIAL_CREDITS, 100);

/*
 * Who is offered card billing. STRIPE_BILLING_ENABLED=true opens it to every
 * teacher; until then only admins and the emails in STRIPE_BILLING_TESTERS see it.
 * Without this gate a sandbox key would show real teachers a test-mode Checkout
 * the moment any frontend build shipped.
 */
const billingOpen = () =>
  !!String(process.env.STRIPE_SECRET_KEY || "").trim() &&
  ["true", "1", "all"].includes(String(process.env.STRIPE_BILLING_ENABLED || "").trim().toLowerCase());

function billingEnabledFor(user) {
  if (!String(process.env.STRIPE_SECRET_KEY || "").trim()) return false;
  if (billingOpen() || user?.role === "admin") return true;
  const email = String(user?.email || "").trim().toLowerCase();
  const testers = String(process.env.STRIPE_BILLING_TESTERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!email && testers.includes(email);
}

// Tests swap in a fake client; nothing else may call this.
const _setStripeForTest = (fake) => {
  testClient = fake || null;
};

module.exports = {
  required,
  stripeClient,
  priceForPlan,
  planForPrice,
  frontendUrl,
  trialDays,
  trialCredits,
  billingOpen,
  billingEnabledFor,
  _setStripeForTest,
};
