const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * One document per calendar day (Azerbaijan time), replacing that day's visits.
 *
 * WHY THIS EXISTS. visitorsessions was the only collection in this database with
 * no retention at all: 12,455 rows, 7.5 MB, and 11,630 of them — 93% — older
 * than a week. Every visit to the public site leaves a row carrying an IP, a
 * user agent and a journey of up to sixty paths, and none of it was ever
 * removed. debuglogs expires after 14 days and healthsnapshots after 31; visits
 * accumulated forever.
 *
 * A visit stops being interesting as a ROW very quickly — nobody reads a
 * three-week-old individual journey — while the NUMBERS it contributes to stay
 * interesting indefinitely. So the day is summarised into this and the rows go.
 * Roughly two kilobytes replaces a day's worth of visits, and the charts keep
 * working over ranges whose rows no longer exist.
 *
 * The summary keeps no IP, no user agent and no journey. It is counts, and the
 * shape of the counts the admin page draws: the hour histogram, the funnel, and
 * the top few countries, sources and devices. That is a privacy improvement as
 * well as a storage one — a visitor's address stops being retained for a week
 * rather than forever.
 */
const bucketSchema = new Schema({ key: String, n: Number }, { _id: false });

const visitorDaySchema = new Schema(
  {
    // "yyyy-mm-dd" in Azerbaijan time — the same key the charts already bucket by.
    day: { type: String, required: true, unique: true, index: true },

    visits: { type: Number, default: 0 },
    // Distinct IPs that day. Counted BEFORE the addresses are discarded, because
    // it cannot be recovered from the summary afterwards.
    uniqueIps: { type: Number, default: 0 },
    signedIn: { type: Number, default: 0 },
    pageViews: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: 0 },

    // The render funnel: opened is the HTML loading, rendered is the app
    // painting. opened && !rendered is a visitor who left before seeing anything,
    // which is the number worth watching.
    opened: { type: Number, default: 0 },
    rendered: { type: Number, default: 0 },
    renderMsTotal: { type: Number, default: 0 },
    renderMsCount: { type: Number, default: 0 },

    // 24 numbers, index = hour of day in Azerbaijan time.
    hours: { type: [Number], default: () => Array(24).fill(0) },
    // Same, counting each IP once per hour, so the "unique" toggle keeps working.
    hoursUnique: { type: [Number], default: () => Array(24).fill(0) },

    // Top slices only. A long tail of one-visit countries is exactly the kind of
    // detail that makes a summary as big as the thing it replaced.
    countries: { type: [bucketSchema], default: [] },
    sources: { type: [bucketSchema], default: [] },
    devices: { type: [bucketSchema], default: [] },
    landings: { type: [bucketSchema], default: [] },

    rolledUpAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

module.exports = mongoose.model("VisitorDay", visitorDaySchema);
