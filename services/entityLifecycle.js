const crypto = require("crypto");
const User = require("../models/userModel");
const Session = require("../models/sessionModel");
const Class = require("../models/classModel");
const Tag = require("../models/tagModel");
const Exam = require("../models/examModel");
const Enrollment = require("../models/enrollmentModel");
const Material = require("../models/materialModel");
const Video = require("../models/videoModel");
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

function deletionBatchId() {
  return `delete-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

module.exports = { archiveUsers, archiveClass, archiveTag, deletionBatchId };
