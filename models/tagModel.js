const mongoose = require('mongoose');
const { Schema } = mongoose;

const tagSchema = Schema({
    name: {
        type: String,
        required: true,
        // NOT unique: categories are now owned per-teacher, so two teachers can
        // both have a "Riyaziyyat". (Uniqueness, if wanted, is per-owner.)
    },
    // The teacher/admin who created this category. Visibility is scoped to it:
    // teachers see only their own, students see it only when enrolled in one of
    // its classes, admins see all.
    owner: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        index: true,
    },

    //I gotta delete it I dont know but mostly yes
    exams: [{
        type: Schema.Types.ObjectId,
        ref: 'Exam'
    }],

    classes: [{
        type: Schema.Types.ObjectId,
        ref: 'Class'
    }]
},
    {
        timestamps: true,
        minimize: false,
    });

const TagModel = mongoose.model('Tag', tagSchema);

module.exports = TagModel;