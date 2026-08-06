const express = require('express')
const { registerUser, loginUser, logoutUser, loginWithGoogle, loginWithCode, sendLoginCode, changePassword, resetPassword, sendVerificationEmail, forgotPasswordEmail, verifyUser, getUser, getUsers, updateUser, deleteUser, setUserPhone, impersonateUser, loginStatus, upgradeUser, getUserById, bulkUsers, teacherOverview, addAchivement, getAchivements, markOnboardingStep, onboardingReport, getMyStorage, setUserStorage, markAppInstalled, getPushPublicKey, subscribePush, unsubscribePush } = require('../controllers/userController')
const { protect, adminOnly, teacherOnly } = require('../middleware/authMiddleware')
const { refreshHandler, logoutAllHandler, requireSessionFlag } = require('../controllers/authSessionController')
const { csrfProtect } = require('../middleware/csrf')
// AUD-008: abuse limiters on the unauthenticated identity endpoints (NAT-safe
// per-IP windows + a tight per-EMAIL cap on the email-sending routes).
const { loginLimiter, registerLimiter, resetLimiter, emailSendLimiter, emailSendIpLimiter, accountGuard } = require('../middleware/authLimit')
const router = express.Router()

// Auth. accountGuard bounds a DISTRIBUTED (many-IP) attack on ONE identity;
// loginLimiter is the generous per-IP classroom-safe cap.
router.post('/register', registerLimiter, registerUser)
router.post('/login', loginLimiter, accountGuard, loginUser)
router.get('/logout', logoutUser)

// AUD-002 session model (additive). requireSessionFlag runs BEFORE any auth
// middleware, so while SESSION_MODEL_ENABLED is off these routes are invisible
// (404) — an unauthenticated flag-off request never reaches protect (CR-011).
// CSRF (Gate 2): cookie-authenticated /refresh enforces the Origin allow-list;
// /logoutAll uses a Bearer access token, so csrfProtect passes it through.
router.post('/refresh', requireSessionFlag, csrfProtect, refreshHandler)
router.post('/logoutAll', requireSessionFlag, csrfProtect, protect, logoutAllHandler)

// PWA install signal: the client posts this the first time a signed-in user
// opens the site as an installed app (standalone). Idempotent; any teacher/user.
router.post('/app-installed', protect, markAppInstalled)

// Web Push opt-in: the browser fetches the VAPID public key, then the signed-in
// user subscribes THIS device so they can receive notifications on their phone.
router.get('/push/public-key', protect, getPushPublicKey)
router.post('/push/subscribe', protect, subscribePush)
router.post('/push/unsubscribe', protect, unsubscribePush)

router.get('/getUser', protect, getUser)
router.get('/getUserById/:id', protect, teacherOnly, getUserById)
router.patch('/updateUser', protect, updateUser)
router.delete('/deleteUser/:id', protect, adminOnly, deleteUser)
// ADMIN "log in as" a user (impersonation). Issues the target's session; audited.
router.post('/impersonate/:id', protect, adminOnly, impersonateUser)
// ADMIN edits any user's phone number (phone only — never role/identity).
router.patch('/:id/phone', protect, adminOnly, setUserPhone)
router.get('/getUsers', protect, teacherOnly, getUsers)
// Admin directory extras: batch role/delete, and one call for everything about
// a single teacher (their classes, students and created exams).
router.patch('/bulk', protect, adminOnly, bulkUsers)
router.get('/teacher/:id/overview', protect, adminOnly, teacherOverview)
// Setup walkthrough: teachers record their own progress, admins read everyone's.
router.post('/onboarding', protect, markOnboardingStep)
router.get('/onboardingReport', protect, adminOnly, onboardingReport)
// Storage allowance: a teacher sees their own, an admin raises anyone's.
router.get('/storage', protect, teacherOnly, getMyStorage)
router.patch('/:id/storage', protect, adminOnly, setUserStorage)

router.get('/loginStatus', loginStatus)
router.post('/upgradeUser', protect, adminOnly, upgradeUser)
// CR-108: the client-controlled /sendAutomatedEmail endpoint was REMOVED. Password-
// and role-changed notifications are now emitted SERVER-SIDE from their domain
// controllers with a typed, server-owned template allowlist. No route replaces it.

// Verify Account
router.post('/sendVerificationEmail', protect, sendVerificationEmail)
router.patch('/verifyUser/:verificationToken', verifyUser)

// Reset Password — an email send (per-email + per-IP limited) and a token redeem.
router.post('/forgotPasswordEmail', emailSendIpLimiter, emailSendLimiter, forgotPasswordEmail)
router.patch('/resetPassword/:resetToken', resetLimiter, resetPassword)

// Change Password
router.patch('/changePassword', csrfProtect, protect, changePassword)

// Login Code Email — an email send (per-email + per-IP limited) and a code redeem.
router.post('/sendLoginCode/:email', emailSendIpLimiter, emailSendLimiter, sendLoginCode)
router.post('/loginWithCode/:email', loginLimiter, accountGuard, loginWithCode)

router.post('/google/callback/', loginWithGoogle)

module.exports = router