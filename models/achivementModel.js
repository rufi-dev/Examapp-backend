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
    },
    // Who submitted this success story. Absent on the historical admin-created
    // global records; set to the teacher/admin who adds one going forward. Used
    // to (a) show the author as a testimonial byline and (b) let a teacher remove
    // ONLY their own story (admins remove any).
    owner: {
        type: Schema.Types.ObjectId,
        ref: "User"
    },
    // Denormalised author name so the public gallery renders the byline without
    // populating (and without leaking anything else about the user).
    ownerName: {
        type: String
    }
},
    {
        timestamps: true,
        minimize: false,
    });

const AchivementModel = mongoose.model('Achivement', achivementSchema);

module.exports = AchivementModel;
