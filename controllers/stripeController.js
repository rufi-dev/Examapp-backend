const asyncHandler = require("express-async-handler")
const Stripe = require('stripe')
const stripe = Stripe(process.env.STRIPE_KEY)
const jwt = require("jsonwebtoken")

const payExam = asyncHandler(async (req, res) => {
    const user = req.user
    const { exam } = req.body
    try {
        const token = jwt.sign({ userId: user._id, examId: exam._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
        const session = await stripe.checkout.sessions.create({
            line_items: [
                {
                    price_data: {
                        currency: "azn",
                        product_data: {
                            name: exam.name,
                            metadata: {
                                id: exam._id,
                                userId: user._id,
                            }
                        },
                        unit_amount: exam.price * 100
                    },
                    quantity: 1
                }
            ],
            mode: 'payment',
            success_url: `http://localhost:5173/myExams?token=${token}&examId=${exam._id}&success=true`,
            cancel_url: `http://localhost:5173/myExams?canceled=true`,
        })
        res.send({ url: session.url });
    } catch (error) {
        console.log(error)
    }
   
})

module.exports = {
    payExam
}