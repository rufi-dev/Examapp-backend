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
const materialRoute = require('./routes/materialRoute')
const healthRoute = require('./routes/healthRoute')
const { initPersistedSessions } = require('./helper/whatsapp')
const Attempt = require('./models/attemptModel')
const Result = require('./models/resultModel')
const Class = require('./models/classModel')
const { runDueExamReports } = require('./jobs/examReports')
const { finalizeExpiredAttempts, purgeExpiredArchived } = require('./controllers/quizController')
const { sampleHealth } = require('./controllers/healthController')
const { requestMetrics } = require('./middleware/requestMetrics')
const { beat } = require('./utils/heartbeat')
const errorHandler = require('./middleware/errorMiddleware')

// Startup VERIFY-ONLY. Data mutation (dedup, backfill, index build) lives in the
// one-time offline migration (scripts/backfillAttemptId.js) — startup must NEVER
// rewrite Attempts (a boot-time dedup could reintroduce "submitted without
// Result"). Here we only ASSERT that the migration ran: the critical indexes
// exist and MIGRATION_TS is a valid timestamp. In production a failed assertion is
// FATAL (a missing unique index silently permits duplicate Results / active
// attempts); in dev it builds the indexes for convenience and only warns.
async function verifyStartupInvariants() {
    const isProd = process.env.NODE_ENV === 'production'

    const rawTs = process.env.MIGRATION_TS
    if (!rawTs || Number.isNaN(new Date(rawTs).getTime())) {
        const msg = `MIGRATION_TS env is missing or not a valid timestamp: ${JSON.stringify(rawTs)}`
        if (isProd) throw new Error(msg)
        console.warn('[STARTUP]', msg, '— dev fallback (orphan create-repair disabled until set)')
    }

    // In dev, build indexes on boot so a fresh/in-memory DB just works. In prod,
    // the offline migration already built them; we only verify.
    if (!isProd) {
        await Attempt.createIndexes()
        await Result.createIndexes()
    }

    const assertIndexes = async (Model, wants) => {
        const idx = await Model.collection.indexes()
        for (const w of wants) {
            if (!idx.some(w.match)) {
                const msg = `${Model.modelName} index ${w.label} is missing (run the migration to build it)`
                if (isProd) throw new Error(msg)
                console.warn('[STARTUP]', msg)
            }
        }
    }
    const keyEq = (key) => (i) => JSON.stringify(i.key) === JSON.stringify(key)
    const pfeEq = (pfe) => (i) => JSON.stringify(i.partialFilterExpression || null) === JSON.stringify(pfe)
    // Assert the EXACT key AND exact partialFilterExpression (not just "has a
    // partial filter") — a prior bug shipped a same-key index under a different
    // name that silently disabled uniqueness, so shape must be verified exactly.
    await assertIndexes(Attempt, [{
        label: "'uniq_active_attempt' unique {userId,examId} partial {submitted:false}",
        match: (i) =>
            i.name === 'uniq_active_attempt' &&
            i.unique === true &&
            keyEq({ userId: 1, examId: 1 })(i) &&
            pfeEq({ submitted: false })(i),
    }])
    await assertIndexes(Result, [
        {
            label: "'uniq_result_attempt' unique {attemptId} partial {attemptId:{$exists,$type:objectId}}",
            match: (i) =>
                i.name === 'uniq_result_attempt' &&
                i.unique === true &&
                keyEq({ attemptId: 1 })(i) &&
                pfeEq({ attemptId: { $exists: true, $type: 'objectId' } })(i),
        },
        { label: '{userId,examId,createdAt}', match: keyEq({ userId: 1, examId: 1, createdAt: 1 }) },
        { label: '{examId}', match: keyEq({ examId: 1 }) },
    ])
}


const app = express()

// Behind Caddy/nginx in production: trust the reverse proxy so req.secure,
// req.protocol and req.ip reflect the original HTTPS request.
app.set("trust proxy", 1)

