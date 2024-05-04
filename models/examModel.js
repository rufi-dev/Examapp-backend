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
    dedline: {
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
    questions: [{
        type: Schema.Types.ObjectId,
        ref: 'Question'
    }],
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
