/*
 * Gate every curriculum route on the backend-owned flag. When off, the whole
 * surface responds 404 — as if it does not exist — so a flag-off deployment is
 * behaviourally identical to before the feature shipped.
 *
 * This runs BEFORE `protect`, so a flag-off deployment returns 404 and never 401:
 * a 401 would tell an anonymous prober that the endpoint is real.
 */
const asyncHandler = require("express-async-handler");
const { isCurriculumEnabled } = require("../config/curriculumFlag");

const requireCurriculum = asyncHandler(async (req, res, next) => {
  if (!isCurriculumEnabled()) {
    res.status(404);
    throw new Error("Not found");
  }
  next();
});

module.exports = { requireCurriculum };
