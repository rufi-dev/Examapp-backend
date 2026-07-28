/*
 * Teacher Success Journey — the CANONICAL index contract and SINGLE SOURCE for
 * both BUILDING (the Journey migration builds natively from `INDEXES`) and
 * VERIFYING (the migration's --verify and production startup assert). A drift
 * test (contractMatchesModel) proves each new-collection model's declared
 * schema.indexes() is EXACTLY this contract, so the models (autoIndex:false —
 * they build nothing at import) and the migration can never diverge.
 *
 * Mirrors helper/attemptResultIndexes.js exactly in shape. The `users` entry
 * (referralCode uniqueness) is BUILT + VERIFIED here but is excluded from the
 * model-schema drift check (MODEL_COLLECTIONS) because the User model carries
 * many non-Journey indexes owned by other migrations.
 */
const INDEXES = [
  // users — the teacher's own random share code is unique among strings (null excluded).
  { collection: "users", name: "uniq_referral_code", key: { referralCode: 1 }, unique: true, partialFilterExpression: { referralCode: { $type: "string" } } },

  // teacher_level_history — a teacher's audit trail, newest first, + the CR-126
  // per-version uniqueness that makes promotion history idempotent/repairable.
  { collection: "teacher_level_history", name: "hist_teacher_time", key: { teacherId: 1, createdAt: -1 }, unique: false, partialFilterExpression: null },
  { collection: "teacher_level_history", name: "uniq_teacher_version", key: { teacherId: 1, levelVersionAfter: 1 }, unique: true, partialFilterExpression: null },

  // teacher_activity_daily — one aggregate per teacher/day.
  { collection: "teacher_activity_daily", name: "uniq_teacher_day", key: { teacherId: 1, date: 1 }, unique: true, partialFilterExpression: null },

  // teacher_referral — one referral per referee; per-referrer state feed; idempotent reward.
  { collection: "teacher_referral", name: "uniq_referee", key: { refereeId: 1 }, unique: true, partialFilterExpression: null },
  { collection: "teacher_referral", name: "ref_referrer_state", key: { referrerId: 1, state: 1 }, unique: false, partialFilterExpression: null },
  { collection: "teacher_referral", name: "uniq_reward_key", key: { rewardKey: 1 }, unique: true, partialFilterExpression: { rewardKey: { $type: "string" } } },

  // teacher_upgrade_request — one OPEN request per {teacher,target}; admin inbox feed.
  { collection: "teacher_upgrade_request", name: "uniq_open_request", key: { teacherId: 1, targetLevel: 1 }, unique: true, partialFilterExpression: { status: "open" } },
  { collection: "teacher_upgrade_request", name: "upreq_status", key: { status: 1, createdAt: -1 }, unique: false, partialFilterExpression: null },

  // ai_credit_period — one period per teacher per UTC month.
  { collection: "ai_credit_period", name: "uniq_teacher_period", key: { teacherId: 1, periodMonthUtc: 1 }, unique: true, partialFilterExpression: null },

  // ai_credit_ledger — unique idempotency key (no double-charge); period feed; grant-expiry sweep.
  { collection: "ai_credit_ledger", name: "uniq_idem", key: { idempotencyKey: 1 }, unique: true, partialFilterExpression: null },
  { collection: "ai_credit_ledger", name: "ledger_teacher_period", key: { teacherId: 1, periodMonthUtc: 1, createdAt: -1 }, unique: false, partialFilterExpression: null },
  { collection: "ai_credit_ledger", name: "grant_expiry", key: { expiresAt: 1 }, unique: false, partialFilterExpression: { kind: "grant" } },

  // teacher_xp_event — the immutable XP ledger. Unique idempotency (award once);
  // teacher feed; per-type cap counts; per-month cap window.
  { collection: "teacher_xp_event", name: "uniq_xp_idem", key: { idempotencyKey: 1 }, unique: true, partialFilterExpression: null },
  { collection: "teacher_xp_event", name: "xp_teacher_time", key: { teacherId: 1, createdAt: -1 }, unique: false, partialFilterExpression: null },
  { collection: "teacher_xp_event", name: "xp_teacher_type", key: { teacherId: 1, type: 1 }, unique: false, partialFilterExpression: null },
  { collection: "teacher_xp_event", name: "xp_teacher_period", key: { teacherId: 1, periodMonthUtc: 1 }, unique: false, partialFilterExpression: null },

  // teacher_xp_state — one projected rollup per teacher (reconcilable from the ledger).
  { collection: "teacher_xp_state", name: "uniq_xp_state_teacher", key: { teacherId: 1 }, unique: true, partialFilterExpression: null },

  // teacher_mission_progress — one row per teacher+mission.
  { collection: "teacher_mission_progress", name: "uniq_mission", key: { teacherId: 1, missionId: 1 }, unique: true, partialFilterExpression: null },

  // teacher_achievement — one earned row per teacher+achievement.
  { collection: "teacher_achievement", name: "uniq_ach", key: { teacherId: 1, achievementId: 1 }, unique: true, partialFilterExpression: null },

  // tsj_xp_outbox — durable XP-award retry queue. Enqueue once; drain due rows.
  { collection: "tsj_xp_outbox", name: "uniq_outbox_key", key: { idempotencyKey: 1 }, unique: true, partialFilterExpression: null },
  { collection: "tsj_xp_outbox", name: "outbox_due", key: { deadLetter: 1, nextAttemptAt: 1 }, unique: false, partialFilterExpression: null },
];

