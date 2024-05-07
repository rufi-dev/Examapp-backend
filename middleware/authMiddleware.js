const asyncHandler = require("express-async-handler")
const jwt = require("jsonwebtoken")
const User = require("../models/userModel")

const protect = asyncHandler(async (req, res, next) => {
    try {
        const token = req.cookies.token

        if (!token) {
            res.status(401)
            throw new Error('Not authorized, please login')
        }

        // Verify Token
        const verified = jwt.verify(token, process.env.JWT_SECRET)

        //Get UserId from Token
        const user = await User.findById(verified.id).select("-password")

        if (!user) {
            res.status(404)
            throw new Error('User not found')
        }

        if (user.role === 'suspended') {
            res.status(400)
            throw new Error('User suspended, please contact support')
        }

        req.user = user
        next()
    } catch (error) {
        res.status(401)
        throw new Error('Not authorized, please login')
    }
})


const adminOnly = asyncHandler(async (req, res, next) => {
    if (req.user && req.user.role === "admin") {
        next()
    } else {
        res.status(401)
        throw new Error('Not authorized as an admin')
    }
})

const teacherOnly = asyncHandler(async (req, res, next) => {
    if (req.user && (req.user.role === "teacher" || req.user.role === "admin")) {
        next()
    } else {
        res.status(401)
        throw new Error('Not authorized as teacher or admin')
    }
})

const verifiedOnly = asyncHandler(async (req, res, next) => {
    if (req.user && req.user.isVerified) {
        next()
    } else {
        res.status(401)
        throw new Error('Not authorized, account not verified!')
    }
})

module.exports = { protect, adminOnly, teacherOnly, verifiedOnly }