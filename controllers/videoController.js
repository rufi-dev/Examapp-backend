const asyncHandler = require("express-async-handler");
const Video = require("../models/videoModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const { pageLimit, withCursor, pageResult, wantsEnvelope } = require("../utils/cursorPagination");

// Pull the 11-char YouTube video id out of the common URL shapes (watch,
// youtu.be, embed, shorts, live) or accept a bare id.
function extractYouTubeId(input) {
  const s = String(input || "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return "";
}

// Keep only the classes this user may publish to (their own; admins: any).
async function ownedClassIds(user, raw) {
  let ids = raw;
  if (typeof ids === "string") {
    try {
      ids = JSON.parse(ids);
    } catch {
      ids = ids ? [ids] : [];
    }
  }
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  ids = ids.filter(Boolean).map(String);
  if (!ids.length) return [];
  const found = await Class.find({ _id: { $in: ids } }).select("owner").lean();
  return found
    .filter((c) => user.role === "admin" || String(c.owner) === String(user._id))
    .map((c) => String(c._id));
}

// Shared with everyone, or overlapping the student's classes — checking the
// new list AND the legacy single-class field, so videos published before
// multi-class support keep their audience.
const audienceFilter = (classIds) => ({
  $or: [
    {
      $and: [
        { $or: [{ classes: { $exists: false } }, { classes: { $size: 0 } }] },
        { $or: [{ class: null }, { class: { $exists: false } }] },
      ],
    },
    { classes: { $in: classIds } },
    { class: { $in: classIds } },
  ],
});

// GET /api/videos — scoped like the rest of the platform (teacher data is
// isolated):
//   • admin   → every video
//   • teacher → ONLY their own uploads (never another teacher's)
//   • student → videos from the teachers whose classes they're approved-enrolled
//               in (so they see their own teachers' lessons, and nobody else's)
const getVideos = asyncHandler(async (req, res) => {
  let filter;
  if (req.user.role === "admin") {
    filter = {};
  } else if (req.user.role === "teacher") {
    filter = { owner: req.user._id };
  } else {
    const classIds = await Enrollment.find({
      student: req.user._id,
      status: "approved",
    }).distinct("class");
    const ownerIds = classIds.length
      ? await Class.find({ _id: { $in: classIds } }).distinct("owner")
      : [];
    // Same rule as study materials: a video shared with everyone (class: null)
    // reaches all of that teacher's students; a class-scoped one only reaches
    // students actually enrolled in that class.
    filter = { owner: { $in: ownerIds }, ...audienceFilter(classIds) };
  }
  const query = req.query || {};
  const limit = pageLimit(query.limit);
  const rows = await Video.find(withCursor(filter, query.cursor))
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate("classes", "name level").populate("class", "name level")
    .lean();
  const page = pageResult(rows, limit);
  res.json(wantsEnvelope(req) ? page : page.items);
});

// POST /api/videos — teacher/admin adds a YouTube link (owned by them).
const addVideo = asyncHandler(async (req, res) => {
  const { title, url } = req.body;
  if (!title || !String(title).trim()) {
    return res.status(400).json({ message: "Başlıq daxil edin" });
  }
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return res.status(400).json({ message: "Düzgün YouTube linki daxil edin" });
  }
  // Only allow attaching to classes the uploader actually owns. Empty = all.
  const classIds = await ownedClassIds(req.user, req.body.classIds ?? req.body.classId);

  const video = await Video.create({
    title: String(title).trim(),
    videoId,
    url: String(url).trim(),
    classes: classIds,
    class: null,
    owner: req.user._id,
    ownerName: req.user.name || "",
  });
  const populated = await Video.findById(video._id).populate("classes", "name level").populate("class", "name level").lean();
  res.status(201).json(populated);
});

// PATCH /api/videos/:id — owner/admin retargets the video at another class (or
// back to "all my students"), or renames it.
const updateVideo = asyncHandler(async (req, res) => {
  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ message: "Tapılmadı" });
  const isOwner = video.owner && String(video.owner) === String(req.user._id);
  if (!isOwner && req.user.role !== "admin") {
    return res.status(403).json({ message: "Bu video sizə aid deyil" });
  }
  if (typeof req.body.title === "string" && req.body.title.trim()) {
    video.title = req.body.title.trim();
  }
  if (
    Object.prototype.hasOwnProperty.call(req.body, "classIds") ||
    Object.prototype.hasOwnProperty.call(req.body, "classId")
  ) {
    video.classes = await ownedClassIds(req.user, req.body.classIds ?? req.body.classId);
    video.class = null; // the list is authoritative from here on
  }
  await video.save();
  const populated = await Video.findById(video._id).populate("classes", "name level").populate("class", "name level").lean();
  res.json(populated);
});

// DELETE /api/videos/:id — only the owner or an admin can remove a video.
const deleteVideo = asyncHandler(async (req, res) => {
  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ message: "Tapılmadı" });
  const isOwner = video.owner && String(video.owner) === String(req.user._id);
  const isAdmin = req.user.role === "admin";
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: "Bu video sizə aid deyil" });
  }
  await video.deleteOne();
  res.json({ id: req.params.id });
});

module.exports = { getVideos, addVideo, updateVideo, deleteVideo };
