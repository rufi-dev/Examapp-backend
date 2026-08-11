const mongoose = require("mongoose");
const { Schema } = mongoose;

// A teacher-shared "Mövzu izahı" (topic explanation) video. Two SOURCES:
//   • "youtube" → only the 11-char videoId is stored; the player/thumbnail are
//     built from it on the client (an <iframe> embed).
//   • "file"    → an uploaded MP4/WebM stored PRIVATELY in videos/ (Docker
//     volume), streamed through an access-checked, range-capable endpoint and
//     played with a native <video> tag.
// Managed by the owner (or an admin). Visibility is scoped so a teacher sees only
// their own videos and a student sees videos from teachers whose classes they've
// joined (see videoController.getVideos).
const videoSchema = Schema(
  {
    title: { type: String, trim: true, required: true },
    // "youtube" (default, legacy rows) or "file" (uploaded MP4/WebM).
    source: { type: String, enum: ["youtube", "file"], default: "youtube" },
    videoId: { type: String }, // 11-char YouTube id (source=youtube only)
    url: { type: String, trim: true }, // original link, for reference
    // Uploaded-file fields (source=file). fileName is the random name inside
    // videos/ — the original name is never exposed in a URL.
    fileName: { type: String, default: "" },
    originalName: { type: String, trim: true, default: "" },
    mimeType: { type: String, default: "" }, // video/mp4 | video/webm
    sizeBytes: { type: Number, default: 0 },
    // Audience, same rule as study materials: EMPTY = all of this teacher's
    // students, otherwise only the listed classes.
    classes: [{ type: Schema.Types.ObjectId, ref: "Class", index: true }],
    // Legacy single-class field, kept so videos published before multi-class
    // support keep their audience. Reads prefer `classes` when non-empty.
    class: { type: Schema.Types.ObjectId, ref: "Class", default: null, index: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", index: true },
    ownerName: { type: String, trim: true },
  },
  { timestamps: true }
);
videoSchema.index(
  { createdAt: -1, _id: -1 },
  { name: "page_createdAt_desc" }
);

module.exports = mongoose.model("Video", videoSchema);
