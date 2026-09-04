/*
 * The Lesson Studio AI kill switch.
 *
 * Studio's AI turns run with NO rate limit, NO daily budget guard and NO credit
 * charge — a deliberate owner decision. That makes this the only brake in the
 * system, so it exists before it is needed rather than after: one env var,
 * `STUDIO_AI_ENABLED=false`, plus `docker compose up -d --force-recreate backend
 * worker`, and generation stops without touching code or taking the feature down.
 *
 * WHY 503 AND NOT 404, unlike middleware/curriculumFlag.js. That flag hides a
 * feature that has not shipped, so 404 ("this does not exist") is the truth. This
 * one switches off part of a feature teachers are already using: their materials,
 * their attachments and their exports must keep working, and the chat must say it
 * is temporarily off rather than pretend it was never there.
 *
 * Gates ONLY the two AI routes. Read, edit, attach and export stay up.
 */
const asyncHandler = require("express-async-handler");
const { httpError } = require("../utils/appError");

// Default ON: flipping this off is an incident response, not a deployment step.
const isStudioAiEnabled = () => String(process.env.STUDIO_AI_ENABLED ?? "true").toLowerCase() !== "false";

const requireStudioAi = asyncHandler(async (req, res, next) => {
  if (!isStudioAiEnabled()) {
    throw httpError(
      503,
      "studio_ai_disabled",
      "AI müvəqqəti olaraq söndürülüb. Materiallarınız yerindədir — bir az sonra yenidən cəhd edin."
    );
  }
  next();
});

module.exports = { requireStudioAi, isStudioAiEnabled };
