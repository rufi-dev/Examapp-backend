const mongoose = require('mongoose');
const { Schema } = mongoose;

const examSchema = Schema({
    name: {
        type: String,
        required: true,
    },
    duration: {
        type: Number,
        required: true
    },
    startDate: {
        type: Date
    },
    endDate: {
        type: Date
    },
    price: {
        type: Number,
        required: true,
        default: 0
    },
    totalMarks: {
        type: Number,
        required: true
    },
    passingMarks: {
        type: Number,
        required: true
    },
    videoLink: {
        type: String,
        required: false
    },
    // Optional cover/banner image (Cloudinary URL) shown at the top of the exam
    // card. Display-only, so it is safe to expose in student payloads.
    coverImage: {
        type: String,
        default: ""
    },
    // What the teacher asked the AI for when the questions were written. Kept so
    // a later rewrite of a single question knows what the paper is about without
    // the teacher retyping it. TEACHER-ONLY — it can name the answers, so the
    // student sanitisers strip it.
    aiPrompt: {
        type: String,
        default: ""
    },
    // Optional listening-section audio (Cloudinary URL, e.g. an mp3). Shown as a
    // player at the top of the exam (English buraxılış has a Dinləmə section).
    // Display content, so it is sent to students.
    listeningAudio: {
        type: String,
        default: ""
    },
    // Shared written solution images (added once per exam by the teacher,
    // shown to every student in their review alongside the video solution).
    solutionPhotos: [{
        type: String,
    }],
    maxTry: {
        type: Number,
        default: 0
    },
    // Optional access password. When non-empty, a student must enter it to
    // start the exam (enforced server-side in startAttempt). Never sent to
    // students in any payload.
    password: {
        type: String,
        default: ""
    },
    // Negative marking: when enabled, every `wrongPerPenalty` wrong answers
    // cancel `correctPerPenalty` correct answers' worth of points (server-side).
    negativeMarking: { type: Boolean, default: false },
    wrongPerPenalty: { type: Number, default: 3 },
    correctPerPenalty: { type: Number, default: 1 },
    // Negative marking only applies to questions 1..negMarkUntil (e.g. the closed
    // section of a Blok exam). 0 = applies to every question (legacy behavior).
    negMarkUntil: { type: Number, default: 0 },
    // Scoring/structure preset id (see helper/examPresets.js). Empty = custom:
    // legacy scoring (questionPoints, total 100). A preset drives the per-question
    // points at scoring time + seeds the builder's question types.
    preset: { type: String, default: "" },
    // Optional MANUAL per-type points override, e.g. { Cm: 1.56, Cmu: 4, Co: 5 }.
    // When a type is present here, every question of that type is worth that many
    // points (overriding the preset's auto value); types absent here keep the
    // preset. Edited in the builder's scoring panel; used by scoreAndCreateResult.
    typePoints: { type: Schema.Types.Mixed, default: undefined },
    // When enabled, the exam runner activates anti-cheat measures.
    antiCheat: { type: Boolean, default: false },
    // Multi-select (Cs) partial credit: award proportional points
    // (correct picks − wrong picks, floored at 0) instead of all-or-nothing.
    partialCredit: { type: Boolean, default: false },
    // Per-student randomization of structured choice order (Cm/Cs). The actual
    // permutation is stored on each Attempt so resume is stable and the server
    // can map the student's picks back to the original indices on submit.
    shuffleOptions: { type: Boolean, default: false },
    // When enabled, students may attach a photo of their worked solution to each
    // question during the exam (teachers review them per student afterwards).
    studentSolutionPhotos: { type: Boolean, default: false },
    // Set once the post-endDate Telegram results report (PDF + Excel) has been
    // sent, so the scheduler never sends it twice for the same exam.
    reportSentAt: { type: Date },
    // Bounded recipient/artifact idempotency ledger for the report worker.
    reportDeliveredKeys: { type: [String], default: undefined, select: false },
    // AUD-017 durable report claim/retry state. A worker owns a bounded lease;
    // failed work remains due indefinitely (no 12-hour loss window).
    reportLeaseOwner: { type: String, default: null, select: false },
    reportLeaseUntil: { type: Date, default: null, select: false },
    reportNextAttemptAt: { type: Date, default: null, select: false },
    reportAttempts: { type: Number, default: 0, select: false },
    reportDeadLetterAt: { type: Date, default: null, select: false },
    reportLastFailure: {
        type: String,
        enum: ["generation", "delivery", "commit", null],
        default: null,
        select: false,
    },
    // Set once the "new exam" WhatsApp notification has gone out to the class's
    // students, so publishing/editing never double-notifies them.
    studentsNotifiedAt: { type: Date },
    // Hidden = a draft only staff can see; students can't list or start it.
    hidden: { type: Boolean, default: false },
    // Soft-delete: when set, the exam is in the Trash (recoverable for 30 days,
    // then auto-purged). Excluded from every listing. null = active.
    deletedAt: { type: Date, default: null, index: true },
    // Who archived it (audit trail for accidental/disputed deletions).
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // A permanent purge removes live resources and private bytes but retains
    // this tombstone so historical Results/Attempts/ExamVersions never dangle.
    purgedAt: { type: Date, default: null, index: true },
    // Result visibility for students:
    showScore: { type: Boolean, default: true },
    showCorrectAnswers: { type: Boolean, default: false },
    // If true (default), the above only take effect after endDate (prevents
    // answer sharing during the exam window).
    revealAfterEnd: { type: Boolean, default: true },
    // "pdf" = questions live in an uploaded PDF (answer key only). "structured"
    // = native questions (text/options/images/latex) built in-app. Default pdf
    // keeps every existing exam unchanged.
    mode: { type: String, enum: ["pdf", "structured"], default: "pdf" },
    // The teacher/admin who created this exam (visibility/ownership scoping).
    owner: { type: Schema.Types.ObjectId, ref: "User", index: true },
    // AUD-009: retry identity for exam creation. The client keeps this key
    // stable until it receives a committed response; the partial unique index
    // makes a response-loss retry return the original exam.
    creationKey: { type: String, select: false },
    // Structured exam pagination: how many questions a student sees per page
    // (0 = show all on one page). Set from the structured builder.
    questionsPerPage: { type: Number, default: 0 },
    // When true the student can only move FORWARD — once they advance a page they
    // can't go back to earlier questions (linear exam).
    forwardOnly: { type: Boolean, default: false },
    questions: {
        type: Schema.Types.ObjectId,
        ref: 'Question'
    },
    // AUD-003 / CR-034: the exam's ACTIVE published version. Student starts bind to
    // THIS pointer only — never to the live draft. Builder edits stay in the
    // Question/Exam draft docs; publishing validates one complete snapshot and
    // atomically CAS-swaps this pointer, so a start mid-edit always gets the
    // complete previous version, never a partially saved paper. null = never
    // published (not startable until published / migrated).
    activeVersionId: {
        type: Schema.Types.ObjectId,
        ref: 'ExamVersion',
        default: null,
    },
    // CR-034: the active version's number, advanced together with activeVersionId
    // in ONE conditional (advance-only) update. The publish CAS filters on this
    // being strictly lower, so a slower concurrent publish can never move the
    // active pointer backwards to an older version.
    activeVersionNumber: {
        type: Number,
        default: 0,
    },
    pdf: {
        type: Schema.Types.ObjectId,
        ref: 'PDF',
    },
    // AUD-013 CR-087: a durable PDF-lifecycle PURGE FENCE. A permanent purge
    // atomically CAS-sets this when it claims the exam; while set, `replaceExamPdf`
    // refuses to commit a new PDF reference (its CAS requires `purging:{$ne:true}`),
    // so a purge and a concurrent replacement can never leave a freshly-attached
    // PDF orphaned. The purge reads `pdf` AFTER winning this claim, so it always
    // deletes the exact winner. Internal only (never returned to clients).
    purging: { type: Boolean, select: false },
    tag: {
        type: Schema.Types.ObjectId,
        ref: 'Tag'
    },
    // Every exam MUST belong to a class — there is no "unassigned" exam. Enforced
    // at creation (addExam) and on restore (a target class is required when the
    // original class was deleted); this schema rule is the final backstop.
    class: {
        type: Schema.Types.ObjectId,
        ref: 'Class',
        required: [true, 'İmtahan mütləq bir sinfə aid olmalıdır'],
    },
    users: [{
        type: Schema.Types.ObjectId,
        ref: "User"
    }],
},
    {
        timestamps: true,
        minimize: false,
    });

examSchema.index(
    { endDate: 1, reportNextAttemptAt: 1, reportLeaseUntil: 1 },
    {
        name: "due_exam_report",
        partialFilterExpression: { reportSentAt: null },
    }
);
examSchema.index(
    { owner: 1, creationKey: 1 },
    {
        name: "uniq_exam_creation",
        unique: true,
        partialFilterExpression: { creationKey: { $type: "string" } },
    }
);
examSchema.index(
    { createdAt: -1, _id: -1 },
    { name: "page_createdAt_desc" }
);

const ExamModel = mongoose.model('Exam', examSchema);

module.exports = ExamModel;
