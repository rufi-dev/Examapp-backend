/*
 * AI credit metering (Phase 2). `chargeAi(operation)` gates a chargeable AI
 * route against the teacher's simple `aiCredits` balance:
 *   - resolves the operation's cost (config/teacherSuccess/aiCredits.js);
 *   - free op / billing off / admin  → pass through, no charge;
 *   - insufficient balance           → 402 "insufficient_credits" (the client
 *                                       shows a "buy credits" prompt);
 *   - otherwise attaches `req.aiCredit` with a one-shot `.usable()` that the
 *     controller calls at the genuine success point — only THEN is the balance
 *     debited (an atomic, no-go-negative $inc). So a failed generation is free.
 *
 * Gated by AI_BILLING_ENABLED (default ON). Set AI_BILLING_ENABLED=false to
 * revert to unlimited AI without touching routes.
 */
const User = require("../models/userModel");
const { httpError } = require("../utils/appError");
const { isOperation } = require("../config/teacherSuccess/aiCredits");

const BILLING_ENABLED = String(process.env.AI_BILLING_ENABLED ?? "true").toLowerCase() !== "false";

// Phase-2 credit cost per AI operation — matches the published pricing
// (config/plans.js AI_ACTION_COSTS): a full exam (AI or PDF) = 10, one rewrite
// = 2, chat + voice = free. Kept HERE (not the retired TSJ weight table) so the
// commercial pricing and the legacy ledger stay independent.
const OP_COST = {
  "ai.extract.questions": 10,
  "ai.generate.questions": 10,
  "ai.regenerate.question": 2,
  "ai.chat.message": 0,
  "ai.transcribe.audio": 0,
  "ai.realtime.session": 0,
  "ai.models.list": 0,
};

function chargeAi(operation) {
  if (!isOperation(operation)) throw new Error(`Unknown AI operation "${operation}"`); // fail fast at wire time
  const cost = OP_COST[operation] || 0;
  return (req, res, next) => {
    req.aiCredit = null;
    // Free operation, billing disabled, or a privileged admin → never charge.
    if (!BILLING_ENABLED || cost <= 0 || !req.user || req.user.role === "admin") {
      return next();
    }
    const balance = Number(req.user.aiCredits) || 0;
    if (balance < cost) {
      return next(
        httpError(
          402,
          "insufficient_credits",
          `Bu əməliyyat üçün ${cost} kredit lazımdır, balansınızda ${balance} var. «Planım» səhifəsindən kredit alın.`,
          { reason: "insufficient_credits", cost, balance }
        )
      );
    }
    // Commit exactly once, when the controller confirms a usable result. The
    // atomic $gte guard makes concurrent requests safe (never goes negative).
    let committed = false;
    req.aiCredit = {
      cost,
      usable: () => {
        if (committed) return;
        committed = true;
        User.updateOne(
          { _id: req.user._id, aiCredits: { $gte: cost } },
          { $inc: { aiCredits: -cost } }
        ).catch((e) => console.error("[AI_CREDIT] debit failed:", e.message));
      },
    };
    next();
  };
}

module.exports = { chargeAi };
