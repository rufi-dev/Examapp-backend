const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * One recorded visit: from the page someone arrived on to the moment they left.
 * Since 2026-10-27 (owner) that is every visitor and every teacher; `user` is
 * null for a visitor who never signed in, and filled in if they sign up or log
 * in during the visit. The recording itself (DOM snapshots, clicks, errors)
 * lives as compressed chunks on the recordings volume; this is the index an
 * admin browses, with the counts worth sorting by.
 *
 * Temporary by design: recordingStore.sweep() removes a recording after
 * RECORDINGS_KEEP_DAYS (30), the oldest ones once RECORDINGS_MAX_MB is passed,
 * and any recording whose account ended up a student or parent.
 */
const sessionRecordingSchema = new Schema(
  {
    _id: { type: String }, // random hex id, also the folder name of its chunks
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    // The visitor tracker's id for this visit (VisitorSession.sessionId): where
    // a visitor came from (ad, campaign, country, landing page).
    visit: { type: String, default: null },
    // A one-way hash of the visitor's IP, only to cap how many visits one
    // address can have recorded a day (the raw IP is not kept here).
    ipHash: { type: String, default: null },
    startedAt: { type: Date, default: Date.now },
    lastChunkAt: { type: Date, default: null },
    endedAt: { type: Date, default: null }, // set when the browser said it was leaving
    // Browser clock (ms) of the first and last recorded event, for the duration.
    firstEventAt: { type: Number, default: null },
    lastEventAt: { type: Number, default: null },
    // The visitor signed up during this very visit (the part before it was kept too).
    registeredInSession: { type: Boolean, default: false },
    chunks: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    jsErrors: { type: Number, default: 0 }, // JavaScript errors ("errors" is reserved by Mongoose)
    apiErrors: { type: Number, default: 0 }, // failed requests
    toasts: { type: Number, default: 0 }, // error messages shown to the person
    pages: { type: [String], default: [] }, // the way through, capped
    entry: { type: String, default: "" },
    exit: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    screen: { type: String, default: "" }, // "1440x900"
  },
  { timestamps: true, minimize: false }
);

sessionRecordingSchema.index({ user: 1, startedAt: -1 });
sessionRecordingSchema.index({ startedAt: -1 });
sessionRecordingSchema.index({ ipHash: 1, startedAt: -1 });

module.exports = mongoose.model("SessionRecording", sessionRecordingSchema);
