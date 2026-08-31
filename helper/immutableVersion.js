/*
 * CR-MSO-008 / CR-MSO-012 — reusable immutable-publication machinery.
 *
 * Generalised from models/examVersionModel.js + helper/examVersion.js, which
 * already solve exactly this for exams. Nothing about the exam path is changed;
 * this is a second, independent instance of the same proven shape.
 *
 * Guarantees:
 *   - a published version row NEVER changes. pre("save") rejects re-saving an
 *     existing row; every query mutator and deleteOne is blocked as BOTH query and
 *     document middleware; bulkWrite is overridden to reject. The only escape
 *     hatch is services/versionMaintenance.performMaintenance, which demands an
 *     actor + reason and writes a durable audit FIRST.
 *   - `state: published|archived` does NOT live on the version, because an
 *     immutable row cannot transition. ARCHIVE VISIBILITY LIVES ON THE PARENT
 *     (`archivedAt`), and archiving therefore releases no source reference.
 *   - contentHash = sha256 over a canonically key-sorted snapshot, so property
 *     order cannot perturb it. Unique {docId, contentHash} makes republishing
 *     identical content idempotent.
 */
const crypto = require("crypto");
const { isAuthorizedContext } = require("../services/versionMaintenance");

/*
 * Recursive key sort so JSON property order can never change the hash.
 *
 * Anything with a toJSON (a Date, an ObjectId, a Mongoose subdocument) is
 * converted FIRST: a Mongoose subdocument holds a circular reference to its
 * parent, and walking it directly overflows the stack.
 */
function stableStringify(v, seen = new WeakSet()) {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (typeof v.toJSON === "function") {
    const j = v.toJSON();
    // toJSON that returns another object (Mongoose docs) still needs the walk, but
    // the primitive case (Date, ObjectId) terminates here.
    if (j === null || typeof j !== "object") return JSON.stringify(j);
    v = j;
  }
  if (seen.has(v)) throw new Error("stableStringify: circular value — pass plain JSON");
  seen.add(v);
  const out = Array.isArray(v)
    ? `[${v.map((x) => stableStringify(x, seen)).join(",")}]`
    : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k], seen)}`).join(",")}}`;
  seen.delete(v);
  return out;
}

const hashCanonical = (content) => crypto.createHash("sha256").update(stableStringify(content)).digest("hex");

/*
 * Attach the immutability middleware to a version schema. `label` only shapes the
 * error text, so a reader of a stack trace knows which artifact refused.
 */
function makeImmutable(schema, label) {
  const refuse = (what) => {
    const e = new Error(
      `${label} rows are immutable — ${what} is not allowed. Use services/versionMaintenance.performMaintenance ` +
        `(actor + reason + authorized:true, durable audit written first).`
    );
    e.immutableViolation = true;
    return e;
  };

  schema.pre("save", function guardSave(next) {
    if (this.isNew || isAuthorizedContext()) return next();
    return next(refuse("re-saving an existing row"));
  });

  const MUTATORS = [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "replaceOne",
    "findOneAndReplace",
    "deleteMany",
    "findOneAndDelete",
    "deleteOne",
  ];
  schema.pre(MUTATORS, function guardQuery(next) {
    if (isAuthorizedContext()) return next();
    return next(refuse(this.op || "a query mutator"));
  });
  // deleteOne is both a query and a document hook depending on how it is called.
  schema.pre("deleteOne", { document: true, query: false }, function guardDocDelete(next) {
    if (isAuthorizedContext()) return next();
    return next(refuse("deleteOne"));
  });

  return schema;
}

// bulkWrite bypasses every hook above, so the model method itself is replaced.
function guardBulkWrite(Model, label) {
  const original = Model.bulkWrite.bind(Model);
  Model.bulkWrite = function guardedBulkWrite(...args) {
    if (isAuthorizedContext()) return original(...args);
    return Promise.reject(
      Object.assign(new Error(`${label}.bulkWrite is not allowed — rows are immutable.`), {
        immutableViolation: true,
      })
    );
  };
  return Model;
}

