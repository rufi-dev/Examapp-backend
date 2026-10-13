const mongoose = require("mongoose");

// One WhatsApp chat the support AI may answer (helper/waAutoReply): which of
// the admin's numbers it is on, the teacher, whether the chat was seen to
// begin with our automatic message, whether a person has taken it over, and
// how many AI replies it has had today (Baku day). Only teachers' chats are
// ever stored here.
const waAutoChatSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true }, // "<ownerKey>|<chatId>"
    owner: { type: String, default: "" },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    verified: { type: Boolean, default: false },
    humanUntil: { type: Date, default: null },
    day: { type: String, default: "" },
    replies: { type: Number, default: 0 },
    lastReplyAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.WaAutoChat || mongoose.model("WaAutoChat", waAutoChatSchema);
