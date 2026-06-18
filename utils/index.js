const jwt = require("jsonwebtoken")
const crypto = require("crypto")

//Generate Token (no expiry — sessions don't time out)
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET)
}

// Extract the auth JWT from the Authorization: Bearer header FIRST (works on
// every device), falling back to the cookie. The frontend and API are on
// different domains, so the cookie is third-party and is dropped by Safari/iOS
// and privacy browsers — the header path is what makes login reliable.
const getToken = (req) => {
    const header = req.headers?.authorization || ""
    if (header.startsWith("Bearer ")) return header.slice(7).trim()
    return req.cookies?.token
}

//Hash Token
const hashToken = (token) => {
    return crypto.createHash("sha256").update(token.toString()).digest("hex");
}

module.exports = { generateToken, hashToken, getToken }