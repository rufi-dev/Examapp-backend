const LessonDoc = require("../models/lessonDocModel");
const { httpError } = require("../utils/appError");

/*
 * Every write to a lesson material, and the one rule they all obey.
 *
 * WHY THIS FILE EXISTS. The controller used to read a document, mutate the
 * Mongoose object, and call `doc.save()` — thirteen times, on thirteen paths, with
 * a revision check on exactly one of them, and that one optional. Between the read
 * and the save there is a window, and in that window a second tab, or an AI turn
 * finishing a minute after it started, writes the whole document back from the
 * copy it read at the beginning. Whoever saves last wins and the other edit is
 * gone, silently, with no error anywhere.
 *
 * So: no path may call `doc.save()`. Every write goes through a compare-and-set on
 * `revision` — the same contract lesson plans have used since CR-089, copied here
 * deliberately rather than reinvented, down to the error codes, so that two
 * features which behave identically also FAIL identically.
 *
 * The AI paths matter most. A generation reads the document, spends 40 seconds
 * with a provider, and commits. If the teacher edited a block in the meantime, the
 * commit must lose — it is writing a document that no longer exists. It gets a
 * conflict instead of quietly erasing the edit.
 */

const CONFLICT = "Material başqa yerdə dəyişdirilib — səhifəni yeniləyin.";

/*
 * A revision the caller must actually have. `undefined` is refused rather than
 * treated as "whatever is current": a blind write is precisely how one tab
 * discards another's, and defaulting it would put that behaviour back.
 */
function requireRevision(expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === "") {
    throw httpError(400, "revision_required", "Dəyişikliyi göndərərkən `revision` göndərilməlidir.");
  }
  const expected = Number(expectedRevision);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw httpError(400, "bad_revision", "`revision` düzgün deyil.");
  }
  return expected;
}

/*
 * The one write primitive. Returns the NEW document or throws — never returns a
 * stale copy, so a caller cannot accidentally keep using the version it read.
 *
 * `revision: 0` has to match a missing field too: documents created before the
 * field existed have no `revision` at all, and `{ revision: 0 }` would not find
 * them. Same reasoning as lessonPlanService.
 */
async function commit(docId, ownerId, patch, expectedRevision, { unset, push } = {}) {
  const expected = requireRevision(expectedRevision);
  const revMatch = expected === 0 ? { $in: [0, null] } : expected;

  // $unset is separate: Mongoose drops `$set: { x: undefined }` before it reaches
  // Mongo, so clearing a field through `patch` silently does nothing.
  const update = { $set: patch, $inc: { revision: 1 } };
  const drop = (Array.isArray(unset) ? unset : []).filter(Boolean);
  if (drop.length) update.$unset = Object.fromEntries(drop.map((f) => [f, ""]));
  /*
   * `push` exists so a turn can append its message in the SAME write that commits
   * its blocks. Appending is not the same as setting: the in-memory copy the
   * caller read is already stale — the teacher's own message was pushed onto the
   * document seconds ago — so writing the array back would delete it. One atomic
   * update also means a document can never gain blocks without the message that
   * explains them, or vice versa.
   */
  if (push && Object.keys(push).length) {
    update.$push = Object.fromEntries(Object.entries(push).map(([k, v]) => [k, { $each: [].concat(v) }]));
  }

  const updated = await LessonDoc.findOneAndUpdate(
    { _id: docId, owner: ownerId, revision: revMatch },
    update,
    { new: true }
  );
  if (!updated) {
    /*
     * A zero-match means one of two very different things, and answering "conflict"
     * for both would tell a teacher to refresh a document that is not there. Ask.
     */
    const exists = await LessonDoc.exists({ _id: docId, owner: ownerId });
    if (!exists) throw httpError(404, "doc_missing", "Material tapılmadı.");
    throw httpError(409, "doc_conflict", CONFLICT);
  }
  return updated;
}

/*
 * Append to the transcript without touching the document's revision.
 *
 * A message is not document content: the teacher's own words, a failure note, a
 * "stopped" marker. Bumping the revision for them would invalidate every open tab
 * on a turn that changed no blocks, and — worse — a failure note written during a
 * conflict would itself conflict. `$push` is atomic on its own, so this needs no
 * CAS and deliberately does not take one.
 */
async function appendMessages(docId, ownerId, messages) {
  const list = (Array.isArray(messages) ? messages : [messages]).filter(Boolean);
  if (!list.length) return null;
  return LessonDoc.findOneAndUpdate(
    { _id: docId, owner: ownerId },
    { $push: { messages: { $each: list } } },
    { new: true }
  );
}

/*
 * The document quota, counted atomically.
 *
 * `countDocuments()` then `create()` is a race with a window between the two: ten
 * requests at 199 documents all read 199, all decide there is room, and all
 * create. The limit was never enforced, only usually observed.
 *
 * A counter on the owner turns the check and the claim into ONE conditional write
 * — `{ lessonDocCount: { $lt: MAX } }` either matches and increments or matches
 * nothing — so exactly one of those ten requests wins the last slot.
 *
 * The counter is seeded once from the real count, so it is correct for accounts
 * that already have documents rather than silently granting them a fresh
 * allowance. Two concurrent seeds both compute the same number and only one wins
 * the `$exists: false` predicate, so the seed cannot double-apply.
 */
async function reserveDocSlot(User, ownerId, max) {
  const seeded = await User.updateOne(
    { _id: ownerId, lessonDocCount: { $exists: false } },
    { $set: { lessonDocCount: await LessonDoc.countDocuments({ owner: ownerId, archivedAt: null }) } }
  );
  void seeded;

  const claimed = await User.updateOne(
    { _id: ownerId, lessonDocCount: { $lt: max } },
    { $inc: { lessonDocCount: 1 } }
  );
  if (!claimed.modifiedCount) {
    throw httpError(422, "too_many_docs", `Ən çox ${max} material saxlaya bilərsiniz.`);
  }
}

/*
 * Give the slot back. Called when a create fails after its slot was claimed, and
 * when a document is deleted. Floored at zero: a counter that drifts BELOW the
 * truth would hand out slots that do not exist, which is the one direction of
 * drift that breaks the limit rather than merely tightening it.
 */
async function releaseDocSlot(User, ownerId) {
  await User.updateOne({ _id: ownerId, lessonDocCount: { $gt: 0 } }, { $inc: { lessonDocCount: -1 } }).catch(() => {});
}

module.exports = { commit, appendMessages, requireRevision, reserveDocSlot, releaseDocSlot, CONFLICT };
