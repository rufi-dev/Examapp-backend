const Stripe = require("stripe");
const { CREDIT_TOPUPS, STORAGE_PACKS } = require("./plans");

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

// Each plan is sold by the month and, 30% off, by the year (2026-10-31).
const PRICE_ENV = {
  pro: { month: "STRIPE_PRICE_PRO_MONTHLY", year: "STRIPE_PRICE_PRO_YEARLY" },
  premium: { month: "STRIPE_PRICE_PREMIUM_MONTHLY", year: "STRIPE_PRICE_PREMIUM_YEARLY" },
};
const INTERVALS = ["month", "year"];

const priceForPlan = (plan, interval = "month") => {
  const name = PRICE_ENV[plan]?.[interval === "year" ? "year" : "month"];
  return name ? String(process.env[name] || "").trim() : "";
};

// Which plan, and how often it is paid, a Stripe price stands for.
const planOfPrice = (priceId) => {
  const id = String(priceId || "");
  if (!id) return null;
  for (const plan of Object.keys(PRICE_ENV)) {
    for (const interval of INTERVALS) {
      if (id === priceForPlan(plan, interval)) return { plan, interval };
    }
  }
  return null;
};

const planForPrice = (priceId) => planOfPrice(priceId)?.plan || null;

// Yearly is offered only once both plans have their yearly price.
const annualConfigured = () => !!priceForPlan("pro", "year") && !!priceForPlan("premium", "year");

const frontendUrl = () => String(process.env.FRONTEND_URL || "https://examopia.com").replace(/\/$/, "");

/*
 * How every Stripe page we open looks (owner, 2026-11-03: "make it look
 * professional"): the Examopia logo and icon, the app's blue on the button, its
 * page background, Inter, rounded corners. The images live on the public site
 * (Frontend/public/brand/stripe) so Stripe can fetch them from any environment,
 * a local server included. STRIPE_CHECKOUT_BRANDING=off drops it, should Stripe
 * ever refuse it.
 */
const BRAND_ASSETS = () => String(process.env.STRIPE_BRAND_ASSET_URL || "https://examopia.com").replace(/\/$/, "");
const checkoutBranding = () =>
  String(process.env.STRIPE_CHECKOUT_BRANDING || "").toLowerCase() === "off"
    ? {}
    : {
        branding_settings: {
          display_name: "Examopia",
          logo: { type: "url", url: `${BRAND_ASSETS()}/brand/stripe/logo.png` },
          icon: { type: "url", url: `${BRAND_ASSETS()}/brand/stripe/icon-512.png` },
          button_color: "#445CCA",
          background_color: "#F4F6F9",
          border_style: "rounded",
          font_family: "inter",
        },
      };
// A portal configuration made through the API is not the account default, so the
// session has to name it; unset = Stripe's default configuration.
const portalConfiguration = () => String(process.env.STRIPE_PORTAL_CONFIGURATION || "").trim();

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

/*
 * Monthly add-ons sold on top of a card subscription: AI credit packs and extra
 * storage, at the prices the catalog shows. Each is its own small subscription
 * whose billing date is pinned to the plan's, so a teacher is charged once a
 * month for everything. Stripe finds the price by lookup key, so sandbox and
 * live need no extra configuration.
 */
const ADDONS = Object.freeze(
  Object.fromEntries([
    ...CREDIT_TOPUPS.map((t) => [`credits_${t.credits}`, Object.freeze({ key: `credits_${t.credits}`, credits: t.credits, gb: 0, priceAzn: t.priceAzn })]),
    ...STORAGE_PACKS.map((t) => [`storage_${t.gb}`, Object.freeze({ key: `storage_${t.gb}`, credits: 0, gb: t.gb, priceAzn: t.priceAzn })]),
  ])
);
const addonLookupKey = (key) => `addon_${key}_v1`;

let addonPriceCache = { key: "", at: 0, prices: null };
async function addonPrices() {
  const key = String(process.env.STRIPE_SECRET_KEY || "");
  if (addonPriceCache.prices && addonPriceCache.key === key && Date.now() - addonPriceCache.at < 10 * 60 * 1000) {
    return addonPriceCache.prices;
  }
  const list = await stripeClient().prices.list({ lookup_keys: Object.keys(ADDONS).map(addonLookupKey), active: true, limit: 20 });
  const prices = {};
  for (const price of list.data || []) {
    const addon = Object.keys(ADDONS).find((k) => addonLookupKey(k) === price.lookup_key);
    if (addon) prices[addon] = price.id;
  }
  addonPriceCache = { key, at: Date.now(), prices };
  return prices;
}

// Tests swap in a fake client; nothing else may call this.
const _setStripeForTest = (fake) => {
  testClient = fake || null;
  addonPriceCache = { key: "", at: 0, prices: null };
};

module.exports = {
  required,
  stripeClient,
  priceForPlan,
  planForPrice,
  planOfPrice,
  annualConfigured,
  frontendUrl,
  checkoutBranding,
  portalConfiguration,
  trialDays,
  trialCredits,
  billingOpen,
  billingEnabledFor,
  ADDONS,
  addonLookupKey,
  addonPrices,
  _setStripeForTest,
};
