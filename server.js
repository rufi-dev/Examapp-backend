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
const videoRoute = require('./routes/videoRoute')
const healthRoute = require('./routes/healthRoute')
const whatsapp = require('./helper/whatsapp')
const Attempt = require('./models/attemptModel')
const { runDueExamReports } = require('./jobs/examReports')
const { finalizeExpiredAttempts, purgeExpiredArchived } = require('./controllers/quizController')
const { sampleHealth } = require('./controllers/healthController')
const { requestMetrics } = require('./middleware/requestMetrics')
const { beat } = require('./utils/heartbeat')
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
// Request timing/error metrics for the admin Health page.
app.use(requestMetrics)
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cookieParser())
app.use(bodyParser.json())
// Allowed browser origins. The Examopia domains plus anything in
// ALLOWED_ORIGINS (comma-separated env) so future domains can be added without
// a code change.
const ALLOWED_ORIGINS = new Set(
    [
        "https://examopia.com",
        "https://www.examopia.com",
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
app.use("/api/videos", videoRoute)
app.use("/api/health", healthRoute)
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
            const initWhatsApp = whatsapp.initPersistedSessions || whatsapp.initWhatsApp
            if (typeof initWhatsApp === "function") initWhatsApp()
            else console.warn("[WHATSAPP] no init function exported")
        } catch (e) {
            console.error("[WHATSAPP] init error:", e.message)
        }
        // End-of-exam Telegram reports: check shortly after boot, then every
        // 10 minutes. Errors are logged, never fatal.
        const reportTick = beat("telegram-reports", 10 * 60 * 1000, runDueExamReports)
        setTimeout(reportTick, 30 * 1000)
        setInterval(reportTick, 10 * 60 * 1000)

        // Server-side safety net: auto-submit attempts whose timer ran out but
        // were never submitted (student abandoned/closed the exam). Runs every
        // minute so a finished result appears within ~1-2 min of the deadline.
        const finalizeTick = beat("attempt-finalizer", 60 * 1000, finalizeExpiredAttempts)
        setTimeout(finalizeTick, 20 * 1000)
        setInterval(finalizeTick, 60 * 1000)

        // Trash sweep: permanently purge exams archived past the retention window.
        // Runs shortly after boot, then every 6 hours.
        const trashTick = beat("trash-purge", 6 * 60 * 60 * 1000, purgeExpiredArchived)
        setTimeout(trashTick, 60 * 1000)
        setInterval(trashTick, 6 * 60 * 60 * 1000)

        // Health sampler: every 5 min record site/db/resource state to Mongo
        // (31-day TTL) for the admin Health page uptime history.
        const healthTick = beat("health-sampler", 5 * 60 * 1000, sampleHealth)
        setTimeout(healthTick, 90 * 1000)
        setInterval(healthTick, 5 * 60 * 1000)
    })
    .catch((err) => {
        console.log(err)
    })
