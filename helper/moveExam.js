const mongoose = require("mongoose");
const Exam = require("../models/examModel");
const Class = require("../models/classModel");
const { withMongoTransaction } = require("../services/mongoUnitOfWork");

/*
 * Move an exam to another class the teacher owns.
 *
 * Ported from BunkerMath (PATCH /exam/:examId/class, 2026-09-16), where it is
 * the exam card's «Sinfi dəyiş». Only `exam.class` changes: results, attempts
 * and versions hang off the exam id, so they go with it; who may START it
 * follows the new class's enrolments from then on. Examopia differences: no
 * paper mode, classes keep a stored `examCount` instead of an `exams` list (so
 * the counts move inside one transaction), and a class in the trash can never
 * be the target. A move OUT of a trashed class is allowed - that is how an exam
 * restored into one gets out again.
 *
 * Shared by the card's endpoint and the support chat's confirmed action, so
 * both obey the same rules. Returns { status, body }; never throws for a
 * refusal.
 */
async function moveExam(user, examId, classId) {
  const isAdmin = user?.role === "admin";
  const no = (status, message) => ({ status, body: { message } });
  if (!mongoose.isValidObjectId(examId)) return no(404, "İmtahan tapılmadı");
  const exam = await Exam.findById(examId).select("name owner class deletedAt").lean();
  if (!exam) return no(404, "İmtahan tapılmadı");
  // Same rule as every exam edit (ownsOrAdmin): legacy exams with no owner stay editable.
  if (!isAdmin && exam.owner && String(exam.owner) !== String(user._id)) return no(403, "Bu imtahan sizə aid deyil");
  if (exam.deletedAt) return { status: 403, body: { reason: "archived", message: "İmtahan arxivdədir (zibil qutusunda)" } };
  if (!mongoose.isValidObjectId(classId)) return no(400, "Sinif seçin");
  const target = await Class.findOne({ _id: classId, deletedAt: null }).select("name owner").lean();
  if (!target) return no(404, "Sinif tapılmadı");
  if (!isAdmin && String(target.owner) !== String(user._id)) return no(403, "Bu sinif sizə aid deyil");

  const from = exam.class ? String(exam.class) : "";
  const moved = { _id: target._id, name: target.name };
  if (from === String(target._id)) return { status: 200, body: { success: true, unchanged: true, class: moved } };

  const RACED = "İmtahan bu vaxt dəyişdi, yenidən cəhd edin";
  try {
    await withMongoTransaction(async (session) => {
      const opts = session ? { session } : {};
      // Only from the class it was read in, and only while it is not in the trash.
      const saved = await Exam.updateOne(
        { _id: exam._id, class: exam.class || null, deletedAt: null },
        { $set: { class: target._id } },
        opts
      );
      if (saved.matchedCount !== 1) throw new Error(RACED);
      if (from) await Class.updateOne({ _id: from, examCount: { $gt: 0 } }, { $inc: { examCount: -1 } }, opts);
      await Class.updateOne({ _id: target._id }, { $inc: { examCount: 1 } }, opts);
    });
  } catch (e) {
    if (e.message === RACED) return no(409, RACED);
    throw e;
  }

  console.info(`[EXAM_MOVE] user=${user._id} exam=${exam._id} from=${from || "-"} to=${target._id}`);
  return { status: 200, body: { success: true, class: moved } };
}

module.exports = { moveExam };