// Collections whose MODEL schema.indexes() must exactly equal the contract
// (users excluded — it has non-Journey indexes owned elsewhere).
const MODEL_COLLECTIONS = [
  "teacher_level_history",
  "teacher_activity_daily",
  "teacher_referral",
  "teacher_upgrade_request",
  "ai_credit_period",
  "ai_credit_ledger",
  "teacher_xp_event",
  "teacher_xp_state",
  "teacher_mission_progress",
  "teacher_achievement",
  "tsj_xp_outbox",
];

const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const collectionsOf = () => [...new Set(INDEXES.map((i) => i.collection))];
const specsFor = (coll) => INDEXES.filter((i) => i.collection === coll);
const keyNames = (coll) => specsFor(coll).map((s) => s.name);

// createIndex args for a spec — the migration builds NATIVELY from these.
function buildArgs(spec) {
  const opts = { name: spec.name };
  if (spec.unique) opts.unique = true;
  if (spec.partialFilterExpression) opts.partialFilterExpression = spec.partialFilterExpression;
  return [spec.key, opts];
}

// Return null if `got` matches `spec` EXACTLY, else a drift reason.
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

// Verify a live db. Never creates a collection/index. Matches by exact NAME and
// flags UNEXPECTED same-key variants.
async function verifyTeacherSuccessIndexes(db) {
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
    const contractKeys = specsFor(coll).map((s) => s.key);
    const names = new Set(keyNames(coll));
    for (const i of present) {
      if (names.has(i.name)) continue;
      // `users` legitimately holds many non-Journey indexes — only flag a same-key
      // variant on a collection we fully own.
      if (coll === "users") continue;
      if (contractKeys.some((k) => jeq(k, i.key))) failures.push({ collection: coll, name: i.name, reason: "unexpected_same_key_variant" });
    }
  }
  return { ok: failures.length === 0, failures };
}

async function assertTeacherSuccessIndexes(db) {
  const r = await verifyTeacherSuccessIndexes(db);
  if (!r.ok) {
    throw new Error(
      "Teacher Success index contract not satisfied: " +
        r.failures.map((f) => `${f.collection}.${f.name}:${f.reason}`).join(", ") +
        " (run migrations/2026-07-27-teacher-success.js --apply --db=<name>)"
    );
  }
}

// DRIFT proof: a model's declared schema.indexes() must be EXACTLY the contract's
// entries for `collection`. Returns { ok, reasons:[] }.
function contractMatchesModel(schemaIndexes, collection) {
  const reasons = [];
  const specs = specsFor(collection);
  const declared = schemaIndexes.map(([key, opts]) => ({
    name: (opts && opts.name) || null,
    key,
    unique: !!(opts && opts.unique),
    partial: (opts && opts.partialFilterExpression) || null,
    sparse: !!(opts && opts.sparse),
    expireAfterSeconds: opts && opts.expireAfterSeconds !== undefined ? opts.expireAfterSeconds : null,
    collation: (opts && opts.collation) || null,
    hidden: !!(opts && opts.hidden),
  }));
  for (const s of specs) {
    const d = declared.filter((x) => x.name === s.name);
    if (d.length !== 1) { reasons.push(`${collection}.${s.name}: declared ${d.length} times (want 1)`); continue; }
    const g = d[0];
    if (!jeq(g.key, s.key)) reasons.push(`${collection}.${s.name}: key drift`);
    if (g.unique !== !!s.unique) reasons.push(`${collection}.${s.name}: unique drift`);
    if (!jeq(g.partial, s.partialFilterExpression || null)) reasons.push(`${collection}.${s.name}: partial drift`);
    if (g.sparse !== !!s.sparse) reasons.push(`${collection}.${s.name}: sparse drift`);
    if (!jeq(g.expireAfterSeconds, s.expireAfterSeconds ?? null)) reasons.push(`${collection}.${s.name}: TTL drift`);
    if (!jeq(g.collation, s.collation || null)) reasons.push(`${collection}.${s.name}: collation drift`);
    if (g.hidden !== !!s.hidden) reasons.push(`${collection}.${s.name}: hidden drift`);
  }
  const names = new Set(specs.map((s) => s.name));
  for (const d of declared) if (!names.has(d.name)) reasons.push(`${collection}: undeclared-in-contract index "${d.name || JSON.stringify(d.key)}"`);
  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  INDEXES, MODEL_COLLECTIONS, collectionsOf, specsFor, keyNames, buildArgs,
  verifyTeacherSuccessIndexes, assertTeacherSuccessIndexes, contractMatchesModel, shapeReason,
};
