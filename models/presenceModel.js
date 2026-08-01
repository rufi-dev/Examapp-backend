const mongoose = require("mongoose");
const { Schema } = mongoose;

// Lightweight "is this user on the site right now" signal. The client pings this
// while a staff tab is visible; "online" is derived in the query as lastSeenAt
// within a freshness window (see chatController). The TTL index only garbage-
// collects rows nobody has refreshed for a day — it is NOT the online signal.
const presenceSchema = Schema({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  lastSeenAt: { type: Date, default: Date.now },
});

presenceSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model("Presence", presenceSchema);
