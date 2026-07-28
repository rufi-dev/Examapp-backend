const mongoose = require("mongoose");
const { Schema } = mongoose;

// A teacher-shared YouTube "Mövzu izahı" (topic explanation) video. Only the
// YouTube video id is stored; the player/thumbnail are built from it on the
// client. Managed by the owner (or an admin). Visibility is scoped so a teacher
// sees only their own videos and a student sees videos from teachers whose
// classes they've joined (see videoController.getVideos).
const videoSchema = Schema(
  {
    title: { type: String, trim: true, required: true },
    videoId: { type: String, required: true }, // 11-char YouTube id
    url: { type: String, trim: true }, // original link, for reference
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
