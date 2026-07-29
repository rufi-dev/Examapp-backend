const asyncHandler = require("express-async-handler")
const Achivement = require("../models/achivementModel")

const addAchivement = asyncHandler(async (req, res) => {
    const { title, about, photo, size } = req.body

    if (!title || !about || !photo) {
        res.status(400)
        throw new Error("All fields are required")
    }
    const achivement = await Achivement.create({
        title, about, photo, size,
        owner: req.user._id,
        ownerName: req.user.name,
    })

    if (!achivement) {
        res.status(500)
        throw new Error("Couldn't add achivement")
    }

    res.status(200).json({ message: "Achivement successfully added!" })
})

const getAchivements = asyncHandler(async (req, res) => {
    const achivements = await Achivement.find({})

    if (!achivements) {
        res.status(404)
        throw new Error("Couldn't fetch any achivement")
    }

    res.status(200).json(achivements)
})

const deleteAchivement = asyncHandler(async (req, res) => {
    const { achivementId } = req.params
    const achivement = await Achivement.findById(achivementId)
    if(!achivement){
        res.status(404)
        throw new Error("No Achivement Found")
    }

    // Admins can remove any story; a teacher may remove ONLY the one they
    // submitted. Legacy records with no owner are admin-only (unchanged).
    const isAdmin = req.user.role === "admin"
    const isOwner = achivement.owner && String(achivement.owner) === String(req.user._id)
    if (!isAdmin && !isOwner) {
        res.status(403)
        throw new Error("You can only remove your own success story")
    }

    await achivement.deleteOne()
    res.status(200).json({ message: "Achivement deleted succesfully" })
})

module.exports = {
    addAchivement,
    getAchivements,
    deleteAchivement
}