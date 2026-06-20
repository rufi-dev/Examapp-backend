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
        }],
        // Last time this user opened the notifications bell (drives unread count).
        notificationsSeenAt: {
            type: Date,
        },
        // Telegram notifications (teachers): when linked, the user gets a bot
        // message whenever a student starts one of their exams.
        // telegramChatId = the linked Telegram chat (set via the bot webhook).
        // telegramLinkCode = one-time deep-link token used to bind the account.
        telegramChatId: {
            type: String,
        },
        telegramLinkCode: {
            type: String,
        },
        telegramLinkedAt: {
            type: Date,
        },
        // Which Telegram notifications this teacher wants, and the scope.
        // Event flags default ON. Scope is OPT-OUT: everything notifies unless
        // its class or exam id is in an excluded list — so a newly created
        // class/exam is automatically included without any action.
        telegramPrefs: {
            onStart: { type: Boolean, default: true },     // student starts an exam
            onFinish: { type: Boolean, default: true },    // student finishes -> result
            onViolation: { type: Boolean, default: true }, // exam terminated for cheating
            onJoin: { type: Boolean, default: true },      // student joins/requests a class
            excludedClasses: [{ type: Schema.Types.ObjectId, ref: "Class" }],
            excludedExams: [{ type: Schema.Types.ObjectId, ref: "Exam" }],
        }
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