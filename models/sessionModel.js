const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// AUD-002: one document per device/login — the refresh "family" IS this doc.
// Normative shape from docs/adr/AUD-002-session-lifecycle.md §7. Only SHA-256
// hashes of refresh secrets are stored; the sid/gen locators are not secrets.
const sessionSchema = new Schema({
  _id: { type: String }, // = sid (opaque high-entropy id, also the access JWT `sid` claim)
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true }, // NO index:true — compound below covers it
  // IMMUTABLE auth epoch captured at creation (= User.sessionVersion then). The
  // reset/logout-all fence (ADR-014): rotation requires authVersion == userSv,
  // and access tokens are signed with THIS value, never a later user read.
  authVersion: { type: Number, required: true },
  refreshHash: { type: String, required: true }, // SHA-256 of the CURRENT refresh secret
  refreshGen: { type: Number, required: true, default: 0 }, // current rotation generation
  // Bounded ring (last N) of superseded { gen, hash } — lets an ancestor replay
  // be AUTHENTICATED before it is treated as theft (ADR-001/ADR-007).
  usedRefreshHashes: { type: [{ gen: Number, hash: String, _id: false }], default: [] },
  userAgent: { type: String },
  ip: { type: String },
  createdAt: { type: Date, required: true },
  lastUsedAt: { type: Date },
  lastRotatedAt: { type: Date }, // drives the grace window
  // Short-lived ENCRYPTED idempotency record for the last successful rotation.
  // If a hard reload loses the HTTP response after the server committed, the
  // immediately-previous cookie can receive the exact same response without a
  // second rotation. No plaintext refresh secret is stored in MongoDB.
  rotationReplay: {
    consumedGen: { type: Number },
    consumedHash: { type: String },
    responseCipher: { type: String },
    expiresAt: { type: Date },
    _id: false,
  },
  refreshExpiresAt: { type: Date, required: true }, // sliding inactivity deadline
  absoluteExpiresAt: { type: Date, required: true }, // immutable hard cap
  revokedAt: { type: Date, default: null },
  // CR-009 / Gate 0: when a theft revoke wins, this records the account-wide
  // fence target ATOMICALLY with revokedAt (one write). Recovered by the worker
  // sweep on crash, then `$unset`. It is ABSENT on a normal Session (no default)
  // so the partial TTL below covers ordinary sessions but NOT a session carrying
  // a pending fence — the TTL can never delete an unrecovered theft intent.
  theftFenceTarget: { type: Number },
}, {
  // CR-007: do NOT let merely importing this model create the collection or
  // build indexes on connect. Collection/index creation is owned EXCLUSIVELY by
  // the reviewed migration (migrations/2026-07-25-session-collection.js), so a
  // flag-off application startup performs zero schema writes.
  autoCreate: false,
  autoIndex: false,
});

sessionSchema.index({ refreshHash: 1 }, { unique: true }); // fast rotation lookup + global uniqueness
// Gate 0: PARTIAL TTL — only sessions with NO pending fence (marker null/absent)
// are TTL-eligible. A session carrying a numeric theftFenceTarget is excluded, so
// MongoDB can never delete an unrecovered theft intent before the worker fences it.
sessionSchema.index(
  { absoluteExpiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { theftFenceTarget: null } }
);
sessionSchema.index({ userId: 1, revokedAt: 1 }); // logout-all + Profile list (serves userId-prefix too)
sessionSchema.index({ theftFenceTarget: 1 }, { sparse: true }); // worker sweep — indexes ONLY sessions with a pending marker

module.exports = mongoose.model("Session", sessionSchema);
