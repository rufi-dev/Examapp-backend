const mongoose = require("mongoose");

// Lightweight diagnostic log for auth problems. Stored in MongoDB (Atlas) so it
// PERSISTS across redeploys and can be inspected days later — unlike console
// logs, which reset every deploy. Auto-expires after 14 days so it never grows
// unbounded. Written fire-and-forget; it must never affect a real request.
const debugLogSchema = new mongoose.Schema(
  {
    kind: String, // login_ok | auth_no_token | auth_invalid_token | auth_user_not_found
    // CR-109/CR-112: mail-failure diagnostics carry ONLY an allowlisted category + a
    // fixed operation — never a raw error message. These are DECLARED (with strict
    // enums) so Mongoose actually persists them instead of silently dropping them.
    category: { type: String, enum: ["smtp_timeout", "smtp_auth", "smtp_tls", "smtp_unavailable"] },
    op: { type: String, enum: ["verify", "loginCode", "forgotPassword", "passwordChanged", "roleChanged"] },
    message: String, // error detail / context (NEVER set on mail-failure events)
    path: String,
    method: String,
    ua: String, // user-agent (which device/browser)
    ip: String,
    email: String, // set on login_ok so failures can be correlated by device
    userId: String, // approved correlation id (e.g. reset_apply_failed). Pseudonymous account-correlation data (not direct contact info, but still governed by the 14-day log-retention/access policy below).
    hasAuthHeader: Boolean, // did the request carry an Authorization header?
    hasCookie: Boolean, // ...or the cookie?
  },
  { timestamps: true }
);

// TTL: delete entries 14 days after creation.
debugLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 3600 });

module.exports = mongoose.model("DebugLog", debugLogSchema);
