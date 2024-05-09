const asyncHandler = require("express-async-handler")
const User = require("../models/userModel")
const bcrypt = require("bcryptjs")
const { generateToken, hashToken } = require("../utils/index")
const parser = require("ua-parser-js")
const jwt = require("jsonwebtoken")
const { sendEmail } = require("../utils/sendEmail")
const crypto = require("crypto")
const Token = require("../models/tokenModel")
const Cryptr = require("cryptr")
const { OAuth2Client } = require("google-auth-library")

const cryptr = new Cryptr(process.env.CRYPTR_KEY)

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

// Register User
const registerUser = asyncHandler(async (req, res) => {
    const { name, email, password } = req.body

    // Validation
    if (!name || !email || !password) {
        res.status(400)
        throw new Error("Zəhmət olmasa bütün xanaları doldurun")
    }

    if (password.length < 6) {
        res.status(400)
        throw new Error("Şifrə ən azı 6 karakter uzunluğunda olmalıdır")
    }

    // Check if the user already exists
    const userExist = await User.findOne({ email })

    if (userExist) {
        res.status(400)
        throw new Error("Bu Email artıq mövcüddur!")
    }

    // Get user agent
    const ua = parser(req.headers["user-agent"])
    const userAgent = ua.ua

    // Create a new user
    const user = await User.create({
        name,
        email,
        password,
        userAgent
    })

    // Generate token
    const token = generateToken(user._id)

    // Send HTTP-only cookie
    res.cookie("token", token, {
        path: "/",
        httpOnly: true,
        //expires: new Date(Date.now() + 1000 * 86400), // 1 day
        sameSite: "none",
        secure: true
    })

    if (user) {
        const { _id, name, email, phone, bio, photo, role, isVerified, userAgent } = user
        res.status(201).json({
            _id, name, email, phone, bio,
            photo, role, isVerified, userAgent, token
        })
    } else {
        res.status(400)
        throw new Error("Invalid user data")
    }
})

// Login User
const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body

    //Validation
    if (!email || !password) {
        res.status(400)
        throw new Error('Email və Şifrə Əlavə edin')
    }

    const user = await User.findOne({ email })

    if (!user) {
        res.status(400)
        throw new Error('Belə bir istifadəcimiz mövcud deyil')
    }

    const isPasswordCorrect = await bcrypt.compare(password, user.password)
    if (!isPasswordCorrect) {
        res.status(400)
        throw new Error('Email və ya şifrə yanlışdır')
    }

    // Trigger 2FA for unknown user agent
    // const ua = parser(req.headers["user-agent"])
    // const thisUserAgent = ua.ua;

    // const allowedAgent = user.userAgent.includes(thisUserAgent)

    // if (!allowedAgent) {
    //     // Generate 6 digit code
    //     const loginCode = Math.floor(100000 + Math.random() * 900000)
    //     console.log(loginCode)
    //     //Encrypt login code
    //     const encryptedLoginCode = cryptr.encrypt(loginCode.toString())

    //     // Delete the token if exists
    //     let userToken = await Token.findOne({ userId: user._id })
    //     if (userToken) {
    //         await userToken.deleteOne()
    //     }

    //     //Save token to DB
    //     await new Token({
    //         userId: user._id,
    //         lToken: encryptedLoginCode,
    //         createdAt: Date.now(),
    //         expiresAt: Date.now() + 60 * (60 * 1000) // 1hour
    //     }).save()

    //     res.status(400)
    //     throw new Error("New browser or device detected")
    // }

    // Generate token
    const token = generateToken(user._id)
    console.log("loginuser: ", token)
    if (user && isPasswordCorrect) {
        // Send HTTP-only cookie
        res.cookie("token", token, {
            path: "/",
            httpOnly: true,
            //expires: new Date(Date.now() + 1000 * 86400), // 1 day
            sameSite: "none",
            secure: true
        })
        const { _id, name, email, phone, bio, photo, role, isVerified, userAgent } = user

        res.status(200).json({
            _id, name, email, phone, bio,
            photo, role, isVerified, userAgent, token
        })
    } else {
        res.status(500)
        throw new Error('Something went wrong, please try again')
    }
})

