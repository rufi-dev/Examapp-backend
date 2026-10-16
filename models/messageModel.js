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
    // Something the support AI prepared for the teacher to confirm
    // (helper/teacherActions): the card under the reply. Nothing happens until
    // the teacher presses «Təsdiq et». `kind`, not `type`: Mongoose reads a
    // nested `type` key as the path's own type.
    action: {
      type: new Schema(
        {
          kind: { type: String, enum: ["update_exam", "move_exam", "create_exam"], required: true },
          params: { type: Schema.Types.Mixed, default: {} },
          title: { type: String, default: "" },
          lines: { type: [String], default: [] },
          status: { type: String, enum: ["pending", "running", "done", "failed", "cancelled"], default: "pending" },
          result: { type: String, default: "" },
          link: { type: String, default: "" },
          decidedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: undefined,
    },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Thread reads (ordered) and unread counts.
messageSchema.index({ conversation: 1, createdAt: 1 });
messageSchema.index({ to: 1, readAt: 1 });

module.exports = mongoose.model("Message", messageSchema);
