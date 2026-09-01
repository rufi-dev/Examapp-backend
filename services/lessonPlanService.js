/*
 * Lesson-plan persistence: draft CAS, immutable publish, and AI proposals.
 *
 * Three rules this file exists to enforce:
 *   1. two tabs cannot overwrite each other — every draft write is a revision CAS
 *      that 409s on a stale revision (the board editor's pattern);
 *   2. publishing freezes an immutable version and claims its sources IN THE SAME
 *      TRANSACTION, so a version can never exist without the references that
 *      protect its bytes;
 *   3. AI regeneration writes a PROPOSAL + diff and never overwrites teacher edits.
 */
const LessonPlan = require("../models/lessonPlanModel");
const LessonPlanVersion = require("../models/lessonPlanVersionModel");
const CurriculumSourceVersion = require("../models/curriculumSourceVersionModel");
const { withMongoTransaction, sessionOpt } = require("./mongoUnitOfWork");
const { publishWithRetry } = require("../helper/immutableVersion");
const { claimNew, transferHolder, releaseHolder } = require("./curriculumSourceService");
const { performMaintenance } = require("./versionMaintenance");
const { httpError } = require("../utils/appError");

const CONTENT_FIELDS = [
  "title", "grade", "subject", "topic", "subStandards", "objectives", "criteria",
  "motivation", "motivationOrigin", "stages", "tasks", "reflection", "homework",
  "materials", "lessonMinutes", "sourceMode", "homeworkWarning",
];

/*
 * The frozen content. Mongoose subdocuments carry circular parent references, so
 * they are converted to PLAIN JSON first — otherwise the canonical hash walk
 * recurses forever. `toJSON` also drops internals that would perturb the hash
 * without changing what the teacher published.
 */
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const snapshotOf = (plan) => {
  const src = typeof plan.toObject === "function" ? plan.toObject({ depopulate: true }) : plan;
  const out = {};
  for (const f of CONTENT_FIELDS) out[f] = plain(src[f]);
  out.sourceVersions = (src.sourceVersions || []).map(String);
  return out;
};

/*
 * Draft write with compare-and-set on `revision`. A caller that omits the revision
 * is refused outright: a blind write is how one tab silently discards another's.
 */
async function updateDraft(planId, ownerId, patch, expectedRevision, unset) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === "") {
    throw httpError(400, "revision_required", "Dəyişikliyi göndərərkən `revision` göndərilməlidir.");
  }
  const expected = Number(expectedRevision);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw httpError(400, "bad_revision", "`revision` düzgün deyil.");
  }
  const revMatch = expected === 0 ? { $in: [0, null] } : expected;
  /*
   * $unset is separate on purpose. `$set: { proposal: undefined }` is dropped by
   * Mongoose before it reaches Mongo, so accepting a proposal left the proposal on
   * the document and the "AI yeni variant hazırladı" panel never went away.
   */
  const update = { $set: patch, $inc: { revision: 1 } };
  const drop = (Array.isArray(unset) ? unset : []).filter(Boolean);
  if (drop.length) update.$unset = Object.fromEntries(drop.map((f) => [f, ""]));

  const updated = await LessonPlan.findOneAndUpdate(
    { _id: planId, owner: ownerId, revision: revMatch },
    update,
    { new: true }
  );
  if (!updated) {
    const exists = await LessonPlan.exists({ _id: planId, owner: ownerId });
    if (!exists) throw httpError(404, "plan_missing", "Dərs planı tapılmadı.");
    throw httpError(409, "lesson_plan_conflict", "Plan başqa yerdə dəyişdirilib — səhifəni yeniləyin.");
  }
  return updated;
}

/*
 * Publish. Claims happen inside the publish transaction; a draft that already
 * pinned a source TRANSFERS its hold onto the published version, which is what
 * lets it publish against bytes that have since been superseded.
 */
async function publish(planId, ownerId) {
  const plan = await LessonPlan.findOne({ _id: planId, owner: ownerId });
  if (!plan) throw httpError(404, "plan_missing", "Dərs planı tapılmadı.");
  if (!(plan.tasks || []).length && !(plan.stages || []).length) {
    throw httpError(422, "plan_empty", "Boş planı dərc etmək olmaz.");
  }

  const content = snapshotOf(plan);
  const versions = await CurriculumSourceVersion.find({ _id: { $in: plan.sourceVersions || [] } })
    .select("sha256")
    .lean();

  const version = await publishWithRetry(withMongoTransaction, {
    Parent: LessonPlan,
    Version: LessonPlanVersion,
    docId: plan._id,
    content,
    author: ownerId,
    extra: {
      sourceVersions: plan.sourceVersions || [],
      sourceHashes: versions.map((v) => v.sha256),
      schemaVersion: plan.schemaVersion || 1,
    },
    onClaimSources: async (v, session) => {
      for (const svId of plan.sourceVersions || []) {
        // Claim-then-release: the source is never momentarily unreferenced.
        await transferHolder(
          {
            sourceVersionId: svId,
            fromKind: "draft",
            fromId: plan._id,
            toKind: "published_version",
            toId: v._id,
            holderLabel: plan.title,
          },
          session
        ).catch(async (e) => {
          // A plan that never held a draft reference (e.g. sources attached after
          // the last save) makes a fresh claim instead.
          if (e && e.code === "source_hold_missing") {
            await claimNew(
              { sourceVersionId: svId, holderKind: "published_version", holderId: v._id, holderLabel: plan.title },
              session
            );
            return;
          }
          throw e;
        });
      }
    },
  });
  return version;
}

