const Stripe = require("stripe");

let client;

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

module.exports = { required, stripeClient, priceForPlan, planForPrice, frontendUrl };
