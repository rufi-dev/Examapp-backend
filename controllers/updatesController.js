const asyncHandler = require("express-async-handler");
const User = require("../models/userModel");
const { updatesNewestFirst, unseenFor, latestPublishedAt } = require("../config/productUpdates");

/*
 * The changelog, and how much of it this teacher has already read.
 *
 * The list itself is public to any signed-in user and identical for everyone — it
 * ships in the code. The only per-user part is the cut between seen and unseen.
 */

// GET /api/updates
const listUpdates = asyncHandler(async (req, res) => {
  const seenAt = req.user?.updatesSeenAt || null;
  const unseen = unseenFor(seenAt);
  res.json({
    updates: updatesNewestFirst(),
    unseenIds: unseen.map((u) => u.id),
    seenAt,
  });
});

/*
 * POST /api/updates/seen — "I have read up to here."
 *
 * Stamped with the newest PUBLISH date rather than `now`, so an update published
 * later today still counts as unseen. Using the clock would silently swallow any
 * announcement that shipped a few minutes after the teacher happened to look.
 */
const markSeen = asyncHandler(async (req, res) => {
  const mark = latestPublishedAt();
  if (!mark) return res.json({ seenAt: null, unseenIds: [] });

  // Never move the mark BACKWARDS: a second tab with a stale page would otherwise
  // re-open the announcements the teacher just dismissed.
  const current = req.user?.updatesSeenAt ? new Date(req.user.updatesSeenAt) : null;
  const next = current && current > mark ? current : mark;

  await User.updateOne({ _id: req.user._id }, { $set: { updatesSeenAt: next } });
  res.json({ seenAt: next, unseenIds: [] });
});

module.exports = { listUpdates, markSeen };
