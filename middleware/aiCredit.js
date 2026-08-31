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

const BILLING_ENABLED = String(process.env.AI_BILLING_ENABLED ?? "true").toLowerCase() !== "false";

// Phase-2 credit cost per AI operation. DERIVED from the one canonical registry
// (config/aiOperations.js), which also feeds the ledger weights and the published
// pricing page — so the three can no longer disagree. A declared-but-unpriced
// operation is absent here on purpose and must be refused by the route
// (middleware/aiOperation.js requireActiveOperation), never charged 0.
const { costTable, isDeclared, isActive } = require("../config/aiOperations");

const OP_COST = costTable();

function chargeAi(operation) {
  // Fail fast at WIRE time: an unknown operation is a typo in a route, and an
  // inactive one has no price yet — neither may reach a request and charge 0.
  if (!isDeclared(operation)) throw new Error(`Unknown AI operation "${operation}"`);
  if (!isActive(operation)) throw new Error(`AI operation "${operation}" is declared but not priced yet`);
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
