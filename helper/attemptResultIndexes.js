/*
 * CR-117/CR-119 — the CANONICAL Attempt/Result index contract and the SINGLE SOURCE for
 * both BUILDING (the offline migration builds natively from `INDEXES`) and VERIFYING
 * (the migration's --verify, scripts/verifySmokeDb, and production startup). A drift test
 * (contractMatchesModel) proves each model's declared `schema.indexes()` is EXACTLY this
 * contract, so the models (which build in dev) and the migration (which builds in prod)
 * can never diverge.
 *
 * Every required index is listed — including the NON-unique Attempt {userId,examId}
 * performance index — each with a stable EXPLICIT name (matching the mongoose default, so
 * no production rename). Verification matches by exact name + exact semantic options and
 * rejects wrong key/uniqueness/partial/sparse/TTL/collation drift AND any UNEXPECTED
 * same-key variant (an index on a contract key under a non-contract name is a conflict).
 */
const INDEXES = [
  { collection: "attempts", name: "userId_1_examId_1", key: { userId: 1, examId: 1 }, unique: false, partialFilterExpression: null },
  { collection: "attempts", name: "uniq_active_attempt", key: { userId: 1, examId: 1 }, unique: true, partialFilterExpression: { submitted: false } },
  { collection: "attempts", name: "due_attempt_finalizer", key: { unscorable: 1, expiresAt: 1, finalizeNextAttemptAt: 1, finalizeLeaseUntil: 1 }, unique: false, partialFilterExpression: { submitted: false } },
  { collection: "results", name: "userId_1_examId_1_createdAt_1", key: { userId: 1, examId: 1, createdAt: 1 }, unique: false, partialFilterExpression: null },
  { collection: "results", name: "examId_1", key: { examId: 1 }, unique: false, partialFilterExpression: null },
  { collection: "results", name: "page_createdAt_desc", key: { createdAt: -1, _id: -1 }, unique: false, partialFilterExpression: null },
  { collection: "results", name: "uniq_result_attempt", key: { attemptId: 1 }, unique: true, partialFilterExpression: { attemptId: { $exists: true, $type: "objectId" } } },
];

const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const collectionsOf = () => [...new Set(INDEXES.map((i) => i.collection))];
const specsFor = (coll) => INDEXES.filter((i) => i.collection === coll);
const keyNames = (coll) => specsFor(coll).map((s) => s.name);

// createIndex args for a spec — the migration builds NATIVELY from these (no Model.createIndexes).
function buildArgs(spec) {
  const opts = { name: spec.name };
  if (spec.unique) opts.unique = true;
  if (spec.partialFilterExpression) opts.partialFilterExpression = spec.partialFilterExpression;
  return [spec.key, opts];
}

// Return null if `got` matches `spec` EXACTLY (incl. no drift), else a reason string.
function shapeReason(spec, got) {
  if (!got) return "absent";
  if (!jeq(got.key, spec.key)) return "key";
  if (!!spec.unique !== !!got.unique) return "unique";
  if (!jeq(got.partialFilterExpression || null, spec.partialFilterExpression || null)) return "partial";
  if (!!spec.sparse !== !!got.sparse) return "sparse_drift";
  if (!jeq(spec.expireAfterSeconds ?? null, got.expireAfterSeconds ?? null)) return "ttl_drift";
  if (!jeq(spec.collation || null, got.collation || null)) return "collation_drift";
  if (!!spec.hidden !== !!got.hidden) return "hidden_drift";
  return null;
}

