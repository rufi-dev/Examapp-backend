const mongoose = require("mongoose");
const { Schema } = mongoose;

// One chat message inside a Conversation. `readAt` stays null until the
// recipient opens the thread — that is what drives the unread badge.
const messageSchema = Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    from: { type: Schema.Types.ObjectId, ref: "User", required: true },
    to: { type: Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, trim: true, maxlength: 4000 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Thread reads (ordered) and unread counts.
messageSchema.index({ conversation: 1, createdAt: 1 });
messageSchema.index({ to: 1, readAt: 1 });

module.exports = mongoose.model("Message", messageSchema);
