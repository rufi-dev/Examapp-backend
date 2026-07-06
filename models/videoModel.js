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
    owner: { type: Schema.Types.ObjectId, ref: "User", index: true },
    ownerName: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Video", videoSchema);
