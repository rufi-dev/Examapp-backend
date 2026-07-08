const { recordErrorEvent } = require("./requestMetrics")

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

    // Feed the admin Health page's grouped error log (in-memory, never throws).
    recordErrorEvent(req, statusCode, err.message)

    res.status(statusCode)

    res.json({
        message: err.message,
        stack: process.env.NODE_ENV === "development" ? err.stack : null
    })
}

module.exports = errorHandler