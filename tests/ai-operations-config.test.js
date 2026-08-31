/*
 * CR-MSO-006 — the AI operation registry is the ONE source of prices.
 *
 * Three tables used to describe the same operations with no link between them
 * (OP_COST enforced, WEIGHTS in the ledger, AI_ACTION_COSTS published under
 * different keys). They are now projections of config/aiOperations.js. This file
 * pins that, pins the price-neutrality of the consolidation, and pins the two
 * hazards the arrangement introduces:
 *
 *   1. an import CYCLE — config/plans.js is loaded during boot validation, and
 *      middleware/aiCredit.js -> models/userModel -> controllers/userController ->
 *      config/plans.js is a real one, so the registry must require NOTHING;
 *   2. a declared-but-unpriced operation silently charging 0.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const reg = require("../config/aiOperations");
const { WEIGHTS, CONFIRM_BEFORE, isOperation, weightFor } = require("../config/teacherSuccess/aiCredits");
const { AI_ACTION_COSTS } = require("../config/plans");
const { chargeAi } = require("../middleware/aiCredit");
const { requireActiveOperation } = require("../middleware/aiOperation");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// ---------------- 1. price neutrality (the numbers must not have moved) -------
console.log("\n1. The consolidation moved no number:");
eq("OP_COST projection (existing operations unchanged)", reg.costTable(), {
  "ai.extract.questions": 10,
  "ai.generate.questions": 10,
  "ai.regenerate.question": 2,
  "ai.chat.message": 0,
  "ai.transcribe.audio": 0,
  "ai.realtime.session": 0,
  "ai.models.list": 0,
  "ai.generate.mso": 10,
  "ai.generate.lessonplan": 6,
});
eq("WEIGHTS projection (existing operations unchanged)", WEIGHTS, {
  "ai.extract.questions": 5,
  "ai.generate.questions": 5,
  "ai.regenerate.question": 1,
  "ai.chat.message": 1,
  "ai.transcribe.audio": 2,
  "ai.realtime.session": 5,
  "ai.models.list": 0,
  "ai.generate.mso": 5,
  "ai.generate.lessonplan": 3,
});
eq("AI_ACTION_COSTS projection", AI_ACTION_COSTS, { generateExam: 10, rewriteQuestion: 2, supportChat: 0, generateMso: 10, generateLessonPlan: 6 });
eq("CONFIRM_BEFORE projection", [...CONFIRM_BEFORE].sort(), [
  "ai.extract.questions",
  "ai.generate.lessonplan",
  "ai.generate.mso",
  "ai.generate.questions",
  "ai.realtime.session",
]);

// ---------------- 2. every table is a projection, none is a 4th source -------
console.log("\n2. Every table is derived, none is independent:");
ok(
  "every priced op appears in all three projections with consistent numbers",
  reg.activeOperations().every(
    (op) => reg.costTable()[op] === reg.costFor(op) && WEIGHTS[op] === reg.ledgerWeightFor(op)
  )
);
ok(
  "the published price equals the charged price for every displayed op",
  reg.activeOperations().every((op) => {
    const d = reg.operationConfig(op).display;
    return !d || AI_ACTION_COSTS[d] === reg.costFor(op);
  })
);
ok("isOperation still answers for the legacy 7", reg.activeOperations().every(isOperation));
ok("weightFor still resolves", weightFor("ai.generate.questions") === 5);
ok(
  "a display key shared by two ops with different prices is refused",
  (() => {
    // Simulate the drift the derivation exists to prevent.
    const saved = reg.AI_OPERATIONS["ai.extract.questions"].cost;
    reg.AI_OPERATIONS["ai.extract.questions"].cost = 7;
    let threw = false;
    try { reg.displayCosts(); } catch { threw = true; }
    reg.AI_OPERATIONS["ai.extract.questions"].cost = saved;
    return threw;
  })()
);

// ---------------- 3. declared-but-inactive operations fail closed ------------
console.log("\n3. Document operations are priced and chargeable:");
for (const op of ["ai.generate.mso", "ai.generate.lessonplan"]) {
  ok(`${op} is declared`, reg.isDeclared(op));
  ok(`${op} is active`, reg.isActive(op));
  ok(`${op} has a positive cost`, reg.costFor(op) > 0, reg.costFor(op));
  ok(`${op} has a ledger weight`, WEIGHTS[op] > 0, WEIGHTS[op]);
  ok(`${op} is confirm-before (a large paid action)`, CONFIRM_BEFORE.has(op));
  ok(`chargeAi("${op}") wires`, typeof chargeAi(op) === "function");
}
// The mechanism that protected them before they were priced must still work, or a
// FUTURE operation could silently charge 0.
{
  const saved = reg.AI_OPERATIONS["ai.generate.mso"].active;
  reg.AI_OPERATIONS["ai.generate.mso"].active = false;
  ok("an inactive op disappears from OP_COST", reg.costTable()["ai.generate.mso"] === undefined);
  ok("costFor throws rather than returning 0", (() => { try { reg.costFor("ai.generate.mso"); return false; } catch { return true; } })());
  ok("chargeAi refuses at WIRE time", (() => { try { chargeAi("ai.generate.mso"); return false; } catch { return true; } })());
  ok(
    "requireActiveOperation answers a typed 503",
    (() => {
      let err = null;
      requireActiveOperation("ai.generate.mso")({}, {}, (e) => (err = e));
      return err && err.statusCode === 503 && err.code === "operation_not_configured";
    })()
  );
  reg.AI_OPERATIONS["ai.generate.mso"].active = saved;
}
ok(
  "chargeAi still wires for a priced operation",
  typeof chargeAi("ai.generate.questions") === "function"
);
ok(
  "chargeAi throws on an unknown operation",
  (() => { try { chargeAi("ai.nope"); return false; } catch { return true; } })()
);

// requireActiveOperation lets a route EXIST while refusing every request.
console.log("\n4. requireActiveOperation passes a priced operation through:");
{
  let passedThrough = false;
  requireActiveOperation("ai.generate.mso")({}, {}, (e) => { passedThrough = !e; });
  ok("a priced op passes through", passedThrough);
  ok(
    "an unknown op throws at wire time",
    (() => { try { requireActiveOperation("ai.nope"); return false; } catch { return true; } })()
  );
}

// ---------------- 5. the import graph stays acyclic ---------------------------
console.log("\n5. The registry cannot create an import cycle:");
const ROOT = path.resolve(__dirname, "..");
function requiresOf(file) {
  const src = fs.readFileSync(file, "utf8");
  const out = [];
  const re = /require\(\s*"(\.[^"]+)"\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    try {
      out.push(Module._resolveFilename(m[1], { id: file, filename: file, paths: Module._nodeModulePaths(path.dirname(file)) }));
    } catch { /* optional/dynamic require — not a static edge */ }
  }
  return out;
}
function findCycle(entry) {
  const stack = [];
  const onStack = new Set();
  const done = new Set();
  const walk = (f) => {
    if (onStack.has(f)) return [...stack.slice(stack.indexOf(f)), f];
    if (done.has(f)) return null;
    onStack.add(f); stack.push(f);
    for (const dep of requiresOf(f)) {
      if (!dep.startsWith(ROOT) || dep.includes("node_modules")) continue;
      const c = walk(dep);
      if (c) return c;
    }
    onStack.delete(f); stack.pop(); done.add(f);
    return null;
  };
  return walk(entry);
}
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");
eq("config/aiOperations.js requires nothing", requiresOf(path.join(ROOT, "config/aiOperations.js")).map(rel), []);
{
  const c = findCycle(path.join(ROOT, "config/plans.js"));
  ok("config/plans.js has an acyclic require graph", c === null, c && c.map(rel).join(" -> "));
}
{
  const c = findCycle(path.join(ROOT, "middleware/aiCredit.js"));
  ok("middleware/aiCredit.js has an acyclic require graph", c === null, c && c.map(rel).join(" -> "));
}
{
  const c = findCycle(path.join(ROOT, "config/teacherSuccess/aiCredits.js"));
  ok("config/teacherSuccess/aiCredits.js has an acyclic require graph", c === null, c && c.map(rel).join(" -> "));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} ai-operations assertions failed`);
process.exit(failed ? 1 : 0);
