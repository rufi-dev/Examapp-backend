const asyncHandler = require("express-async-handler")
const Achivement = require("../models/achivementModel")
const User = require("../models/userModel")
const Class = require("../models/classModel")
const Enrollment = require("../models/enrollmentModel")
const ParentLink = require("../models/parentLinkModel")

// Which teachers' success stories THIS caller may see.
//
// A story a teacher uploads is about their own students, so it stays inside that
// teacher's circle: the teacher, their approved students, and those students'
// linked parents (admins see everything). Stories with no owner are the curated
// admin ones — those remain the public "Uğurlarımız" gallery, so an anonymous
// visitor gets exactly those and nothing else.
async function visibleOwnerIds(user) {
    if (!user) return []
    if (user.role === "admin") return "all"

    const owners = new Set([String(user._id)]) // a teacher always sees their own

    // The students whose classes decide what this caller may see: for a parent,
    // their linked children; for anyone else, themselves.
    let studentIds = [user._id]
    if (user.role === "parent") {
        const links = await ParentLink.find({ parent: user._id, status: "approved" }).select("student").lean()
        studentIds = links.map((l) => l.student)
    }
    if (!studentIds.length) return [...owners]

    // Approved enrolments → the classes they're in → those classes' owners.
    const enrolments = await Enrollment.find({ student: { $in: studentIds }, status: "approved" }).select("class").lean()
    if (enrolments.length) {
        const classes = await Class.find({ _id: { $in: enrolments.map((e) => e.class) }, deletedAt: null }).select("owner").lean()
        classes.forEach((c) => c.owner && owners.add(String(c.owner)))
    }
    return [...owners]
}

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
    const owners = await visibleOwnerIds(req.user)
    // The public gallery = stories with no owner (legacy) PLUS anything an admin
    // posted; those are curated marketing content. A TEACHER's story is about their
    // own students, so it only reaches their circle. `$in: [null]` also matches a
    // missing field.
    const adminIds = (await User.find({ role: "admin" }).select("_id").lean()).map((a) => a._id)
    const filter =
        owners === "all"
            ? {}
            : { $or: [{ owner: { $in: [null, ...adminIds] } }, ...(owners.length ? [{ owner: { $in: owners } }] : [])] }

    const achivements = await Achivement.find(filter).sort({ createdAt: -1 })
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