// Middlewares
// Request timing/error metrics for the admin Health page (in-memory, ~zero
// overhead). Registered first so every API request is measured.
app.use(requestMetrics)
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cookieParser())
app.use(bodyParser.json())
// Allowed browser origins. The production domain (examopia.com + www) plus
// anything in ALLOWED_ORIGINS (comma-separated env) so future domains can be
// added without a code change.
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
                // Tag as 403 so the error handler + health metrics classify a
                // disallowed-origin request as a client (4xx) error, not a 500.
                const e = new Error("Not allowed by CORS: " + origin)
                e.status = 403
                callback(e)
            }
        },
        credentials: true,
        // Let the PDF viewer read length/range headers (efficient streaming
        // of server-hosted PDFs).
        exposedHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
    })
)

// SEO — api.examopia.com is an API host, not a page to be indexed. A blanket
// noindex header on every response plus a disallow-all robots.txt keep API URLs
// (and /uploads) out of Google. The public site (examopia.com) is unaffected and
// indexes normally.
app.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow")
    next()
})
app.get("/robots.txt", (req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /\n")
})

// Routes
app.use("/api/users", userRoute)
app.use("/api/quiz", quizRoute)
app.use("/api/achivement", achivementRoute)
app.use("/api/stripe", stripeRoute)
app.use("/api/telegram", telegramRoute)
app.use("/api/whatsapp", whatsappRoute)
app.use("/api/videos", videoRoute)
app.use("/api/materials", materialRoute)
app.use("/api/health", healthRoute)
// NOTE: only uploads/ is public. Study materials live in materials/ and are
// deliberately NOT served statically — they're streamed by materialController
// after an access check, so students can read them but can't share a file URL.
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
            await verifyStartupInvariants()
        } catch (e) {
            // FATAL: a missing unique index or an unset MIGRATION_TS means the data
            // invariants aren't guaranteed. Do NOT serve traffic — abort so a
            // partial/unmigrated deploy can't silently permit duplicate Results.
            console.error("[STARTUP] invariant verification FAILED — refusing to boot:", e.message)
            process.exit(1)
        }
        // Public/open classes were removed — convert any legacy public class to
        // code-only so nothing stays openly accessible (idempotent).
        try {
            const r = await Class.updateMany({ requireCode: false }, { $set: { requireCode: true } })
            if (r.modifiedCount) console.log(`[MIGRATION] ${r.modifiedCount} public class(es) -> code-only`)
        } catch (e) {
            console.error("[MIGRATION] public->code-only failed:", e.message)
        }
        app.listen(PORT, () => {
            console.log("Connected to DB and listening on port:", PORT)
        })

        // Per-teacher WhatsApp Web sessions. No-op unless WHATSAPP_WEB_ENABLED=true
        // (set in the Docker image, where Chromium exists). Re-links teachers who
        // already linked a number so their alerts keep working after a restart;
        // unlinked teachers' sessions start lazily when they open the QR page.
        try {
            initPersistedSessions()
        } catch (e) {
            console.error("[WHATSAPP] init error:", e.message)
        }
        // End-of-exam Telegram reports: check shortly after boot, then every
        // 10 minutes. Errors are logged, never fatal. Each tick is wrapped in
        // beat() so the admin Health page can see last-run/failure per job.
        const reportTick = beat("telegram-reports", 10 * 60 * 1000, runDueExamReports)
        setTimeout(reportTick, 30 * 1000)
        setInterval(reportTick, 10 * 60 * 1000)

        // Server-side safety net: auto-submit attempts whose timer ran out but
        // were never submitted (student abandoned/closed the exam). Runs every
        // minute so a finished result appears within ~1-2 min of the deadline.
        const finalizeTick = beat("attempt-finalizer", 60 * 1000, finalizeExpiredAttempts)
        setTimeout(finalizeTick, 20 * 1000)
        setInterval(finalizeTick, 60 * 1000)

        // Trash sweep: purge exams archived longer than the retention window.
        const trashTick = beat("trash-purge", 6 * 60 * 60 * 1000, purgeExpiredArchived)
        setTimeout(trashTick, 60 * 1000)
        setInterval(trashTick, 6 * 60 * 60 * 1000)

        // Health sampler: every 5 min record site/db/resource state to Mongo
        // (31-day TTL) — powers the Health page's uptime history.
        const healthTick = beat("health-sampler", 5 * 60 * 1000, sampleHealth)
        setTimeout(healthTick, 90 * 1000)
        setInterval(healthTick, 5 * 60 * 1000)
    })
    .catch((err) => {
        console.log(err)
    })