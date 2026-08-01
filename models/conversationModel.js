const mongoose = require("mongoose");
const { Schema } = mongoose;

// A 1:1 support conversation between two users (admin <-> teacher). `key` is the
// two participant ids sorted and joined, so there is exactly ONE conversation per
// pair no matter who opens it first (the unique index enforces it).
const conversationSchema = Schema(
  {
    participants: [{ type: Schema.Types.ObjectId, ref: "User", index: true }],
    key: { type: String, required: true, unique: true },
    lastMessageText: { type: String, default: "" },
    lastMessageAt: { type: Date, default: null, index: true },
    lastMessageFrom: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Deterministic pair key — same value regardless of argument order.
conversationSchema.statics.keyFor = (a, b) =>
  [String(a), String(b)].sort().join(":");

module.exports = mongoose.model("Conversation", conversationSchema);
