const mongoose = require("mongoose");

// Tiny key/value store for cross-request app settings that must survive a
// restart but don't warrant their own collection each. First use: the
// auto-outreach watcher's on/off toggle + the "watch from" timestamp so
// enabling it starts watching NEW registrations rather than the backlog.
const appSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.AppSetting || mongoose.model("AppSetting", appSettingSchema);
