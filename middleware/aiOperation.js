/*
 * Fail-closed guard for AI operations that are DECLARED but not yet priced.
 *
 * `chargeAi` refuses an inactive operation at wire time, which is right for a
 * route that means to charge. A route for a not-yet-priced feature still needs to
 * EXIST (so it can be wired, tested and documented) while refusing every request
 * — it must never fall through to the handler and generate for free.
 *
 * The refusal is a stable, typed 503 so the client can tell "not configured yet"
 * apart from "you are out of credits" (402 insufficient_credits).
 */
const { httpError } = require("../utils/appError");
const { isDeclared, isActive } = require("../config/aiOperations");

function requireActiveOperation(operation) {
  // Wire-time: a typo in a route name must break the boot, not a request.
  if (!isDeclared(operation)) throw new Error(`Unknown AI operation "${operation}"`);
  return (req, res, next) => {
    if (isActive(operation)) return next();
    return next(
      httpError(
        503,
        "operation_not_configured",
        "Bu AI əməliyyatı hələ qiymətləndirilməyib və istifadəyə açıq deyil.",
        { reason: "operation_not_configured", operation }
      )
    );
  };
}

module.exports = { requireActiveOperation };
