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
const { withMongoTransaction } = require("./mongoUnitOfWork");
const { publishWithRetry } = require("../helper/immutableVersion");
const { claimNew, transferHolder, releaseHolder } = require("./curriculumSourceService");
const { httpError } = require("../utils/appError");

const CONTENT_FIELDS = [
  "title", "grade", "subject", "topic", "subStandards", "objectives", "criteria",
  "motivation", "motivationOrigin", "stages", "tasks", "reflection", "homework",
  "materials", "lessonMinutes", "sourceMode",
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
async function updateDraft(planId, ownerId, patch, expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === "") {
    throw httpError(400, "revision_required", "Dəyişikliyi göndərərkən `revision` göndərilməlidir.");
  }
  const expected = Number(expectedRevision);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw httpError(400, "bad_revision", "`revision` düzgün deyil.");
  }
  const revMatch = expected === 0 ? { $in: [0, null] } : expected;
  const updated = await LessonPlan.findOneAndUpdate(
    { _id: planId, owner: ownerId, revision: revMatch },
    { $set: patch, $inc: { revision: 1 } },
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
async function deleteDraft(planId, ownerId) {
  return withMongoTransaction(async (session) => {
    const plan = await LessonPlan.findOne({ _id: planId, owner: ownerId }).session(session || null);
    if (!plan) throw httpError(404, "plan_missing", "Dərs planı tapılmadı.");
    if (plan.activeVersionNumber > 0) {
      throw httpError(409, "plan_published", "Dərc edilmiş planı silmək olmaz — arxivləyin.");
    }
    await releaseHolder({ holderKind: "draft", holderId: plan._id }, session);
    await LessonPlan.deleteOne({ _id: plan._id }, session ? { session } : {});
    return true;
  });
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
  const patch = { ...plan.proposal.content, proposal: undefined };
  return updateDraft(planId, ownerId, patch, expectedRevision);
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
