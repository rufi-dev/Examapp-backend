/*
 * AUD-008 CR-058/CR-062 — the EXACT unique {email:1} index invariant, shared by
 * the canonical-email migration (which OWNS it) and a production startup verifier
 * (which only CHECKS it, never creates/repairs). Without an EXACT unique index,
 * concurrent case-variant registrations could create duplicate canonical
 * identities — and a partial/sparse/collation-altered "unique" index would NOT
 * actually enforce that, so those are rejected as wrong_shape.
 */
const { collectionExists } = require("./tokenIndexes");

// Canonical spec (one place). "email_1" is Mongoose's default name for the
// schema's `unique:true` on email; kept as the documented canonical name.
const EMAIL_INDEX = { name: "email_1", key: { email: 1 } };

// An EXACT match: {email:1}, unique, and NOTHING that weakens/changes the
// invariant (no sparse, no partial filter, no non-simple collation).
function exactReasons(ix) {
  const reasons = [];
  if (!ix) return ["absent"];
  if (JSON.stringify(ix.key) !== JSON.stringify(EMAIL_INDEX.key)) reasons.push("key");
  if (ix.unique !== true) reasons.push("not_unique");
  if (ix.sparse) reasons.push("sparse");
  if (ix.partialFilterExpression) reasons.push("partial");
  // A non-simple collation changes equality semantics; only the simple binary
  // collation (absent, or locale "simple") preserves the invariant we verify.
  if (ix.collation && ix.collation.locale && ix.collation.locale !== "simple") reasons.push("collation");
  return reasons;
}
const isExactUnique = (ix) => exactReasons(ix).length === 0;

// Classify the email index: no_collection | absent | exact | wrong_shape (+reasons).
async function inspectEmailIndex(db, name = "users") {
  if (!(await collectionExists(db, name))) return { state: "no_collection" };
  const idx = await db.collection(name).indexes();
  const email = idx.find((i) => i.key && Object.keys(i.key).length === 1 && i.key.email === 1);
  if (!email) return { state: "absent" };
  if (isExactUnique(email)) return { state: "exact", name: email.name };
  return { state: "wrong_shape", name: email.name, reasons: exactReasons(email) };
}

async function verifyEmailUniqueIndex(db, name = "users") {
  const r = await inspectEmailIndex(db, name);
  return { ok: r.state === "exact", ...r };
}

// Startup guard (production): NEVER create/repair — fail with a migration instruction.
async function assertEmailUniqueIndex(db) {
  const r = await verifyEmailUniqueIndex(db);
  if (!r.ok) {
    const detail = r.state === "wrong_shape" ? `wrong_shape[${(r.reasons || []).join(",")}]` : r.state;
    throw new Error(
      `FATAL: exact unique {email:1} index not present (${detail}). Run: node migrations/2026-07-26-canonical-email.js --apply --db=<name>`
    );
  }
}

module.exports = { EMAIL_INDEX, inspectEmailIndex, verifyEmailUniqueIndex, assertEmailUniqueIndex, isExactUnique, exactReasons };
