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

    // Track activity for the admin user list. Throttled to once every 10
    // minutes per user and deliberately NOT awaited, so an authenticated
    // request never pays for an extra write (this runs on every API call).
    const TEN_MIN = 10 * 60 * 1000;
    if (!user.lastActiveAt || Date.now() - new Date(user.lastActiveAt).getTime() > TEN_MIN) {
      User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
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

// Attaches req.user when a valid token is present and carries on regardless.
//
// For routes that serve BOTH signed-in and anonymous callers — a public share
// link where the teacher may or may not have required sign-in. Never rejects:
// the route itself decides what an anonymous caller is allowed to see, so an
// expired token degrades to "anonymous" instead of a 401 on a public page.
const attachUser = asyncHandler(async (req, res, next) => {
  try {
    const token = getToken(req);
    if (token) {
      const verified = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(verified.id).select("-password");
      if (user && user.role !== "suspended") req.user = user;
    }
  } catch {
    /* anonymous */
  }
  next();
});

module.exports = { protect, adminOnly, teacherOnly, verifiedOnly, attachUser };
