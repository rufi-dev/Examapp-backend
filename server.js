require("dotenv").config()
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')
const userRoute = require('./routes/userRoute')
const quizRoute = require('./routes/quizRoute')
const achivementRoute = require('./routes/achivementRoute')
const telegramRoute = require('./routes/telegramRoute')
const whatsappRoute = require('./routes/whatsappRoute')
const videoRoute = require('./routes/videoRoute')
const materialRoute = require('./routes/materialRoute')
const healthRoute = require('./routes/healthRoute')
const { initPersistedSessions, shutdownWhatsapp } = require('./helper/whatsapp')
const Attempt = require('./models/attemptModel')
const Result = require('./models/resultModel')
const Class = require('./models/classModel')
const { assertAttemptResultIndexes } = require('./helper/attemptResultIndexes')
const { sampleHealth } = require('./controllers/healthController')
const { requestMetrics } = require('./middleware/requestMetrics')
const { beat } = require('./utils/heartbeat')
const errorHandler = require('./middleware/errorMiddleware')
// AUD-019: fail-fast config validation + env-aware CORS + security headers.
const { assertEnv } = require('./config/validateEnv')
// AUD-008 (CR-051/CR-053): validate PASSWORD_MIN + AUTH_* numeric config.
const { assertConfig } = require('./config/validateConfig')
const { corsOrigin, assertOrigins } = require('./config/corsOptions')
const securityHeaders = require('./middleware/securityHeaders')
// Teacher Success Journey — config validation + flag + startup index assert.
const { assertTeacherSuccessConfig } = require('./config/teacherSuccess')
const { isJourneyEnabled } = require('./config/teacherSuccess/flag')
const { assertTeacherSuccessIndexes } = require('./helper/teacherSuccessIndexes')

// Refuse to boot with missing critical config instead of limping on a fallback
// (a preview build must never silently talk to / mutate production).
assertEnv()
// Refuse to boot on invalid security config (a NaN PASSWORD_MIN / AUTH_* must
// never silently disable the min-length check or a rate limiter).
assertConfig()
// CR-054: refuse to boot on a malformed ALLOWED_ORIGINS / FRONTEND_URL (a
// wildcard/path/localhost origin must never reach the CORS allow-list).
assertOrigins()
// Teacher Success Journey: refuse to boot on an invalid TSJ_* override (a bad AI
// allowance must never silently fall back). Harmless when the flag is off — it
// only validates config values and creates nothing.
assertTeacherSuccessConfig()

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

    // CR-117: the EXACT Attempt/Result shapes come from the SHARED contract
    // (helper/attemptResultIndexes) — the same one the offline migration builds and
    // verifySmokeDb checks — so production startup can never drift from the migration.
    // In prod a failure is FATAL; in dev we already built the indexes above and only warn.
    if (isProd) {
        await assertAttemptResultIndexes(mongoose.connection.db)
    } else {
        const { verifyAttemptResultIndexes } = require('./helper/attemptResultIndexes')
        const r = await verifyAttemptResultIndexes(mongoose.connection.db)
        if (!r.ok) console.warn('[STARTUP] Attempt/Result index contract:', r.failures.map((f) => `${f.collection}.${f.name}:${f.reason}`).join(', '))
    }

    // Teacher Success Journey — ONLY when the flag is enabled. Flag-off is a true
    // no-op here (no Journey collection/index is asserted or built), so import +
    // boot never create Journey schema (D16). Enabled + prod ⇒ the migration must
    // have run (FATAL if not). Enabled + dev ⇒ build the Journey indexes for
    // convenience and warn on drift.
    if (isJourneyEnabled()) {
        if (isProd) {
            await assertTeacherSuccessIndexes(mongoose.connection.db)
        } else {
            const TeacherReferral = require('./models/teacherReferralModel')
            const AiCreditPeriod = require('./models/aiCreditPeriodModel')
            const AiCreditLedger = require('./models/aiCreditLedgerModel')
            const TeacherActivityDaily = require('./models/teacherActivityDailyModel')
            const TeacherLevelHistory = require('./models/teacherLevelHistoryModel')
            const TeacherUpgradeRequest = require('./models/teacherUpgradeRequestModel')
            await Promise.all([
                TeacherReferral.createIndexes(), AiCreditPeriod.createIndexes(), AiCreditLedger.createIndexes(),
                TeacherActivityDaily.createIndexes(), TeacherLevelHistory.createIndexes(), TeacherUpgradeRequest.createIndexes(),
            ])
            const { verifyTeacherSuccessIndexes } = require('./helper/teacherSuccessIndexes')
            const rt = await verifyTeacherSuccessIndexes(mongoose.connection.db)
            // users.referralCode index is migration-owned; a dev warning is enough.
            if (!rt.ok) console.warn('[STARTUP] Teacher Success index contract:', rt.failures.map((f) => `${f.collection}.${f.name}:${f.reason}`).join(', '))
        }
    }
}


