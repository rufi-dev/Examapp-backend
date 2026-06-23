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
    // Set once the "new exam" WhatsApp notification has gone out to the class's
    // students, so publishing/editing never double-notifies them.
    studentsNotifiedAt: { type: Date },
    // Hidden = a draft only staff can see; students can't list or start it.
    hidden: { type: Boolean, default: false },
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
    pdf: {
        type: Schema.Types.ObjectId,
        ref: 'PDF',
    },
    tag: {
        type: Schema.Types.ObjectId,
        ref: 'Tag'
    },
    class: {
        type: Schema.Types.ObjectId,
        ref: 'Class'
    },
    users: [{
        type: Schema.Types.ObjectId,
        ref: "User"
    }],
    results: [{
        type: Schema.Types.ObjectId,
        ref: "Result"
    }]
},
    {
        timestamps: true,
        minimize: false,
    });

const ExamModel = mongoose.model('Exam', examSchema);

module.exports = ExamModel;
