const express = require('express')
const { addAchivement, getAchivements, deleteAchivement } = require("../controllers/achivementController")
const { adminOnly, protect } = require("../middleware/authMiddleware")
const router = express.Router()

// Achivement — these are GLOBAL, unscoped platform records (public gallery via
// getAchivements; the model has no owner field). AUD-005: global content
// management is an ADMIN capability, not a per-teacher one — any teacher could
// otherwise create or delete ANY achievement. Mutations are admin-only; reads
// stay public.
router.post('/addAchivement', protect, adminOnly, addAchivement)
router.get('/getAchivements', getAchivements)
router.delete('/deleteAchivement/:achivementId', protect, adminOnly, deleteAchivement)

module.exports = router
