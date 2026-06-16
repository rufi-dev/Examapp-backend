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
    // When enabled, the exam runner activates anti-cheat measures.
    antiCheat: { type: Boolean, default: false },
    // Result visibility for students:
    showScore: { type: Boolean, default: true },
    showCorrectAnswers: { type: Boolean, default: false },
    // If true (default), the above only take effect after endDate (prevents
    // answer sharing during the exam window).
    revealAfterEnd: { type: Boolean, default: true },
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
