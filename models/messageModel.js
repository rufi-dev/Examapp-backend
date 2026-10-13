const mongoose = require("mongoose");
const { Schema } = mongoose;

// One chat message inside a Conversation. `readAt` stays null until the
// recipient opens the thread — that is what drives the unread badge.
const messageSchema = Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    from: { type: Schema.Types.ObjectId, ref: "User", required: true },
    to: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Text, an image or a voice note — at least one is present (enforced in the controller).
    text: { type: String, default: "", trim: true, maxlength: 4000 },
    imageUrl: { type: String, default: "" },
    // A voice note: the recording (Cloudinary), its length in seconds, and what
    // it says (speech to text when it was sent; "" if it could not be heard).
    audioUrl: { type: String, default: "" },
    audioSec: { type: Number, default: 0 },
    transcript: { type: String, default: "", maxlength: 4000 },
    // The second listener's hearing, when it differs from `transcript` (only the AI reads it).
    transcriptAlt: { type: String, default: "", maxlength: 4000 },
    // Written by the support AI (as the admin), not typed by a person.
    ai: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Thread reads (ordered) and unread counts.
messageSchema.index({ conversation: 1, createdAt: 1 });
messageSchema.index({ to: 1, readAt: 1 });

module.exports = mongoose.model("Message", messageSchema);
