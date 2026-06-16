const mongoose = require("mongoose");
const { Schema } = mongoose;

// A broadcast announcement written by a teacher/admin, shown to everyone.
const notificationSchema = Schema(
  {
    title: { type: String, default: "" },
    message: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
