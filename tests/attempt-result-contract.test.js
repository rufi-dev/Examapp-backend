/*
 * CR-119 — the shared Attempt/Result index contract cannot drift from the model
 * declarations, and its exact-shape verifier rejects every kind of drift (wrong key,
 * uniqueness, partial, sparse, TTL, collation) and hidden/extra indexes.
 */
const { INDEXES, contractMatchesModel, shapeReason } = require("../helper/attemptResultIndexes");
const Attempt = require("../models/attemptModel");
const Result = require("../models/resultModel");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

// ── 1) The live models are EXACTLY the contract (no drift). ──
ok("Attempt model schema.indexes() == contract", contractMatchesModel(Attempt.schema.indexes(), "attempts").ok);
ok("Result model schema.indexes() == contract", contractMatchesModel(Result.schema.indexes(), "results").ok);
ok("contract lists the NON-unique Attempt {userId,examId} perf index", INDEXES.some((i) => i.collection === "attempts" && i.name === "userId_1_examId_1" && !i.unique));

// ── 2) Drift in a model declaration is DETECTED. ──
ok("missing an index → drift detected", contractMatchesModel([[{ userId: 1, examId: 1 }, { name: "userId_1_examId_1" }]], "attempts").ok === false);
ok("wrong uniqueness → drift detected", contractMatchesModel([
  [{ userId: 1, examId: 1 }, { name: "userId_1_examId_1", unique: true }],
  [{ userId: 1, examId: 1 }, { name: "uniq_active_attempt", unique: true, partialFilterExpression: { submitted: false } }],
], "attempts").ok === false);
for (const [name, option] of [
  ["hidden", { hidden: true }],
  ["sparse", { sparse: true }],
  ["TTL", { expireAfterSeconds: 60 }],
  ["collation", { collation: { locale: "en" } }],
]) {
  ok(`${name} model-option drift → rejected`, contractMatchesModel([
    [{ userId: 1, examId: 1 }, { name: "userId_1_examId_1" }],
    [
      { userId: 1, examId: 1 },
      {
        name: "uniq_active_attempt",
        unique: true,
        partialFilterExpression: { submitted: false },
        ...option,
      },
    ],
  ], "attempts").ok === false);
}
ok("an EXTRA (undeclared-in-contract) index → drift detected", contractMatchesModel([
  [{ userId: 1, examId: 1 }, { name: "userId_1_examId_1" }],
  [{ userId: 1, examId: 1 }, { name: "uniq_active_attempt", unique: true, partialFilterExpression: { submitted: false } }],
  [{ foo: 1 }, { name: "foo_1" }],
], "attempts").ok === false);

// ── 3) shapeReason rejects every drift kind (pure, no DB). ──
const spec = INDEXES.find((i) => i.name === "uniq_active_attempt");
ok("exact match → null (no reason)", shapeReason(spec, { key: { userId: 1, examId: 1 }, unique: true, partialFilterExpression: { submitted: false } }) === null);
ok("absent → 'absent'", shapeReason(spec, null) === "absent");
ok("wrong key → 'key'", shapeReason(spec, { key: { userId: 1 }, unique: true, partialFilterExpression: { submitted: false } }) === "key");
ok("missing unique → 'unique'", shapeReason(spec, { key: { userId: 1, examId: 1 }, unique: false, partialFilterExpression: { submitted: false } }) === "unique");
ok("wrong partial → 'partial'", shapeReason(spec, { key: { userId: 1, examId: 1 }, unique: true, partialFilterExpression: { submitted: true } }) === "partial");
ok("sparse drift → 'sparse_drift'", shapeReason(spec, { key: { userId: 1, examId: 1 }, unique: true, partialFilterExpression: { submitted: false }, sparse: true }) === "sparse_drift");
ok("TTL drift → 'ttl_drift'", shapeReason(spec, { key: { userId: 1, examId: 1 }, unique: true, partialFilterExpression: { submitted: false }, expireAfterSeconds: 60 }) === "ttl_drift");
ok("collation drift → 'collation_drift'", shapeReason(spec, { key: { userId: 1, examId: 1 }, unique: true, partialFilterExpression: { submitted: false }, collation: { locale: "en" } }) === "collation_drift");
ok("hidden drift → 'hidden_drift'", shapeReason(spec, { key: { userId: 1, examId: 1 }, unique: true, partialFilterExpression: { submitted: false }, hidden: true }) === "hidden_drift");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
