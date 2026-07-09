const { recordErrorEvent } = require("./requestMetrics")

const errorHandler = (err, req, res, next) => {
    const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500

    recordErrorEvent(req, statusCode, err.message)

    res.status(statusCode)

    res.json({
        message: err.message,
        stack: process.env.NODE_ENV === "development" ? err.stack : null
    })
}

module.exports = errorHandler
