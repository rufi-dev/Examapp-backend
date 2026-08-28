const express = require('express')
const { addAchivement, getAchivements, deleteAchivement } = require("../controllers/achivementController")
const { teacherOnly, protect, attachUser } = require("../middleware/authMiddleware")
const router = express.Router()

// Achivement — student success stories. Each story records its `owner`, so:
//  - Add: any APPROVED teacher (or admin) may submit their own success story;
//    it appears instantly (teacherOnly derives the capability on the server,
//    never from the request body).
//  - Read: `attachUser` (never rejects) identifies the caller when signed in, and
//    the controller scopes the result — a teacher's story reaches only that
//    teacher's own students and their linked parents. An anonymous visitor sees
//    just the curated ownerless stories (the public "Uğurlarımız" gallery).
//  - Delete: authenticated only; the controller then enforces owner-or-admin,
//    so a teacher can remove ONLY their own story while an admin removes any.
router.post('/addAchivement', protect, teacherOnly, addAchivement)
router.get('/getAchivements', attachUser, getAchivements)
router.delete('/deleteAchivement/:achivementId', protect, deleteAchivement)

module.exports = router
