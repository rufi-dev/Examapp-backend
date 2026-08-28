// PAID PACKAGES — the single source of truth for the Pulsuz / Pro / Premium
// tiers and their per-tier LIMITS. This is a NEW, commercial dimension and is
// deliberately SEPARATE from `teacherLevel` (spark/momentum/impact), which is
// recognition-only and must never be read in an authorization decision. Plan
// limits are enforced by explicit count/allowance checks in the controllers
// (see helper/planLimits.js) — never through the capability system.
//
// Limits use `Infinity` for "unlimited". Prices are in AZN (manat) per month.
// Credit fields (welcome/monthly) are declared here for the UI + Phase 2, but
// AI credit metering is NOT enforced yet (AI stays unlimited until Phase 2).
//
// Every numeric is env-overridable (mirrors config/teacherSuccess/allowances.js)
// so pricing/limits can change without a code deploy.

const num = (envKey, fallback) => {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const PLAN_IDS = ["free", "pro", "premium"];

// Per-tier definition. `limits`: enforced (classes/students concurrent caps;
// examCreations is a DECREMENTING lifetime allowance — see planLimits.js).
// `features`: booleans surfaced to the UI (mostly Phase 2 / informational now).
const PLANS = {
  free: {
    id: "free",
    label: "Pulsuz",
    priceAzn: num("PLAN_PRICE_FREE", 0),
    limits: {
      classes: num("PLAN_FREE_CLASSES", 1),
      students: num("PLAN_FREE_STUDENTS", 10),
      examCreations: num("PLAN_FREE_EXAMS", 3), // lifetime allowance, non-restoring
    },
    credits: { welcome: num("PLAN_FREE_WELCOME_CREDITS", 60), monthly: num("PLAN_FREE_MONTHLY_CREDITS", 20) },
    // Live monitoring ("Canlı izlə") is FREE for everyone — it is not enforced by
    // plan anywhere, so the pricing card reflects that (available on every tier).
    features: { whatsapp: false, teacherWhatsApp: false, analytics: "basic", pdfExport: false, prioritySupport: false, liveExams: true },
  },
  pro: {
    id: "pro",
    label: "Pro",
    priceAzn: num("PLAN_PRICE_PRO", 15),
    limits: {
      classes: num("PLAN_PRO_CLASSES", 5),
      students: num("PLAN_PRO_STUDENTS", 40),
      examCreations: Infinity,
    },
    credits: { welcome: 0, monthly: num("PLAN_PRO_MONTHLY_CREDITS", 350) },
    // `whatsapp` = parent notifications (sent from the platform number).
    // `teacherWhatsApp` = linking the teacher's OWN number — Premium only, because
    // each linked number costs a headless browser on the server.
    features: { whatsapp: true, teacherWhatsApp: false, analytics: "full", pdfExport: true, prioritySupport: true, liveExams: true },
  },
  premium: {
    id: "premium",
    label: "Premium",
    priceAzn: num("PLAN_PRICE_PREMIUM", 20),
    limits: {
      classes: Infinity,
      students: Infinity,
      examCreations: Infinity,
    },
    credits: { welcome: 0, monthly: num("PLAN_PREMIUM_MONTHLY_CREDITS", 2000) },
    features: { whatsapp: true, teacherWhatsApp: true, analytics: "full", pdfExport: true, prioritySupport: true, liveExams: true },
  },
};

// One-off credit top-ups (Phase 2 for enforcement; shown on the pricing page now).
const CREDIT_TOPUPS = [
  { credits: 100, priceAzn: num("PLAN_TOPUP_100_AZN", 5) },
  { credits: 300, priceAzn: num("PLAN_TOPUP_300_AZN", 12) },
];

// Per-action AI credit costs (Phase 2 — informational on the pricing page now).
const AI_ACTION_COSTS = {
  generateExam: 10,
  rewriteQuestion: 2,
  supportChat: 0,
};

// Card the teacher transfers to for a manual upgrade. All env-driven so the
// number/holder can change without a code deploy (edit .env + restart backend).
const paymentInfo = () => ({
  cardNumber: (process.env.PAYMENT_CARD_NUMBER || "").trim(),
  cardHolder: (process.env.PAYMENT_CARD_HOLDER || "").trim(),
  bank: (process.env.PAYMENT_CARD_BANK || "").trim(),
  note: (process.env.PAYMENT_NOTE || "").trim(),
});

// Grandfather-safe: an unknown / missing plan is treated as free, so existing
// users (whose docs predate the field) resolve to the free tier automatically.
const normalizePlan = (plan) => (PLAN_IDS.includes(plan) ? plan : "free");

const planDef = (plan) => PLANS[normalizePlan(plan)];
const limitsFor = (plan) => planDef(plan).limits;
const featuresFor = (plan) => planDef(plan).features;
const isUnlimited = (v) => v === Infinity || v === null || v === undefined;

module.exports = {
  PLAN_IDS,
  PLANS,
  CREDIT_TOPUPS,
  AI_ACTION_COSTS,
  normalizePlan,
  planDef,
  limitsFor,
  featuresFor,
  isUnlimited,
  paymentInfo,
};
