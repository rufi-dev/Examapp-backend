const mongoose = require("mongoose");

// One row every ~5 minutes from the health sampler. Powers the uptime
// percentages (24h / 7d / 30d) and the resource-history strips on the admin
// Health page. Persisted in Mongo so history survives redeploys; TTL keeps it
// bounded (~9k docs a month, a few bytes each).
//
// A GAP in samples means the backend itself was down/restarting — the page
// derives "API availability" from expected-vs-actual sample counts, and
// "site uptime" from the recorded siteUp flags (Cloudflare can be up while
// the backend restarts, and vice versa).
const healthSnapshotSchema = new mongoose.Schema(
  {
    // NOTE: indexed via the TTL index below — do not add index:true here too
    // (two index specs on the same key conflict at createIndexes time).
    at: { type: Date, required: true },
    siteUp: Boolean, // https://bunkermath.az reachable from the server
    siteMs: Number, // homepage response time
    siteStatus: Number, // HTTP status code
    dbUp: Boolean,
    dbMs: Number, // mongo ping round-trip
    cpuPct: Number,
    memPct: Number,
    diskPct: Number,
    status: String, // healthy | warning | critical | down (overall at sample time)
  },
  { timestamps: false, versionKey: false }
);

// TTL: 31 days of history.
healthSnapshotSchema.index({ at: 1 }, { expireAfterSeconds: 31 * 24 * 3600 });

module.exports = mongoose.model("HealthSnapshot", healthSnapshotSchema);
