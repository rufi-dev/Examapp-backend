const { recordErrorEvent } = require("./requestMetrics")
const crypto = require("crypto")
const { isAppError } = require("../utils/appError")

const errorHandler = (err, req, res, next) => {
    // Prefer a status the error carries (body-parser sets err.status=400 on
    // malformed JSON, multer sets 4xx, etc.) so routine client-caused errors
    // are NOT misreported as 500s — which would otherwise inflate the health
    // page's 5xx rate and trip a false "critical" alert. Then a controller-set
    // res.statusCode, and finally: an unhandled throw that set nothing is a
    // real server error → 500 (Express defaults res.statusCode to 200).
    const carried = err.status || err.statusCode
    const statusCode = (carried && carried >= 400)
        ? carried
        : (res.statusCode && res.statusCode !== 200 ? res.statusCode : 500)
    const known = isAppError(err) || (carried >= 400 && carried < 500)
    const code = isAppError(err)
        ? err.code
        : statusCode >= 500
            ? "internal_error"
            : `http_${statusCode}`
    const message = statusCode >= 500 && !isAppError(err)
        ? "Internal server error"
        : (err.message || "Request failed")
    const requestId =
        req.requestId ||
        req.get?.("x-request-id") ||
        crypto.randomUUID()

    // Feed the admin Health page's grouped error log (in-memory, never throws).
    recordErrorEvent(req, statusCode, code)

    res.status(statusCode)
    res.setHeader("X-Request-Id", requestId)

    const body = { code, message, requestId }
    if (
        known &&
        err.details &&
        typeof err.details === "object" &&
        JSON.stringify(err.details).length <= 2000
    ) {
        body.details = err.details
    }
    res.json(body)
}

module.exports = errorHandler
