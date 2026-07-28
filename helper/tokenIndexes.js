/*
 * AUD-008 (CR-052) — the CANONICAL token-index spec, shared by the migration and
 * the startup verifier so they can never drift. The startup verifier confirms the
 * EXACT shapes exist and refuses to boot (with a migration instruction) if they
 * don't — it NEVER creates an index or the collection (that is migration-owned).
 */
const INDEXES = [
  { key: { expiresAt: 1 }, options: { name: "aud008_ttl_expiresAt", expireAfterSeconds: 0 } },
  { key: { rToken: 1 }, options: { name: "aud008_uniq_rToken", unique: true, partialFilterExpression: { rToken: { $gt: "" } } } },
  { key: { vToken: 1 }, options: { name: "aud008_uniq_vToken", unique: true, partialFilterExpression: { vToken: { $gt: "" } } } },
  { key: { lToken: 1 }, options: { name: "aud008_uniq_lToken", unique: true, partialFilterExpression: { lToken: { $gt: "" } } } },
  { key: { userId: 1 }, options: { name: "aud008_userId" } },
];

// Does the collection exist? Uses listCollections so it never CREATES it (a plain
// `db.collection(name).indexes()` throws NamespaceNotFound on an absent collection).
async function collectionExists(db, name = "tokens") {
  const cols = await db.listCollections({ name }, { nameOnly: true }).toArray();
  return cols.length > 0;
}

// Verify EXACT shapes (name, key, unique, TTL, partial filter) without creating
// anything. Returns { ok, missing:[names], mismatched:[{name,reason}], collectionMissing }.
async function verifyTokenIndexes(db, name = "tokens") {
  if (!(await collectionExists(db, name))) {
    return { ok: false, collectionMissing: true, missing: INDEXES.map((i) => i.options.name), mismatched: [] };
  }
  const present = await db.collection(name).indexes();
  const byName = Object.fromEntries(present.map((i) => [i.name, i]));
  const missing = [];
  const mismatched = [];
  for (const ix of INDEXES) {
    const got = byName[ix.options.name];
    if (!got) { missing.push(ix.options.name); continue; }
    if (JSON.stringify(got.key) !== JSON.stringify(ix.key)) mismatched.push({ name: ix.options.name, reason: "key" });
    if (!!ix.options.unique !== !!got.unique) mismatched.push({ name: ix.options.name, reason: "unique" });
    if (ix.options.expireAfterSeconds !== undefined && got.expireAfterSeconds !== ix.options.expireAfterSeconds) mismatched.push({ name: ix.options.name, reason: "ttl" });
    if (ix.options.partialFilterExpression && JSON.stringify(got.partialFilterExpression || null) !== JSON.stringify(ix.options.partialFilterExpression)) mismatched.push({ name: ix.options.name, reason: "partial" });
  }
  return { ok: missing.length === 0 && mismatched.length === 0, collectionMissing: false, missing, mismatched };
}

// Boot guard (production): fail with a migration instruction; NEVER create indexes.
async function assertTokenIndexes(db) {
  const r = await verifyTokenIndexes(db);
  if (!r.ok) {
    const detail = r.collectionMissing
      ? "the tokens collection does not exist"
      : `missing=[${r.missing.join(",")}] mismatched=[${r.mismatched.map((m) => `${m.name}:${m.reason}`).join(",")}]`;
    throw new Error(
      `FATAL: token indexes are not built (${detail}). Run: node migrations/2026-07-26-token-indexes.js --apply --db=<name>`
    );
  }
}

module.exports = { INDEXES, collectionExists, verifyTokenIndexes, assertTokenIndexes };
