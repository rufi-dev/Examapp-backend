const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { payExam } = require('../controllers/stripeController');
const router = express.Router()

router.post('/create-checkout-session', protect, payExam);

module.exports = router