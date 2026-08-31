/*
 * CR-MSO-007 — the exact index contract for every curriculum collection.
 *
 * One shared source for BUILD (the migration creates indexes natively from
 * buildArgs), VERIFY (the migration's --verify and the production startup
 * assertion) and a DRIFT TEST proving model.schema.indexes() equals this contract.
 * Mirrors helper/attemptResultIndexes.js + helper/teacherSuccessIndexes.js down to
 * the exported names, so a reader of one knows all three.
 *
 * Every entry carries an EXPLICIT stable `name`: matching by name is what lets
 * verify tell "absent" apart from "present under a different name with the same
 * key", which is the drift that silently changes uniqueness semantics.
 */
const INDEXES = [
  // ---- curriculum sources ----
  { collection: "curriculum_sources", name: "owner_1_createdAt_-1", key: { owner: 1, createdAt: -1 }, unique: false, partialFilterExpression: null },

  // ---- immutable source bytes ----
  { collection: "curriculum_source_versions", name: "uniq_source_version", key: { source: 1, versionNumber: 1 }, unique: true, partialFilterExpression: null },
  { collection: "curriculum_source_versions", name: "uniq_storage_key", key: { storageKey: 1 }, unique: true, partialFilterExpression: null },

  // ---- the DELETION AUTHORITY ----
  { collection: "curriculum_source_references", name: "uniq_source_holder", key: { sourceVersion: 1, holderKind: 1, holderId: 1 }, unique: true, partialFilterExpression: null },
  { collection: "curriculum_source_references", name: "holderKind_1_holderId_1", key: { holderKind: 1, holderId: 1 }, unique: false, partialFilterExpression: null },

  // ---- lesson plans ----
  { collection: "lesson_plans", name: "owner_1_updatedAt_-1", key: { owner: 1, updatedAt: -1 }, unique: false, partialFilterExpression: null },
  { collection: "lesson_plan_versions", name: "uniq_plan_version", key: { docId: 1, versionNumber: 1 }, unique: true, partialFilterExpression: null },
  { collection: "lesson_plan_versions", name: "uniq_plan_content", key: { docId: 1, contentHash: 1 }, unique: true, partialFilterExpression: null },

  // ---- MSO ----
  { collection: "mso_blueprints", name: "owner_1_updatedAt_-1", key: { owner: 1, updatedAt: -1 }, unique: false, partialFilterExpression: null },
  { collection: "mso_documents", name: "owner_1_updatedAt_-1", key: { owner: 1, updatedAt: -1 }, unique: false, partialFilterExpression: null },
  { collection: "mso_versions", name: "uniq_mso_version", key: { docId: 1, versionNumber: 1 }, unique: true, partialFilterExpression: null },
  { collection: "mso_versions", name: "uniq_mso_content", key: { docId: 1, contentHash: 1 }, unique: true, partialFilterExpression: null },
  { collection: "mso_generation_jobs", name: "uniq_owner_clientReqId", key: { owner: 1, clientReqId: 1 }, unique: true, partialFilterExpression: null },
  { collection: "mso_generation_jobs", name: "state_1_nextAttemptAt_1_leaseUntil_1", key: { state: 1, nextAttemptAt: 1, leaseUntil: 1 }, unique: false, partialFilterExpression: null },
];

// collection -> the model file whose schema.indexes() must match exactly.
// `modelFor` resolves relative to THIS file, so a caller in tests/ or migrations/
// does not have to know where models live.
const MODEL_COLLECTIONS = {
  curriculum_sources: "curriculumSourceModel",
  curriculum_source_versions: "curriculumSourceVersionModel",
  curriculum_source_references: "sourceReferenceModel",
  lesson_plans: "lessonPlanModel",
  lesson_plan_versions: "lessonPlanVersionModel",
  mso_blueprints: "msoBlueprintModel",
  mso_documents: "msoDocumentModel",
  mso_versions: "msoVersionModel",
  mso_generation_jobs: "msoGenerationJobModel",
};

function modelFor(collection) {
  const file = MODEL_COLLECTIONS[collection];
  if (!file) throw new Error(`no model mapped for collection "${collection}"`);
  return require(`../models/${file}`);
}