// Send Login Code to Email
const sendLoginCode = asyncHandler(async (req, res) => {
    const { email } = req.params

    const user = await User.findOne({ email })

    if (!user) {
        res.status(404)
        throw new Error('User not found')
    }

    // Find login code in DB
    let userToken = await Token.findOne({
        userId: user._id,
        expiresAt: { $gt: Date.now() }
    })

    if (!userToken) {
        res.status(404)
        throw new Error('Invalid or Expired token, please login again')
    }

    const loginCode = userToken.lToken
    const decryptedLoginCode = cryptr.decrypt(loginCode)

    //Send Login Code Email
    const subject = "Login Access Code - MATH"
    const send_to = email
    const sent_from = process.env.EMAIL_USER
    const reply_to = "noreply@rufi.com"
    const template = "loginCode"
    const name = user.name
    const link = decryptedLoginCode

    try {
        await sendEmail(subject, send_to, sent_from, reply_to, template, name, link)
        res.status(200).json({ message: `Access code sent to ${email}` })
    } catch (error) {
        res.status(500)
        throw new Error('Reset Password Email not sent, please try again')
    }
})

// Login With Code
const loginWithCode = asyncHandler(async (req, res) => {
    const { email } = req.params
    const { loginCode } = req.body

    if (!loginCode) {
        res.status(400)
        throw new Error('Please enter login code')
    }

    const user = await User.findOne({ email })

    if (!user) {
        res.status(404)
        throw new Error('User not found')
    }

    // Find user login token
    let userToken = await Token.findOne({
        userId: user._id,
        expiresAt: { $gt: Date.now() }
    })

    if (!userToken) {
        res.status(404)
        throw new Error('Invalid or Expired token, please login again')
    }


    const decryptedLoginCode = cryptr.decrypt(userToken.lToken)

    if (loginCode != decryptedLoginCode) {
        res.status(400)
        throw new Error('Incorrect login code, please try again')
    } else {
        // Register user agent
        const ua = parser(req.headers["user-agent"])
        const thisUserAgent = ua.ua;

        if (user.userAgent.includes(thisUserAgent)) {
            res.status(400)
            throw new Error('This browser or device has already registered')
        }

        user.userAgent.push(thisUserAgent)
        await user.save()

        // Generate token
        const token = generateToken(user._id)

        // Send HTTP-only cookie
        res.cookie("token", token, {
            path: "/",
            httpOnly: true,
            expires: new Date(Date.now() + 1000 * 86400), // 1 day
            sameSite: "none",
            secure: true
        })

        const { _id, name, email, phone, bio, photo, role, isVerified, userAgent } = user
        res.status(200).json({
            _id, name, email, phone, bio,
            photo, role, isVerified, userAgent, token
        })
    }
})

// Send Verification Email
const sendVerificationEmail = asyncHandler(async (req, res) => {
    // const user = await User.findById(req.user.id)

    // if (!user) {
    //     res.status(404)
    //     throw new Error('User not found')
    // }

    // if (user.isVerified) {
    //     res.status(400)
    //     throw new Error('User already verified')
    // }

    // let token = await Token.findOne({ userId: user._id })

    // if (token) {
    //     await token.deleteOne()
    // }

    // // Create Verification Token and Save
    // const verificationToken = crypto.randomBytes(32).toString("hex") + user._id

    // //Hash token and save
    // const hashedToken = hashToken(verificationToken)
    // await new Token({
    //     userId: user._id,
    //     vToken: hashedToken,
    //     createdAt: Date.now(),
    //     expiresAt: Date.now() + 60 * (60 * 1000) // 1hour
    // }).save()

    // //Construct Verification URL
    // const verificationUrl = `${process.env.FRONTEND_URL}/verify/${verificationToken}`

    // //Send Verification Email
    // const subject = "Verify Your Account - MATH"
    // const send_to = user.email
    // const sent_from = process.env.EMAIL_USER
    // const reply_to = "noreply@rufi.com"
    // const template = "verifyEmail"
    // const name = user.name
    // const link = verificationUrl

    // try {
    //     await sendEmail(subject, send_to, sent_from, reply_to, template, name, link)
    //     res.status(200).json({ message: "Verification Email Sent" })
    // } catch (error) {
    //     res.status(500)
    //     throw new Error('Verification Email not sent, please try again')
    // }
})

// Verify User
const verifyUser = asyncHandler(async (req, res) => {
    // const { verificationToken } = req.params

    // const hashedToken = hashToken(verificationToken)
    // console.log(hashedToken)

    // const userToken = await Token.findOne({
    //     vToken: hashedToken,
    //     expiresAt: { $gt: Date.now() }
    // })


    // if (!userToken) {
    //     res.status(404)
    //     throw new Error('Invalid or Expired Token!')
    // }

    // Find user
    // const user = await User.findOne({ _id: userToken.userId })

    // if (user.isVerified) {
    //     res.status(400)
    //     throw new Error('User is already verified')
    // }

    // Now verify the user
    // user.isVerified = true
    // await user.save()

    // res.status(200).json({
    //     message: "Account verification successful"
    // })
})

