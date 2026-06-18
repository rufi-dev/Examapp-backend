const asyncHandler = require("express-async-handler");
const jwt = require("jsonwebtoken");
const User = require("../models/userModel");
const { getToken } = require("../utils/index");
const { recordDebug } = require("../utils/debugLog");

const protect = asyncHandler(async (req, res, next) => {
  // Diagnostic context (stored in DebugLog on failure) so a recurring login
  // problem shows the EXACT reason: did a real device send no token at all
  // (header+cookie both missing = the cross-domain issue), or an invalid one?
  const ctx = {
    path: req.originalUrl,
    method: req.method,
    ua: req.headers["user-agent"],
    ip: req.ip,
    hasAuthHeader: !!req.headers.authorization,
    hasCookie: !!(req.cookies && req.cookies.token),
  };
  const isBrowser = /Mozilla/i.test(ctx.ua || ""); // skip curl/bot noise
  try {
    // Authorization: Bearer header first (reliable cross-domain), cookie fallback.
    const token = getToken(req);
    if (!token) {
      if (isBrowser) recordDebug({ kind: "auth_no_token", ...ctx });
      res.status(401);
      throw new Error("Not authorized, please login");
    }

    // Verify Token
    let verified;
    try {
      verified = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      recordDebug({ kind: "auth_invalid_token", message: e.message, ...ctx });
      res.status(401);
      throw new Error("Not authorized, please login");
    }

    //Get UserId from Token
    const user = await User.findById(verified.id).select("-password");

    if (!user) {
      recordDebug({ kind: "auth_user_not_found", message: String(verified.id), ...ctx });
      res.status(404);
      throw new Error("User not found");
    }

    if (user.role === "suspended") {
      res.status(400);
      throw new Error("User suspended, please contact support");
    }

    req.user = user;
    next();
  } catch (error) {
    if (res.statusCode === 200) {
      res.status(401);
      throw new Error("Not authorized, please login");
    }
    throw error;
  }
});

const adminOnly = asyncHandler(async (req, res, next) => {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    res.status(401);
    throw new Error("Not authorized as an admin");
  }
});

const teacherOnly = asyncHandler(async (req, res, next) => {
  if (req.user && (req.user.role === "teacher" || req.user.role === "admin")) {
    next();
  } else {
    res.status(401);
    throw new Error("Not authorized as teacher or admin");
  }
});

const verifiedOnly = asyncHandler(async (req, res, next) => {
  if (req.user && req.user.isVerified) {
    next();
  } else {
    res.status(401);
    throw new Error("Not authorized, account not verified!");
  }
});

module.exports = { protect, adminOnly, teacherOnly, verifiedOnly };