/*
 * Publish `content` as the next immutable version of `docId`.
 *
 * Concurrency (CR-MSO-012):
 *   1. reuse by content hash — an identical republish is a no-op that still
 *      reconciles references and re-runs the pointer step;
 *   2. allocate with retry on duplicate key — re-check by hash first (reuse), else
 *      retry at a higher number;
 *   3. advance the parent pointer with an absent-safe ADVANCE-ONLY CAS.
 *
 * IMPORTANT: a duplicate-key error inside a Mongo transaction poisons that
 * transaction, so the retry loop must wrap the WHOLE transaction. `attempt` here
 * runs one attempt; the caller retries it. See publishWithRetry below.
 *
 * Zero-match pointer CAS is NOT automatically fatal: when a strictly NEWER version
 * is already active, a slower publisher must not move the pointer backwards and
 * its own version is legitimately published. Anything else aborts, so no orphan
 * version or reference can survive.
 */
async function publishVersionAttempt({
  Parent,
  Version,
  docId,
  content,
  extra = {},
  author = null,
  session,
  onClaimSources,
}) {
  const opts = session ? { session } : {};
  const contentHash = hashCanonical(content);

  let version = await Version.findOne({ docId, contentHash }).session(session || null);
  if (!version) {
    const last = await Version.findOne({ docId }).sort({ versionNumber: -1 }).lean().session(session || null);
    const versionNumber = last ? last.versionNumber + 1 : 1;
    const created = await Version.create(
      [{ docId, versionNumber, contentHash, author, publishedAt: new Date(), content, ...extra }],
      opts
    );
    version = created[0];
  }

  // Source claims live in the SAME transaction as the version create, so a version
  // can never exist without the references that protect its bytes.
  if (typeof onClaimSources === "function") await onClaimSources(version, session);

  const res = await Parent.updateOne(
    {
      _id: docId,
      $or: [
        { activeVersionNumber: { $lt: version.versionNumber } },
        { activeVersionNumber: { $exists: false } },
        { activeVersionNumber: null },
      ],
    },
    { $set: { activeVersion: version._id, activeVersionNumber: version.versionNumber, status: "published" } },
    opts
  );

  if (res.modifiedCount !== 1) {
    // Re-read INSIDE the transaction and decide. TWO outcomes are legitimate:
    //   - a strictly NEWER version is already active: a slower publisher must not
    //     move the pointer backwards, and its own version is still published;
    //   - THIS version is already the active one: an identical republish is an
    //     idempotent no-op, not a failure.
    // Anything else aborts, so no orphan version or reference can survive.
    const parent = await Parent.findById(docId)
      .select("activeVersion activeVersionNumber")
      .lean()
      .session(session || null);
    const active = parent ? Number(parent.activeVersionNumber) || 0 : -1;
    const alreadyThisVersion =
      parent && active === version.versionNumber && String(parent.activeVersion) === String(version._id);
    if (!parent || (active <= version.versionNumber && !alreadyThisVersion)) {
      const e = new Error("publish pointer did not advance and no newer version is active");
      e.publishAbort = true;
      throw e;
    }
  }
  return version;
}

const isRetryablePublishError = (e) =>
  !!e &&
  (e.code === 11000 ||
    e.codeName === "WriteConflict" ||
    e.code === 112 ||
    (Array.isArray(e.errorLabels) && e.errorLabels.includes("TransientTransactionError")));

/*
 * Run publishVersionAttempt inside its OWN transaction, retrying the whole
 * transaction (never just the create) on duplicate key / write conflict.
 */
async function publishWithRetry(runInTransaction, args, attempts = 8) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await runInTransaction(async (session) => publishVersionAttempt({ ...args, session }));
    } catch (e) {
      lastErr = e;
      if (!isRetryablePublishError(e)) throw e;
    }
  }
  const e = new Error("could not allocate a version number");
  e.code = "version_alloc_failed";
  e.cause = lastErr;
  throw e;
}

module.exports = {
  stableStringify,
  hashCanonical,
  makeImmutable,
  guardBulkWrite,
  publishVersionAttempt,
  publishWithRetry,
  isRetryablePublishError,
};
