/*
 * Refund rule (owner's decision, 2026-10-26; published on /refund):
 * a paid month is refundable within 7 days of the payment, and only while no AI
 * credits have been spent since that payment. Using classes or exams by hand does
 * not count; spending AI credits does (middleware/aiCredit.js stamps the time).
 *
 * Takes a user carrying aiCreditsLastSpentAt, stripeLastPaidAt,
 * stripeLastCreditedInvoiceId and stripeRefundedInvoiceId.
 */
const REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function refundStatus(user, now = new Date()) {
  const paidAt = user?.stripeLastPaidAt ? new Date(user.stripeLastPaidAt) : null;
  if (!paidAt) return { eligible: false, reason: "no_payment", until: null };
  const until = new Date(paidAt.getTime() + REFUND_WINDOW_MS);
  if (user.stripeRefundedInvoiceId && user.stripeRefundedInvoiceId === user.stripeLastCreditedInvoiceId) {
    return { eligible: false, reason: "refunded", until };
  }
  if (now > until) return { eligible: false, reason: "window_passed", until };
  const spentAt = user.aiCreditsLastSpentAt ? new Date(user.aiCreditsLastSpentAt) : null;
  if (spentAt && spentAt > paidAt) return { eligible: false, reason: "credits_used", until };
  return { eligible: true, reason: null, until };
}

module.exports = { refundStatus, REFUND_WINDOW_MS };
