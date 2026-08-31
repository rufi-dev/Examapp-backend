/*
 * CR-MSO-001 / CR-MSO-016 — reference ownership for curriculum source versions.
 *
 * The race this exists to close: "does anything reference this version?" followed
 * by "mark it deleting" is TOCTOU — a draft or job can claim in between and its
 * bytes get unlinked underneath it. So claims and deletion CONTEND ON THE SAME
 * ROW, inside transactions, through the `refEpoch` fence:
 *
 *   claim   findOneAndUpdate({_id, state: <allowed>}, {$inc: {refEpoch: 1}})
 *   delete  findOneAndUpdate({_id, state: "ready", refEpoch: <observed>}, {$set: {state: "deleting"}})
 *
 * Under readConcern snapshot / w:majority one of a concurrent pair takes a write
 * conflict and retries, so a reference can never be inserted after deletion wins,
 * and deletion can never win after a claim commits.
 *
 * Two DISTINCT claim operations, because "already pinned" and "newly chosen" are
 * different questions:
 *   claimNew        a fresh claim  -> `ready` ONLY
 *   transferHolder  moves an existing hold (draft/job -> published_version)
 *                   -> `ready` OR `superseded`
 * That second case is CR-MSO-016: a draft that pinned v1 must still publish
 * against v1's exact bytes after the teacher uploads v2. Neither is ever allowed
 * on `deleting`.
 */
const mongoose = require("mongoose");
const CurriculumSource = require("../models/curriculumSourceModel");
const CurriculumSourceVersion = require("../models/curriculumSourceVersionModel");
const SourceReference = require("../models/sourceReferenceModel");
const { withMongoTransaction, sessionOpt } = require("./mongoUnitOfWork");
const { httpError } = require("../utils/appError");

const CLAIMABLE_NEW = ["ready"];
const CLAIMABLE_TRANSFER = ["ready", "superseded"];

const svcError = (status, code, message, details) => httpError(status, code, message, details);

/*
 * Bump the fence and prove the version is claimable, in the CALLER'S transaction.
 * Returns the updated version. Throws (aborting the caller's transaction) when the
 * version is missing or in a state that must not accept a claim.
 */
async function fenceVersion(sourceVersionId, allowedStates, session) {
  const v = await CurriculumSourceVersion.findOneAndUpdate(
    { _id: sourceVersionId, state: { $in: allowedStates } },
    { $inc: { refEpoch: 1 } },
    { new: true, ...sessionOpt(session) }
  );
  if (!v) {
    throw svcError(
      409,
      "source_version_unavailable",
      "Bu dərslik faylı artıq istifadəyə yararlı deyil (silinir və ya hazır deyil).",
      { reason: "source_version_unavailable", sourceVersionId: String(sourceVersionId) }
    );
  }
  return v;
}

async function addReference({ sourceVersionId, holderKind, holderId, holderLabel = "" }, session) {
  // Idempotent: the unique (version, kind, holder) index makes a repeated claim a
  // no-op rather than a second row, so a retried publish cannot inflate refCount.
  await SourceReference.updateOne(
    { sourceVersion: sourceVersionId, holderKind, holderId },
    { $setOnInsert: { sourceVersion: sourceVersionId, holderKind, holderId, holderLabel } },
    { upsert: true, ...sessionOpt(session) }
  );
}

async function syncRefCount(sourceId, session) {
  const versions = await CurriculumSourceVersion.find({ source: sourceId })
    .select("_id")
    .lean()
    .session(session || null);
  const count = await SourceReference.countDocuments({
    sourceVersion: { $in: versions.map((v) => v._id) },
  }).session(session || null);
  await CurriculumSource.updateOne({ _id: sourceId }, { $set: { refCount: count } }, sessionOpt(session));
  return count;
}

// A FRESH claim: only a `ready` version. Runs inside the caller's transaction.
async function claimNew({ sourceVersionId, holderKind, holderId, holderLabel }, session) {
  const v = await fenceVersion(sourceVersionId, CLAIMABLE_NEW, session);
  await addReference({ sourceVersionId, holderKind, holderId, holderLabel }, session);
  await syncRefCount(v.source, session);
  return v;
}

/*
 * Move an existing hold onto a new holder — draft/job -> published_version.
 * Claim-then-release, so the source is never momentarily unreferenced, and a
 * concurrent delete always sees at least one row.
 */
async function transferHolder(
  { sourceVersionId, fromKind, fromId, toKind, toId, holderLabel },
  session
) {
  const existing = await SourceReference.findOne({
    sourceVersion: sourceVersionId,
    holderKind: fromKind,
    holderId: fromId,
  })
    .lean()
    .session(session || null);
  if (!existing) {
    throw svcError(409, "source_hold_missing", "Bu sənəd artıq həmin dərslik faylını tutmur.", {
      reason: "source_hold_missing",
    });
  }
  // `superseded` is allowed HERE and only here: an already-pinned holder keeps its
  // exact bytes even after the teacher uploads a replacement.
  const v = await fenceVersion(sourceVersionId, CLAIMABLE_TRANSFER, session);
  await addReference({ sourceVersionId, holderKind: toKind, holderId: toId, holderLabel }, session);
  await SourceReference.deleteOne(
    { sourceVersion: sourceVersionId, holderKind: fromKind, holderId: fromId },
    sessionOpt(session)
  );
  await syncRefCount(v.source, session);
  return v;
}

