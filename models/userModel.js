const mongoose = require('mongoose')
const Schema = mongoose.Schema
const bcrypt = require('bcryptjs')

const userSchema = Schema(
    {
        name: {
            type: String,
            required: [true, "Please add a name"]
        },
        email: {
            type: String,
            required: [true, "Please add an email"],
            unique: true,
            trim: true,
            match: [
                /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
                "Please enter a valid email",
            ],
        },
        password: {
            type: String,
            required: [true, "Please add a password"]
        },
        photo: {
            type: String,
            required: [true, "Please add a photo"],
            default: "https://i.stack.imgur.com/34AD2.jpg",
        },
        phone: {
            type: String,
            default: "+994",
        },
        bio: {
            type: String,
            default: "bio"
        },
        role: {
            type: String,
            default: "student",
            required: true
            //student, teacher, admin (suspended)
        },
        isVerified: {
            type: Boolean,
            default: true
        },
        userAgent: {
            type: Array,
            required: true,
            default: []
        },
        exams: [{
            type: Schema.Types.ObjectId,
            ref: "Exam"
        }],
        results: [{
            type: Schema.Types.ObjectId,
            ref: "Result"
        }]
    },
    {
        timestamps: true,
        minimize: false,
    }
);

// Encrypt password before saving to DB
userSchema.pre("save", async function (next) {
    if (!this.isModified("password")) {
        return next()
    }

    // Hash the password
    const salt = await bcrypt.genSalt(10)
    const hashedPassword = await bcrypt.hash(this.password, salt)

    this.password = hashedPassword;

    next();
})

const User = mongoose.model("User", userSchema)
module.exports = User