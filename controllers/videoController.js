const asyncHandler = require("express-async-handler");
const Video = require("../models/videoModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");

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
    filter = {
      owner: { $in: ownerIds },
      $or: [{ class: null }, { class: { $in: classIds } }],
    };
  }
  const videos = await Video.find(filter)
    .sort({ createdAt: -1 })
    .populate("class", "name level")
    .lean();
  res.json(videos);
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
  // Only allow attaching to a class the uploader actually owns.
  let classId = req.body.classId || null;
  if (classId) {
    const cls = await Class.findById(classId).select("owner");
    const ownsClass =
      cls && (String(cls.owner) === String(req.user._id) || req.user.role === "admin");
    if (!ownsClass) classId = null;
  }

  const video = await Video.create({
    title: String(title).trim(),
    videoId,
    url: String(url).trim(),
    class: classId || null,
    owner: req.user._id,
    ownerName: req.user.name || "",
  });
  const populated = await Video.findById(video._id).populate("class", "name level").lean();
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
  if (Object.prototype.hasOwnProperty.call(req.body, "classId")) {
    const wanted = req.body.classId || null;
    if (!wanted) {
      video.class = null;
    } else {
      const cls = await Class.findById(wanted).select("owner");
      const ownsClass =
        cls && (String(cls.owner) === String(req.user._id) || req.user.role === "admin");
      if (!ownsClass) {
        return res.status(403).json({ message: "Bu sinif sizə aid deyil" });
      }
      video.class = wanted;
    }
  }
  await video.save();
  const populated = await Video.findById(video._id).populate("class", "name level").lean();
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