// Logout User
const logoutUser = asyncHandler(async (req, res) => {
    res.cookie("token", "", {
        path: "/",
        httpOnly: true,
        expires: new Date(0), // expire immediately
        sameSite: "none",
        secure: true
    })

    return res.status(200).json({
        message: "Çıxış uğurludur"
    })
})

// Get User
const getUser = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id)

    if (user) {
        const { _id, name, email, phone, bio, photo, role, exams, isVerified, userAgent } = user

        res.status(200).json({
            _id, name, email, phone, bio,
            photo, role, exams, isVerified, userAgent
        })
    } else {
        res.status(404)
        throw new Error('User not found!')
    }
})

// Get User By Id
const getUserById = asyncHandler(async (req, res) => {
    const { id } = req.params

    const user = await User.findById(id).populate("exams").populate({
        path: 'results',
        populate: {
            path: 'examId',
        }
    })
        .exec();

    if (!user) {
        res.status(404)
        throw new Error('User not found!')
    }

    res.status(200).json(user)
})

// Update User
const updateUser = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id)

    if (user) {
        const { name, email, phone, bio, photo } = user;

        user.email = email
        user.name = req.body.name || name
        user.phone = req.body.phone || phone
        user.name = req.body.name || name
        user.bio = req.body.bio || bio
        user.photo = req.body.photo || photo

        const updatedUser = await user.save()

        res.status(200).json({
            _id: updatedUser._id, name: updatedUser.name,
            email: updatedUser.email, phone: updatedUser.phone,
            bio: updatedUser.bio, photo: updatedUser.photo,
            role: updatedUser.role, isVerified: updatedUser.isVerified
        })
    } else {
        res.status(404)
        throw new Error('User not found!')
    }
})

// Delete User
const deleteUser = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id)

    if (!user) {
        res.status(404)
        throw new Error('User not found!')
    }

    await user.deleteOne()

    res.status(200).json({
        message: 'User removed successfully'
    })

})

// Get Users
const getUsers = asyncHandler(async (req, res) => {
    const users = await User.find().sort("-createdAt").select("-password")

    if (!users) {
        res.status(500)
        throw new Error('Something went wrong')
    }

    res.status(200).json(users)
})

// Login Status
const loginStatus = asyncHandler(async (req, res) => {
    const token = req.cookies.token
    if (!token) {
        return res.json(false)
    }
    //Verify Token
    const verified = jwt.verify(token, process.env.JWT_SECRET)

    if (verified) {
        return res.json(true)
    }
    console.log("loginstatus:", token)
    return res.json(false)
})

// Update User Role
const upgradeUser = asyncHandler(async (req, res) => {
    const { role, id } = req.body

    const user = await User.findById(id)

    if (!user) {
        res.status(404)
        throw new Error('User not found')
    }

    user.role = role
    await user.save()

    res.status(200).json({
        message: `User role updated to ${role} successfully`,
    })
})

// Send Auto Email
const sendAutomatedEmail = asyncHandler(async (req, res) => {
    const { subject, send_to, reply_to, template, url } = req.body

    if (!subject || !send_to || !reply_to || !template) {
        res.status(500)
        throw new Error('Missing email parameter')
    }

    //Get User
    const user = await User.findOne({ email: send_to })

    if (!user) {
        res.status(404)
        throw new Error('User not found')
    }

    const sent_from = process.env.EMAIL_USER
    const name = user.name
    const link = `${process.env.FRONTEND_URL}${url}`

    try {
        await sendEmail(subject, send_to, sent_from, reply_to, template, name, link)
        res.status(200).json({ message: "Email sent successfully" })
    } catch (error) {
        res.status(500)
        throw new Error('Email not sent, please try again')
    }
})

