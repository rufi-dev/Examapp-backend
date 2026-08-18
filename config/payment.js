// Manual bank-transfer card info for paid exams — read from env at request time
// (no DB doc). Set PAYMENT_CARD_NUMBER etc. in the backend .env.
const paymentInfo = () => ({
  cardNumber: (process.env.PAYMENT_CARD_NUMBER || "").trim(),
  cardHolder: (process.env.PAYMENT_CARD_HOLDER || "").trim(),
  bank: (process.env.PAYMENT_CARD_BANK || "").trim(),
  note: (process.env.PAYMENT_NOTE || "").trim(),
});

module.exports = { paymentInfo };
