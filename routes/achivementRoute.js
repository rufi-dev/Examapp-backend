const express = require('express')
const { addAchivement, getAchivements, updateAchivement, deleteAchivement } = require("../controllers/achivementController")
const { teacherOnly, protect } = require("../middleware/authMiddleware")
const router = express.Router()

// Achivement
router.post('/addAchivement', protect, teacherOnly, addAchivement)
router.get('/getAchivements', getAchivements)
router.put('/updateAchivement/:achivementId', protect, teacherOnly, updateAchivement)
router.delete('/deleteAchivement/:achivementId', protect, teacherOnly, deleteAchivement)

module.exports = router