const collectionsOf = () => [...new Set(INDEXES.map((i) => i.collection))];
const specsFor = (collection) => INDEXES.filter((i) => i.collection === collection);

// The exact createIndex(key, opts) arguments, so the migration builds NATIVELY and
// can never diverge from what verify expects.
function buildArgs(spec) {
  const opts = { name: spec.name };
  if (spec.unique) opts.unique = true;
  if (spec.partialFilterExpression) opts.partialFilterExpression = spec.partialFilterExpression;
  return [spec.key, opts];
}

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Why a present index still fails the contract. Named reasons, so a migration or a
// startup refusal says something actionable.
function shapeReason(spec, got) {
  if (!got) return "absent";
  if (!sameKey(got.key, spec.key)) return "key";
  if (Boolean(got.unique) !== Boolean(spec.unique)) return "unique";
  const wantPartial = spec.partialFilterExpression || null;
  const gotPartial = got.partialFilterExpression || null;
  if (JSON.stringify(wantPartial) !== JSON.stringify(gotPartial)) return "partial";
  if (got.sparse) return "sparse_drift";
  if (got.expireAfterSeconds !== undefined) return "ttl_drift";
  if (got.collation) return "collation_drift";
  if (got.hidden) return "hidden_drift";
  return null;
}

/*
 * Read-only. Uses listCollections({nameOnly}) so it NEVER creates a namespace —
 * a verify must not be the thing that brings a collection into existence.
 */
async function verifyCurriculumIndexes(db) {
  const failures = [];
  for (const collection of collectionsOf()) {
    const exists = await db.listCollections({ name: collection }, { nameOnly: true }).toArray();
    if (!exists.length) {
      for (const spec of specsFor(collection)) failures.push({ collection, name: spec.name, reason: "collection_missing" });
      continue;
    }
    const present = await db.collection(collection).indexes();
    const byName = new Map(present.map((i) => [i.name, i]));
    for (const spec of specsFor(collection)) {
      const reason = shapeReason(spec, byName.get(spec.name));
      if (reason) failures.push({ collection, name: spec.name, reason });
    }
    // An index with a contract key under a NON-contract name is drift too: it
    // silently changes which index the planner uses and what uniqueness holds.
    for (const idx of present) {
      if (idx.name === "_id_") continue;
      if (specsFor(collection).some((s) => s.name === idx.name)) continue;
      if (specsFor(collection).some((s) => sameKey(s.key, idx.key))) {
        failures.push({ collection, name: idx.name, reason: "unexpected_same_key_variant" });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

async function assertCurriculumIndexes(db) {
  const r = await verifyCurriculumIndexes(db);
  if (!r.ok) {
    const detail = r.failures.map((f) => `${f.collection}.${f.name}: ${f.reason}`).join("; ");
    throw new Error(
      `FATAL: curriculum indexes are not built (${detail}). ` +
        `Run: node migrations/2026-09-01-curriculum.js --apply --db=<name>`
    );
  }
  return true;
}

/*
 * Pure drift proof, both directions: every spec must be declared exactly once by
 * name on the model, and the model must declare nothing the contract omits.
 */
function contractMatchesModel(schemaIndexes, collection) {
  const specs = specsFor(collection);
  const declared = (schemaIndexes || []).map(([key, opts]) => ({ key, opts: opts || {} }));
  const problems = [];
  for (const spec of specs) {
    const hits = declared.filter((d) => d.opts.name === spec.name);
    if (hits.length !== 1) { problems.push(`${spec.name}: declared ${hits.length} times`); continue; }
    const d = hits[0];
    if (!sameKey(d.key, spec.key)) problems.push(`${spec.name}: key mismatch`);
    if (Boolean(d.opts.unique) !== Boolean(spec.unique)) problems.push(`${spec.name}: uniqueness mismatch`);
  }
  for (const d of declared) {
    if (!specs.some((s) => s.name === d.opts.name)) {
      problems.push(`undeclared-in-contract index ${d.opts.name || JSON.stringify(d.key)}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

module.exports = {
  INDEXES,
  MODEL_COLLECTIONS,
  modelFor,
  collectionsOf,
  specsFor,
  buildArgs,
  verifyCurriculumIndexes,
  assertCurriculumIndexes,
  contractMatchesModel,
  shapeReason,
};
