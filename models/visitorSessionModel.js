const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * One document per visit (keyed by a per-visit sessionId the browser mints).
 * The public site pings /api/track as a visitor moves around; this row fills in
 * with where they came from, where they went, and how long they stayed. The
 * admin "Ziyarətçilər" page reads these back. No account, no PII beyond IP +
 * coarse country — it is site analytics, not a user record.
 */
const visitorSessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },

    // Set the moment a logged-in user is seen browsing this visit (the browser
    // sends its own id/name). The reliable link between a visit and an account —
    // no IP guessing. Absent for anonymous visits.
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    userName: { type: String },

    // Where from
    ip: String,
    country: String,
    affiliate: String, // utm_source / ?ref= / referring host / "(direct)"
    referrer: String,
    landing: String, // first path of the visit
    campaign: String, // utm_campaign

    // What they did
    pages: { type: [String], default: [] }, // journey, newest last (capped)
    lastPage: String,
    pageViews: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: 0 }, // active time on site

    // Who (coarse)
    device: String,
    userAgent: String,

    firstSeen: { type: Date, default: Date.now },
    lastActivity: { type: Date, default: Date.now, index: true },
  },
  { minimize: false }
);

module.exports = mongoose.model("VisitorSession", visitorSessionSchema);
