const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * One recorded visit of a new teacher: from the page they arrived on to the
 * moment they left. The recording itself (DOM snapshots, clicks, errors) lives
 * as compressed chunks on the recordings volume; this is the index an admin
 * browses, with the counts worth sorting by.
 *
 * Temporary by design: recordingStore.sweep() removes a recording after 30
 * days, and any recording whose account did not end up a teacher.
 */
const sessionRecordingSchema = new Schema(
  {
    _id: { type: String }, // random hex id, also the folder name of its chunks
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
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

module.exports = mongoose.model("SessionRecording", sessionRecordingSchema);