// Attach/replace the draft's pinned sources, holding them as `draft` so a delete
// cannot take them out from under unpublished work.
async function setSources(planId, ownerId, sourceVersionIds) {
  return withMongoTransaction(async (session) => {
    const plan = await LessonPlan.findOne({ _id: planId, owner: ownerId }).session(session || null);
    if (!plan) throw httpError(404, "plan_missing", "Dərs planı tapılmadı.");
    for (const id of sourceVersionIds) {
      await claimNew({ sourceVersionId: id, holderKind: "draft", holderId: plan._id, holderLabel: plan.title }, session);
    }
    plan.sourceVersions = sourceVersionIds;
    await plan.save({ session: session || undefined });
    return plan;
  });
}

/*
 * ARCHIVE IS PARENT-SIDE ONLY (CR-MSO-016). It never touches a version row and
 * never releases a `published_version` reference: a citation pinned by a published
 * version stays valid for as long as that row exists, archived or not.
 */
async function archive(planId, ownerId, archived = true) {
  const plan = await LessonPlan.findOneAndUpdate(
    { _id: planId, owner: ownerId },
    { $set: { archivedAt: archived ? new Date() : null, status: archived ? "archived" : "published" } },
    { new: true }
  );
  if (!plan) throw httpError(404, "plan_missing", "Dərs planı tapılmadı.");
  return plan;
}

// Deleting a DRAFT releases its draft holds, in the same transaction.
/*
 * Delete a plan for real, published or not.
 *
 * A published plan is not just a row: it owns immutable LessonPlanVersion rows and,
 * through them, `published_version` claims on the textbook chapters it cites. So
 * "delete" has to unwind all three or it leaves either orphan versions or a chapter
 * that can never be deleted because something invisible still holds it.
 *
 * Immutability is what protects PUBLISHED CONTENT FROM BEING REWRITTEN; it was never
 * meant to stop the owner removing their own plan. Destroying those rows is
 * therefore done the way the repo already requires for any authorized mutation of an
 * immutable row — inside performMaintenance, which writes a durable MaintenanceAudit
 * FIRST (actor, reason, target). The deletion is irreversible, so it leaves a trail.
 *
 * `force` is required for the published case: a stray DELETE must not be able to
 * destroy published content, and the caller has to have asked for it deliberately.
 */
async function deleteDraft(planId, ownerId, { actor, force } = {}) {
  const plan = await LessonPlan.findOne({ _id: planId, owner: ownerId });
  if (!plan) throw httpError(404, "plan_missing", "Dərs planı tapılmadı.");

  const published = (plan.activeVersionNumber || 0) > 0;
  if (!published) {
    return withMongoTransaction(async (session) => {
      await releaseHolder({ holderKind: "draft", holderId: plan._id }, session);
      await LessonPlan.deleteOne({ _id: plan._id }, session ? { session } : {});
      return { deleted: true, versionsRemoved: 0 };
    });
  }

  if (force !== true) {
    throw httpError(
      409,
      "plan_published_confirm",
      "Bu plan dərc edilib — silinməsi üçün açıq təsdiq tələb olunur."
    );
  }

  const versions = await LessonPlanVersion.find({ docId: plan._id }).select("_id").lean();
  return performMaintenance(
    {
      actor: String(actor || ownerId),
      reason: `owner deleted published lesson plan "${plan.title}" (${versions.length} version row(s))`,
      action: "lesson_plan_delete",
      target: String(plan._id),
      authorized: true,
    },
    async () =>
      withMongoTransaction(async (session) => {
        // Release BEFORE the version rows go: a reference whose holder no longer
        // exists would keep a chapter undeletable with nothing left to point at.
        for (const v of versions) {
          await releaseHolder({ holderKind: "published_version", holderId: v._id }, session);
        }
        await releaseHolder({ holderKind: "draft", holderId: plan._id }, session);
        await LessonPlanVersion.deleteMany({ docId: plan._id }, sessionOpt(session));
        await LessonPlan.deleteOne({ _id: plan._id }, session ? { session } : {});
        return { deleted: true, versionsRemoved: versions.length };
      })
  );
}

/*
 * An AI regeneration lands as a PROPOSAL with a field-level diff. The teacher's
 * current draft is untouched until they accept it.
 */
function diffAgainst(plan, proposed) {
  const changed = [];
  for (const f of CONTENT_FIELDS) {
    const a = JSON.stringify(plan[f] ?? null);
    const b = JSON.stringify(proposed[f] ?? null);
    if (a !== b) changed.push(f);
  }
  return changed;
}

async function proposeRegeneration(planId, ownerId, proposed, meta = {}) {
  const plan = await LessonPlan.findOne({ _id: planId, owner: ownerId });
  if (!plan) throw httpError(404, "plan_missing", "Dərs planı tapılmadı.");
  const changed = diffAgainst(plan, proposed);
  plan.proposal = { content: proposed, changed, at: new Date(), ...meta };
  await plan.save();
  return { changed, proposal: plan.proposal };
}

async function acceptProposal(planId, ownerId, expectedRevision) {
  const plan = await LessonPlan.findOne({ _id: planId, owner: ownerId });
  if (!plan) throw httpError(404, "plan_missing", "Dərs planı tapılmadı.");
  if (!plan.proposal || !plan.proposal.content) {
    throw httpError(409, "no_proposal", "Qəbul ediləcək təklif yoxdur.");
  }
  const patch = { ...plan.proposal.content };
  delete patch.proposal;
  return updateDraft(planId, ownerId, patch, expectedRevision, ["proposal"]);
}

module.exports = {
  CONTENT_FIELDS,
  snapshotOf,
  updateDraft,
  publish,
  setSources,
  archive,
  deleteDraft,
  diffAgainst,
  proposeRegeneration,
  acceptProposal,
};
