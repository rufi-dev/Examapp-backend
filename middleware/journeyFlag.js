const asyncHandler = require("express-async-handler");
const { isJourneyEnabled } = require("../config/teacherSuccess/flag");

/*
 * Teacher Success Journey — gate every Journey route on the backend-owned flag.
 * When off, the whole surface responds 404 (as if it does not exist), so a
 * flag-off deployment is behaviorally identical to before the feature shipped.
 */
const requireJourney = asyncHandler(async (req, res, next) => {
  if (!isJourneyEnabled()) {
    res.status(404);
    throw new Error("Not found");
  }
  next();
});

// A teacher (any level, INCLUDING a new pending Spark teacher) or an admin may
// read/act on their own Journey. This is recognition data, NOT a privileged
// capability — so it deliberately does NOT use teacherOnly (which blocks pending).
const teacherOrAdmin = asyncHandler(async (req, res, next) => {
  if (req.user && (req.user.role === "teacher" || req.user.role === "admin")) return next();
  res.status(403);
  throw new Error("Teacher or admin only");
});

module.exports = { requireJourney, teacherOrAdmin };
