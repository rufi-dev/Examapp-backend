const mongoose = require('mongoose');
const { Schema } = mongoose;

const pdfSchema = Schema({
    // Legacy: an origin-qualified PUBLIC /uploads URL (AUD-013). New records store
    // `key` and serve the file privately; `path` is kept only for the migration.
    path: {
        type: String,
    },
    // AUD-013 CR-057: the private random storage key (see helper/examPdfStorage).
    // The file lives at <EXAM_PDF_DIR>/<key>.pdf and is served ONLY through the
    // authorized range-streaming endpoint.
    key: {
        type: String,
    },
    // AUD-013 CR-069/CR-075/CR-079: owner-bound staged-upload lifecycle with
    // MUTUALLY EXCLUSIVE durable states + fencing tokens, so an attach and a
    // janitor deletion can never both win the same row:
    //   staged    → uploaded, unclaimed, has `expiresAt`; janitor reclaims if expired
    //   claimed   → CAS-claimed for `examId` by the owner (carries `opToken`)
    //   attaching → the request won the commit-intent CAS; Exam reference imminent
    //   attached  → an exam durably references it (terminal for a live PDF)
    //   deleting  → the janitor won the delete CAS (carries `deleteToken`); terminal
    // A `claimed → attaching` (request) and a `claimed → deleting` (janitor) CAS
    // contend on the SAME state:"claimed" — only one wins; the loser aborts.
    owner: {
        type: Schema.Types.ObjectId,
        ref: 'User',
    },
    state: {
        type: String,
        enum: ['staged', 'claimed', 'attaching', 'attached', 'deleting'],
    },
    // The exam this upload is/was claimed for — set atomically WITH the claim so
    // the reconciler can tell a committed attachment from a crashed one.
    examId: {
        type: Schema.Types.ObjectId,
        ref: 'Exam',
    },
    size: { type: Number },
    hash: { type: String }, // sha256 of the stored bytes
    // Set while staged; unset on claim. The janitor reclaims staged rows past this.
    expiresAt: { type: Date },
    claimedAt: { type: Date },
    // Unpredictable fencing tokens: `opToken` binds a claim → attaching → attached
    // chain to ONE request; `deleteToken` binds a deletion to ONE janitor run.
    opToken: { type: String },
    deleteToken: { type: String },
    deletingAt: { type: Date },
}, { timestamps: true });

// AUD-013 CR-087/CR-088/CR-091/CR-094/CR-095 — enforce the terminal owner+examId
// binding at the model write boundary FAIL-CLOSED so NO mongoose write shape can
// clear, unset, rename, move OR rewrite it — including replacement writes,
// aggregation-pipeline updates, `$rename`/`$setOnInsert`/dotted-path operators and
// bulkWrite. The ONLY write permitted to touch the binding is the EXACT single-row
// `staged → claimed` claim (a `findOneAndUpdate`).
//   (1) A live/committed state (claimed/attaching/attached) MUST carry both owner
//       and examId (conditionally required on document save/validate).
//   (2) An existing document may not modify owner/examId via save.
//   (3) Any update whose operators touch owner/examId (by ANY path) is rejected
//       unless it is the exact claim; the claim's shape is validated by allowlist.
//   (4) replaceOne / findOneAndReplace / pipeline updates / bulkWrite are rejected
//       outright — no shipping caller uses them.
// The one-time migration binds via the NATIVE driver (bypasses these hooks).
const BINDING_STATES = ['claimed', 'attaching', 'attached'];
const BINDING_FIELDS = ['owner', 'examId'];

// A scalar identifier (ObjectId or a valid ObjectId string) — NEVER an operator
// object such as `{$exists:true}` / `{$in:[…]}`.
const isScalarId = (v) =>
    v != null && (v instanceof mongoose.Types.ObjectId ||
        (typeof v === 'string' && mongoose.Types.ObjectId.isValid(v)));
const isExistsFalse = (v) =>
    v != null && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length === 1 && v.$exists === false;
const isFutureGt = (v) =>
    v != null && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length === 1 && v.$gt instanceof Date;
const pathTouchesBinding = (p) => BINDING_FIELDS.some((f) => p === f || p.startsWith(f + '.'));

// Does ANY operator in the update reference owner/examId — as a $set/$unset/$inc/…
// key (including dotted subpaths), or as a `$rename` source OR destination?
function updateTouchesBinding(u) {
    if (!u || typeof u !== 'object' || Array.isArray(u)) return false;
    for (const [op, val] of Object.entries(u)) {
        if (!op.startsWith('$')) { if (pathTouchesBinding(op)) return true; continue; }
        if (op === '$rename') {
            for (const [src, dest] of Object.entries(val || {})) {
                if (pathTouchesBinding(src) || pathTouchesBinding(String(dest))) return true;
            }
            continue;
        }
        if (val && typeof val === 'object') {
            for (const key of Object.keys(val)) if (pathTouchesBinding(key)) return true;
        }
    }
    return false;
}

