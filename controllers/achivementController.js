const asyncHandler = require("express-async-handler")
const Achivement = require("../models/achivementModel")

const addAchivement = asyncHandler(async (req, res) => {
    const { title, about, photo, size } = req.body

    if (!title || !about || !photo) {
        res.status(400)
        throw new Error("All fields are required")
    }
    const achivement = await Achivement.create({
        title, about, photo, size
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

const updateAchivement = asyncHandler(async (req, res) => {
    const { achivementId } = req.params
    const { title, about, photo, size } = req.body
    const achivement = await Achivement.findById(achivementId)
    if (!achivement) {
        res.status(404)
        throw new Error("No Achivement Found")
    }

    if (title !== undefined) achivement.title = title
    if (about !== undefined) achivement.about = about
    if (photo) achivement.photo = photo // only replace the image if a new one was uploaded
    if (size !== undefined) achivement.size = size

    await achivement.save()
    res.status(200).json({ message: "Achivement updated successfully" })
})

const deleteAchivement = asyncHandler(async (req, res) => {
    const { achivementId } = req.params
    const achivement = await Achivement.findById(achivementId)
    if(!achivement){
        res.status(404)
        throw new Error("No Achivement Found")
    }

    await achivement.deleteOne()
    res.status(200).json({ message: "Achivement deleted succesfully" })
})

module.exports = {
    addAchivement,
    getAchivements,
    updateAchivement,
    deleteAchivement
}