/*
 * Teacher Success Journey — FROZEN customer-facing copy (ADR §3).
 *
 * These exact strings are the single source. The header, panel, and dashboard
 * card all read from here so the frozen positioning cannot drift. NEVER add
 * paywall/price/discount/urgency/subscription wording (D17).
 */

// Positioning: level is earned through activity + verified referrals, not paid.
const POSITIONING = {
  az: "Səviyyəniz ödənişlə deyil, müəllim fəaliyyətiniz və təsdiqlənmiş tövsiyələriniz əsasında yüksəlir. Bütün əsas imtahan yaratma alətləri hər səviyyədə açıqdır.",
  en: "Your level is earned through teaching activity and verified referrals. It is not a paid plan. All core exam-creation tools are available at every level.",
};

// AI: tools at every level; more active teachers get a larger monthly allowance.
const AI_EXPLANATION = {
  az: "AI alətləri bütün səviyyələrdə mövcuddur. Daha aktiv müəllimlər daha yüksək aylıq AI limiti əldə edir. Bu ödənişli paket deyil. Manual imtahan yaratmaq AI limitindən asılı deyil.",
  en: "AI tools are available at every level. More active teachers receive a larger monthly AI allowance. These are activity-based levels, not paid plans. Manual exam creation never requires AI credits.",
};

// Tokens that must NEVER appear in Journey copy (guarded by a test).
const BANNED_TERMS = [
  "paywall",
  "subscription",
  "subscribe",
  "discount",
  "upgrade by paying",
  "$",
  "azn",
  "price",
  "pricing",
  "checkout",
  "billing",
];

module.exports = { POSITIONING, AI_EXPLANATION, BANNED_TERMS };
