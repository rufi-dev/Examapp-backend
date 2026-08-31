/*
 * CR-MSO-006 — the ONE canonical AI operation registry.
 *
 * Before this module the same operations were described by three tables that
 * nothing kept in agreement:
 *   - middleware/aiCredit.js  OP_COST          (the enforced price)
 *   - config/teacherSuccess/aiCredits.js WEIGHTS (the ledger weight)
 *   - config/plans.js AI_ACTION_COSTS         (the published price, under DIFFERENT keys)
 * All three are now PROJECTIONS of the table below. No number changed when this
 * landed — the consolidation is deliberately price-neutral, so reconciling the
 * cost/ledgerWeight difference stays a separate, visible decision.
 *
 * This module must stay SIDE-EFFECT FREE and require NOTHING: config/plans.js
 * imports it and is itself loaded during boot validation, and
 * middleware/aiCredit.js -> models/userModel -> controllers/userController ->
 * config/plans.js is a real cycle if this file ever pulls in a model.
 * tests/ai-operations-config.test.js walks the require graph and fails on a cycle.
 *
 * `active: false` means DECLARED BUT NOT SELLABLE — the operation exists so
 * routes, tests and docs can name it, but it has no price yet. An inactive
 * operation is invisible to every projection (so it can never silently charge 0)
 * and its route must fail closed; see requireActiveOperation in
 * middleware/aiOperation.js.
 */

// stable operation name -> { cost, ledgerWeight, confirmBefore, active, display }
//   cost          — credits charged by middleware/aiCredit.js (the enforced price)
//   ledgerWeight  — weight recorded by the Teacher-Success credit ledger
//   confirmBefore — a large action whose cost the UI must show before confirming
//   display       — key under which config/plans.js publishes the price, or null
//                   when the operation is not on the public pricing list
const AI_OPERATIONS = {
  "ai.extract.questions": { cost: 10, ledgerWeight: 5, confirmBefore: true, active: true, display: "generateExam" },
  "ai.generate.questions": { cost: 10, ledgerWeight: 5, confirmBefore: true, active: true, display: "generateExam" },
  "ai.regenerate.question": { cost: 2, ledgerWeight: 1, confirmBefore: false, active: true, display: "rewriteQuestion" },
  "ai.chat.message": { cost: 0, ledgerWeight: 1, confirmBefore: false, active: true, display: "supportChat" },
  "ai.transcribe.audio": { cost: 0, ledgerWeight: 2, confirmBefore: false, active: true, display: null },
  "ai.realtime.session": { cost: 0, ledgerWeight: 5, confirmBefore: true, active: true, display: null },
  "ai.models.list": { cost: 0, ledgerWeight: 0, confirmBefore: false, active: true, display: null },

  // ---- document generation ----
  // Priced against the work actually done, on the existing 10-for-a-full-exam
  // scale. An MSO is a full two-variant paper with an answer key, solutions and an
  // analytics table — at least an exam's worth of generation — so it matches
  // ai.generate.questions. A lesson plan is one smaller document: it sits between
  // a rewrite (2) and a full exam (10). The ledger weights keep the same 2:1 ratio
  // to cost that every existing operation uses.
  "ai.generate.mso": { cost: 10, ledgerWeight: 5, confirmBefore: true, active: true, display: "generateMso" },
  "ai.generate.lessonplan": { cost: 6, ledgerWeight: 3, confirmBefore: true, active: true, display: "generateLessonPlan" },
};

const OPERATION_NAMES = Object.keys(AI_OPERATIONS);
const has = (op) => Object.prototype.hasOwnProperty.call(AI_OPERATIONS, op);

// Declared at all (active or not) — for routing, docs and tests.
const isDeclared = (op) => has(op);
// Priced and sellable. Everything that charges must go through this.
const isActive = (op) => has(op) && AI_OPERATIONS[op].active === true;
const activeOperations = () => OPERATION_NAMES.filter(isActive);

function operationConfig(op) {
  if (!has(op)) throw new Error(`Unknown AI operation "${op}"`);
  return AI_OPERATIONS[op];
}

// Resolve a trusted price. An unknown OR inactive operation throws — never a
// silent 0-charge for a forged or not-yet-priced operation.
function costFor(op) {
  const cfg = operationConfig(op);
  if (!cfg.active) throw new Error(`AI operation "${op}" is declared but not priced yet`);
  return cfg.cost;
}

function ledgerWeightFor(op) {
  const cfg = operationConfig(op);
  if (!cfg.active) throw new Error(`AI operation "${op}" is declared but not priced yet`);
  return cfg.ledgerWeight;
}

// ---- the three projections (active operations only) ----

const costTable = () =>
  Object.fromEntries(activeOperations().map((op) => [op, AI_OPERATIONS[op].cost]));

const ledgerWeightTable = () =>
  Object.fromEntries(activeOperations().map((op) => [op, AI_OPERATIONS[op].ledgerWeight]));

const confirmBeforeSet = () =>
  new Set(activeOperations().filter((op) => AI_OPERATIONS[op].confirmBefore));

// The published pricing list. Several operations may share one display key
// (extraction and generation are both "a full exam"); when they do, their prices
// must agree, or the pricing page would show a number nobody is charged.
function displayCosts() {
  const out = {};
  for (const op of activeOperations()) {
    const { display, cost } = AI_OPERATIONS[op];
    if (!display) continue;
    if (out[display] !== undefined && out[display] !== cost) {
      throw new Error(
        `AI pricing conflict: "${display}" is published as ${out[display]} but "${op}" costs ${cost}`
      );
    }
    out[display] = cost;
  }
  return out;
}

module.exports = {
  AI_OPERATIONS,
  OPERATION_NAMES,
  isDeclared,
  isActive,
  activeOperations,
  operationConfig,
  costFor,
  ledgerWeightFor,
  costTable,
  ledgerWeightTable,
  confirmBeforeSet,
  displayCosts,
};