/*
 * Release every hold of one holder. Called in the SAME transaction as the state
 * change that ends the hold: draft deleted or swept as abandoned, job cancelled or
 * dead-lettered. NEVER on archive — an archived publication keeps its sources.
 */
async function releaseHolder({ holderKind, holderId }, session) {
  const rows = await SourceReference.find({ holderKind, holderId })
    .select("sourceVersion")
    .lean()
    .session(session || null);
  if (!rows.length) return 0;
  await SourceReference.deleteMany({ holderKind, holderId }, sessionOpt(session));
  const versions = await CurriculumSourceVersion.find({ _id: { $in: rows.map((r) => r.sourceVersion) } })
    .select("source")
    .lean()
    .session(session || null);
  for (const sid of new Set(versions.map((v) => String(v.source)))) {
    await syncRefCount(new mongoose.Types.ObjectId(sid), session);
  }
  return rows.length;
}

// Change which version a draft/job holds: claim the new, then release the old.
async function switchSelection({ holderKind, holderId, toSourceVersionId, holderLabel }, session) {
  await fenceVersion(toSourceVersionId, CLAIMABLE_NEW, session);
  await addReference({ sourceVersionId: toSourceVersionId, holderKind, holderId, holderLabel }, session);
  await SourceReference.deleteMany(
    { holderKind, holderId, sourceVersion: { $ne: toSourceVersionId } },
    sessionOpt(session)
  );
  const v = await CurriculumSourceVersion.findById(toSourceVersionId).select("source").lean().session(session || null);
  if (v) await syncRefCount(v.source, session);
}

/*
 * Claim the deletion of a version. Its own transaction, and it does NOT unlink —
 * the filesystem is not transactional, so the caller unlinks only after this
 * commits, and retains the row if the unlink fails (mirroring deletePdfDurably).
 *
 * Fails CLOSED: any doubt about the reference state refuses the delete.
 */
async function claimDeletion(sourceVersionId) {
  return withMongoTransaction(async (session) => {
    const v = await CurriculumSourceVersion.findById(sourceVersionId).session(session || null);
    if (!v) throw svcError(404, "source_version_missing", "Dərslik faylı tapılmadı.");
    if (v.state === "deleting") return { alreadyClaimed: true, version: v };
    if (v.state === "staged") {
      throw svcError(409, "source_version_unavailable", "Fayl hələ hazır deyil.", {
        reason: "source_version_unavailable",
      });
    }

    const holders = await SourceReference.find({ sourceVersion: v._id })
      .select("holderKind holderId holderLabel")
      .lean()
      .session(session || null);
    if (holders.length) {
      throw svcError(
        409,
        "source_in_use",
        "Bu dərslik faylına istinad edən sənədlər var; əvvəlcə onları silin və ya dəyişin.",
        {
          reason: "source_in_use",
          holders: holders.map((h) => ({ kind: h.holderKind, id: String(h.holderId), label: h.holderLabel })),
        }
      );
    }

    const observedEpoch = v.refEpoch;
    const deleteToken = require("crypto").randomBytes(16).toString("hex");
    const claimed = await CurriculumSourceVersion.findOneAndUpdate(
      { _id: v._id, state: { $in: ["ready", "superseded"] }, refEpoch: observedEpoch },
      { $set: { state: "deleting", deleteToken } },
      { new: true, ...sessionOpt(session) }
    );
    if (!claimed) {
      // Someone claimed a reference between the check and the CAS. Refuse.
      throw svcError(409, "source_in_use", "Bu dərslik faylı eyni anda istifadəyə götürüldü.", {
        reason: "source_in_use",
      });
    }
    return { alreadyClaimed: false, version: claimed, deleteToken };
  });
}

// Finish a claimed deletion AFTER the bytes are gone. On unlink failure the caller
// must NOT call this: the row is retained so the locator is never lost.
async function finishDeletion(sourceVersionId, deleteToken) {
  const res = await CurriculumSourceVersion.deleteOne({
    _id: sourceVersionId,
    state: "deleting",
    deleteToken,
  });
  return res.deletedCount === 1;
}

module.exports = {
  CLAIMABLE_NEW,
  CLAIMABLE_TRANSFER,
  fenceVersion,
  addReference,
  syncRefCount,
  claimNew,
  transferHolder,
  releaseHolder,
  switchSelection,
  claimDeletion,
  finishDeletion,
};
