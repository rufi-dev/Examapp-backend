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
const telegramRoute = require('./routes/telegramRoute')
const whatsappRoute = require('./routes/whatsappRoute')
const { initWhatsApp } = require('./helper/whatsapp')
const Attempt = require('./models/attemptModel')
const { runDueExamReports } = require('./jobs/examReports')
const { finalizeExpiredAttempts } = require('./controllers/quizController')
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
// Allowed browser origins. The new domain (bunkermath.az + www) plus the old
// Vercel URL during the migration, plus anything in ALLOWED_ORIGINS (comma-
// separated env) so future domains can be added without a code change.
const ALLOWED_ORIGINS = new Set(
    [
        "https://bunkermath.az",
        "https://www.bunkermath.az",
        "https://sinaqriyaziyyat.vercel.app",
        ...(process.env.ALLOWED_ORIGINS || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    ]
)
app.use(
    cors({
        origin: function (origin, callback) {
            // Allow no-origin requests (curl/postman), the allow-listed sites,
            // and any localhost port in dev (Vite may fall back to 5174, 5175, ...)
            if (
                !origin ||
                ALLOWED_ORIGINS.has(origin) ||
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
app.use("/api/telegram", telegramRoute)
app.use("/api/whatsapp", whatsappRoute)
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

        // Unofficial WhatsApp Web client (whatsapp-web.js). No-op unless
        // WHATSAPP_WEB_ENABLED=true (set in the Docker image, where Chromium
        // exists). Boots the session so the owner can link via the QR page.
        try {
            initWhatsApp()
        } catch (e) {
            console.error("[WHATSAPP] init error:", e.message)
        }
        // End-of-exam Telegram reports: check shortly after boot, then every
        // 10 minutes. Errors are logged, never fatal.
        const reportTick = () =>
            runDueExamReports().catch((e) => console.error("[REPORT] tick failed:", e.message))
        setTimeout(reportTick, 30 * 1000)
        setInterval(reportTick, 10 * 60 * 1000)

        // Server-side safety net: auto-submit attempts whose timer ran out but
        // were never submitted (student abandoned/closed the exam). Runs every
        // minute so a finished result appears within ~1-2 min of the deadline.
        const finalizeTick = () =>
            finalizeExpiredAttempts().catch((e) => console.error("[FINALIZE] tick failed:", e.message))
        setTimeout(finalizeTick, 20 * 1000)
        setInterval(finalizeTick, 60 * 1000)
    })
    .catch((err) => {
        console.log(err)
    })