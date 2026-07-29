const express = require('express')
const { addAchivement, getAchivements, deleteAchivement } = require("../controllers/achivementController")
const { teacherOnly, protect } = require("../middleware/authMiddleware")
const router = express.Router()

// Achivement — the PUBLIC "Uğurlarımız" testimonial gallery (read via
// getAchivements; reads stay public). Each story now records its `owner`, so:
//  - Add: any APPROVED teacher (or admin) may submit their own success story;
//    it appears instantly (teacherOnly derives the capability on the server,
//    never from the request body).
//  - Delete: authenticated only; the controller then enforces owner-or-admin,
//    so a teacher can remove ONLY their own story while an admin removes any.
router.post('/addAchivement', protect, teacherOnly, addAchivement)
router.get('/getAchivements', getAchivements)
router.delete('/deleteAchivement/:achivementId', protect, deleteAchivement)

module.exports = router
