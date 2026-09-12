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

const assertPriced = (operation) => {
  // Fail fast: an unknown operation is a typo in a route, and an inactive one
  // has no price yet — neither may reach a request and charge 0.
  if (!isDeclared(operation)) throw new Error(`Unknown AI operation "${operation}"`);
  if (!isActive(operation)) throw new Error(`AI operation "${operation}" is declared but not priced yet`);
};

/*
 * The meter itself, usable from a controller as well as from a route.
 *
 * Studio needed this split. Its one route serves both a creation and an edit,
 * and which one it is — and so what it costs — is only known once the document
 * is loaded, which is inside the controller. A route-level `chargeAi(op)` has
 * to name the operation at wire time, so it could only ever have charged the
 * wrong price for one of the two. The decision the middleware makes is exactly
 * the same; it is just made a few lines later, still BEFORE the first byte of
 * the response goes out, so a 402 still arrives as a proper JSON error.
 *
 * Returns null when nothing is charged (free op, billing off, admin) — the same
 * `req.aiCredit = null` the middleware always set — or throws the 402.
 */
function meterFor(req, operation) {
  assertPriced(operation);
  const cost = OP_COST[operation] || 0;
  // Free operation, billing disabled, or a privileged admin → never charge.
  if (!BILLING_ENABLED || cost <= 0 || !req.user || req.user.role === "admin") return null;
  const balance = Number(req.user.aiCredits) || 0;
  if (balance < cost) {
    throw httpError(
      402,
      "insufficient_credits",
      `Bu əməliyyat üçün ${cost} kredit lazımdır, balansınızda ${balance} var. «Planım» səhifəsindən kredit alın.`,
      { reason: "insufficient_credits", cost, balance }
    );
  }
  // Commit exactly once, when the controller confirms a usable result. The
  // atomic $gte guard makes concurrent requests safe (never goes negative).
  let committed = false;
  return {
    cost,
    balance,
    operation,
    usable: () => {
      if (committed) return;
      committed = true;
      User.updateOne(
        { _id: req.user._id, aiCredits: { $gte: cost } },
        { $inc: { aiCredits: -cost } }
      ).catch((e) => console.error("[AI_CREDIT] debit failed:", e.message));
    },
  };
}

function chargeAi(operation) {
  assertPriced(operation); // at WIRE time, so a typo fails the boot, not a teacher
  return (req, res, next) => {
    try {
      req.aiCredit = meterFor(req, operation);
      next();
    } catch (e) {
      req.aiCredit = null;
      next(e);
    }
  };
}

module.exports = { chargeAi, meterFor };
