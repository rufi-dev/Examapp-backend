const mongoose = require('mongoose')
const Schema = mongoose.Schema

const tokenSchema = Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            required: true,
            ref: "User"
        },
        vToken: {
            type: String,
            default: ""
        },
        rToken: {
            type: String,
            default: "" 
        },
        lToken: {
            type: String,
            default: ""
        },
        createdAt: {
            type: Date,
            required: true
        },
        expiresAt: {
            type: Date,
            required: true
        },
        // AUD-008 (CR-005): one-time-use claim marker for password-reset tokens.
        // The reset flow atomically sets this (findOneAndUpdate on usedAt:null)
        // BEFORE changing the password, so a token can never be redeemed twice —
        // even if the password write commits and then errors. Null/absent = unused.
        usedAt: {
            type: Date,
            default: null,
        },
    },
    // CR-052: the TTL + partial-unique indexes are MIGRATION-OWNED. Disable
    // autoIndex so application startup never builds them (or creates the
    // collection) ahead of the reviewed migration; tests build them explicitly via
    // Token.createIndexes(). Production verifies their shapes at boot (see
    // helper/tokenIndexes.js) and refuses to start with a migration instruction if
    // they are absent — it never creates them.
    { autoIndex: false }
);

// AUD-008: token lifecycle + lookup hardening.
//  - TTL: expired token rows are auto-reaped by Mongo (expireAfterSeconds:0 deletes
//    a document once `expiresAt` passes), so used/stale reset/verify/login-code
//    rows never accumulate. The reset/verify handlers still gate on `expiresAt` in
//    the query, so this is defence-in-depth cleanup, not the security boundary.
// Index NAMES match migrations/2026-07-26-token-indexes.js so the schema build and
// the migration produce the SAME indexes (idempotent either way).
tokenSchema.index({ expiresAt: 1 }, { name: "aud008_ttl_expiresAt", expireAfterSeconds: 0 });
//  - Lookups by token hash are now indexed instead of full collection scans, and
//    PARTIAL-UNIQUE (only over non-empty values, since a row carries exactly one of
//    r/v/l and leaves the other two ""), so a token hash cannot collide.
tokenSchema.index({ rToken: 1 }, { name: "aud008_uniq_rToken", unique: true, partialFilterExpression: { rToken: { $gt: "" } } });
tokenSchema.index({ vToken: 1 }, { name: "aud008_uniq_vToken", unique: true, partialFilterExpression: { vToken: { $gt: "" } } });
tokenSchema.index({ lToken: 1 }, { name: "aud008_uniq_lToken", unique: true, partialFilterExpression: { lToken: { $gt: "" } } });
tokenSchema.index({ userId: 1 }, { name: "aud008_userId" });

const Token = mongoose.model("Token", tokenSchema)
module.exports = Token