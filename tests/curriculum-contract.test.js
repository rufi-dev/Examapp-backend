/*
 * CR-MSO-007 — the index contract, and the flag-off no-op.
 *
 * Pure: no database. It proves that importing the models BUILDS NOTHING
 * (autoIndex/autoCreate off) and that the contract and the schemas agree in both
 * directions, so the migration, the production startup assertion and the models
 * can never drift apart silently.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const c = require("../helper/curriculumIndexes");
const { isCurriculumEnabled } = require("../config/curriculumFlag");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

console.log("\n1. Every model matches the contract and builds nothing on import:");
for (const coll of Object.keys(c.MODEL_COLLECTIONS)) {
  const M = c.modelFor(coll);
  const r = c.contractMatchesModel(M.schema.indexes(), coll);
  ok(`${coll}: schema.indexes() == contract`, r.ok, r.problems.join("; "));
  ok(`${coll}: autoIndex OFF (import builds nothing)`, M.schema.options.autoIndex === false);
  ok(`${coll}: autoCreate OFF`, M.schema.options.autoCreate === false);
  ok(`${coll}: model collection name matches contract`, M.collection.name === coll, M.collection.name);
}

console.log("\n2. Drift is caught in BOTH directions:");
{
  const coll = "curriculum_source_versions";
  const good = c.modelFor(coll).schema.indexes();
  ok("a MISSING contract index is caught", c.contractMatchesModel(good.filter((i) => i[1].name !== "uniq_storage_key"), coll).ok === false);
  ok(
    "a wrong UNIQUENESS is caught",
    c.contractMatchesModel(good.map((i) => (i[1].name === "uniq_storage_key" ? [i[0], { ...i[1], unique: false }] : i)), coll).ok === false
  );
  ok(
    "an EXTRA undeclared index is caught",
    c.contractMatchesModel([...good, [{ nope: 1 }, { name: "nope_1" }]], coll).ok === false
  );
  ok(
    "a wrong KEY is caught",
    c.contractMatchesModel(good.map((i) => (i[1].name === "uniq_storage_key" ? [{ other: 1 }, i[1]] : i)), coll).ok === false
  );
}

console.log("\n3. shapeReason names every drift kind:");
{
  const spec = c.specsFor("curriculum_source_versions").find((s) => s.name === "uniq_storage_key");
  ok("absent", c.shapeReason(spec, null) === "absent");
  ok("key", c.shapeReason(spec, { key: { other: 1 }, unique: true }) === "key");
  ok("unique", c.shapeReason(spec, { key: spec.key, unique: false }) === "unique");
  ok("partial", c.shapeReason(spec, { key: spec.key, unique: true, partialFilterExpression: { a: 1 } }) === "partial");
  ok("sparse_drift", c.shapeReason(spec, { key: spec.key, unique: true, sparse: true }) === "sparse_drift");
  ok("ttl_drift", c.shapeReason(spec, { key: spec.key, unique: true, expireAfterSeconds: 60 }) === "ttl_drift");
  ok("collation_drift", c.shapeReason(spec, { key: spec.key, unique: true, collation: {} }) === "collation_drift");
  ok("hidden_drift", c.shapeReason(spec, { key: spec.key, unique: true, hidden: true }) === "hidden_drift");
  ok("a matching index has no reason", c.shapeReason(spec, { key: spec.key, unique: true }) === null);
}

console.log("\n4. buildArgs gives the migration the exact createIndex arguments:");
{
  const uniq = c.specsFor("mso_generation_jobs").find((s) => s.name === "uniq_owner_clientReqId");
  const [key, opts] = c.buildArgs(uniq);
  ok("key is passed through", JSON.stringify(key) === JSON.stringify({ owner: 1, clientReqId: 1 }));
  ok("an explicit stable name is always set", opts.name === "uniq_owner_clientReqId");
  ok("uniqueness is carried", opts.unique === true);
  const plain = c.specsFor("lesson_plans")[0];
  ok("a non-unique index does not set unique", c.buildArgs(plain)[1].unique === undefined);
  ok("every spec has an explicit name", c.INDEXES.every((s) => typeof s.name === "string" && s.name.length > 0));
  ok("every spec states partialFilterExpression explicitly", c.INDEXES.every((s) => Object.prototype.hasOwnProperty.call(s, "partialFilterExpression")));
  ok("all nine collections are covered", c.collectionsOf().length === 9, c.collectionsOf().length);
}

console.log("\n5. Flag OFF is a true no-op:");
{
  ok("the flag is OFF by default", isCurriculumEnabled({}) === false);
  ok("'false' stays off", isCurriculumEnabled({ CURRICULUM_ENABLED: "false" }) === false);
  ok("'true' turns it on", isCurriculumEnabled({ CURRICULUM_ENABLED: "true" }) === true);
  ok("'1'/'yes'/'on' also turn it on", ["1", "yes", "on", "ON"].every((x) => isCurriculumEnabled({ CURRICULUM_ENABLED: x })));

  // The startup assertion must be INSIDE a flag check, or a flag-off deployment
  // would refuse to boot on collections the migration has not created yet.
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  ok("server.js gates the curriculum startup assertion on the flag", /isCurriculumEnabled\(\)/.test(server));
  // Match the CALL SITE, not the import at the top of the file.
  const idx = server.indexOf("await assertCurriculumIndexes(");
  const gate = server.lastIndexOf("isCurriculumEnabled()", idx);
  ok("the assertion sits inside a flag check", idx > 0 && gate > 0 && idx - gate < 1200, `assert@${idx} gate@${gate}`);

  // The route middleware must answer 404, never 401: a 401 tells an anonymous
  // prober the endpoint is real.
  const mw = fs.readFileSync(path.join(__dirname, "..", "middleware", "curriculumFlag.js"), "utf8");
  ok("the route gate 404s when off", /res\.status\(404\)/.test(mw));
  // The word "401" appears in the explaining comment, so assert on the CODE.
  ok("the route gate never sends 401", !/res\.status\(\s*401\s*\)/.test(mw));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} curriculum-contract assertions failed`);
process.exit(failed ? 1 : 0);
