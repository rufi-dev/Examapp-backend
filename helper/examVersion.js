// AUD-003 / CR-034 / CR-035 — immutable exam versions with a real draft/publish
// boundary and an enforced integrity contract.
//
// buildSnapshot freezes a COMPLETE, canonical grading+review record from a
// consistent (Exam, Question) read — including the resolved per-question point
// plan and an evaluator version, so a score is reproducible from the row alone.
// publishExam validates that snapshot, allocates a unique version number, and
// atomically CAS-swaps the exam's activeVersionId; a student start reads only that
// pointer, so a start mid-edit gets the complete previous version, never a partial
// draft. verifyIntegrity re-hashes a bound version at grade/review time; a missing
// or corrupt bound version is a typed integrity failure, never a live fallback.
const crypto = require("crypto");
const { computePointsPlan, EVALUATOR_VERSION } = require("./scoring");

class VersionIntegrityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "VersionIntegrityError";
    this.code = code || "version_integrity";
  }
}

// Deterministic JSON: recursively sort object keys so the hash is stable
// regardless of property insertion order.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}
function plain(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}
function num(v, d) {
  return v === undefined || v === null || Number.isNaN(Number(v)) ? d : Number(v);
}

// The canonical, JSON-safe content object that IS the version. Everything that can
// affect a grade or the frozen review is here; the hash covers all of it. Used at
// publish (to compute contentHash) and at verify (rebuilt from the stored row).
function canonicalContent({ questions, grading, reveal, display, pointsPlan, evaluatorVersion }) {
  const endMs = reveal && reveal.endDate != null ? new Date(reveal.endDate).getTime() : null;
  return {
    evaluatorVersion: evaluatorVersion || EVALUATOR_VERSION,
    questions: plain(questions) || [],
    pointsPlan: (Array.isArray(pointsPlan) ? pointsPlan : []).map((n) => num(n, 0)),
    grading: {
      preset: (grading && grading.preset) || "",
      typePoints: grading && grading.typePoints != null ? plain(grading.typePoints) : null,
      partialCredit: !!(grading && grading.partialCredit),
      negativeMarking: !!(grading && grading.negativeMarking),
      wrongPerPenalty: num(grading && grading.wrongPerPenalty, 3),
      correctPerPenalty: num(grading && grading.correctPerPenalty, 1),
      negMarkUntil: num(grading && grading.negMarkUntil, 0),
      totalMarks: num(grading && grading.totalMarks, 0),
      passingMarks: num(grading && grading.passingMarks, 0),
      shuffleOptions: !!(grading && grading.shuffleOptions),
      // NOTE: shuffleQuestions is deliberately NOT in the integrity hash — it only
      // affects DISPLAY order (answers are mapped back to canonical before scoring),
      // so it must not change a version's contentHash (that would break every
      // existing version). startAttempt reads it from the live exam instead.
      mode: (grading && grading.mode) || "pdf",
    },
    reveal: {
      showScore: !(reveal && reveal.showScore === false),
      showCorrectAnswers: !!(reveal && reveal.showCorrectAnswers),
      revealAfterEnd: !(reveal && reveal.revealAfterEnd === false),
      endMs,
    },
    display: {
      name: (display && display.name) || "",
      duration: num(display && display.duration, 0),
      questionsPerPage: num(display && display.questionsPerPage, 0),
      forwardOnly: !!(display && display.forwardOnly),
      antiCheat: !!(display && display.antiCheat),
      studentSolutionPhotos: !!(display && display.studentSolutionPhotos),
      listeningAudio: (display && display.listeningAudio) || "",
    },
  };
}

function hashCanonical(content) {
  return crypto.createHash("sha256").update(stableStringify(content)).digest("hex");
}

// Freeze the grading/review evidence from a live exam + its populated Question doc.
function buildSnapshot(exam, questionDoc) {
  const correctAnswers = (questionDoc && questionDoc.correctAnswers) || [];
  const grading = {
    preset: exam.preset || "",
    typePoints: exam.typePoints == null ? null : plain(exam.typePoints),
    partialCredit: !!exam.partialCredit,
    negativeMarking: !!exam.negativeMarking,
    wrongPerPenalty: num(exam.wrongPerPenalty, 3),
    correctPerPenalty: num(exam.correctPerPenalty, 1),
    negMarkUntil: exam.negMarkUntil || 0,
    totalMarks: exam.totalMarks || 0,
    passingMarks: exam.passingMarks || 0,
    shuffleOptions: !!exam.shuffleOptions,
    shuffleQuestions: !!exam.shuffleQuestions,
    mode: exam.mode || "pdf",
  };
  return {
    questions: plain(correctAnswers),
    pointsPlan: computePointsPlan(correctAnswers, { preset: grading.preset, typePoints: grading.typePoints }),
    evaluatorVersion: EVALUATOR_VERSION,
    grading,
    reveal: {
      showScore: exam.showScore !== false,
      showCorrectAnswers: !!exam.showCorrectAnswers,
      revealAfterEnd: exam.revealAfterEnd !== false,
      endDate: exam.endDate || null,
    },
    display: {
      name: exam.name || "",
      duration: exam.duration || 0,
      questionsPerPage: exam.questionsPerPage || 0,
      forwardOnly: !!exam.forwardOnly,
      antiCheat: !!exam.antiCheat,
      studentSolutionPhotos: !!exam.studentSolutionPhotos,
      listeningAudio: exam.listeningAudio || "",
    },
  };
}

