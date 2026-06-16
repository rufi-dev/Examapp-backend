const asyncHandler = require("express-async-handler")
const Stripe = require('stripe')
const stripe = Stripe(process.env.STRIPE_KEY)
const jwt = require("jsonwebtoken")
const Exam = require("../models/examModel")

const payExam = asyncHandler(async (req, res) => {
    const user = req.user
    // Derive everything from the DB exam, NOT the client body, so price and the
    // unlocked examId can't be spoofed.
    const examId = (req.body && (req.body.examId || (req.body.exam && req.body.exam._id)))
    const exam = await Exam.findById(examId)
    if (!exam) {
        return res.status(404).json({ message: 'Exam not found' })
    }
    try {
        // The token binds the unlock to this user+exam; the Stripe SESSION
        // (verified server-side in addExamToUser via {CHECKOUT_SESSION_ID}) is the
        // actual proof of payment.
        const token = jwt.sign(
            { userId: user._id, examId: exam._id, typ: 'exam_purchase' },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        )
        const session = await stripe.checkout.sessions.create({
            line_items: [
                {
                    price_data: {
                        currency: "azn",
                        product_data: { name: exam.name },
                        unit_amount: Math.round((exam.price || 0) * 100)
                    },
                    quantity: 1
                }
            ],
            mode: 'payment',
            metadata: { userId: String(user._id), examId: String(exam._id) },
            success_url: `${process.env.FRONTEND_URL}/myExams?token=${token}&examId=${exam._id}&session_id={CHECKOUT_SESSION_ID}&success=true`,
            cancel_url: `${process.env.FRONTEND_URL}/myExams?canceled=true`,
        })
        res.send({ url: session.url });
    } catch (error) {
        console.log(error)
        res.status(500).json({ message: 'Payment session could not be created' })
    }

})

module.exports = {
    payExam
}