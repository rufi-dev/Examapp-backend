const mongoose = require("mongoose");

// Lightweight diagnostic log for auth problems. Stored in MongoDB (Atlas) so it
// PERSISTS across redeploys and can be inspected days later — unlike console
// logs, which reset every deploy. Auto-expires after 14 days so it never grows
// unbounded. Written fire-and-forget; it must never affect a real request.
const debugLogSchema = new mongoose.Schema(
  {
    kind: String, // login_ok | auth_no_token | auth_invalid_token | auth_user_not_found
    message: String, // error detail / context
    path: String,
    method: String,
    ua: String, // user-agent (which device/browser)
    ip: String,
    email: String, // set on login_ok so failures can be correlated by device
    hasAuthHeader: Boolean, // did the request carry an Authorization header?
    hasCookie: Boolean, // ...or the cookie?
  },
  { timestamps: true }
);

// TTL: delete entries 14 days after creation.
debugLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 3600 });

module.exports = mongoose.model("DebugLog", debugLogSchema);
