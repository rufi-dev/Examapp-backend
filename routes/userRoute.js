const express = require('express')
const { registerUser, loginUser, logoutUser, loginWithGoogle, loginWithCode, sendLoginCode, changePassword, resetPassword, sendVerificationEmail, forgotPasswordEmail, verifyUser, getUser, getUsers, updateUser, deleteUser, loginStatus, upgradeUser, sendAutomatedEmail, getUserById, addAchivement, getAchivements } = require('../controllers/userController')
const { protect, adminOnly, teacherOnly } = require('../middleware/authMiddleware')
const router = express.Router()

// Auth
router.post('/register', registerUser)
router.post('/login', loginUser)
router.get('/logout', logoutUser)

router.get('/getUser', protect, getUser)
router.get('/getUserById/:id', protect, teacherOnly, getUserById)
router.patch('/updateUser', protect, updateUser)
router.delete('/deleteUser/:id', protect, adminOnly, deleteUser)
router.get('/getUsers', protect, teacherOnly, getUsers)

router.get('/loginStatus', loginStatus)
router.post('/upgradeUser', protect, adminOnly, upgradeUser)

router.post('/sendAutomatedEmail', protect, sendAutomatedEmail)

// Verify Account
router.post('/sendVerificationEmail', protect, sendVerificationEmail)
router.patch('/verifyUser/:verificationToken', verifyUser)

// Reset Password
router.post('/forgotPasswordEmail', forgotPasswordEmail)
router.patch('/resetPassword/:resetToken', resetPassword)

// Change Password
router.patch('/changePassword', protect, changePassword)

// Login Code Email
router.post('/sendLoginCode/:email', sendLoginCode)
router.post('/loginWithCode/:email', loginWithCode)

router.post('/google/callback/', loginWithGoogle)

module.exports = router