// Send Reset Password Email
const forgotPasswordEmail = asyncHandler(async (req, res) => {
    const { email } = req.body

    const user = await User.findOne({ email })

    if (!user) {
        res.status(404)
        throw new Error('No user with this email')
    }

    // Delete the token if exists
    let token = await Token.findOne({ userId: user._id })
    if (token) {
        await token.deleteOne()
    }

    // Create Verification Token and Save
    const resetToken = crypto.randomBytes(32).toString("hex") + user._id

    //Hash token and save
    const hashedToken = hashToken(resetToken)
    await new Token({
        userId: user._id,
        rToken: hashedToken,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60 * (60 * 1000) // 1hour
    }).save()

    //Construct Reset Password URL
    const resetUrl = `${process.env.FRONTEND_URL}/resetPassword/${resetToken}`

    //Send Reset Password Email
    const subject = "Reset Your Password - MATH"
    const send_to = user.email
    const sent_from = process.env.EMAIL_USER
    const reply_to = "noreply@rufi.com"
    const template = "forgotPassword"
    const name = user.name
    const link = resetUrl

    try {
        await sendEmail(subject, send_to, sent_from, reply_to, template, name, link)
        res.status(200).json({ message: "Reset Password Email Sent" })
    } catch (error) {
        res.status(500)
        throw new Error('Reset Password Email not sent, please try again')
    }
})

// Reset Password Action
const resetPassword = asyncHandler(async (req, res) => {
    const { resetToken } = req.params
    const { password } = req.body

    // Validation
    if (password.length < 6) {
        res.status(400)
        throw new Error("Password must be at least 6 characters")
    }

    const hashedToken = hashToken(resetToken)

    const userToken = await Token.findOne({
        rToken: hashedToken,
        expiresAt: { $gt: Date.now() }
    })
    if (!userToken) {
        res.status(404)
        throw new Error('Invalid or Expired Token!')
    }

    // Find user
    const user = await User.findOne({ _id: userToken.userId })


    // Now reset user password
    user.password = password
    await user.save()

    res.status(200).json({
        message: "Password reset successful, Please login"
    })
})

// Change password
const changePassword = asyncHandler(async (req, res) => {
    const { oldPassword, password } = req.body
    const user = await User.findById(req.user._id)

    if (password.length < 6) {
        res.status(400)
        throw new Error("Password must be at least 6 characters")
    }

    if (!user) {
        res.status(404)
        throw new Error('User not found')
    }

    if (!oldPassword || !password) {
        res.status(400)
        throw new Error('Please enter old and new password')
    }

    //Check if old password is correct
    const isPasswordCorrect = await bcrypt.compare(oldPassword, user.password)

    //Save new password
    if (user && isPasswordCorrect) {
        user.password = password
        await user.save()
        res.status(200).json({ message: 'Password reset successfully, Please re-login' })
    } else {
        res.status(400)
        throw new Error('Old password is incorrect')
    }
})

// Login With Google
const loginWithGoogle = asyncHandler(async (req, res) => {
    const { userToken } = req.body

    const ticket = await client.verifyIdToken({
        idToken: userToken,
        audience: process.env.GOOGLE_CLIENT_ID
    })

    const payload = ticket.getPayload()
    const { name, email, picture, sub } = payload
    const password = Date.now() + sub

    // Get user agent
    const ua = parser(req.headers["user-agent"])
    const userAgent = ua.ua

    // Check if the user exist
    const user = await User.findOne({ email })

    if (!user) {
        // Create a new user
        const newUser = await User.create({
            name,
            email,
            password,
            photo: picture,
            userAgent,
            isVerified: true
        })

        if (newUser) {
            // Generate token
            const token = generateToken(newUser._id)

            // Send HTTP-only cookie
            res.cookie("token", token, {
                path: "/",
                httpOnly: true,
                expires: new Date(Date.now() + 1000 * 86400), // 1 day
                sameSite: "none",
                secure: true
            })

            const { _id, name, email, phone, bio, photo, role, isVerified, userAgent } = newUser
            res.status(201).json({
                _id, name, email, phone, bio,
                photo, role, isVerified, userAgent, token
            })
        }
    }

    // User exists Login
    if (user) {
        // Generate token
        const token = generateToken(user._id)

        // Send HTTP-only cookie
        res.cookie("token", token, {
            path: "/",
            httpOnly: true,
            expires: new Date(Date.now() + 1000 * 86400), // 1 day
            sameSite: "none",
            secure: true
        })

        const { _id, name, email, phone, bio, photo, role, isVerified, userAgent } = user
        res.status(200).json({
            _id, name, email, phone, bio,
            photo, role, isVerified, userAgent, token
        })
    }
})


module.exports = {
    registerUser,
    loginUser,
    logoutUser,
    getUser,
    getUsers,
    updateUser,
    deleteUser,
    loginStatus,
    upgradeUser,
    sendAutomatedEmail,
    sendVerificationEmail,
    verifyUser,
    forgotPasswordEmail,
    resetPassword,
    changePassword,
    sendLoginCode,
    loginWithCode,
    loginWithGoogle,
    getUserById,
}