const app = express()

// Behind Caddy/nginx in production: trust the reverse proxy so req.secure,
// req.protocol and req.ip reflect the original HTTPS request.
app.set("trust proxy", 1)

// Middlewares
// Request timing/error metrics for the admin Health page (in-memory, ~zero
// overhead). Registered first so every API request is measured.
app.use(requestMetrics)
// AUD-019: defense-in-depth headers on every API/file response.
app.use(securityHeaders)
// AUD-019 CR-061: the public CSP report sink is mounted BEFORE the global JSON
// parser and uses its OWN raw pipeline with a hard 16KB cap (so the cap can't be
// bypassed by the 100KB global parser) + per-IP/global write bounds.
app.use("/api/csp-report", require("./routes/cspReportRoute"))
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cookieParser())
app.use(bodyParser.json())
// AUD-019: env-aware CORS origin policy (localhost allowed ONLY outside
// production; the allow-list is examopia.com + www + ALLOWED_ORIGINS). See
// config/corsOptions.js.
app.use(
    cors({
        origin: corsOrigin,
        credentials: true,
        // Let the PDF viewer read length/range headers (efficient streaming
        // of server-hosted PDFs).
        exposedHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
        // Cache the CORS preflight for a day. pdf.js opens a big PDF with dozens
        // of cross-origin range requests; without this EACH one pays for its own
        // OPTIONS preflight (~15s of round-trips for a 80MB file). With it, only
        // the first range request is preflighted and the rest go straight through.
        maxAge: 86400,
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

// CR-113: a minimal, NON-SECRET liveness probe for the container/CI smoke gate and
// load balancers. It reveals nothing (no config, no DB detail) — the rich diagnostic
// health report stays admin-only at /api/health.
app.get("/healthz", (req, res) => {
    res.status(200).json({ status: "ok" })
})

// Routes
app.use("/api/users", userRoute)
app.use("/api/quiz", quizRoute)
app.use("/api/achivement", achivementRoute)
// Public visitor analytics ingest (POST) + admin visitor list (GET).
app.use("/api/track", require("./routes/visitorRoute"))
// Payments (Stripe) removed — all exams are free. The paid-exam control remains
// in the builder as a disabled "coming soon" placeholder; price is enforced to 0
// server-side (addExam/editExam). The defensive Permissions-Policy: payment=()
// header (securityHeaders) is retained.
app.use("/api/telegram", telegramRoute)
app.use("/api/whatsapp", whatsappRoute)
app.use("/api/videos", videoRoute)
app.use("/api/materials", materialRoute)
// Teacher Success Journey — every route is flag-gated (404 when off), so mounting
// the router unconditionally is safe: a flag-off deployment exposes nothing.
app.use("/api/teacher-success", require("./routes/teacherSuccessRoute"))
app.use("/api/health", healthRoute)
// AUD-013 CR-057: NOTHING under uploads/ is public anymore. Exam PDFs moved to
// PRIVATE key storage (examPdfs/) served only by the authorized byte-stream
// GET /api/quiz/exam/:examId/pdf/stream, so a shared file URL can no longer
// bypass exam access/revocation. Study materials likewise stream from
// materialController after an access check. The old express.static('uploads')
// mount is intentionally REMOVED — deploy only AFTER the exam-pdf-private
// migration has relocated legacy uploads/*.pdf into private storage.

app.get('/', (req, res) => {
    res.send('Home page')
})

// Error Handler
app.use(errorHandler)

// Connection
const PORT = process.env.PORT || 5000

// ── CR-115: one idempotent application lifecycle ──────────────────────────────
// A single graceful-shutdown path used by BOTH signal handlers AND every startup
// failure. It stops accepting new work (closes the HTTP server), clears every
// server-level timer, stops the outbox worker EXACTLY once, disconnects Mongoose,
// and exits cleanly — under a bounded forced-exit deadline so a stuck close can
// never hang the container. `process.once` + a shared promise make it run once no
// matter how many signals arrive; a partial/failed startup takes the SAME path.
const _timers = new Set()
const track = (h) => { _timers.add(h); return h }
let _server = null
let _stopWorker = null
let _stopBackgroundJobs = null
let _shutdownPromise = null
const SHUTDOWN_DEADLINE_MS = Number(process.env.SHUTDOWN_DEADLINE_MS) > 0 ? Number(process.env.SHUTDOWN_DEADLINE_MS) : 10000

function lifecycleShutdown(reason, code = 0) {
    if (_shutdownPromise) return _shutdownPromise
    // Swallow any FURTHER signals while shutting down: no double-clean, and no
    // default-action termination that would kill us mid-cleanup.
    process.on("SIGTERM", () => {})
    process.on("SIGINT", () => {})
    _shutdownPromise = (async () => {
        console.log(`[LIFECYCLE] shutting down (${reason})`)
        const forced = setTimeout(() => {
            console.error("[LIFECYCLE] forced exit after shutdown deadline")
            process.exit(code || 1)
        }, SHUTDOWN_DEADLINE_MS)
        if (forced.unref) forced.unref()
        try {
            // 1. Stop accepting work: close the HTTP listener (drains in-flight).
            if (_server) {
                await new Promise((resolve) => _server.close(() => resolve()))
                console.log("[LIFECYCLE] HTTP server closed")
            }
            // 2. Clear every server-level timer/interval.
            for (const h of _timers) { try { clearTimeout(h); clearInterval(h) } catch (_) {} }
            _timers.clear()
            // 3. Stop the outbox worker EXACTLY once (only if it was started).
            if (_stopWorker) {
                const stop = _stopWorker
                _stopWorker = null
                try { stop() } catch (_) {} finally { console.log("[AUD-002] outbox worker stopped (shutdown)") }
            }
            if (_stopBackgroundJobs) {
                const stop = _stopBackgroundJobs
                _stopBackgroundJobs = null
                try { stop() } catch (_) {}
                console.log("[BACKGROUND] in-process jobs stopped")
            }
            // 3b. CR-117: gracefully stop the optional WhatsApp subsystem (prevent
            // reconnects, clear per-session timers, destroy clients without logout).
            // Bounded internally; a no-op when the flag is off (no sessions started).
            try { await shutdownWhatsapp({ timeoutMs: 8000 }) } catch (_) {}
            // 4. Disconnect Mongoose (only if connected).
            try { if (mongoose.connection && mongoose.connection.readyState !== 0) await mongoose.disconnect() } catch (_) {}
            clearTimeout(forced)
            console.log("[LIFECYCLE] shutdown complete")
            process.exit(code)
        } catch (e) {
            clearTimeout(forced)
            console.error("[LIFECYCLE] shutdown error:", e && e.message)
            process.exit(code || 1)
        }
    })()
    return _shutdownPromise
}
process.once("SIGTERM", () => lifecycleShutdown("SIGTERM", 0))
process.once("SIGINT", () => lifecycleShutdown("SIGINT", 0))

mongoose
    .connect(process.env.MONGO_URI)
    .then(async () => {
        try {
            await verifyStartupInvariants()
            // AUD-013 CR-067: prove the PRIVATE exam-PDF store is a writable,
            // persistent (absolute) directory BEFORE serving. In production a
            // relative dir would be the ephemeral container layer — refuse it.
            const { preflight } = require("./helper/examPdfStorage")
            await preflight()
            // CR-052: in production, the migration-owned token indexes MUST already
            // exist (startup never builds them). Fail with a migration instruction.
            if (process.env.NODE_ENV === "production") {
                const { assertTokenIndexes } = require("./helper/tokenIndexes")
                await assertTokenIndexes(mongoose.connection.db)
                // CR-058: the unique {email:1} index must exist (never built here).
                const { assertEmailUniqueIndex } = require("./helper/emailIndex")
                await assertEmailUniqueIndex(mongoose.connection.db)
                const { assertReliabilityIndexes } = require("./helper/reliabilityIndexes")
                await assertReliabilityIndexes(mongoose.connection.db)
            }
        } catch (e) {
            // FATAL: a missing unique index or an unset MIGRATION_TS means the data
            // invariants aren't guaranteed. Do NOT serve traffic — abort. CR-115: a
            // partial startup takes the SAME cleanup path (disconnect Mongoose, clear
            // any timers) instead of a raw process.exit that leaks the open connection.
            console.error("[STARTUP] invariant verification FAILED — refusing to boot:", e.message)
            return lifecycleShutdown("startup-invariant-failed", 1)
        }
        // Public/open classes were removed — convert any legacy public class to
        // code-only so nothing stays openly accessible (idempotent).
        try {
            const r = await Class.updateMany({ requireCode: false }, { $set: { requireCode: true } })
            if (r.modifiedCount) console.log(`[MIGRATION] ${r.modifiedCount} public class(es) -> code-only`)
        } catch (e) {
            console.error("[MIGRATION] public->code-only failed:", e.message)
        }
        // CR-115: retain the http.Server so graceful shutdown can close the listener,
        // and log the ACTUAL bound port (PORT=0 lets the OS assign one for tests).
        const useDisposableTls = process.env.EXQ_E2E_HTTPS === "1"
        if (useDisposableTls && process.env.EXQ_E2E_DISPOSABLE !== "1") {
            throw new Error("E2E HTTPS is allowed only inside the disposable launcher")
        }
        _server = useDisposableTls
            ? require("https").createServer({
                key: require("fs").readFileSync(process.env.E2E_TLS_KEY),
                cert: require("fs").readFileSync(process.env.E2E_TLS_CERT),
              }, app).listen(PORT)
            : app.listen(PORT)
        _server.once("listening", () => {
            const bound = (_server.address() && _server.address().port) || PORT
            console.log("Connected to DB and listening on port:", bound)
        })
        // A bind failure (e.g. EADDRINUSE) must be LOUD and take the shared cleanup
        // path — never an unhandled 'error' that kills the process with no diagnosis.
        _server.on("error", (err) => {
            console.error("[STARTUP] HTTP listen failed:", err && err.message ? err.message : err)
            lifecycleShutdown("listen-failed", 1)
        })

        // AUD-002 (Gate 2/CR-021): start the outbox worker ONLY when the session
        // model is enabled (decision extracted to a testable helper). Flag-off ⇒
        // no timer, no session/outbox writes. CR-115: the stop handle is retained on
        // the shared lifecycle and stopped EXACTLY once by lifecycleShutdown — the
        // signal handlers are registered ONCE at module scope, not per worker.
        try {
            const { flags } = require("./config/featureFlags")
            const { startWorker } = require("./jobs/outboxWorker")
            const { maybeStartWorker } = require("./jobs/workerLifecycle")
            _stopWorker = maybeStartWorker({ flags, startWorker, onLog: console.log })
        } catch (e) {
            console.error("[AUD-002] worker startup skipped:", e.message)
        }

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
        // AUD-017: mutating periodic work belongs to the dedicated worker
        // process. This explicit compatibility mode is off by default.
        if (process.env.RUN_BACKGROUND_JOBS === "true") {
            _stopBackgroundJobs = require("./jobs/backgroundJobs").startBackgroundJobs()
            console.log("[BACKGROUND] in-process compatibility mode enabled")
        }

        // Server-side safety net: auto-submit attempts whose timer ran out but
        // were never submitted (student abandoned/closed the exam). Runs every
        // minute so a finished result appears within ~1-2 min of the deadline.
        // Interval + first-run delay are overridable for deterministic E2E (CR-040)
        // via FINALIZE_INTERVAL_MS / FINALIZE_FIRST_MS; production defaults to 60s.

        // Trash sweep: purge exams archived longer than the retention window.

        // Orphan sweep: PDFs uploaded for an exam that was never created. Runs
        // on the same slow cadence as the trash purge — nothing here is urgent.

        // AUD-013 CR-069: reclaim abandoned OWNER-BOUND staged uploads (never
        // claimed by an exam) past their expiry — exact private key files, no glob.

        // Health sampler: every 5 min record site/db/resource state to Mongo
        // (31-day TTL) — powers the Health page's uptime history.
        const healthTick = beat("health-sampler", 5 * 60 * 1000, sampleHealth)
        track(setTimeout(healthTick, 90 * 1000))
        track(setInterval(healthTick, 5 * 60 * 1000))

        // Teacher Success Journey recovery worker (CR-122/CR-125) — ONLY when the
        // flag is on. Reclaims stale AI credit reservations (crash between reserve
        // and settle) and repairs deferred referral bindings. Idempotent + bounded;
        // a no-op when the flag is off.
        if (isJourneyEnabled()) {
            const creditSvc = require('./services/aiCreditService')
            const referralSvc = require('./services/teacherReferralService')
            const journeyRecoveryTick = beat('tsj-recovery', 5 * 60 * 1000, async () => {
                try { await creditSvc.recoverStaleReservations(new Date()) } catch (e) { console.warn('[TSJ] reservation recovery:', e && e.message) }
                try { await referralSvc.reconcilePendingBindings() } catch (e) { console.warn('[TSJ] referral reconcile:', e && e.message) }
                try { await require('./services/teacherXpService').drainOutbox() } catch (e) { console.warn('[TSJ] xp outbox drain:', e && e.message) }
            })
            track(setTimeout(journeyRecoveryTick, 120 * 1000))
            track(setInterval(journeyRecoveryTick, 5 * 60 * 1000))
        }
    })
    .catch((err) => {
        // CR-115: a failed connect/startup uses the SAME cleanup path, not a bare log
        // that leaves the process half-initialised.
        console.error("[STARTUP] fatal:", err && err.message ? err.message : err)
        return lifecycleShutdown("startup-connect-failed", 1)
    })