// The ONE permitted binding-touching write: the exact single-row staged→claimed
// claim, validated by an ALLOWLIST of filter + update keys (no extra predicates,
// no operator objects, no extra $set/$unset keys).
const CLAIM_FILTER_KEYS = new Set(['_id', 'owner', 'state', 'examId', 'expiresAt', 'opToken']);
const CLAIM_SET_REQUIRED = ['state', 'examId', 'opToken', 'claimedAt'];
const CLAIM_SET_TIMESTAMPS = new Set(['updatedAt', 'createdAt']); // mongoose auto-adds these
function isExactClaim(op, filter, update) {
    if (op !== 'findOneAndUpdate') return false;
    if (!filter || !update || Array.isArray(update)) return false;
    // filter: only the allowlisted claim predicate keys, each in its exact shape.
    if (Object.keys(filter).some((k) => !CLAIM_FILTER_KEYS.has(k))) return false;
    if (!isScalarId(filter._id) || !isScalarId(filter.owner)) return false;
    if (filter.state !== 'staged') return false;
    if (!isExistsFalse(filter.examId)) return false;            // examId MUST be absent
    if (!isFutureGt(filter.expiresAt)) return false;
    if ('opToken' in filter && !isExistsFalse(filter.opToken)) return false; // if present, must be absent
    // update operators: ONLY $set + $unset + (mongoose's timestamp) $setOnInsert.
    // Any binding field in $setOnInsert is already caught by updateTouchesBinding;
    // here $setOnInsert may carry ONLY timestamp keys.
    if (Object.keys(update).some((k) => k !== '$set' && k !== '$unset' && k !== '$setOnInsert')) return false;
    const set = update.$set || {};
    const unset = update.$unset || {};
    const setOnInsert = update.$setOnInsert || {};
    if (!CLAIM_SET_REQUIRED.every((k) => k in set)) return false;
    if (Object.keys(set).some((k) => !CLAIM_SET_REQUIRED.includes(k) && !CLAIM_SET_TIMESTAMPS.has(k))) return false;
    if (Object.keys(setOnInsert).some((k) => !CLAIM_SET_TIMESTAMPS.has(k))) return false;
    if (set.state !== 'claimed') return false;
    if (!isScalarId(set.examId)) return false;
    if (typeof set.opToken !== 'string' || !set.opToken) return false;
    if (!(set.claimedAt instanceof Date)) return false;
    const unsetKeys = Object.keys(unset);
    if (unsetKeys.length !== 1 || unsetKeys[0] !== 'expiresAt') return false;
    return true;
}

pdfSchema.pre('validate', function bindingRequired(next) {
    if (BINDING_STATES.includes(this.state) && (!this.owner || !this.examId)) {
        return next(new Error(`PDF in state "${this.state}" must carry owner and examId`));
    }
    next();
});
// Document save: an EXISTING doc may not modify owner/examId at all.
pdfSchema.pre('save', function bindingImmutableOnSave(next) {
    if (this.isNew) return next();
    if (this.isModified('owner')) return next(new Error('PDF owner is immutable and cannot be reassigned'));
    if (this.isModified('examId')) return next(new Error('PDF examId is immutable and cannot be reassigned'));
    next();
});
function guardBindingUpdate(next) {
    const op = this.op || '';
    // (4) Replacement writes are rejected outright — no shipping caller uses them.
    if (op === 'replaceOne' || op === 'findOneAndReplace') {
        return next(new Error('PDF replaceOne/findOneAndReplace are rejected (immutable binding)'));
    }
    const u = this.getUpdate() || {};
    // (4) Aggregation-pipeline updates (array of stages) are rejected.
    if (Array.isArray(u)) {
        return next(new Error('PDF aggregation-pipeline updates are rejected (immutable binding)'));
    }
    const filter = (typeof this.getFilter === 'function' ? this.getFilter() : (typeof this.getQuery === 'function' ? this.getQuery() : {})) || {};
    // (3) FAIL-CLOSED: ANY operator/path that can touch owner/examId ($set, $unset,
    //     $rename source/dest, $setOnInsert, dotted paths, …) is rejected UNLESS the
    //     whole write is the exact staged→claimed claim.
    if (updateTouchesBinding(u)) {
        if (isExactClaim(op, filter, u)) return next();
        return next(new Error('PDF owner/examId binding is immutable (only the exact staged→claimed claim may set examId)'));
    }
    next();
}
pdfSchema.pre('findOneAndUpdate', guardBindingUpdate);
pdfSchema.pre('updateOne', guardBindingUpdate);
pdfSchema.pre('updateMany', guardBindingUpdate);
pdfSchema.pre('replaceOne', guardBindingUpdate);
pdfSchema.pre('findOneAndReplace', guardBindingUpdate);

const PdfModel = mongoose.model('PDF', pdfSchema);

// (4) CR-095: reject PDF.bulkWrite OUTRIGHT. No shipping caller uses it, and a
// second update-language parser is an unnecessary bypass surface.
PdfModel.bulkWrite = function rejectedBulkWrite() {
    return Promise.reject(new Error('PDF bulkWrite is rejected (immutable binding; no shipping caller)'));
};

module.exports = PdfModel;
