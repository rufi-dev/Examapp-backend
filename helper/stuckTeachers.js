const Class = require("../models/classModel");
const Exam = require("../models/examModel");

// "Started but stuck" state for a set of teacher ids. A teacher is stuck if they
// created an EXAM and left it empty (no questions AND no PDF), created a CLASS
// with no exams inside, OR just signed up and made nothing at all — AND they have
// no working exam anywhere. One working exam means they got going, so the empty
// leftovers beside it are housekeeping rather than a stall. Returns a Map
// keyed by String(teacherId) → { emptyExams, hasEmptyExam, emptyClasses,
// hasEmptyClass, hasNoSetup, isStuck }. Shared by the admin directory
// (userController.getUsers) and the auto-outreach watcher so both agree on who
// counts as stuck.
async function stuckStateForOwners(teacherIds) {
  const map = new Map();
  const ids = (teacherIds || []).filter(Boolean);
  if (!ids.length) return map;

  // Empty exams (no content).
  const emptyExamRows = await Exam.aggregate([
    { $match: { owner: { $in: ids }, deletedAt: null } },
    { $lookup: { from: "questions", localField: "questions", foreignField: "_id", as: "q" } },
    {
      $project: {
        owner: 1,
        qcount: { $size: { $ifNull: [{ $arrayElemAt: ["$q.correctAnswers", 0] }, []] } },
        hasPdf: { $cond: [{ $ifNull: ["$pdf", false] }, true, false] },
      },
    },
    { $group: { _id: { owner: "$owner", empty: { $and: [{ $eq: ["$qcount", 0] }, { $eq: ["$hasPdf", false] }] } }, n: { $sum: 1 } } },
  ]);
  const emptyExamMap = new Map();
  const readyExamMap = new Map();
  emptyExamRows.forEach((r) => {
    const k = String(r._id.owner);
    const target = r._id.empty ? emptyExamMap : readyExamMap;
    target.set(k, (target.get(k) || 0) + r.n);
  });

  // Empty classes (a class with no exams).
  const tClasses = await Class.find({ owner: { $in: ids }, deletedAt: null })
    .select("owner")
    .lean();
  const withExams = new Set(
    tClasses.length
      ? (await Exam.find({ class: { $in: tClasses.map((c) => c._id) }, deletedAt: null }).distinct("class")).map(String)
      : []
  );
  const emptyClassMap = new Map();
  tClasses.forEach((c) => {
    if (!withExams.has(String(c._id))) {
      const k = String(c.owner);
      emptyClassMap.set(k, (emptyClassMap.get(k) || 0) + 1);
    }
  });
  // Teachers who created ANY class at all — those absent just signed up.
  const classOwners = new Set(tClasses.map((c) => String(c.owner)));

  ids.forEach((id) => {
    const k = String(id);
    const emptyExams = emptyExamMap.get(k) || 0;
    const readyExams = readyExamMap.get(k) || 0;
    const emptyClasses = emptyClassMap.get(k) || 0;
    const hasNoSetup = !classOwners.has(k);
    map.set(k, {
      emptyExams,
      hasEmptyExam: emptyExams > 0,
      readyExams,
      emptyClasses,
      hasEmptyClass: emptyClasses > 0,
      hasNoSetup,
      /*
       * A teacher with even ONE working exam has plainly got going, so an empty
       * class or a leftover draft alongside it is ordinary housekeeping — not a
       * sign they are stuck.
       *
       * Without this a teacher with ten live exams and two empty classes she made
       * for next term was queued for a "what went wrong?" WhatsApp. Outreach is
       * for people who signed up and never finished setting up; messaging an
       * active teacher as though she had failed is worse than not messaging at
       * all, and it is the kind of mistake that costs a customer.
       */
      isStuck: readyExams === 0 && (emptyExams > 0 || emptyClasses > 0 || hasNoSetup),
    });
  });
  return map;
}

module.exports = { stuckStateForOwners };
