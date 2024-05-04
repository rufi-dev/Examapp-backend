const mongoose = require('mongoose')
const Schema = mongoose.Schema

const tokenSchema = Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            required: true,
            ref: "User"
        },
        vToken: {
            type: String,
            default: ""
        },
        rToken: {
            type: String,
            default: "" 
        },
        lToken: {
            type: String,
            default: ""
        },
        createdAt: {
            type: Date,
            required: true
        },
        expiresAt: {
            type: Date,
            required: true
        },
    }
);

const Token = mongoose.model("Token", tokenSchema)
module.exports = Token