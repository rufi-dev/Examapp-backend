/*
 * AI credit middleware — RETIRED. The Teacher Success Journey credit/quota was
 * removed and AI is now UNLIMITED. `chargeAi(operation)` is kept as a no-op
 * pass-through so the AI route wiring (and the `if (req.aiCredit)` settlement
 * calls in the controllers) stay valid without editing every route. Restore the
 * reservation logic here if a metered plan ever returns.
 */
const { weightFor } = require("../config/teacherSuccess/aiCredits");

function chargeAi(operation) {
  weightFor(operation); // fail fast on a typo at wire time
  // AI credit enforcement retired — AI is UNLIMITED for teachers. This stays a
  // no-op pass-through so the route wiring is untouched; the req.aiCredit
  // settlement callers in the controllers are all guarded by `if (req.aiCredit)`,
  // so they become harmless no-ops. (Reintroduce reservation here if a metered
  // plan ever returns.)
  return (req, res, next) => next();
}

module.exports = { chargeAi };