// Verify a live db. Returns { ok, failures:[{collection,name,reason}] }. Never creates
// a collection/index. Matches contract indexes by exact NAME and flags UNEXPECTED
// same-key variants (a same-key index under a non-contract name).
async function verifyAttemptResultIndexes(db) {
  const failures = [];
  for (const coll of collectionsOf()) {
    const exists = (await db.listCollections({ name: coll }, { nameOnly: true }).toArray()).length > 0;
    if (!exists) { for (const s of specsFor(coll)) failures.push({ collection: coll, name: s.name, reason: "collection_missing" }); continue; }
    const present = await db.collection(coll).indexes();
    const byName = Object.fromEntries(present.map((i) => [i.name, i]));
    for (const spec of specsFor(coll)) {
      const r = shapeReason(spec, byName[spec.name]);
      if (r) failures.push({ collection: coll, name: spec.name, reason: r });
    }
    // Unexpected same-key variant: any present index whose key equals a contract key but
    // whose name is NOT one of the contract names for this collection.
    const contractKeys = specsFor(coll).map((s) => s.key);
    const names = new Set(keyNames(coll));
    for (const i of present) {
      if (names.has(i.name)) continue;
      if (contractKeys.some((k) => jeq(k, i.key))) failures.push({ collection: coll, name: i.name, reason: "unexpected_same_key_variant" });
    }
  }
  return { ok: failures.length === 0, failures };
}

async function assertAttemptResultIndexes(db) {
  const r = await verifyAttemptResultIndexes(db);
  if (!r.ok) {
    throw new Error(
      "Attempt/Result index contract not satisfied: " +
        r.failures.map((f) => `${f.collection}.${f.name}:${f.reason}`).join(", ") +
        " (run migrations/2026-07-27-attempt-result-indexes.js --apply --db=<name>)"
    );
  }
}

// DRIFT proof: the model's declared schema.indexes() (array of [key, options]) must be
// EXACTLY the contract's entries for `collection` — same set of {name,key,unique,partial}
// (ignoring build-only options like `background`). Returns { ok, reasons:[] }.
function contractMatchesModel(schemaIndexes, collection) {
  const reasons = [];
  const specs = specsFor(collection);
  const declared = schemaIndexes.map(([key, opts]) => ({
    name: (opts && opts.name) || null,
    key,
    unique: !!(opts && opts.unique),
    partial: (opts && opts.partialFilterExpression) || null,
    sparse: !!(opts && opts.sparse),
    expireAfterSeconds:
      opts && opts.expireAfterSeconds !== undefined ? opts.expireAfterSeconds : null,
    collation: (opts && opts.collation) || null,
    hidden: !!(opts && opts.hidden),
  }));
  // Every contract spec must be declared exactly once, matched by name.
  for (const s of specs) {
    const d = declared.filter((x) => x.name === s.name);
    if (d.length !== 1) { reasons.push(`${collection}.${s.name}: declared ${d.length} times (want 1)`); continue; }
    const g = d[0];
    if (!jeq(g.key, s.key)) reasons.push(`${collection}.${s.name}: key drift`);
    if (g.unique !== !!s.unique) reasons.push(`${collection}.${s.name}: unique drift`);
    if (!jeq(g.partial, s.partialFilterExpression || null)) reasons.push(`${collection}.${s.name}: partial drift`);
    if (g.sparse !== !!s.sparse) reasons.push(`${collection}.${s.name}: sparse drift`);
    if (!jeq(g.expireAfterSeconds, s.expireAfterSeconds ?? null)) {
      reasons.push(`${collection}.${s.name}: TTL drift`);
    }
    if (!jeq(g.collation, s.collation || null)) reasons.push(`${collection}.${s.name}: collation drift`);
    if (g.hidden !== !!s.hidden) reasons.push(`${collection}.${s.name}: hidden drift`);
  }
  // No EXTRA declared index beyond the contract (models can't add a hidden index).
  const names = new Set(specs.map((s) => s.name));
  for (const d of declared) if (!names.has(d.name)) reasons.push(`${collection}: undeclared-in-contract index "${d.name || JSON.stringify(d.key)}"`);
  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  INDEXES, collectionsOf, specsFor, buildArgs,
  verifyAttemptResultIndexes, assertAttemptResultIndexes, contractMatchesModel, shapeReason,
};
