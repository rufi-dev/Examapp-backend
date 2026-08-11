const asyncHandler = require("express-async-handler");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const Video = require("../models/videoModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const { pageLimit, withCursor, pageResult, wantsEnvelope } = require("../utils/cursorPagination");

// PRIVATE storage for uploaded MP4/WebM — deliberately NOT under uploads/ (which
// express.static serves publicly). The only way to read a file is through the
// access-checked, token-gated stream endpoint below.
const VIDEOS_DIR = path.join(process.cwd(), "videos");
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

const cleanup = (p) => {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* best effort */
  }
};

// Magic-byte gate for an uploaded video: MP4/MOV (ISO-BMFF: "ftyp" at offset 4)
// or WebM/Matroska (EBML header 1A 45 DF A3). Rejects anything else fail-closed.
function videoHeadOk(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    const isMp4 = buf.slice(4, 8).toString("latin1") === "ftyp";
    const isWebm = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
    return isMp4 || isWebm;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// The audience a doc reaches (new list, falling back to the legacy single class).
const audienceOf = (v) =>
  v.classes?.length ? v.classes.map(String) : v.class ? [String(v.class)] : [];

// Can this user open/stream this video? Mirrors the getVideos list scoping.
async function canAccessVideo(user, video) {
  if (!video) return false;
  if (user.role === "admin") return true;
  if (video.owner && String(video.owner) === String(user._id)) return true; // owning teacher
  if (user.role === "teacher") return false; // never another teacher's video
  const classIds = await Enrollment.find({ student: user._id, status: "approved" }).distinct("class");
  const ownerIds = classIds.length
    ? await Class.find({ _id: { $in: classIds } }).distinct("owner")
    : [];
  if (!ownerIds.some((o) => String(o) === String(video.owner))) return false;
  const audience = audienceOf(video);
  if (!audience.length) return true; // shared with all of that teacher's students
  return classIds.some((c) => audience.includes(String(c)));
}

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

// POST /api/videos — teacher/admin adds a video: either a YouTube link OR an
// uploaded MP4/WebM file (multipart, field "file"). Owned by the caller.
const addVideo = asyncHandler(async (req, res) => {
  const file = req.file;
  const title = String(req.body.title || "").trim();
  if (!title) {
    cleanup(file?.path);
    return res.status(400).json({ message: "Başlıq daxil edin" });
  }
  // Only allow attaching to classes the uploader actually owns. Empty = all.
  const classIds = await ownedClassIds(req.user, req.body.classIds ?? req.body.classId);

  // ── Uploaded file (MP4/WebM) ───────────────────────────────────────────────
  if (file) {
    // Quota is checked by middleware AFTER multer wrote the file; reject cheaply.
    if (req.quotaRejected) {
      cleanup(file.path);
      return res.status(413).json({ message: req.quotaRejected.message });
    }
    if (!videoHeadOk(file.path)) {
      cleanup(file.path);
      return res.status(400).json({ message: "Yalnız MP4 və ya WebM video yükləyin" });
    }
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(file.path).size;
    } catch {
      /* non-fatal */
    }
    const mimeType = /webm$/i.test(file.originalname) ? "video/webm" : "video/mp4";
    const video = await Video.create({
      title,
      source: "file",
      fileName: path.basename(file.path),
      originalName: file.originalname || "",
      mimeType,
      sizeBytes,
      classes: classIds,
      class: null,
      owner: req.user._id,
      ownerName: req.user.name || "",
    });
    const populated = await Video.findById(video._id)
      .populate("classes", "name level")
      .populate("class", "name level")
      .lean();
    return res.status(201).json(populated);
  }

  // ── YouTube link ───────────────────────────────────────────────────────────
  const videoId = extractYouTubeId(req.body.url);
  if (!videoId) {
    return res.status(400).json({ message: "YouTube linki daxil edin və ya video faylı yükləyin" });
  }
  const video = await Video.create({
    title,
    source: "youtube",
    videoId,
    url: String(req.body.url).trim(),
    classes: classIds,
    class: null,
    owner: req.user._id,
    ownerName: req.user.name || "",
  });
  const populated = await Video.findById(video._id)
    .populate("classes", "name level")
    .populate("class", "name level")
    .lean();
  res.status(201).json(populated);
});

// GET /api/videos/:id/token — a short-lived signed token the <video> tag uses to
// stream a private uploaded file (the media request can't carry the bearer
// header). Access is verified HERE, once, before the token is issued.
const getStreamToken = asyncHandler(async (req, res) => {
  const video = await Video.findById(req.params.id).lean();
  if (!video || video.source !== "file") return res.status(404).json({ message: "Tapılmadı" });
  if (!(await canAccessVideo(req.user, video))) {
    return res.status(403).json({ message: "Bu videoya girişiniz yoxdur" });
  }
  const token = jwt.sign(
    { vid: String(video._id), uid: String(req.user._id) },
    process.env.JWT_SECRET,
    { expiresIn: "3h" }
  );
  res.json({ token });
});

// GET /api/videos/:id/stream?t=<token> — stream a private uploaded video with
// HTTP Range support (res.sendFile honours Range, so the player can seek). No
// bearer middleware: the signed, video-scoped, short-lived token is the auth.
const streamVideo = asyncHandler(async (req, res) => {
  let payload;
  try {
    payload = jwt.verify(String(req.query.t || ""), process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Token etibarsızdır" });
  }
  if (!payload || payload.vid !== String(req.params.id)) {
    return res.status(403).json({ message: "İcazə yoxdur" });
  }
  const video = await Video.findById(req.params.id).lean();
  if (!video || video.source !== "file" || !video.fileName) {
    return res.status(404).json({ message: "Tapılmadı" });
  }
  const abs = path.join(VIDEOS_DIR, video.fileName);
  if (!abs.startsWith(VIDEOS_DIR) || !fs.existsSync(abs)) {
    return res.status(404).json({ message: "Fayl tapılmadı" });
  }
  res.sendFile(abs, {
    acceptRanges: true,
    headers: {
      "Content-Type": video.mimeType || "video/mp4",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
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
  const storedName = video.source === "file" ? video.fileName : "";
  await video.deleteOne();
  if (storedName) cleanup(path.join(VIDEOS_DIR, storedName)); // free the disk
  res.json({ id: req.params.id });
});

module.exports = { getVideos, addVideo, updateVideo, deleteVideo, getStreamToken, streamVideo, VIDEOS_DIR };
