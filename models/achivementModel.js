const mongoose = require('mongoose');
const { Schema } = mongoose;

const achivementSchema = Schema({
    title: {
        type: String,
        required: true
    },
    photo: {
        type: String,
        required: true
    },
    about: {
        type: String,
        required: true
    },
    size: {
        type: String
    }
},
    {
        timestamps: true,
        minimize: false,
    });

const AchivementModel = mongoose.model('Achivement', achivementSchema);

module.exports = AchivementModel;
