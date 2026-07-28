/*
 * Teacher Success Journey — central AI operation -> credit weight table
 * (ADR §8.1 / Appendix B). Grounded in controllers/aiController.js.
 *
 * The CLIENT NEVER supplies a cost. The server resolves the weight from a
 * stable operation name. Weights are validated config (non-negative safe
 * integers). Streaming variants MUST share the same operation name as their
 * non-streaming counterpart so a reconnect keyed by the same idempotency key
 * cannot double-charge (D12). Essential grading/finalization is NOT here (D13).
 */

// stable operation name -> integer credit weight
const WEIGHTS = {
  "ai.extract.questions": 5, // POST /extractQuestions[/Stream]/:examId
  "ai.generate.questions": 5, // POST /generateQuestions[/Stream]/:examId
  "ai.regenerate.question": 1, // POST /regenerateQuestion/:examId
  "ai.chat.message": 1, // POST /chat
  "ai.transcribe.audio": 2, // POST /transcribe
  "ai.realtime.session": 5, // POST /realtime-token
  "ai.models.list": 0, // GET /ai/models — no provider call, not chargeable
};

// Operations a large-action UI must show the cost for before confirming.
const CONFIRM_BEFORE = new Set(["ai.extract.questions", "ai.generate.questions", "ai.realtime.session"]);

const OPERATIONS = Object.keys(WEIGHTS);
const isOperation = (op) => Object.prototype.hasOwnProperty.call(WEIGHTS, op);

// Resolve the trusted weight. Unknown op -> throw (never silently 0-charge a
// forged/unmapped operation).
function weightFor(op) {
  if (!isOperation(op)) throw new Error(`Unknown AI operation "${op}"`);
  return WEIGHTS[op];
}

// A chargeable/optional op is one with a positive weight (models.list is free).
const isChargeable = (op) => isOperation(op) && WEIGHTS[op] > 0;

module.exports = { WEIGHTS, CONFIRM_BEFORE, OPERATIONS, isOperation, weightFor, isChargeable };
