const mongoose = require("mongoose");
const { Schema } = mongoose;

// A weekly-recurring lesson series (e.g. "every Tue & Fri at 18:00"). Concrete Lesson
// docs are materialised from it up to a rolling horizon; a daily sweep tops up
// open-ended series so they keep going until the teacher stops them.
const lessonSeriesSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    class: { type: Schema.Types.ObjectId, ref: "Class", required: true, index: true },
    title: { type: String, default: "" },
    note: { type: String, default: "" },
    price: { type: Number, default: null },
    weekdays: [{ type: Number, min: 0, max: 6 }], // JS getDay(): 0=Sun .. 6=Sat
    hour: { type: Number, default: 18, min: 0, max: 23 },
    minute: { type: Number, default: 0, min: 0, max: 59 },
    durationMin: { type: Number, default: null }, // null => no end time
    startDate: { type: Date, required: true }, // first eligible day
    until: { type: Date, default: null }, // null = open-ended (endless)
    active: { type: Boolean, default: true, index: true },
    generatedThrough: { type: Date, default: null }, // last date occurrences were created up to
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model("LessonSeries", lessonSeriesSchema);