// Public: the content hash of a freshly-built snapshot.
function hashSnapshot(snapshot) {
  return hashCanonical(canonicalContent(snapshot));
}

// CR-035: re-hash a STORED version row and confirm it matches its recorded
// contentHash. Returns { ok, expected, actual }.
function verifyIntegrity(version) {
  if (!version) return { ok: false, expected: null, actual: null };
  const actual = hashCanonical(canonicalContent(version));
  return { ok: actual === version.contentHash, expected: version.contentHash, actual };
}

// A publishable snapshot must have at least one question with content.
function isPublishable(snapshot) {
  return Array.isArray(snapshot.questions) && snapshot.questions.length > 0;
}

// CR-034 — publish the exam's CURRENT draft as an immutable version and make it
// the active pointer. Idempotent by content hash; a unique (examId, versionNumber)
// index + retry gives atomic number allocation under a race; the pointer swap only
// advances (an older concurrent publish never clobbers a newer active version).
async function publishExam(exam, questionDoc, ExamVersion, Exam) {
  const snapshot = buildSnapshot(exam, questionDoc);
  if (!isPublishable(snapshot)) return null; // nothing complete to publish yet
  const contentHash = hashSnapshot(snapshot);

  let version = await ExamVersion.findOne({ examId: exam._id, contentHash });
  if (!version) {
    for (let attempt = 0; attempt < 8 && !version; attempt++) {
      const last = await ExamVersion.findOne({ examId: exam._id }).sort({ versionNumber: -1 }).lean();
      const versionNumber = last ? last.versionNumber + 1 : 1;
      try {
        version = await ExamVersion.create({
          examId: exam._id,
          versionNumber,
          contentHash,
          author: exam.owner || null,
          publishedAt: new Date(),
          state: "published",
          questions: snapshot.questions,
          pointsPlan: snapshot.pointsPlan,
          evaluatorVersion: snapshot.evaluatorVersion,
          grading: snapshot.grading,
          reveal: snapshot.reveal,
          display: snapshot.display,
        });
      } catch (err) {
        if (err && err.code === 11000) {
          // Either the same content was published concurrently (reuse it) or the
          // versionNumber raced (retry with a higher number).
          const byHash = await ExamVersion.findOne({ examId: exam._id, contentHash });
          if (byHash) { version = byHash; break; }
          continue;
        }
        throw err;
      }
    }
    if (!version) throw new VersionIntegrityError("could not allocate a version number", "version_alloc_failed");
  }

  // CR-034: advance the pointer with ONE absent-safe conditional (advance-only)
  // update. The filter proves the STORED number is strictly lower, so a slower
  // concurrent publisher gets modifiedCount:0 and never moves the pointer back to
  // an older version. We NEVER decide from the caller's (possibly stale)
  // exam.activeVersionId/Number.
  const res = await Exam.updateOne(
    {
      _id: exam._id,
      $or: [
        { activeVersionNumber: { $lt: version.versionNumber } },
        { activeVersionNumber: { $exists: false } },
        { activeVersionNumber: null },
      ],
    },
    { $set: { activeVersionId: version._id, activeVersionNumber: version.versionNumber } }
  );
  if (res.modifiedCount === 1) {
    exam.activeVersionId = version._id;
    exam.activeVersionNumber = version.versionNumber;
  }
  return version;
}

// The version a starting attempt must bind to. Reads the ACTIVE pointer only. If
// the exam was never published (legacy / created outside the builder), publish
// once from the current consistent read so the attempt still binds a complete
// snapshot — but an already-published exam is NEVER re-snapshotted here (that is
// what prevents a start mid-edit from publishing a partial draft).
async function resolveActiveVersionForStart(exam, questionDoc, ExamVersion, Exam) {
  if (exam.activeVersionId) {
    const v = await ExamVersion.findById(exam.activeVersionId);
    if (v) return v;
    // CR-034: a NON-NULL active pointer with no row is a typed integrity failure —
    // NEVER republish whatever live draft happens to exist (that could publish a
    // half-saved paper under the guise of the "active" version).
    throw new VersionIntegrityError(
      `active version ${exam.activeVersionId} is missing for exam ${exam._id}`,
      "active_version_missing"
    );
  }
  // Never published (legacy / first attempt): publish once from a consistent read.
  return publishExam(exam, questionDoc, ExamVersion, Exam);
}

module.exports = {
  buildSnapshot,
  hashSnapshot,
  verifyIntegrity,
  publishExam,
  resolveActiveVersionForStart,
  canonicalContent,
  stableStringify,
  VersionIntegrityError,
};
