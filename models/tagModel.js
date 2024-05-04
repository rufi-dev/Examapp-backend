const mongoose = require('mongoose');
const { Schema } = mongoose;

const tagSchema = Schema({
    name: {
        type: String,
        required: true,
        unique: true
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