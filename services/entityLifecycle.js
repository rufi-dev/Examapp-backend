const crypto = require("crypto");
const User = require("../models/userModel");
const Session = require("../models/sessionModel");
const Class = require("../models/classModel");
const Tag = require("../models/tagModel");
const Exam = require("../models/examModel");
const Enrollment = require("../models/enrollmentModel");
const Material = require("../models/materialModel");
const Video = require("../models/videoModel");
const Attempt = require("../models/attemptModel");
const Result = require("../models/resultModel");
const Token = require("../models/tokenModel");
const { withMongoTransaction } = require("./mongoUnitOfWork");
const { httpError } = require("../utils/appError");

const opts = (session) => (session ? { session } : {});

async function archiveUsers(userIds, actorId) {
  const ids = [...new Set(userIds.map(String))];
  const now = new Date();
  return withMongoTransaction(async (session) => {
    const users = await User.find({ _id: { $in: ids }, deletedAt: null })
      .select("+password")
      .session(session || null);
    for (const user of users) {
      const suffix = String(user._id);
      await User.updateOne(
        { _id: user._id, deletedAt: null },
        {
          $set: {
            deletedAt: now,
            deletedBy: actorId,
            role: "suspended",
            teacherApproval: "none",
            name: "Deleted account",
            email: `deleted+${suffix}@invalid.examopia`,
            phone: "",
            bio: "",
            photo: "https://i.stack.imgur.com/34AD2.jpg",
            telegramChatId: null,
            whatsappGroupId: "",
            whatsappInviteLink: "",
            exams: [],
          },
          $unset: {
            results: "",
            teacherApprovalMeta: "",
            telegramLinkCode: "",
            telegramLinkedAt: "",
            _acqMig: "",
          },
          $inc: { sessionVersion: 1 },
        },
        opts(session)
      );
    }
    await Enrollment.deleteMany(
      { student: { $in: ids } },
      opts(session)
    );
    await Session.updateMany(
      { userId: { $in: ids }, revokedAt: null },
      { $set: { revokedAt: now, revokeReason: "account_deleted" } },
      opts(session)
    );
    return { archived: users.length };
  });
}

async function archiveClass(classId, actorId) {
  const now = new Date();
  return withMongoTransaction(async (session) => {
    const klass = await Class.findOneAndUpdate(
      { _id: classId, deletedAt: null },
      { $set: { deletedAt: now, deletedBy: actorId } },
      { new: true, ...opts(session) }
    );
    if (!klass) throw httpError(404, "class_not_found", "Class not found");
    await Exam.updateMany(
      { class: classId, deletedAt: null },
      { $set: { deletedAt: now, deletedBy: actorId } },
      opts(session)
    );
    await Enrollment.deleteMany({ class: classId }, opts(session));
    await Material.updateMany({}, { $pull: { classes: classId } }, opts(session));
    await Material.updateMany(
      { "share.joinClass": classId },
      { $set: { "share.joinClass": null } },
      opts(session)
    );
    await Material.updateMany({ class: classId }, { $set: { class: null } }, opts(session));
    await Video.updateMany({}, { $pull: { classes: classId } }, opts(session));
    await Video.updateMany({ class: classId }, { $set: { class: null } }, opts(session));
    return klass;
  });
}

async function archiveTag(tagId, actorId) {
  const now = new Date();
  return withMongoTransaction(async (session) => {
    const tag = await Tag.findOneAndUpdate(
      { _id: tagId, deletedAt: null },
      { $set: { deletedAt: now, deletedBy: actorId } },
      { new: true, ...opts(session) }
    );
    if (!tag) throw httpError(404, "tag_not_found", "Tag not found");
    const classIds = await Class.find({ tag: tagId, deletedAt: null })
      .distinct("_id")
      .session(session || null);
    if (classIds.length) {
      await Class.updateMany(
        { _id: { $in: classIds } },
        { $set: { deletedAt: now, deletedBy: actorId } },
        opts(session)
      );
      await Exam.updateMany(
        { class: { $in: classIds }, deletedAt: null },
        { $set: { deletedAt: now, deletedBy: actorId } },
        opts(session)
      );
      await Enrollment.deleteMany({ class: { $in: classIds } }, opts(session));
      await Material.updateMany({}, { $pull: { classes: { $in: classIds } } }, opts(session));
      await Material.updateMany(
        { "share.joinClass": { $in: classIds } },
        { $set: { "share.joinClass": null } },
        opts(session)
      );
      await Material.updateMany({ class: { $in: classIds } }, { $set: { class: null } }, opts(session));
      await Video.updateMany({}, { $pull: { classes: { $in: classIds } } }, opts(session));
      await Video.updateMany({ class: { $in: classIds } }, { $set: { class: null } }, opts(session));
    }
    return { tag, classIds };
  });
}

// HARD delete (physical removal) — the pre-remediation admin "delete" behaviour,
// but done as a CLEAN transactional cascade so nothing is left orphaned. Removes,
// in one transaction: the user's own attempts/results, their enrollments (as
// student OR teacher), the content they OWN (classes / exams / materials / videos)
// and the attempts/results taken on those owned exams, plus their sessions and
// auth tokens — and finally the user document(s). IRREVERSIBLE (no deletedAt shell
// is kept, unlike archiveUsers). The caller is responsible for authorization and
// for not passing the actor's own id.
async function hardDeleteUsers(userIds) {
  const ids = [...new Set(userIds.map(String))];
  if (!ids.length) return { deleted: 0 };
  return withMongoTransaction(async (session) => {
    const s = session || null;
    const ownedClassIds = await Class.find({ owner: { $in: ids } }).distinct("_id").session(s);
    const ownedExamIds = await Exam.find({ owner: { $in: ids } }).distinct("_id").session(s);

    // Attempts/results authored BY the user, or taken ON an exam the user owns.
    const attemptResultFilter = ownedExamIds.length
      ? { $or: [{ userId: { $in: ids } }, { examId: { $in: ownedExamIds } }] }
      : { userId: { $in: ids } };
    await Attempt.deleteMany(attemptResultFilter, opts(session));
    await Result.deleteMany(attemptResultFilter, opts(session));

    // Enrollments where the user is the student, the teacher, or in a class they own.
    const enrollFilter = [{ student: { $in: ids } }, { teacher: { $in: ids } }];
    if (ownedClassIds.length) enrollFilter.push({ class: { $in: ownedClassIds } });
    await Enrollment.deleteMany({ $or: enrollFilter }, opts(session));

    // Content the user owns.
    await Material.deleteMany({ owner: { $in: ids } }, opts(session));
    await Video.deleteMany({ owner: { $in: ids } }, opts(session));
    if (ownedExamIds.length) await Exam.deleteMany({ _id: { $in: ownedExamIds } }, opts(session));
    if (ownedClassIds.length) await Class.deleteMany({ _id: { $in: ownedClassIds } }, opts(session));

    // Auth records.
    await Session.deleteMany({ userId: { $in: ids } }, opts(session));
    await Token.deleteMany({ userId: { $in: ids } }, opts(session));

    const { deletedCount } = await User.deleteMany({ _id: { $in: ids } }, opts(session));
    return { deleted: deletedCount || 0 };
  });
}

function deletionBatchId() {
  return `delete-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

module.exports = { archiveUsers, hardDeleteUsers, archiveClass, archiveTag, deletionBatchId };
