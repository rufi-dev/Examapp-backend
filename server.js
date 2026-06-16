require("dotenv").config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')
const userRoute = require('./routes/userRoute')
const quizRoute = require('./routes/quizRoute')
const achivementRoute = require('./routes/achivementRoute')
const stripeRoute = require('./routes/stripeRoute')
const notificationRoute = require('./routes/notificationRoute')
const Attempt = require('./models/attemptModel')
const errorHandler = require('./middleware/errorMiddleware')

// Collapse any pre-existing duplicate ACTIVE attempts (keep the newest, mark the
// rest submitted) so the unique partial index can build, then ensure indexes
// exist. Idempotent: a no-op once there are no duplicates.
async function prepareAttempts() {
    const dupes = await Attempt.aggregate([
        { $match: { submitted: false } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: { u: "$userId", e: "$examId" }, ids: { $push: "$_id" } } },
        { $match: { "ids.1": { $exists: true } } },
    ])
    for (const d of dupes) {
        const [, ...older] = d.ids // keep ids[0] (newest); retire the rest
        await Attempt.updateMany({ _id: { $in: older } }, { $set: { submitted: true } })
    }
    await Attempt.createIndexes()
}


const app = express()

// Behind Caddy/nginx in production: trust the reverse proxy so req.secure,
// req.protocol and req.ip reflect the original HTTPS request.
app.set("trust proxy", 1)

// Middlewares
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cookieParser())
app.use(bodyParser.json())
app.use(
    cors({
        origin: function (origin, callback) {
            // Allow no-origin requests (curl/postman), the production site,
            // and any localhost port in dev (Vite may fall back to 5174, 5175, ...)
            if (
                !origin ||
                origin === "https://sinaqriyaziyyat.vercel.app" ||
                /^http:\/\/localhost:\d+$/.test(origin)
            ) {
                callback(null, true)
            } else {
                callback(new Error("Not allowed by CORS: " + origin))
            }
        },
        credentials: true,
        // Let the PDF viewer read length/range headers (efficient streaming
        // of server-hosted PDFs).
        exposedHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
    })
)

// Routes
app.use("/api/users", userRoute)
app.use("/api/quiz", quizRoute)
app.use("/api/achivement", achivementRoute)
app.use("/api/stripe", stripeRoute)
app.use("/api/notifications", notificationRoute)
app.use('/uploads', express.static('uploads'));

app.get('/', (req, res) => {
    res.send('Home page')
})

// Error Handler
app.use(errorHandler)

// Connection
const PORT = process.env.PORT || 5000

mongoose
    .connect(process.env.MONGO_URI)
    .then(async () => {
        try {
            await prepareAttempts()
        } catch (e) {
            // Non-fatal so a transient DB hiccup doesn't block boot, but loud:
            // a missing uniqueness index silently disables the single-active-
            // attempt guarantee.
            console.error("[ATTEMPT INDEX] prep FAILED — single-active-attempt uniqueness NOT enforced:", e.message)
        }
        app.listen(PORT, () => {
            console.log("Connected to DB and listening on port:", PORT)
        })
    })
    .catch((err) => {
        console.log(err)
    })