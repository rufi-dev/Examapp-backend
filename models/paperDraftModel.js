const mongoose = require("mongoose");
const { Schema } = mongoose;

// A student's in-progress self-upload of a paper exam answer sheet: the photos,
// what the AI read, and the student's corrections. Kept server-side so a refresh
// never loses the work and so AI reads can be limited per student. Deleted once
// the sheet is submitted (the Result is the permanent record).
const paperDraftSchema = new Schema(
  {
    exam: { type: Schema.Types.ObjectId, ref: "Exam", required: true },
    student: { type: Schema.Types.ObjectId, ref: "User", required: true },
    photos: [{ type: String }],
    // Plain answer values, one per key question (no key information).
    answers: { type: Schema.Types.Mixed, default: undefined },
    // The last AI read: [{ answer, confidence, note }].
    aiAnswers: { type: Schema.Types.Mixed, default: undefined },
    // Name/class boxes read off the sheet.
    sheetStudent: { type: Schema.Types.Mixed, default: undefined },
    // AI reads used (each is a paid model call).
    readCount: { type: Number, default: 0 },
    // Submit lock: set while a submit is being processed.
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

// One draft per student per exam — also what makes the submit lock atomic.
paperDraftSchema.index({ exam: 1, student: 1 }, { unique: true });

module.exports = mongoose.model("PaperDraft", paperDraftSchema);
